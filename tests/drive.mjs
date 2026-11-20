// Google Drive import test: real Next.js production server + mock Supabase /
// Rekognition / Google Drive API. Exercises the API routes directly.
//   node tests/drive.mjs            (builds first)
//   SKIP_BUILD=1 node tests/drive.mjs
//   DRIVE_MODE=public SKIP_BUILD=1 node tests/drive.mjs   (API-key / public-link mode)
const PRIVATE = process.env.DRIVE_MODE !== 'public';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createMockBackend } from './mock-backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 54331;
const APP_PORT = 3311;
const APP = `http://127.0.0.1:${APP_PORT}`;
const ADMIN_CODE = 'drive-test-admin-code-123';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

const mock = createMockBackend();
await new Promise((r) => mock.server.listen(MOCK_PORT, '127.0.0.1', r));

// Drive fixture: folder with 3 photos at top level + 1 in a sub-folder + a non-image.
const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg({ quality: 95 }).toBuffer();
const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#c08060' } }).png().toBuffer();
const FOLDER = '1NiMBS20pOexZbjvLZwp26B0Mpo34eU4r';
const SUB = 'subFolder_abcdefghij';
mock.drive.folders[FOLDER] = {
  name: 'Anukool & Anjali QR',
  children: [
    { id: 'fileA_0123456789', name: 'IMG_0001.jpg', mimeType: 'image/jpeg', size: String(big.length) },
    { id: 'fileB_0123456789', name: 'IMG_0002.jpg', mimeType: 'image/jpeg', size: String(big.length) },
    { id: 'fileC_0123456789', name: 'couple.png', mimeType: 'image/png', size: String(small.length) },
    { id: 'notes_0123456789', name: 'notes.txt', mimeType: 'text/plain', size: '12' },
    { id: SUB, name: 'Haldi', mimeType: 'application/vnd.google-apps.folder' },
  ],
};
mock.drive.folders[SUB] = { name: 'Haldi', children: [{ id: 'fileD_0123456789', name: 'HALDI_01.jpg', mimeType: 'image/jpeg', size: String(big.length) }] };
Object.assign(mock.drive.files, { fileA_0123456789: big, fileB_0123456789: big, fileC_0123456789: small, fileD_0123456789: big });

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
mock.drive.saPublicKey = publicKey;
const SA_EMAIL = 'jab-we-wed-drive@jab-we-wed.iam.gserviceaccount.com';
// Exactly like a downloaded key file: JSON with "\n" escapes inside private_key.
const saJson = JSON.stringify({ type: 'service_account', client_email: SA_EMAIL, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' }, null, 2);

const env = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_PUBLIC_SITE_URL: APP,
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
  SUPABASE_SERVICE_ROLE_KEY: mock.serviceKey,
  ADMIN_ACCESS_CODE: ADMIN_CODE,
  ADMIN_SESSION_SECRET: 'drive-test-session-secret-0123456789abcdef',
  AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'secret', AWS_REGION: 'ap-south-1',
  AWS_REKOGNITION_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}`,
  AWS_REKOGNITION_COLLECTION_PREFIX: 'jab-we-wed',
  ...(PRIVATE ? { GOOGLE_SERVICE_ACCOUNT_JSON: saJson } : { GOOGLE_DRIVE_API_KEY: mock.drive.key }),
  GOOGLE_DRIVE_API_BASE: `http://127.0.0.1:${MOCK_PORT}/drive/v3`,
  GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/oauth/token`,
};

const run = (args) => new Promise((resolve, reject) => {
  const p = spawn('npx', args, { cwd: ROOT, env, stdio: 'inherit' });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${c}`))));
});
if (!process.env.SKIP_BUILD) await run(['next', 'build']);
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let serverLog = '';
app.stdout.on('data', (d) => { serverLog += d; });
app.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 60; i++) { try { await fetch(APP); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

let cookie = '';
const api = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(`${APP}${p}`, {
    method,
    headers: { Origin: APP, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

try {
  const login = await api('/api/admin/session', { method: 'POST', body: { code: ADMIN_CODE } });
  check('Admin login', login.status === 200 && cookie);
  const created = await api('/api/admin/events', { method: 'POST', body: { brideName: 'Anjali', groomName: 'Anukool', slug: '01-anjali-anukool' } });
  const eventId = created.data.event?.id;
  check('Wedding created', Boolean(eventId), JSON.stringify(created.data).slice(0, 120));

  const bad = await api(`/api/admin/events/${eventId}/drive`, { method: 'POST', body: { folder: 'https://drive.google.com/drive/folders/doesNotExist_123' } });
  check('Unknown folder gives a clear error', bad.status === 400 && /not found|share the folder/i.test(bad.data.error || ''), bad.data.error);

  const info = await api(`/api/admin/events/${eventId}/drive`);
  check(`Drive mode reported (${PRIVATE ? 'private' : 'public'})`, info.data.mode === (PRIVATE ? 'private' : 'public') && (!PRIVATE || info.data.shareEmail === SA_EMAIL), JSON.stringify(info.data));
  if (PRIVATE) {
    const notShared = await api(`/api/admin/events/${eventId}/drive`, { method: 'POST', body: { folder: FOLDER } });
    check('Folder not shared with service account → asks to share with its email', notShared.status === 400 && (notShared.data.error || '').includes(SA_EMAIL), notShared.data.error);
    mock.drive.sharedWithSa.add(FOLDER);
  }

  const sync = await api(`/api/admin/events/${eventId}/drive`, { method: 'POST', body: { folder: `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing` } });
  check('Drive folder synced (4 photos incl. sub-folder, text file ignored)', sync.status === 200 && sync.data.found === 4 && sync.data.added === 4, JSON.stringify({ ...sync.data, event: undefined }));
  check('Folder id saved on wedding', mock.db.jw_events[0].drive_folder_id === FOLDER && sync.data.event.drive_folder_id === FOLDER);
  check('Photos count includes pending Drive photos', sync.data.event.photos_count === 4 && sync.data.event.indexed_count === 0);
  check('Originals NOT copied into storage', ![...mock.storage.keys()].some((k) => k.startsWith('jw-originals/')));

  const again = await api(`/api/admin/events/${eventId}/drive`, { method: 'POST', body: {} });
  check('Re-sync adds nothing new', again.status === 200 && again.data.added === 0 && again.data.alreadySynced === 4);
  mock.drive.folders[FOLDER].children.push({ id: 'fileE_0123456789', name: 'IMG_0003.jpg', mimeType: 'image/jpeg', size: String(big.length) });
  mock.drive.files.fileE_0123456789 = big;
  const more = await api(`/api/admin/events/${eventId}/drive`, { method: 'POST', body: {} });
  check('Re-sync picks up a newly added photo only', more.data.added === 1 && mock.db.jw_photos.length === 5);

  let loops = 0, last;
  do { last = await api(`/api/admin/events/${eventId}/index`, { method: 'POST', body: {} }); loops++; } while (last.status === 200 && !last.data.done && loops < 10);
  check('Face index built from Drive photos', last.status === 200 && last.data.done && last.data.event.indexed_count === 5, `loops=${loops} ${last.data.error || ''}`);
  check('Drive photos processed max 4 per call', loops >= 2);
  const previews = [...mock.storage.entries()].filter(([k]) => k.startsWith('jw-previews/'));
  const metas = await Promise.all(previews.map(([, b]) => sharp(b).metadata()));
  check('Small JPEG previews saved (≤1600px, ≤900KB)', previews.length === 5 && metas.every((m) => m.format === 'jpeg' && Math.max(m.width, m.height) <= 1600) && previews.every(([, b]) => b.length <= 900 * 1024),
    previews.map(([, b]) => `${Math.round(b.length / 1024)}KB`).join(','));
  check('All photos marked ready', mock.db.jw_photos.every((p) => p.processing_status === 'ready' && p.indexed_at));

  const lib = await api(`/api/admin/events/${eventId}/photos`);
  check('Admin library lists Drive photos with previews', lib.data.total === 5 && lib.data.photos.every((p) => p.preview_url));

  await api(`/api/admin/events/${eventId}`, { method: 'PATCH', body: { status: 'live' } });
  await api(`/api/admin/events/${eventId}`, { method: 'PATCH', body: { guestAccess: true } });

  const form = new FormData();
  form.set('event', '01-anjali-anukool');
  form.set('consent', 'yes');
  form.set('selfie', new Blob([await sharp({ create: { width: 600, height: 800, channels: 3, background: '#d0a080' } }).jpeg().toBuffer()], { type: 'image/jpeg' }), 'selfie.jpg');
  const match = await api('/api/match', { method: 'POST', body: form });
  check('Guest selfie matches Drive photos', match.status === 200 && match.data.matches?.length === 5 && match.data.matches.every((m) => m.previewUrl), match.data.error);

  const dl = await api('/api/download', { method: 'POST', body: { photoIds: match.data.matches.map((m) => m.id) }, headers: { Authorization: `Bearer ${match.data.token}` } });
  const files = dl.data.files || [];
  const fA = files.find((f) => f.name === 'IMG_0001.jpg');
  if (PRIVATE) {
    check('Download returns private app links (no Drive URL, no key)', dl.status === 200 && files.length === 5 && files.every((f) => f.url.startsWith('/api/download/file?t=') && f.fetchUrl.startsWith('/api/download/file?t=')) && !JSON.stringify(files).includes('google'));
    const r = await fetch(`${APP}${fA.url}`);
    const got = Buffer.from(await r.arrayBuffer());
    check('Streams the full-resolution original from private Drive', r.status === 200 && got.equals(big), `${r.status} ${got.length} vs ${big.length}`);
    check('Download sends attachment filename', /attachment; filename="IMG_0001.jpg"/.test(r.headers.get('content-disposition') || ''));
    const zipFetch = await fetch(`${APP}${fA.fetchUrl}`);
    check('ZIP fetch URL works (same origin)', zipFetch.status === 200 && Buffer.from(await zipFetch.arrayBuffer()).equals(big));
    const t = new URL(fA.url, APP).searchParams.get('t');
    const otherPhoto = mock.db.jw_photos.find((p) => p.original_filename === 'IMG_0002.jpg').id;
    const forged = t.replace(/^([^.]+)\.([^.]+)/, (_, s1) => `${s1}.${otherPhoto}`);
    check('Tampered ticket rejected', (await fetch(`${APP}/api/download/file?t=${encodeURIComponent(forged)}`)).status === 401);
    check('Missing ticket rejected', (await fetch(`${APP}/api/download/file`)).status === 401);
    await api(`/api/admin/events/${eventId}`, { method: 'PATCH', body: { guestAccess: false } });
    check('Closing the gallery blocks existing links', (await fetch(`${APP}${fA.url}`)).status === 401);
  } else {
    check('Download returns Drive links', dl.status === 200 && files.length === 5 && files.every((f) => f.url.startsWith('https://drive.usercontent.google.com/download?id=') && f.fetchUrl));
    const got = Buffer.from(await (await fetch(fA.fetchUrl)).arrayBuffer());
    check('ZIP fetch URL returns the full-resolution original', got.equals(big), `${got.length} vs ${big.length}`);
  }

  const del = await api(`/api/admin/events/${eventId}/photos`, { method: 'DELETE', body: { photoIds: [mock.db.jw_photos[0].id] } });
  check('Deleting a Drive photo works (Drive file untouched)', del.status === 200 && del.data.deleted === 1 && mock.drive.files.fileA_0123456789);
} catch (e) {
  check(`Unexpected error: ${e.message}`, false);
} finally {
  try { process.kill(-app.pid); } catch { /* ignore */ }
  mock.server.close();
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log(serverLog.split('\n').filter((l) => /error|fail/i.test(l)).slice(-20).join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
