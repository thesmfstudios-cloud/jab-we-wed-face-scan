import { NextResponse } from 'next/server';
import { CreateCollectionCommand, DescribeCollectionCommand, IndexFacesCommand } from '@aws-sdk/client-rekognition';
import { getAdminSupabase, BUCKET_PREVIEWS } from '@/lib/server/supabase-admin';
import { getCollectionId, getRekognitionClient } from '@/lib/server/rekognition';
import { jsonError, requireAdmin } from '@/lib/server/security';
import { loadAdminEvent } from '@/lib/server/admin-events';
import { downloadDriveFile, friendlyDriveError } from '@/lib/server/google-drive';
import { makeServerPreview } from '@/lib/server/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH = 8;
const DRIVE_BATCH = 4; // Drive originals are full size; keep each call well under the time limit.

async function ensureCollection(client, collectionId) {
  try {
    await client.send(new DescribeCollectionCommand({ CollectionId: collectionId }));
  } catch (error) {
    if (error?.name !== 'ResourceNotFoundException') throw error;
    try {
      await client.send(new CreateCollectionCommand({ CollectionId: collectionId }));
    } catch (e) {
      if (e?.name !== 'ResourceAlreadyExistsException') throw e;
    }
  }
}

/**
 * Incremental face indexing (adapted from Face Match's rekognition-index).
 * Each call indexes the next batch of NOT-yet-indexed photos for one wedding
 * into that wedding's own collection, so re-running after new uploads only
 * processes the new photos. The dashboard calls this in a loop.
 */
export async function POST(request, { params }) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const event = await loadAdminEvent(id);
    if (!event) return jsonError('Wedding not found.', 404);
    const body = await request.json().catch(() => ({}));
    const retryFailed = body.retryFailed === true;

    const supabase = getAdminSupabase();
    let query = supabase
      .from('jw_photos')
      .select('id,preview_path,drive_file_id,processing_status')
      .eq('event_id', event.id)
      .in('processing_status', ['ready', 'pending'])
      .is('indexed_at', null)
      .order('created_at', { ascending: true })
      .limit(BATCH);
    if (!retryFailed) query = query.is('index_error', null);
    const { data: rows, error } = await query;
    if (error) throw error;
    // Cap Drive photos per call (each one is a full-size download).
    let driveSlots = DRIVE_BATCH;
    const photos = (rows || []).filter((p) => p.processing_status !== 'pending' || driveSlots-- > 0);

    const client = getRekognitionClient();
    const collectionId = getCollectionId(event.id);
    if (photos?.length) await ensureCollection(client, collectionId);

    const results = await Promise.all((photos || []).map(async (photo) => {
      try {
        let bytes;
        if (photo.processing_status === 'pending') {
          // Google Drive photo: fetch the original once, keep only a small preview.
          if (!photo.drive_file_id) throw new Error('Photo has no source.');
          let original;
          try { original = await downloadDriveFile(photo.drive_file_id); } catch (e) { throw new Error(friendlyDriveError(e)); }
          bytes = await makeServerPreview(original);
          const { error: upError } = await supabase.storage.from(BUCKET_PREVIEWS)
            .upload(photo.preview_path, bytes, { contentType: 'image/jpeg', upsert: true });
          if (upError) throw new Error(upError.message);
          await supabase.from('jw_photos').update({ processing_status: 'ready', bytes: original.length }).eq('id', photo.id);
        } else {
          const { data: file, error: dlError } = await supabase.storage.from(BUCKET_PREVIEWS).download(photo.preview_path);
          if (dlError || !file) throw new Error(dlError?.message || 'Preview missing.');
          bytes = Buffer.from(await file.arrayBuffer());
        }
        const indexed = await client.send(new IndexFacesCommand({
          CollectionId: collectionId,
          Image: { Bytes: bytes },
          ExternalImageId: photo.id,
          // NONE (as in the live Face Match indexer) keeps small/background
          // faces from group shots so guests are found in them too.
          QualityFilter: 'NONE',
          MaxFaces: 100,
          DetectionAttributes: [],
        }));
        const faceIds = (indexed.FaceRecords || []).map((r) => r.Face?.FaceId).filter(Boolean);
        await supabase.from('jw_photos').update({ indexed_at: new Date().toISOString(), face_count: faceIds.length, face_ids: faceIds, index_error: null }).eq('id', photo.id);
        return { photoId: photo.id, faces: faceIds.length };
      } catch (e) {
        await supabase.from('jw_photos').update({ index_error: String(e?.message || 'Indexing failed').slice(0, 300) }).eq('id', photo.id);
        return { photoId: photo.id, error: e?.message || 'Indexing failed' };
      }
    }));

    await supabase.rpc('jw_refresh_event_counts', { p_event_id: event.id });
    let remainingQuery = supabase.from('jw_photos').select('id', { count: 'exact', head: true })
      .eq('event_id', event.id).in('processing_status', ['ready', 'pending']).is('indexed_at', null);
    if (!retryFailed) remainingQuery = remainingQuery.is('index_error', null);
    const { count: remaining } = await remainingQuery;
    const fresh = await loadAdminEvent(event.id);

    return NextResponse.json({
      ok: true,
      processed: results.length,
      faces: results.reduce((s, r) => s + (r.faces || 0), 0),
      errors: results.filter((r) => r.error).length,
      remaining: remaining || 0,
      done: !remaining,
      event: fresh,
    });
  } catch (error) {
    console.error('indexing failed:', error?.message);
    if (error?.code === 'REKOGNITION_NOT_CONFIGURED') return jsonError('Amazon Rekognition is not configured. Add AWS keys in Vercel.', 503);
    return jsonError(error?.message || 'Could not build face index.', 500);
  }
}
