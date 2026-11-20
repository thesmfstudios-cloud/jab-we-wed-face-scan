import { NextResponse } from 'next/server';
import { jsonError, requireAdmin } from '@/lib/server/security';
import { loadAdminEvent } from '@/lib/server/admin-events';
import { driveMode, driveShareEmail, friendlyDriveError, parseDriveFolderId } from '@/lib/server/google-drive';
import { syncDriveFolder } from '@/lib/server/drive-sync';

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

    let result;
    try {
      result = await syncDriveFolder(event, folderId);
    } catch (e) {
      if (e?.status || e?.code === 'DRIVE_NOT_CONFIGURED' || e?.code === 'DRIVE_AUTH_FAILED') return jsonError(friendlyDriveError(e), e?.code === 'DRIVE_NOT_CONFIGURED' || e?.code === 'DRIVE_AUTH_FAILED' ? 503 : 400);
      throw e;
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('drive sync failed:', error?.message);
    return jsonError(error?.message || 'Could not sync the Drive folder.', 500);
  }
}
