import { NextResponse } from 'next/server';
import { getAdminSupabase, isGuestOpen, BUCKET_ORIGINALS } from '@/lib/server/supabase-admin';
import { createDownloadTicket, jsonError, rateLimit, sha256, UUID_RE } from '@/lib/server/security';
import { driveMode, drivePublicUrls } from '@/lib/server/google-drive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PER_REQUEST = 200;
const SIGNED_SECONDS = 5 * 60;
const DRIVE_TICKET_SECONDS = 30 * 60; // ZIPs fetch photos one after another

function downloadName(name, fallback) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim();
  return clean || fallback;
}

/**
 * Issue short-lived signed URLs for FULL-RESOLUTION originals.
 * Authorization: the bearer token from a server-verified face match. Only
 * photo ids recorded in that session can be requested — editing ids or the
 * event in the browser cannot reach any other photo.
 */
export async function POST(request) {
  try {
    if (!(await rateLimit(request, 'download', 120, 600))) {
      return jsonError('Too many download requests. Please wait a minute.', 429);
    }
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || token.length < 32) return jsonError('Your download session has expired. Please scan your face again.', 401, { code: 'SESSION_EXPIRED' });

    const body = await request.json().catch(() => ({}));
    const requested = Array.isArray(body.photoIds) ? [...new Set(body.photoIds.map(String))] : [];
    if (!requested.length) return jsonError('No photos selected.', 400);
    if (requested.length > MAX_PER_REQUEST) return jsonError(`Please download at most ${MAX_PER_REQUEST} photos at a time.`, 400);
    if (!requested.every((id) => UUID_RE.test(id))) return jsonError('Invalid photo selection.', 400);

    const supabase = getAdminSupabase();
    const { data: session, error: sessionError } = await supabase
      .from('jw_match_sessions')
      .select('id,event_id,photo_ids,expires_at')
      .eq('token_hash', sha256(token))
      .maybeSingle();
    if (sessionError) throw sessionError;
    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      return jsonError('Your download session has expired. Please scan your face again.', 401, { code: 'SESSION_EXPIRED' });
    }

    const allowed = new Set(session.photo_ids || []);
    if (!requested.every((id) => allowed.has(id))) {
      return jsonError('Some of these photos are not part of your matches.', 403, { code: 'NOT_YOUR_PHOTO' });
    }

    const { data: event } = await supabase.from('jw_events').select('id,status,guest_access').eq('id', session.event_id).maybeSingle();
    if (!isGuestOpen(event)) return jsonError('This gallery is not open for guests right now.', 403, { code: 'GALLERY_CLOSED' });

    const { data: photos, error: photoError } = await supabase
      .from('jw_photos')
      .select('id,original_path,original_filename,bytes,drive_file_id')
      .eq('event_id', session.event_id)
      .in('id', requested);
    if (photoError) throw photoError;

    const byId = new Map((photos || []).map((p) => [p.id, p]));
    const files = [];
    const privateDrive = (photos || []).some((p) => p.drive_file_id) && driveMode() === 'private';
    for (let i = 0; i < requested.length; i += 20) {
      const chunk = requested.slice(i, i + 20).map((id) => byId.get(id)).filter(Boolean);
      const signed = await Promise.all(chunk.map(async (p, j) => {
        const name = downloadName(p.original_filename, `wedding-photo-${i + j + 1}.jpg`);
        // Google Drive originals are downloaded straight from Drive.
        if (p.drive_file_id) {
          if (privateDrive) {
            // Private Drive: this app streams the original after checking the ticket.
            const t = encodeURIComponent(createDownloadTicket(session.id, p.id, DRIVE_TICKET_SECONDS));
            return { id: p.id, name, bytes: p.bytes || null, url: `/api/download/file?t=${t}&dl=1`, fetchUrl: `/api/download/file?t=${t}` };
          }
          return { id: p.id, name, bytes: p.bytes || null, ...drivePublicUrls(p.drive_file_id) };
        }
        const { data, error } = await supabase.storage.from(BUCKET_ORIGINALS).createSignedUrl(p.original_path, SIGNED_SECONDS, { download: name });
        if (error) throw error;
        return { id: p.id, name, bytes: p.bytes || null, url: data.signedUrl };
      }));
      files.push(...signed);
    }

    return NextResponse.json({ ok: true, expiresInSeconds: SIGNED_SECONDS, files });
  } catch (error) {
    console.error('download authorization failed:', error?.message);
    return jsonError('Could not prepare your download. Please try again.', 500);
  }
}
