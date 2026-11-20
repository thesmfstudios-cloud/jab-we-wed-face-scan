import { NextResponse, after } from 'next/server';
import { refreshEventInBackground } from '@/lib/server/auto-refresh';
import { SearchFacesByImageCommand } from '@aws-sdk/client-rekognition';
import { getAdminSupabase, getEventBySlug, isGuestOpen, signPaths, BUCKET_PREVIEWS } from '@/lib/server/supabase-admin';
import { getCollectionId, getRekognitionClient, matchThreshold } from '@/lib/server/rekognition';
import { jsonError, rateLimit, randomToken, sha256 } from '@/lib/server/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_SELFIE_BYTES = 5 * 1024 * 1024;
const PREVIEW_URL_SECONDS = 60 * 60;

function sniffImage(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

/**
 * Guest face match. The selfie is processed in memory only — it is never
 * written to storage, the database, or logs.
 */
export async function POST(request) {
  try {
    const form = await request.formData().catch(() => null);
    if (!form) return jsonError('Please send a selfie image.', 400);
    const slug = String(form.get('event') || '').toLowerCase();
    const consent = String(form.get('consent') || '') === 'yes';
    const file = form.get('selfie');

    if (!consent) return jsonError('Please accept the privacy note before scanning.', 400, { code: 'CONSENT_REQUIRED' });
    if (!slug || !file || typeof file.arrayBuffer !== 'function') return jsonError('Event and selfie are required.', 400);
    if (Number(file.size || 0) > MAX_SELFIE_BYTES) return jsonError('That photo is too large. Please use one under 5 MB.', 413);

    const limit = Number(process.env.MATCH_RATE_LIMIT || 12);
    if (!(await rateLimit(request, 'match', limit, 600))) {
      return jsonError('Too many scans from this device. Please wait a few minutes and try again.', 429, { code: 'RATE_LIMITED' });
    }

    const event = await getEventBySlug(slug);
    if (!event) return jsonError('We could not find this wedding gallery.', 404, { code: 'EVENT_NOT_FOUND' });
    if (!isGuestOpen(event)) return jsonError('This gallery is not open for guests right now.', 403, { code: 'GALLERY_CLOSED' });

    const bytes = Buffer.from(await file.arrayBuffer());
    if (!sniffImage(bytes)) return jsonError('Please use a JPG or PNG photo.', 415, { code: 'BAD_IMAGE' });

    const supabase = getAdminSupabase();
    const indexIncomplete = Number(event.indexed_count || 0) < Number(event.photos_count || 0);
    if (indexIncomplete) after(() => refreshEventInBackground(event.id));

    let response;
    try {
      response = await getRekognitionClient().send(new SearchFacesByImageCommand({
        CollectionId: getCollectionId(event.id),
        Image: { Bytes: bytes },
        FaceMatchThreshold: matchThreshold(),
        MaxFaces: 2000,
        QualityFilter: 'AUTO',
      }));
    } catch (error) {
      const name = error?.name || '';
      if (name === 'ResourceNotFoundException') {
        return jsonError('The photographers are still preparing this gallery. Please check back soon.', 503, { code: 'INDEX_NOT_READY' });
      }
      if (name === 'InvalidParameterException') {
        return jsonError('We could not see a clear face. Try a well-lit, front-facing selfie without sunglasses.', 422, { code: 'NO_FACE' });
      }
      if (name === 'InvalidImageFormatException' || name === 'ImageTooLargeException') {
        return jsonError('Please use a JPG or PNG photo under 5 MB.', 415, { code: 'BAD_IMAGE' });
      }
      throw error;
    }

    // Low-confidence face detection in the selfie itself → ask for a better one.
    if (Number(response.SearchedFaceConfidence || 0) < 90) {
      return jsonError('Your selfie is a little unclear. Please retake it in good light, facing the camera.', 422, { code: 'NO_FACE' });
    }

    const best = new Map();
    for (const m of response.FaceMatches || []) {
      const id = m.Face?.ExternalImageId;
      const sim = Number(m.Similarity || 0);
      if (!id) continue;
      if (!best.has(id) || best.get(id) < sim) best.set(id, sim);
    }

    let photos = [];
    if (best.size) {
      // Defence in depth: only accept photo ids that belong to THIS event.
      const ids = [...best.keys()];
      for (let i = 0; i < ids.length; i += 300) {
        const { data, error } = await supabase
          .from('jw_photos')
          .select('id,preview_path,original_filename,created_at')
          .eq('event_id', event.id)
          .eq('processing_status', 'ready')
          .in('id', ids.slice(i, i + 300));
        if (error) throw error;
        photos.push(...(data || []));
      }
    }

    if (!photos.length) {
      return NextResponse.json({ ok: true, matches: [], indexIncomplete, token: null });
    }

    photos.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const previewUrls = await signPaths(supabase, BUCKET_PREVIEWS, photos.map((p) => p.preview_path), PREVIEW_URL_SECONDS);

    const minutes = Math.min(720, Math.max(10, Number(process.env.DOWNLOAD_SESSION_MINUTES || 120)));
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const { error: sessionError } = await supabase.from('jw_match_sessions').insert({
      token_hash: sha256(token),
      event_id: event.id,
      photo_ids: photos.map((p) => p.id),
      expires_at: expiresAt,
    });
    if (sessionError) throw sessionError;

    return NextResponse.json({
      ok: true,
      token,
      expiresAt,
      indexIncomplete,
      matches: photos.map((p) => ({
        id: p.id,
        name: p.original_filename,
        previewUrl: previewUrls.get(p.preview_path) || null,
        similarity: Math.round(best.get(p.id) * 10) / 10,
      })),
    });
  } catch (error) {
    console.error('face match failed:', error?.name, error?.message);
    if (error?.code === 'REKOGNITION_NOT_CONFIGURED') return jsonError('Face scanning is not configured yet.', 503, { code: 'NOT_CONFIGURED' });
    return jsonError('Something went wrong while finding your photos. Please try again.', 500);
  }
}
