// End-to-end test: real Next.js production server + mock Supabase/Rekognition.
// Usage: npm run build && node tests/e2e.mjs
// Requires Playwright (PLAYWRIGHT_PATH) and Chrome (CHROME_PATH).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { createMockBackend } from './mock-backend.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'tests/.artifacts');
fs.mkdirSync(OUT, { recursive: true });
const FIX = path.join(ROOT, 'tests/fixtures');
const MOCK_PORT = 54331, APP_PORT = 3111;
const APP = `http://localhost:${APP_PORT}`;
const ADMIN_CODE = 'test-admin-code-123456';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = createMockBackend();
await new Promise((r) => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
const control = (c) => fetch(`http://127.0.0.1:${MOCK_PORT}/__control`, { method: 'POST', body: JSON.stringify(c) });

const env = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: String(APP_PORT),
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
  SUPABASE_SERVICE_ROLE_KEY: mock.serviceKey,
  ADMIN_ACCESS_CODE: ADMIN_CODE,
  ADMIN_SESSION_SECRET: 'test-session-secret-abcdefghijklmnopqrstuvwxyz',
  AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'secret', AWS_REGION: 'ap-south-1',
  AWS_REKOGNITION_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}`,
  AWS_REKOGNITION_COLLECTION_PREFIX: 'jab-we-wed',
  MATCH_RATE_LIMIT: '30',
  HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '*',
};
if (!process.env.SKIP_BUILD) {
  // NEXT_PUBLIC_* values are inlined at build time, so build with the test env.
  const b = spawn('npx', ['next', 'build'], { cwd: ROOT, env: { ...env, NODE_ENV: 'production' }, stdio: 'inherit' });
  if (await new Promise((r) => b.on('exit', r))) throw new Error('build failed');
}
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let appLog = '';
app.stdout.on('data', (d) => { appLog += d; });
app.stderr.on('data', (d) => { appLog += d; });
for (let i = 0; i < 60; i++) { try { await fetch(APP); break; } catch { await sleep(500); } }

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-proxy-server'],
});

try {
  /* ───────── 1. Public pages ───────── */
  const desk = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await desk.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) consoleErrors.push(m.text()); });
  await page.goto(APP);
  check('Landing page renders brand + headline', (await page.textContent('h1')).toUpperCase().includes('FIND YOUR'));
  await page.screenshot({ path: `${OUT}/01-landing-desktop.png`, fullPage: true });
  check('Landing has no payment wording', !/(₹|razorpay|upi|price|checkout|pay now)/i.test(await page.textContent('body')));

  /* ───────── 2. Admin: login, create, upload, index, publish ───────── */
  await page.goto(`${APP}/admin`);
  await page.fill('#code', 'wrong-code');
  await page.click('button:has-text("Sign in")');
  check('Admin rejects wrong code', await page.waitForSelector('text=Incorrect access code', { timeout: 5000 }).then(() => true).catch(() => false));
  await page.fill('#code', ADMIN_CODE);
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('text=New wedding');
  check('Admin login works', true);
  await page.click('text=New wedding');
  await page.fill('#b', 'Anjali');
  await page.fill('#g', 'Anukool');
  await page.fill('#d', '2026-12-12');
  await page.fill('#v', 'Bhopal');
  check('Gallery link auto-generated', (await page.inputValue('#s')) === 'anjali-anukool');
  await page.click('text=Create wedding');
  await page.waitForURL(/\/admin\/events\//);
  const eventId = page.url().split('/').pop();
  check('Wedding created as draft', mock.db.jw_events[0]?.status === 'draft' && mock.db.jw_events[0]?.guest_access === false);
  await page.screenshot({ path: `${OUT}/02-admin-overview.png`, fullPage: true });

  // guest page should 404 while draft
  const draftRes = await fetch(`${APP}/w/anjali-anukool`);
  check('Draft gallery hidden from guests (404)', draftRes.status === 404, `status ${draftRes.status}`);

  await page.click('role=tab[name="Upload"]');
  const photos = fs.readdirSync(FIX).filter((f) => f.startsWith('photo-')).sort().slice(0, 6).map((f) => path.join(FIX, f));
  await page.setInputFiles('input[type=file]', photos);
  await page.click('button:has-text("Upload 6 photos")');
  await page.waitForSelector('text=/Done\\. 6 uploaded/', { timeout: 30000 });
  check('Admin uploaded 6 originals + previews', mock.db.jw_photos.length === 6 && [...mock.storage.keys()].filter((k) => k.startsWith('jw-originals/')).length === 6);
  const origMatch = mock.db.jw_photos.every((p) => {
    const local = photos.find((f) => path.basename(f) === p.original_filename);
    return local && sha(fs.readFileSync(local)) === sha(mock.storage.get(`jw-originals/${p.original_path}`));
  });
  check('Stored originals are byte-identical (full resolution)', origMatch);
  // duplicates
  await page.setInputFiles('input[type=file]', photos.slice(0, 2));
  await page.click('button:has-text("Upload 2 photos")');
  await page.waitForSelector('text=/0 uploaded, 2 duplicates skipped/', { timeout: 15000 });
  check('Duplicate uploads skipped', mock.db.jw_photos.length === 6);
  await page.screenshot({ path: `${OUT}/03-admin-upload.png`, fullPage: true });

  await page.click('role=tab[name="Face index"]');
  await page.click('text=Build / update index');
  await page.waitForSelector('text=/Face index up to date/', { timeout: 30000 });
  const collectionId = `jab-we-wed-${eventId}`;
  check('Face index built in wedding-specific collection', (mock.collections.get(collectionId) || []).length === 12, collectionId);
  check('Collection namespace differs from original app (smf-face)', ![...mock.collections.keys()].some((k) => k.startsWith('smf-face')));
  await page.screenshot({ path: `${OUT}/04-admin-index.png`, fullPage: true });

  await page.click('role=tab[name="Library"]');
  await page.waitForSelector('.lib-tile img');
  check('Library shows signed previews', (await page.$$('.lib-tile')).length === 6);
  await page.screenshot({ path: `${OUT}/05-admin-library.png`, fullPage: true });

  await page.click('role=tab[name="Overview"]');
  await page.click('role=switch[name="Gallery published"]');
  await page.waitForSelector('button[aria-label="Guest access"]:not([disabled])');
  await page.click('role=switch[name="Guest access"]');
  await page.waitForSelector('text=Live · guests open');
  check('Gallery published with guest access', mock.db.jw_events[0].status === 'live' && mock.db.jw_events[0].guest_access === true);
  const qrUrl = await page.textContent('code');
  check('QR code points to this wedding', qrUrl.endsWith('/w/anjali-anukool'), qrUrl);
  const [qrDl] = await Promise.all([page.waitForEvent('download'), page.click('text=PNG (print)')]);
  await qrDl.saveAs(`${OUT}/qr-anjali-anukool.png`);
  check('QR PNG downloadable', fs.statSync(`${OUT}/qr-anjali-anukool.png`).size > 5000);
  const [cardDl] = await Promise.all([page.waitForEvent('download'), page.click('text=Branded card')]);
  await cardDl.saveAs(`${OUT}/qr-card.png`);
  check('Branded QR card downloadable', fs.statSync(`${OUT}/qr-card.png`).size > 20000);
  await page.screenshot({ path: `${OUT}/06-admin-live.png`, fullPage: true });

  // Admin cookie for API-level tests
  const cookie = (await desk.cookies()).find((c) => c.name === 'jww_admin');
  const adminHeaders = { Cookie: `jww_admin=${cookie.value}`, 'Content-Type': 'application/json' };
  check('Admin cookie is httpOnly + SameSite=Strict', cookie.httpOnly && cookie.sameSite === 'Strict');

  // Second wedding with photos, for isolation tests
  const ev2 = await (await fetch(`${APP}/api/admin/events`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ brideName: 'Riya', groomName: 'Karan', slug: 'riya-karan' }) })).json();
  const otherPhotoId = crypto.randomUUID();
  mock.db.jw_photos.push({ id: otherPhotoId, event_id: ev2.event.id, original_path: `${ev2.event.id}/x-private.jpg`, preview_path: `${ev2.event.id}/x-preview.jpg`, original_filename: 'private.jpg', processing_status: 'ready', indexed_at: new Date().toISOString(), face_count: 1, face_ids: [], created_at: new Date().toISOString() });
  mock.storage.set(`jw-originals/${ev2.event.id}/x-private.jpg`, Buffer.from('SECRET'));
  mock.storage.set(`jw-previews/${ev2.event.id}/x-preview.jpg`, Buffer.from('SECRET'));

  /* ───────── 3. Guest flow on a phone ───────── */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true, permissions: ['camera'],
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const g = await phone.newPage();
  await g.goto(`${APP}/w/anjali-anukool`);
  check('Guest welcome shows couple names', (await g.textContent('.couple')).includes('Anjali & Anukool'));
  check('Guest welcome shows date', (await g.textContent('body')).includes('12 December 2026'));
  await g.screenshot({ path: `${OUT}/10-guest-welcome-mobile.png`, fullPage: true });
  await g.click('text=Find My Photos');

  // Camera capture with fake device
  await g.click('text=Take selfie');
  await g.waitForSelector('video');
  await g.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, null, { timeout: 10000 });
  await g.screenshot({ path: `${OUT}/11-guest-camera-mobile.png` });
  await g.click('button:has-text("Capture")');
  check('Camera capture produces selfie preview', await g.waitForSelector('img[alt="Your selfie preview"]', { timeout: 8000 }).then(() => true).catch(() => false));

  // Upload path
  await g.setInputFiles('input[type=file]:not([capture])', path.join(FIX, 'selfie.jpg'));
  await g.waitForSelector('img[alt="Your selfie preview"]');
  check('Scan disabled until consent', await g.isDisabled('button.btn-block'));
  await g.check('input[type=checkbox]');
  await g.screenshot({ path: `${OUT}/12-guest-selfie-mobile.png`, fullPage: true });

  await control({ mode: 'match', ids: mock.db.jw_photos.filter((p) => p.event_id === eventId).slice(0, 4).map((p) => p.id), injectIds: [otherPhotoId] });
  await g.click('button.btn-block');
  await g.waitForSelector('text=Finding your photos');
  await g.screenshot({ path: `${OUT}/13-guest-scanning-mobile.png` });
  await g.waitForSelector('text=Your Wedding Memories', { timeout: 15000 });
  await g.waitForTimeout(800);
  const tiles = await g.$$('.tile');
  check('Matched photos shown (4)', tiles.length === 4, `${tiles.length} tiles`);
  check('Other wedding’s photo NOT shown even if Rekognition returns it', !(await g.content()).includes(otherPhotoId));
  await g.screenshot({ path: `${OUT}/14-guest-results-mobile.png`, fullPage: true });
  check('Selfie never written to storage', ![...mock.storage.keys()].some((k) => /selfie/i.test(k)) && mock.storage.size === 14);

  // Single download from lightbox
  await g.click('.tile >> nth=0');
  await g.waitForSelector('.lightbox');
  await g.screenshot({ path: `${OUT}/15-guest-lightbox-mobile.png` });
  const [single] = await Promise.all([g.waitForEvent('download'), g.click('.lightbox >> text=Download')]);
  const singlePath = `${OUT}/single-download.jpg`;
  await single.saveAs(singlePath);
  const singleBytes = fs.readFileSync(singlePath);
  check('Single download is the full-resolution original', photos.some((f) => sha(fs.readFileSync(f)) === sha(singleBytes)), single.suggestedFilename());
  await g.click('[aria-label="Close"]');

  // Multi-select ZIP
  await g.click('.tile >> nth=1 >> .tick');
  await g.click('.tile >> nth=2 >> .tick');
  await g.screenshot({ path: `${OUT}/16-guest-selected-mobile.png` });
  const [zipSel] = await Promise.all([g.waitForEvent('download', { timeout: 20000 }), g.click('text=Download 2')]);
  await zipSel.saveAs(`${OUT}/selected.zip`);
  const zSel = unzipSync(fs.readFileSync(`${OUT}/selected.zip`));
  const originals = new Set(photos.map((f) => sha(fs.readFileSync(f))));
  check('Selected ZIP has 2 full-res originals', Object.keys(zSel).length === 2 && Object.values(zSel).every((b) => originals.has(sha(Buffer.from(b)))), Object.keys(zSel).join(', '));
  await g.click('text=Clear');
  const [zipAll] = await Promise.all([g.waitForEvent('download', { timeout: 20000 }), g.click('text=Download all')]);
  await zipAll.saveAs(`${OUT}/all.zip`);
  const zAll = unzipSync(fs.readFileSync(`${OUT}/all.zip`));
  check('Download-all ZIP has all 4 matched originals', Object.keys(zAll).length === 4 && Object.values(zAll).every((b) => originals.has(sha(Buffer.from(b)))));
  await g.waitForSelector('text=/4 photos downloaded/');
  await g.screenshot({ path: `${OUT}/17-guest-downloaded-mobile.png`, fullPage: true });

  const token = await g.evaluate(() => JSON.parse(sessionStorage.getItem('jww:anjali-anukool')).token);
  const sessionIds = (await g.evaluate(() => JSON.parse(sessionStorage.getItem('jww:anjali-anukool')).matches.map((m) => m.id)));
  const unmatchedSameEvent = mock.db.jw_photos.find((p) => p.event_id === eventId && !sessionIds.includes(p.id)).id;

  /* ───────── 4. Security checks (API level) ───────── */
  const dl = (ids, tok = token, ip = '10.0.0.9') => fetch(`${APP}/api/download`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, 'x-forwarded-for': ip }, body: JSON.stringify({ photoIds: ids }) });
  check('Download without token → 401', (await fetch(`${APP}/api/download`, { method: 'POST', body: '{}' })).status === 401);
  check('Download with forged token → 401', (await dl([sessionIds[0]], crypto.randomBytes(32).toString('base64url'))).status === 401);
  check('Download unmatched photo from SAME wedding → 403', (await dl([unmatchedSameEvent])).status === 403);
  check('Download photo from OTHER wedding → 403', (await dl([otherPhotoId])).status === 403);
  check('Mixing a valid + foreign id → 403 (all-or-nothing)', (await dl([sessionIds[0], otherPhotoId])).status === 403);
  check('Malformed ids rejected → 400', (await dl(['../../etc/passwd'])).status === 400);
  const okDl = await (await dl([sessionIds[0]])).json();
  check('Signed original URL is short-lived (≤5 min)', okDl.expiresInSeconds <= 300);
  const unsigned = okDl.files[0].url.replace(/token=[^&]+/, 'token=forged');
  check('Original not readable with tampered signature', (await fetch(unsigned)).status >= 400);
  check('Original not readable without signature (no public bucket)', (await fetch(`http://127.0.0.1:${MOCK_PORT}/storage/v1/object/public/jw-originals/${mock.db.jw_photos[0].original_path}`)).status >= 400);

  const match = async (mode, slug = 'anjali-anukool', extra = {}) => {
    await control({ mode, ids: null, injectIds: [], ...extra });
    const fd = new FormData();
    fd.append('event', slug); fd.append('consent', 'yes');
    fd.append('selfie', new Blob([fs.readFileSync(path.join(FIX, 'selfie.jpg'))], { type: 'image/jpeg' }), 's.jpg');
    const r = await fetch(`${APP}/api/match`, { method: 'POST', body: fd, headers: { 'x-forwarded-for': extra.ip || '10.0.1.1' } });
    return { status: r.status, body: await r.json() };
  };
  let r = await match('noface'); check('No face in selfie → 422 NO_FACE', r.status === 422 && r.body.code === 'NO_FACE');
  r = await match('lowconf'); check('Blurry selfie (low confidence) → 422', r.status === 422);
  r = await match('none'); check('No match → empty result, no session', r.status === 200 && r.body.matches.length === 0 && !r.body.token);
  r = await match('match', 'riya-karan'); check('Draft/closed wedding refuses scans', r.status === 403 || r.status === 404, `status ${r.status}`);
  r = await match('match', 'does-not-exist'); check('Unknown wedding → 404', r.status === 404);
  {
    const fd = new FormData(); fd.append('event', 'anjali-anukool');
    fd.append('selfie', new Blob([fs.readFileSync(path.join(FIX, 'selfie.jpg'))], { type: 'image/jpeg' }), 's.jpg');
    check('Scan without consent → 400', (await fetch(`${APP}/api/match`, { method: 'POST', body: fd })).status === 400);
    const fd2 = new FormData(); fd2.append('event', 'anjali-anukool'); fd2.append('consent', 'yes');
    fd2.append('selfie', new Blob([Buffer.from('<svg/>')], { type: 'image/jpeg' }), 's.jpg');
    check('Non-image upload rejected → 415', (await fetch(`${APP}/api/match`, { method: 'POST', body: fd2, headers: { 'x-forwarded-for': '10.0.3.3' } })).status === 415);
  }
  // incomplete index flag
  mock.db.jw_photos.push({ id: crypto.randomUUID(), event_id: eventId, original_path: `${eventId}/new.jpg`, preview_path: `${eventId}/new-p.jpg`, original_filename: 'new.jpg', processing_status: 'ready', indexed_at: null, face_count: 0, face_ids: [], created_at: new Date().toISOString() });
  mock.db.jw_events[0].photos_count = 7;
  r = await match('match'); check('Incomplete index flagged to guest', r.body.indexIncomplete === true);
  mock.db.jw_photos.pop(); mock.db.jw_events[0].photos_count = 6;
  // index not built for a wedding
  await fetch(`${APP}/api/admin/events/${ev2.event.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'live' }) });
  await fetch(`${APP}/api/admin/events/${ev2.event.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ guestAccess: true }) });
  r = await match('match', 'riya-karan'); check('Index not built → 503 friendly message', r.status === 503 && r.body.code === 'INDEX_NOT_READY');

  // rate limit
  let limited = false;
  for (let i = 0; i < 32; i++) { const x = await match('none', 'anjali-anukool', { ip: '10.9.9.9' }); if (x.status === 429) { limited = true; break; } }
  check('Selfie scans are rate-limited per IP', limited);

  // expiry
  const sess = mock.db.jw_match_sessions.find((s) => s.event_id === eventId);
  const realExp = sess.expires_at; sess.expires_at = new Date(Date.now() - 1000).toISOString();
  const expiredRes = await dl([sessionIds[0]]);
  check('Expired session → 401', expiredRes.status === 401);
  sess.expires_at = realExp;

  // closing the gallery revokes sessions
  await fetch(`${APP}/api/admin/events/${eventId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ guestAccess: false }) });
  check('Closing guest access revokes download sessions', (await dl([sessionIds[0]])).status === 401);
  const closedPage = await (await fetch(`${APP}/w/anjali-anukool`)).text();
  check('Closed gallery shows friendly message', closedPage.includes('still preparing'));
  await fetch(`${APP}/api/admin/events/${eventId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ guestAccess: true }) });

  // admin protection
  check('Admin API without cookie → 401', (await fetch(`${APP}/api/admin/events`)).status === 401);
  check('Admin upload-url without cookie → 401', (await fetch(`${APP}/api/admin/events/${eventId}/upload-url`, { method: 'POST', body: '{}' })).status === 401);
  check('Cross-site admin POST blocked → 403', (await fetch(`${APP}/api/admin/events`, { method: 'POST', headers: { ...adminHeaders, Origin: 'https://evil.example' }, body: '{}' })).status === 403);
  check('Finalize refuses paths from another wedding', (await fetch(`${APP}/api/admin/events/${eventId}/upload-finalize`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ uploads: [{ originalPath: `${ev2.event.id}/x-private.jpg`, previewPath: `${ev2.event.id}/x.jpg`, name: 'x.jpg' }] }) })).status === 400);
  check('Public event API exposes no photo data', !JSON.stringify(await (await fetch(`${APP}/api/events/anjali-anukool`)).json()).includes('path'));

  // printed-QR short links
  const sl = await fetch(`${APP}/Anjali-Anukool`, { redirect: 'manual' });
  check('Short link /Anjali-Anukool redirects to /w/anjali-anukool', sl.status >= 300 && sl.status < 400 && (sl.headers.get('location') || '').endsWith('/w/anjali-anukool'), `${sl.status} ${sl.headers.get('location')}`);
  check('Short link does not shadow /admin or /privacy', (await fetch(`${APP}/privacy`, { redirect: 'manual' })).status === 200);

  // payment removal
  for (const p of ['/api/create-order', '/api/verify-payment', '/api/orders', '/api/admin/orders', '/api/orders/x/download-zip']) {
    const s = (await fetch(`${APP}${p}`, { method: 'POST' })).status;
    check(`Payment route ${p} unreachable`, s === 404 || s === 405, `status ${s}`);
  }

  // Desktop guest results + not-found page
  const d2 = await desk.newPage();
  await d2.goto(`${APP}/w/anjali-anukool`);
  await d2.screenshot({ path: `${OUT}/20-guest-welcome-desktop.png`, fullPage: true });
  await d2.goto(`${APP}/w/nope-nope`);
  await d2.screenshot({ path: `${OUT}/21-not-found.png` });
  const p3 = await phone.newPage();
  await p3.goto(APP);
  await p3.screenshot({ path: `${OUT}/22-landing-mobile.png`, fullPage: true });

  // delete-all removes the collection
  await page.goto(`${APP}/admin/events/${ev2.event.id}`);
  await page.click('role=tab[name="Settings"]');
  await page.fill('[aria-label="Type gallery link to confirm"]', 'riya-karan');
  await page.click('text=Delete all photos');
  await page.waitForSelector('text=/Deleted 1 photos/');
  check('Delete-all removes photos + storage for that wedding only', !mock.db.jw_photos.some((p) => p.event_id === ev2.event.id) && mock.db.jw_photos.filter((p) => p.event_id === eventId).length === 6 && !mock.storage.has(`jw-originals/${ev2.event.id}/x-private.jpg`));

  check('No browser console errors (admin)', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('E2E run completed without exception', false, e.stack);
  console.log(appLog.slice(-3000));
} finally {
  await browser.close();
  try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill('SIGTERM'); }
  mock.server.close();
}

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
