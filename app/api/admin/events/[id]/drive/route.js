import { NextResponse } from 'next/server';
import { getAdminSupabase } from '@/lib/server/supabase-admin';
import { jsonError, requireAdmin } from '@/lib/server/security';
import { loadAdminEvent } from '@/lib/server/admin-events';
import { driveMode, driveShareEmail, friendlyDriveError, getDriveFolder, listDriveImages, parseDriveFolderId } from '@/lib/server/google-drive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** How Drive is connected, and which email folders must be shared with. */
export async function GET(request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ mode: driveMode(), shareEmail: driveShareEmail() });
  } catch (e) {
    return NextResponse.json({ mode: null, shareEmail: null, error: e.message });
  }
}

/**
 * Connect a Google Drive folder to a wedding and sync its photo list.
 * Body: { folder: "<link or id>" } — omit to re-sync the saved folder.
 * New photos are added as "pending"; the face-index step then fetches each
 * one from Drive, saves a small preview and indexes the faces. Originals stay
 * in Drive. Photos already synced are skipped, so re-syncing is safe.
 */
export async function POST(request, { params }) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const event = await loadAdminEvent(id);
    if (!event) return jsonError('Wedding not found.', 404);
    const body = await request.json().catch(() => ({}));
    const folderId = body.folder ? parseDriveFolderId(body.folder) : event.drive_folder_id;
    if (!folderId) return jsonError('Paste a Google Drive folder link.', 400);

    let folder, images;
    try {
      folder = await getDriveFolder(folderId);
      images = await listDriveImages(folderId);
    } catch (e) {
      return jsonError(friendlyDriveError(e), e?.code === 'DRIVE_NOT_CONFIGURED' || e?.code === 'DRIVE_AUTH_FAILED' ? 503 : 400);
    }

    const supabase = getAdminSupabase();
    const existing = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('jw_photos').select('drive_file_id')
        .eq('event_id', event.id).not('drive_file_id', 'is', null).range(from, from + 999);
      if (error) throw error;
      (data || []).forEach((r) => existing.add(r.drive_file_id));
      if (!data || data.length < 1000) break;
    }

    const fresh = images.filter((f) => !existing.has(f.id));
    let added = 0;
    for (let i = 0; i < fresh.length; i += 500) {
      const rows = fresh.slice(i, i + 500).map((f) => ({
        event_id: event.id,
        drive_file_id: f.id,
        original_path: `drive/${event.id}/${f.id}`,
        preview_path: `${event.id}/drive-${f.id}-preview.jpg`,
        original_filename: String(f.name || 'photo.jpg').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 160),
        content_type: String(f.mimeType || 'image/jpeg').slice(0, 40),
        bytes: f.size,
        processing_status: 'pending',
      }));
      const { data, error } = await supabase.from('jw_photos').insert(rows).select('id');
      if (error) throw error;
      added += data?.length || 0;
    }

    const now = new Date().toISOString();
    const { error: upErr } = await supabase.from('jw_events')
      .update({ drive_folder_id: folderId, drive_synced_at: now, updated_at: now }).eq('id', event.id);
    if (upErr) throw upErr;
    await supabase.rpc('jw_refresh_event_counts', { p_event_id: event.id });

    return NextResponse.json({
      ok: true,
      folder: { id: folderId, name: folder.name },
      found: images.length,
      added,
      alreadySynced: images.length - fresh.length,
      event: await loadAdminEvent(event.id),
    });
  } catch (error) {
    console.error('drive sync failed:', error?.message);
    return jsonError(error?.message || 'Could not sync the Drive folder.', 500);
  }
}
