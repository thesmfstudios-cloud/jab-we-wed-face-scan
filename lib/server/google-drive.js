import 'server-only';

/**
 * Google Drive (read-only, API key). Works with folders and photos shared as
 * "Anyone with the link can view". No Google login is stored in the app.
 */

const API = process.env.GOOGLE_DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';
const IMAGE_RE = /\.(jpe?g|png)$/i;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/jpg']);
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_FILES = 10000;
const MAX_DEPTH = 4;

export function driveApiKey() {
  const key = process.env.GOOGLE_DRIVE_API_KEY;
  if (!key) {
    throw Object.assign(new Error('Google Drive is not configured. Add GOOGLE_DRIVE_API_KEY in Vercel.'), { code: 'DRIVE_NOT_CONFIGURED' });
  }
  return key;
}

const ID_RE = /^[a-zA-Z0-9_-]{10,200}$/;

/** Accepts a folder link (…/folders/<id>?usp=…, ?id=<id>) or a bare id. */
export function parseDriveFolderId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : s;
  return ID_RE.test(id) ? id : null;
}

async function driveGet(path, params) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  url.searchParams.set('key', driveApiKey());
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    let reason = '';
    try { const j = await res.json(); reason = j?.error?.message || ''; } catch { /* ignore */ }
    const err = new Error(reason || `Google Drive request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function getDriveFolder(folderId) {
  const res = await driveGet(`/files/${folderId}`, { fields: 'id,name,mimeType', supportsAllDrives: 'true' });
  const f = await res.json();
  if (f.mimeType !== FOLDER_MIME) throw Object.assign(new Error('That link is a file, not a folder.'), { status: 400 });
  return f;
}

async function listChildren(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const params = {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,createdTime)',
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await driveGet('/files', params);
    const body = await res.json();
    out.push(...(body.files || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken && out.length < MAX_FILES);
  return out;
}

/** All JPG/PNG photos in the folder and its sub-folders. */
export async function listDriveImages(folderId) {
  const images = [];
  const queue = [{ id: folderId, depth: 0, prefix: '' }];
  while (queue.length && images.length < MAX_FILES) {
    const { id, depth, prefix } = queue.shift();
    for (const f of await listChildren(id)) {
      if (f.mimeType === FOLDER_MIME) {
        if (depth < MAX_DEPTH) queue.push({ id: f.id, depth: depth + 1, prefix: `${prefix}${f.name}/` });
      } else if (IMAGE_MIME.has(f.mimeType) || IMAGE_RE.test(f.name || '')) {
        images.push({ id: f.id, name: f.name, path: `${prefix}${f.name}`, mimeType: f.mimeType, size: Number(f.size) || null });
      }
    }
  }
  return images.slice(0, MAX_FILES);
}

/** Download a photo's full bytes (server side). */
export async function downloadDriveFile(fileId) {
  if (!ID_RE.test(String(fileId || ''))) throw new Error('Invalid Drive file id.');
  const res = await driveGet(`/files/${fileId}`, { alt: 'media', supportsAllDrives: 'true' });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Guest download links for a Drive original.
 * - url: browser download (sends an attachment header, no CORS needed)
 * - fetchUrl: CORS-enabled Drive API media URL, used when the browser packs
 *   several photos into a ZIP or shares a photo.
 */
export function driveGuestUrls(fileId) {
  const id = encodeURIComponent(fileId);
  return {
    url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    fetchUrl: `${API}/files/${id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(driveApiKey())}`,
  };
}

export function friendlyDriveError(error) {
  const s = error?.status;
  if (error?.code === 'DRIVE_NOT_CONFIGURED') return error.message;
  if (s === 404) return 'Drive folder not found. Check the link, and share the folder as “Anyone with the link can view”.';
  if (s === 403) return 'Google Drive refused access. Share the folder as “Anyone with the link can view”, and check the API key has Google Drive API enabled.';
  if (s === 400 && /API key/i.test(error?.message || '')) return 'The Google Drive API key is not valid. Check GOOGLE_DRIVE_API_KEY in Vercel.';
  return error?.message || 'Google Drive request failed.';
}
