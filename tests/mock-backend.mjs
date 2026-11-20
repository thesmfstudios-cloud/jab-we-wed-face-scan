// Test-only mock of the Supabase REST/Storage APIs and Amazon Rekognition,
// so the real Next.js server code can be exercised end-to-end offline.
// NOT used in production.
import http from 'node:http';
import crypto from 'node:crypto';

export function createMockBackend() {
  const db = { jw_events: [], jw_photos: [], jw_match_sessions: [], jw_rate_limits: [] };
  const storage = new Map(); // "bucket/path" -> Buffer
  const signTokens = new Map(); // token -> "bucket/path"
  const uploadTokens = new Map();
  const collections = new Map(); // id -> [{FaceId, ExternalImageId}]
  const control = { mode: 'match', ids: null, injectIds: [], confidence: 99.9 };
  const calls = [];
  const uniques = { jw_events: ['slug'], jw_photos: ['original_path', 'preview_path'], jw_match_sessions: ['token_hash'] };

  const now = () => new Date().toISOString();
  const defaults = {
    jw_events: () => ({ id: crypto.randomUUID(), status: 'draft', guest_access: false, photos_count: 0, indexed_count: 0, faces_count: 0, created_at: now(), updated_at: now(), event_date: null, venue: null }),
    jw_photos: () => ({ id: crypto.randomUUID(), processing_status: 'ready', indexed_at: null, face_count: 0, face_ids: [], index_error: null, created_at: now(), file_hash: null, bytes: null }),
    jw_match_sessions: () => ({ id: crypto.randomUUID(), created_at: now() }),
  };

  const parseVal = (v) => (v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : v);
  const parseList = (s) => s.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));

  function applyFilters(rows, params) {
    let out = rows;
    for (const [k, raw] of params) {
      if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
      let neg = false, v = raw;
      if (v.startsWith('not.')) { neg = true; v = v.slice(4); }
      const [op, ...rest] = v.split('.');
      const arg = rest.join('.');
      const test = (row) => {
        const cell = row[k];
        if (op === 'eq') return String(cell) === String(parseVal(arg)) || cell === parseVal(arg);
        if (op === 'neq') return String(cell) !== String(parseVal(arg));
        if (op === 'in') return parseList(arg).includes(String(cell));
        if (op === 'is') return arg === 'null' ? cell == null : cell === parseVal(arg);
        throw new Error(`unsupported op ${op}`);
      };
      out = out.filter((r) => (neg ? !test(r) : test(r)));
    }
    return out;
  }

  function applyOrder(rows, order) {
    if (!order) return rows;
    const keys = order.split(',').map((s) => { const [col, dir, nulls] = s.split('.'); return { col, desc: dir === 'desc', nullsLast: nulls === 'nullslast' }; });
    return [...rows].sort((a, b) => {
      for (const { col, desc } of keys) {
        const x = a[col], y = b[col];
        if (x == null && y == null) continue;
        if (x == null) return 1;
        if (y == null) return -1;
        const c = String(x).localeCompare(String(y));
        if (c) return desc ? -c : c;
      }
      return 0;
    });
  }

  function project(rows, select) {
    if (!select || select === '*') return rows;
    const cols = select.split(',').map((c) => c.trim());
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }

  function refreshCounts(eventId) {
    const ev = db.jw_events.find((e) => e.id === eventId);
    if (!ev) return;
    const ps = db.jw_photos.filter((p) => p.event_id === eventId);
    ev.photos_count = ps.filter((p) => ['ready', 'pending'].includes(p.processing_status)).length;
    ev.indexed_count = ps.filter((p) => p.indexed_at).length;
    ev.faces_count = ps.reduce((s, p) => s + (p.face_count || 0), 0);
  }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*', ...headers });
    res.end(body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function rest(req, res, url, body) {
    const table = url.pathname.replace('/rest/v1/', '');
    const params = [...url.searchParams.entries()];
    const prefer = req.headers.prefer || '';
    const wantsObject = (req.headers.accept || '').includes('vnd.pgrst.object');

    if (table.startsWith('rpc/')) {
      const fn = table.slice(4);
      const args = JSON.parse(body.toString() || '{}');
      calls.push({ rpc: fn, args });
      if (fn === 'jw_refresh_event_counts') { refreshCounts(args.p_event_id); return send(res, 200, null); }
      if (fn === 'jw_rate_limit_hit') {
        let row = db.jw_rate_limits.find((r) => r.key === args.p_key);
        const t = Date.now();
        if (!row || t - row.start > args.p_window_seconds * 1000) { row = row || { key: args.p_key }; row.start = t; row.hits = 0; if (!db.jw_rate_limits.includes(row)) db.jw_rate_limits.push(row); }
        row.hits += 1;
        return send(res, 200, row.hits <= args.p_max);
      }
      return send(res, 404, { message: 'no rpc' });
    }
    if (!db[table]) return send(res, 404, { message: `no table ${table}` });
    const select = url.searchParams.get('select');

    if (req.method === 'GET' || req.method === 'HEAD') {
      let rows = applyFilters(db[table], params);
      const total = rows.length;
      rows = applyOrder(rows, url.searchParams.get('order'));
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : Infinity;
      rows = rows.slice(offset, offset + limit);
      const headers = prefer.includes('count=exact') ? { 'Content-Range': `${offset}-${offset + rows.length - 1}/${total}` } : {};
      if (req.method === 'HEAD') return send(res, 200, undefined, headers);
      const out = project(rows, select);
      if (wantsObject) {
        if (out.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `Results contain ${out.length} rows` });
        return send(res, 200, out[0], headers);
      }
      return send(res, 200, out, headers);
    }
    if (req.method === 'POST') {
      const input = JSON.parse(body.toString());
      const list = Array.isArray(input) ? input : [input];
      const created = [];
      for (const item of list) {
        const row = { ...(defaults[table]?.() || {}), ...item };
        for (const col of uniques[table] || []) {
          if (db[table].some((r) => r[col] === row[col])) return send(res, 409, { code: '23505', message: `duplicate key value violates unique constraint (${col})` });
        }
        if (table === 'jw_photos' && row.file_hash && db.jw_photos.some((r) => r.event_id === row.event_id && r.file_hash === row.file_hash)) {
          return send(res, 409, { code: '23505', message: 'duplicate file hash' });
        }
        created.push(row);
      }
      db[table].push(...created);
      const out = project(created, select);
      if (wantsObject) return send(res, 201, out[0]);
      return send(res, 201, prefer.includes('return=representation') ? out : undefined);
    }
    if (req.method === 'PATCH') {
      const patch = JSON.parse(body.toString());
      const rows = applyFilters(db[table], params);
      rows.forEach((r) => Object.assign(r, patch));
      for (const col of uniques[table] || []) {
        const vals = db[table].map((r) => r[col]);
        if (new Set(vals).size !== vals.length) return send(res, 409, { code: '23505', message: 'duplicate' });
      }
      const out = project(rows, select);
      if (wantsObject) return send(res, 200, out[0]);
      return send(res, 200, prefer.includes('return=representation') ? out : undefined);
    }
    if (req.method === 'DELETE') {
      const rows = new Set(applyFilters(db[table], params));
      db[table] = db[table].filter((r) => !rows.has(r));
      if (table === 'jw_events') db.jw_photos = db.jw_photos.filter((p) => db.jw_events.some((e) => e.id === p.event_id));
      return send(res, 200, prefer.includes('return=representation') ? [...rows] : undefined);
    }
    return send(res, 405, {});
  }

  function storageApi(req, res, url, body, base) {
    const p = decodeURIComponent(url.pathname.replace('/storage/v1/', ''));
    let m;
    if (req.method === 'OPTIONS') return send(res, 204);
    if (req.method === 'POST' && (m = p.match(/^object\/upload\/sign\/([^/]+)\/(.+)$/))) {
      const token = crypto.randomUUID();
      uploadTokens.set(token, `${m[1]}/${m[2]}`);
      return send(res, 200, { url: `/object/upload/sign/${m[1]}/${m[2]}?token=${token}` });
    }
    if (req.method === 'PUT' && (m = p.match(/^object\/upload\/sign\/([^/]+)\/(.+)$/))) {
      const key = uploadTokens.get(url.searchParams.get('token'));
      if (!key || key !== `${m[1]}/${m[2]}`) return send(res, 400, { message: 'bad token' });
      let data = body;
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) {
        const boundary = ct.split('boundary=')[1];
        const parts = body.toString('latin1').split(`--${boundary}`);
        const filePart = parts.find((x) => x.includes('filename=')) || parts.find((x) => x.includes('name=""')) || parts[1];
        const idx = filePart.indexOf('\r\n\r\n');
        data = Buffer.from(filePart.slice(idx + 4, filePart.lastIndexOf('\r\n')), 'latin1');
      }
      storage.set(key, data);
      uploadTokens.delete(url.searchParams.get('token'));
      return send(res, 200, { Key: key });
    }
    if ((req.method === 'POST' || req.method === 'PUT') && (m = p.match(/^object\/(?!sign\/|upload\/|public\/|authenticated\/)([^/]+)\/(.+)$/))) {
      if (!String(req.headers.authorization || '').includes(base.serviceKey)) return send(res, 403, { message: 'forbidden' });
      storage.set(`${m[1]}/${m[2]}`, body);
      return send(res, 200, { Key: `${m[1]}/${m[2]}` });
    }
    if (req.method === 'POST' && (m = p.match(/^object\/sign\/([^/]+)$/))) {
      const { paths, expiresIn } = JSON.parse(body.toString());
      return send(res, 200, paths.map((path) => {
        const token = crypto.randomUUID();
        signTokens.set(token, { key: `${m[1]}/${path}`, exp: Date.now() + expiresIn * 1000 });
        return { path, signedURL: `/object/sign/${m[1]}/${path}?token=${token}`, error: storage.has(`${m[1]}/${path}`) ? null : 'not found' };
      }));
    }
    if (req.method === 'POST' && (m = p.match(/^object\/sign\/([^/]+)\/(.+)$/))) {
      const { expiresIn } = JSON.parse(body.toString());
      if (!storage.has(`${m[1]}/${m[2]}`)) return send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const token = crypto.randomUUID();
      signTokens.set(token, { key: `${m[1]}/${m[2]}`, exp: Date.now() + expiresIn * 1000 });
      return send(res, 200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${token}` });
    }
    if (req.method === 'GET' && (m = p.match(/^object\/sign\/([^/]+)\/(.+)$/))) {
      const t = signTokens.get(url.searchParams.get('token'));
      if (!t || t.key !== `${m[1]}/${m[2]}` || t.exp < Date.now()) return send(res, 400, { message: 'invalid signature' });
      const dl = url.searchParams.get('download');
      return send(res, 200, storage.get(t.key), { 'Content-Type': 'image/jpeg', ...(dl != null ? { 'Content-Disposition': `attachment; filename="${dl}"` } : {}) });
    }
    if (req.method === 'GET' && (m = p.match(/^object\/(?:authenticated\/)?([^/]+)\/(.+)$/))) {
      if (!String(req.headers.authorization || '').includes(base.serviceKey)) return send(res, 403, { message: 'forbidden' });
      const data = storage.get(`${m[1]}/${m[2]}`);
      return data ? send(res, 200, data, { 'Content-Type': 'image/jpeg' }) : send(res, 404, { message: 'not found' });
    }
    if (req.method === 'DELETE' && (m = p.match(/^object\/([^/]+)$/))) {
      const { prefixes } = JSON.parse(body.toString());
      prefixes.forEach((x) => storage.delete(`${m[1]}/${x}`));
      return send(res, 200, prefixes.map((name) => ({ name })));
    }
    return send(res, 404, { message: `storage route ${req.method} ${p}` });
  }

  function rekognition(req, res, body) {
    const action = String(req.headers['x-amz-target'] || '').split('.')[1];
    const input = JSON.parse(body.toString() || '{}');
    calls.push({ rekognition: action, collection: input.CollectionId, externalImageId: input.ExternalImageId });
    const err = (type, status = 400) => send(res, status, { __type: type, message: type }, { 'Content-Type': 'application/x-amz-json-1.1', 'x-amzn-errortype': type });
    const ok = (b) => send(res, 200, b, { 'Content-Type': 'application/x-amz-json-1.1' });
    switch (action) {
      case 'DescribeCollection': return collections.has(input.CollectionId) ? ok({ FaceCount: collections.get(input.CollectionId).length }) : err('ResourceNotFoundException');
      case 'CreateCollection': if (collections.has(input.CollectionId)) return err('ResourceAlreadyExistsException'); collections.set(input.CollectionId, []); return ok({ StatusCode: 200 });
      case 'DeleteCollection': if (!collections.delete(input.CollectionId)) return err('ResourceNotFoundException'); return ok({ StatusCode: 200 });
      case 'IndexFaces': {
        const col = collections.get(input.CollectionId);
        if (!col) return err('ResourceNotFoundException');
        const n = control.facesPerPhoto ?? 2;
        const recs = Array.from({ length: n }, () => ({ Face: { FaceId: crypto.randomUUID(), ExternalImageId: input.ExternalImageId } }));
        recs.forEach((r) => col.push(r.Face));
        return ok({ FaceRecords: recs, UnindexedFaces: [] });
      }
      case 'DeleteFaces': {
        const col = collections.get(input.CollectionId);
        if (!col) return err('ResourceNotFoundException');
        collections.set(input.CollectionId, col.filter((f) => !input.FaceIds.includes(f.FaceId)));
        return ok({ DeletedFaces: input.FaceIds });
      }
      case 'SearchFacesByImage': {
        const col = collections.get(input.CollectionId);
        if (!col) return err('ResourceNotFoundException');
        if (control.mode === 'noface') return err('InvalidParameterException');
        if (control.mode === 'none') return ok({ FaceMatches: [], SearchedFaceConfidence: 99.9 });
        if (control.mode === 'lowconf') return ok({ FaceMatches: [], SearchedFaceConfidence: 60 });
        const matches = col.filter((f) => !control.ids || control.ids.includes(f.ExternalImageId)).map((f) => ({ Similarity: 97.5, Face: f }));
        control.injectIds.forEach((id) => matches.push({ Similarity: 99, Face: { FaceId: crypto.randomUUID(), ExternalImageId: id } }));
        return ok({ FaceMatches: matches, SearchedFaceConfidence: control.confidence });
      }
      default: return err('UnknownOperationException');
    }
  }

  // Google Drive v3 (API key) mock: drive.folders[id] = { name, children: [{id,name,mimeType,size}] }, drive.files[id] = Buffer
  // Private mode: a service account (drive.saPublicKey) gets a bearer token from
  // /oauth/token; it can only see folders listed in drive.sharedWithSa.
  const drive = { key: 'test-drive-key', folders: {}, files: {}, meta: {}, saPublicKey: null, sharedWithSa: new Set(), tokens: new Set(), publicFolders: new Set() };
  function oauthToken(req, res, body) {
    const form = new URLSearchParams(body.toString());
    const [h, p, sig] = String(form.get('assertion') || '').split('.');
    const okSig = drive.saPublicKey && sig && crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(drive.saPublicKey, sig, 'base64url');
    const claims = JSON.parse(Buffer.from(p || 'e30', 'base64url').toString());
    if (!okSig || !/drive\.readonly/.test(claims.scope || '')) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    const token = `ya29.${crypto.randomUUID()}`;
    drive.tokens.add(token);
    return send(res, 200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
  }
  // Link mode: Drive web folder view + public download host.
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
  const publicParentOf = (fileId) => Object.entries(drive.folders).find(([fid, f]) => drive.publicFolders.has(fid) && f.children.some((c) => c.id === fileId));
  function driveWeb(req, res, url) {
    calls.push({ driveWeb: url.pathname });
    if (url.pathname === '/embeddedfolderview') {
      const id = url.searchParams.get('id');
      const f = drive.folders[id];
      if (!f || !drive.publicFolders.has(id)) return send(res, 404, '<html><title>Error 404 (Not Found)</title></html>', { 'Content-Type': 'text/html' });
      const rows = f.children.map((c) => {
        const folder = c.mimeType === 'application/vnd.google-apps.folder';
        const href = folder ? `https://drive.google.com/drive/folders/${c.id}` : `https://drive.google.com/file/d/${c.id}/view?usp=drive_web`;
        return `<div class="flip-entry" id="entry-${c.id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="${href}" target="_blank"><div class="flip-entry-thumb"></div><div class="flip-entry-title">${esc(c.name)}</div></a></div></div>`;
      }).join('');
      return send(res, 200, `<!DOCTYPE html><html><head><title>${esc(f.name)}</title></head><body><div class="flip-entries">${rows}</div></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (url.pathname === '/download') {
      const id = url.searchParams.get('id');
      if (!drive.files[id] || !publicParentOf(id)) return send(res, 200, '<html><body>Sign in</body></html>', { 'Content-Type': 'text/html' });
      return send(res, 200, drive.files[id], { 'Content-Type': 'image/jpeg', 'Content-Length': String(drive.files[id].length) });
    }
    return send(res, 404, 'nope', { 'Content-Type': 'text/html' });
  }
  function driveApi(req, res, url) {
    calls.push({ drive: url.pathname, q: url.searchParams.get('q') });
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const viaSa = drive.tokens.has(bearer);
    if (!viaSa && url.searchParams.get('key') !== drive.key) return send(res, viaSa || bearer ? 401 : 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }, cors);
    // A service account only sees folders shared with it (and files inside them).
    const visible = (id) => !viaSa || drive.sharedWithSa.has(id) || Object.entries(drive.folders).some(([fid, f]) => drive.sharedWithSa.has(fid) && f.children.some((c) => c.id === id || (drive.folders[c.id] && drive.folders[c.id].children.some((g) => g.id === id))));
    const p = url.pathname.replace('/drive/v3/files', '');
    if (!p) {
      const q = url.searchParams.get('q') || '';
      const parent = (q.match(/'([^']+)' in parents/) || [])[1];
      const f = visible(parent) && drive.folders[parent];
      return f ? send(res, 200, { files: f.children }, cors) : send(res, 404, { error: { code: 404, message: 'File not found' } }, cors);
    }
    const id = decodeURIComponent(p.slice(1));
    if (!visible(id)) return send(res, 404, { error: { code: 404, message: `File not found: ${id}.` } }, cors);
    if (url.searchParams.get('alt') === 'media') {
      return drive.files[id] ? send(res, 200, drive.files[id], { 'Content-Type': 'image/jpeg', ...cors }) : send(res, 404, { error: { code: 404, message: 'File not found' } }, cors);
    }
    if (drive.folders[id]) return send(res, 200, { id, name: drive.folders[id].name, mimeType: 'application/vnd.google-apps.folder' }, cors);
    if (drive.meta[id]) return send(res, 200, drive.meta[id], cors);
    return send(res, 404, { error: { code: 404, message: `File not found: ${id}.` } }, cors);
  }

  const base = { serviceKey: 'test-service-role-key' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') return send(res, 204);
      const body = await readBody(req);
      if (url.pathname === '/__control') { Object.assign(control, JSON.parse(body.toString())); return send(res, 200, control); }
      if (url.pathname === '/__state') return send(res, 200, { db, collections: Object.fromEntries(collections), storageKeys: [...storage.keys()] });
      if (req.headers['x-amz-target']) return rekognition(req, res, body);
      if (url.pathname.startsWith('/rest/v1/')) return rest(req, res, url, body);
      if (url.pathname.startsWith('/storage/v1/')) return storageApi(req, res, url, body, base);
      if (url.pathname.startsWith('/drive/v3/files')) return driveApi(req, res, url);
      if (url.pathname === '/oauth/token') return oauthToken(req, res, body);
      if (url.pathname === '/embeddedfolderview' || url.pathname === '/download') return driveWeb(req, res, url);
      send(res, 404, { message: 'unknown' });
    } catch (e) {
      console.error('[mock]', e);
      send(res, 500, { message: e.message });
    }
  });
  return { server, db, storage, collections, control, calls, drive, serviceKey: base.serviceKey };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT || 54321);
  createMockBackend().server.listen(port, '127.0.0.1', () => console.log(`mock backend on ${port}`));
}
