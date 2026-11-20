import 'server-only';
import crypto from 'node:crypto';

/**
 * Google Drive, read-only. Three ways to connect:
 *
 * 0. LINK (no setup): nothing configured. The folder is shared as "Anyone with
 *    the link"; the app reads Drive's public folder view and public download
 *    links. Guests still download through this app after a face match.
 *
 * 1. PRIVATE (recommended): GOOGLE_SERVICE_ACCOUNT_JSON — a Google service
 *    account. Each wedding folder is shared with the service account's email
 *    (like sharing with a person, Viewer). Folders stay private; guests get
 *    their originals through this app after a face match.
 * 2. Public link: GOOGLE_DRIVE_API_KEY — folders shared as "Anyone with the
 *    link can view"; guests download straight from Drive.
 */

const API = process.env.GOOGLE_DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const IMAGE_RE = /\.(jpe?g|png)$/i;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/jpg']);
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_FILES = 10000;
const MAX_DEPTH = 4;
const ID_RE = /^[a-zA-Z0-9_-]{10,200}$/;
const WEB = process.env.GOOGLE_DRIVE_WEB_BASE || 'https://drive.google.com';
const DL = process.env.GOOGLE_DRIVE_DOWNLOAD_BASE || 'https://drive.usercontent.google.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

let serviceAccount;
function getServiceAccount() {
  if (serviceAccount !== undefined) return serviceAccount;
  serviceAccount = null;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw.trim() : Buffer.from(raw.trim(), 'base64').toString('utf8');
    const j = JSON.parse(text);
    if (!j.client_email || !j.private_key) throw new Error('missing client_email/private_key');
    serviceAccount = { email: j.client_email, key: String(j.private_key).replace(/\\n/g, '\n') };
  } catch (e) {
    throw Object.assign(new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not a valid service-account key file (${e.message}).`), { code: 'DRIVE_NOT_CONFIGURED' });
  }
  return serviceAccount;
}

/** 'private' (service account) | 'public' (API key) | 'link' (no setup) */
export function driveMode() {
  if (getServiceAccount()) return 'private';
  if (process.env.GOOGLE_DRIVE_API_KEY) return 'public';
  return 'link';
}

/** Email that wedding folders must be shared with (private mode). */
export function driveShareEmail() {
  return getServiceAccount()?.email || null;
}

let cachedToken = null; // { token, exp }
async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const sa = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.key, 'base64url');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    cache: 'no-store',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw Object.assign(new Error(`Google login for the service account failed: ${body.error_description || body.error || res.status}`), { code: 'DRIVE_AUTH_FAILED' });
  }
  cachedToken = { token: body.access_token, exp: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function driveFetch(path, params) {
  const mode = driveMode();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const headers = {};
  if (mode === 'private') headers.Authorization = `Bearer ${await accessToken()}`;
  else url.searchParams.set('key', process.env.GOOGLE_DRIVE_API_KEY);
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (!res.ok) {
    let reason = '';
    try { const j = await res.json(); reason = j?.error?.message || ''; } catch { /* ignore */ }
    const err = new Error(reason || `Google Drive request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/* ── Link mode (no credentials): Drive's public folder view ── */
const decodeHtml = (t) => String(t || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .trim();

async function publicFolderView(folderId) {
  const res = await fetch(`${WEB}/embeddedfolderview?id=${encodeURIComponent(folderId)}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en' }, cache: 'no-store', redirect: 'follow',
  });
  const html = res.ok ? await res.text() : '';
  // Not shared publicly → Google answers with an error or a sign-in page.
  if (!res.ok || !/flip-entry|flip-entries|class="folder-view/i.test(html) || /accounts\.google\.com\/(ServiceLogin|v3\/signin)/i.test(res.url)) {
    throw Object.assign(new Error('Drive folder not found or not shared publicly.'), { status: 404 });
  }
  const name = decodeHtml((html.match(/<title>([^<]*)<\/title>/i) || [])[1]).replace(/\s*[-–]\s*Google Drive\s*$/i, '') || 'Drive folder';
  const entries = [];
  for (const chunk of html.split(/<div class="flip-entry"/).slice(1)) {
    const id = (chunk.match(/id="entry-([a-zA-Z0-9_-]+)"/) || [])[1];
    const href = decodeHtml((chunk.match(/<a [^>]*href="([^"]+)"/) || [])[1]);
    const title = decodeHtml((chunk.match(/class="flip-entry-title"[^>]*>([^<]*)</) || [])[1]);
    if (!id) continue;
    entries.push({ id, name: title, isFolder: /\/folders\//.test(href) });
  }
  return { name, entries };
}

/** Accepts a folder link (…/folders/<id>?usp=…, ?id=<id>) or a bare id. */
export function parseDriveFolderId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : s;
  return ID_RE.test(id) ? id : null;
}

export async function getDriveFolder(folderId) {
  if (driveMode() === 'link') return { id: folderId, name: (await publicFolderView(folderId)).name };
  const res = await driveFetch(`/files/${folderId}`, { fields: 'id,name,mimeType', supportsAllDrives: 'true' });
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
    const body = await (await driveFetch('/files', params)).json();
    out.push(...(body.files || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken && out.length < MAX_FILES);
  return out;
}

/** All JPG/PNG photos in the folder and its sub-folders. */
export async function listDriveImages(folderId) {
  const images = [];
  if (driveMode() === 'link') {
    const queue = [{ id: folderId, depth: 0, prefix: '' }];
    const seen = new Set();
    while (queue.length && images.length < MAX_FILES) {
      const { id, depth, prefix } = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of (await publicFolderView(id)).entries) {
        if (e.isFolder) { if (depth < MAX_DEPTH) queue.push({ id: e.id, depth: depth + 1, prefix: `${prefix}${e.name}/` }); }
        else if (IMAGE_RE.test(e.name || '')) {
          images.push({ id: e.id, name: e.name, path: `${prefix}${e.name}`, mimeType: /\.png$/i.test(e.name) ? 'image/png' : 'image/jpeg', size: null });
        }
      }
    }
    return images.slice(0, MAX_FILES);
  }
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

/** Open a Drive file's bytes as a streaming fetch Response (server side). */
export async function openDriveFile(fileId) {
  if (!ID_RE.test(String(fileId || ''))) throw new Error('Invalid Drive file id.');
  if (driveMode() === 'link') {
    const res = await fetch(`${DL}/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`, {
      headers: { 'User-Agent': BROWSER_UA }, cache: 'no-store', redirect: 'follow',
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || /text\/html/i.test(type)) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw Object.assign(new Error('Could not download this photo from Drive. Is the folder shared as “Anyone with the link”?'), { status: res.ok ? 403 : res.status });
    }
    return res;
  }
  return driveFetch(`/files/${fileId}`, { alt: 'media', supportsAllDrives: 'true' });
}

export async function downloadDriveFile(fileId) {
  return Buffer.from(await (await openDriveFile(fileId)).arrayBuffer());
}

export function friendlyDriveError(error) {
  const s = error?.status;
  if (error?.code === 'DRIVE_NOT_CONFIGURED' || error?.code === 'DRIVE_AUTH_FAILED') return error.message;
  const email = driveShareEmail();
  if (s === 404 || s === 403) {
    return email
      ? `Can't open this folder. In Google Drive, share the folder with ${email} (Viewer), then try again.`
      : 'Drive folder not found or not shared. In Drive: Share → General access → “Anyone with the link” (Viewer), then try again.';
  }
  if (s === 400 && /API key/i.test(error?.message || '')) return 'The Google Drive API key is not valid. Check GOOGLE_DRIVE_API_KEY in Vercel.';
  return error?.message || 'Google Drive request failed.';
}
