import { getAdminSupabase, isGuestOpen } from '@/lib/server/supabase-admin';
import { jsonError, rateLimit, verifyDownloadTicket } from '@/lib/server/security';
import { openDriveFile } from '@/lib/server/google-drive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function contentDisposition(kind, name) {
  const ascii = String(name || 'photo.jpg').replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name || 'photo.jpg')}`;
}

/**
 * Streams one full-resolution original from a PRIVATE Google Drive folder.
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
    const { data: event } = await supabase.from('jw_events').select('id,status,guest_access').eq('id', session.event_id).maybeSingle();
    if (!isGuestOpen(event)) return jsonError('This gallery is not open for guests right now.', 403, { code: 'GALLERY_CLOSED' });
    const { data: photo } = await supabase.from('jw_photos')
      .select('id,drive_file_id,original_filename,content_type').eq('id', ticket.photoId).eq('event_id', session.event_id).maybeSingle();
    if (!photo?.drive_file_id) return jsonError('Photo not found.', 404);

    const upstream = await openDriveFile(photo.drive_file_id);
    const headers = new Headers({
      'Content-Type': upstream.headers.get('content-type') || photo.content_type || 'image/jpeg',
      'Content-Disposition': contentDisposition(request.nextUrl.searchParams.get('dl') ? 'attachment' : 'inline', photo.original_filename),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    const len = upstream.headers.get('content-length');
    if (len) headers.set('Content-Length', len);
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    console.error('drive file download failed:', error?.status, error?.message);
    return jsonError('Could not download this photo. Please try again.', 502);
  }
}
