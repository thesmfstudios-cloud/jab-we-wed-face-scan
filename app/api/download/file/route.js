import { getAdminSupabase, isGuestOpen, BUCKET_ORIGINALS } from '@/lib/server/supabase-admin';
import { FRAME_DOWNLOADS } from '@/lib/site-config';
import { framePhoto, framedName } from '@/lib/server/frame';
import { coupleNames, formatDate } from '@/lib/format';
import { jsonError, rateLimit, verifyDownloadTicket } from '@/lib/server/security';
import { openDriveFile } from '@/lib/server/google-drive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function contentDisposition(kind, name) {
  const ascii = String(name || 'photo.jpg').replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name || 'photo.jpg')}`;
}

/** Send a Buffer as a stream (streamed responses aren't capped at 4.5 MB on Vercel). */
function streamBuffer(buf) {
  const CHUNK = 256 * 1024;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= buf.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset + i, Math.min(CHUNK, buf.length - i)));
      i += CHUNK;
    },
  });
}

/**
 * Streams one full-resolution photo (Google Drive or private storage), framed
 * in the Jab We Wed frame when FRAME_DOWNLOADS is on.
 * Needs a ticket from /api/download (issued only after a face match); the
 * session must still be valid, contain this photo, and the gallery must be open.
 * Streamed, so Vercel's 4.5 MB response-body limit does not apply.
 */
export async function GET(request) {
  try {
    const ticket = verifyDownloadTicket(request.nextUrl.searchParams.get('t'));
    if (!ticket) return jsonError('This download link has expired. Please scan your face again.', 401, { code: 'SESSION_EXPIRED' });
    if (!(await rateLimit(request, 'file', 1500, 600))) return jsonError('Too many downloads. Please wait a minute.', 429);

    const supabase = getAdminSupabase();
    const { data: session } = await supabase.from('jw_match_sessions')
      .select('id,event_id,photo_ids,expires_at').eq('id', ticket.sessionId).maybeSingle();
    if (!session || new Date(session.expires_at).getTime() < Date.now() || !(session.photo_ids || []).includes(ticket.photoId)) {
      return jsonError('This download link has expired. Please scan your face again.', 401, { code: 'SESSION_EXPIRED' });
    }
    const { data: event } = await supabase.from('jw_events').select('id,status,guest_access,bride_name,groom_name,title,event_date').eq('id', session.event_id).maybeSingle();
    if (!isGuestOpen(event)) return jsonError('This gallery is not open for guests right now.', 403, { code: 'GALLERY_CLOSED' });
    const { data: photo } = await supabase.from('jw_photos')
      .select('id,drive_file_id,original_path,original_filename,content_type').eq('id', ticket.photoId).eq('event_id', session.event_id).maybeSingle();
    if (!photo) return jsonError('Photo not found.', 404);
    const kind = request.nextUrl.searchParams.get('dl') ? 'attachment' : 'inline';
    const baseHeaders = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };

    if (!FRAME_DOWNLOADS) {
      if (!photo.drive_file_id) return jsonError('Photo not found.', 404);
      const upstream = await openDriveFile(photo.drive_file_id);
      const headers = new Headers({ ...baseHeaders, 'Content-Type': upstream.headers.get('content-type') || photo.content_type || 'image/jpeg', 'Content-Disposition': contentDisposition(kind, photo.original_filename) });
      const len = upstream.headers.get('content-length');
      if (len) headers.set('Content-Length', len);
      return new Response(upstream.body, { status: 200, headers });
    }

    let original;
    if (photo.drive_file_id) {
      original = Buffer.from(await (await openDriveFile(photo.drive_file_id)).arrayBuffer());
    } else {
      const { data: file, error } = await supabase.storage.from(BUCKET_ORIGINALS).download(photo.original_path);
      if (error || !file) throw new Error(error?.message || 'Original missing.');
      original = Buffer.from(await file.arrayBuffer());
    }
    const framed = await framePhoto(original, { couple: coupleNames(event), date: formatDate(event.event_date) });
    return new Response(streamBuffer(framed), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Type': 'image/jpeg', 'Content-Length': String(framed.length), 'Content-Disposition': contentDisposition(kind, framedName(photo.original_filename)) },
    });
  } catch (error) {
    console.error('drive file download failed:', error?.status, error?.message);
    return jsonError('Could not download this photo. Please try again.', 502);
  }
}
