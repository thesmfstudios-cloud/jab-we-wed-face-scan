import 'server-only';
import { getAdminSupabase } from './supabase-admin';
import { loadAdminEvent } from './admin-events';
import { getDriveFolder, listDriveImages } from './google-drive';

/**
 * Read a wedding's Drive folder and add photos not seen before as "pending"
 * (the indexer then fetches, previews and indexes them). Safe to re-run.
 */
export async function syncDriveFolder(event, folderId) {
  const folder = await getDriveFolder(folderId);
  const images = await listDriveImages(folderId);
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

  return { folder: { id: folderId, name: folder.name }, found: images.length, added, alreadySynced: images.length - fresh.length, event: await loadAdminEvent(event.id) };
}
