'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft, Archive, Cloud, Copy, Download, ExternalLink, ImagePlus, Loader2, Play, RefreshCw, Save, ScanFace, Square, Trash2, Upload,
} from 'lucide-react';
import AdminShell from '@/components/admin/AdminShell';
import { StatusPill } from '@/components/admin/StatusPill';
import { api, makePreview, sha256File } from '@/lib/client/admin-api';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { formatBytes, formatDate, slugify } from '@/lib/format';

const TABS = ['Overview', 'Upload', 'Face index', 'Library', 'Settings'];

export default function EventAdminPage() {
  return <AdminShell><EventAdmin /></AdminShell>;
}

function EventAdmin() {
  const { id } = useParams();
  const [event, setEvent] = useState(null);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('Overview');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const d = await api(`/api/admin/events/${id}`);
      setEvent(d.event); setStats(d.stats);
    } catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  const patch = async (body) => {
    setError('');
    try { const d = await api(`/api/admin/events/${id}`, { method: 'PATCH', body }); setEvent(d.event); return true; }
    catch (e) { setError(e.message); return false; }
  };

  if (!event) return error ? <div className="notice notice-error">{error}</div> : <div style={{ textAlign: 'center', padding: 60 }}><Loader2 className="spin" aria-label="Loading" /></div>;

  return (
    <>
      <Link href="/admin" className="btn btn-quiet" style={{ paddingLeft: 0 }}><ArrowLeft aria-hidden="true" /> All weddings</Link>
      <div className="spread" style={{ marginTop: 6 }}>
        <div>
          <h1>{event.bride_name} &amp; {event.groom_name}</h1>
          <div className="muted small" style={{ marginTop: 6 }}>{[event.title, formatDate(event.event_date), event.venue].filter(Boolean).join(' · ')}</div>
        </div>
        <StatusPill event={event} />
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {error && <div className="notice notice-error" style={{ marginBottom: 14 }}>{error}</div>}

      {tab === 'Overview' && <Overview event={event} stats={stats} patch={patch} goto={setTab} />}
      {tab === 'Upload' && <><DriveImport event={event} onSynced={(ev) => setEvent(ev)} goto={setTab} /><Uploader event={event} onDone={reload} /></>}
      {tab === 'Face index' && <Indexer event={event} stats={stats} onChange={(ev) => setEvent(ev)} reload={reload} />}
      {tab === 'Library' && <Library event={event} onChange={reload} />}
      {tab === 'Settings' && <Settings event={event} patch={patch} onDeleted={reload} />}
    </>
  );
}

/* ───────────── Overview: stats, guest access, QR ───────────── */
function Overview({ event, stats, patch, goto }) {
  const pending = event.photos_count - event.indexed_count;
  const live = event.status === 'live';
  return (
    <>
      <div className="stats">
        <div className="stat"><b>{event.photos_count}</b><span>Photos uploaded</span></div>
        <div className="stat"><b>{event.indexed_count}</b><span>Photos indexed</span></div>
        <div className="stat"><b>{event.faces_count}</b><span>Faces found</span></div>
        <div className="stat"><b>{stats?.indexErrors || 0}</b><span>Index errors</span></div>
      </div>

      {pending > 0 && (
        <div className="notice notice-info" style={{ marginTop: 14 }}>
          <ScanFace aria-hidden="true" /><span>{pending} photo{pending === 1 ? '' : 's'} not yet in the face index. Guests can&apos;t find these until you <button className="btn btn-quiet" style={{ padding: 0, minHeight: 0 }} onClick={() => goto('Face index')}>build the index</button>.</span>
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <div className="panel">
          <h2>Guest access</h2>
          <div className="spread" style={{ marginTop: 16 }}>
            <div><b>Gallery published</b><div className="small muted">Draft galleries return “not found” to guests.</div></div>
            <button className="switch" role="switch" aria-checked={live} aria-label="Gallery published" disabled={event.status === 'archived'}
              onClick={() => patch({ status: live ? 'draft' : 'live' })} />
          </div>
          <div className="spread" style={{ marginTop: 16 }}>
            <div><b>Guests can scan &amp; download</b><div className="small muted">Turning this off immediately ends all guest download sessions.</div></div>
            <button className="switch" role="switch" aria-checked={event.guest_access} aria-label="Guest access" disabled={!live}
              onClick={() => patch({ guestAccess: !event.guest_access })} />
          </div>
          {!live && event.status !== 'archived' && <p className="small muted">Publish the gallery to enable guest access.</p>}
          <div className="row" style={{ marginTop: 18 }}>
            {event.status === 'archived'
              ? <button className="btn btn-ghost" onClick={() => patch({ status: 'draft' })}><RefreshCw aria-hidden="true" /> Restore from archive</button>
              : <button className="btn btn-ghost" onClick={() => window.confirm('Archive this wedding? Guests will no longer be able to download.') && patch({ status: 'archived' })}><Archive aria-hidden="true" /> Archive wedding</button>}
          </div>
        </div>
        <QrPanel event={event} />
      </div>
    </>
  );
}

function guestUrl(slug) {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');
  return `${base}/w/${slug}`;
}

function QrPanel({ event }) {
  const url = guestUrl(event.slug);
  const canvasWrap = useRef(null);
  const svgWrap = useRef(null);
  const [copied, setCopied] = useState(false);
  const file = `jab-we-wed-${event.slug}-qr`;

  const dl = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
  const png = () => dl(canvasWrap.current.querySelector('canvas').toDataURL('image/png'), `${file}.png`);
  const svg = () => {
    const blob = new Blob([svgWrap.current.innerHTML], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(blob); dl(href, `${file}.svg`); setTimeout(() => URL.revokeObjectURL(href), 5000);
  };
  const card = async () => {
    await document.fonts?.ready;
    const W = 1200, H = 1600, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#f8e3d3'); grad.addColorStop(1, '#f6d9c5');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.textAlign = 'center'; g.fillStyle = '#a65b4b';
    g.font = '150px Allura, cursive'; g.fillText('jab ♡ we wed..', W / 2, 220);
    g.fillStyle = '#5c2d25'; g.font = '34px Jost, sans-serif'; g.fillText('—  by SMF Studios  —', W / 2, 290);
    g.font = '500 64px Cinzel, serif'; g.fillText('FIND YOUR', W / 2, 430); g.fillText('WEDDING PHOTOS', W / 2, 510);
    g.font = '28px Jost, sans-serif'; g.fillStyle = '#3d2621'; g.fillText('S C A N   Y O U R   F A C E   &   D O W N L O A D   Y O U R   M E M O R I E S', W / 2, 580);
    const qr = canvasWrap.current.querySelector('canvas');
    g.fillStyle = '#fffaf5'; g.fillRect(W / 2 - 290, 650, 580, 580);
    g.drawImage(qr, W / 2 - 250, 690, 500, 500);
    g.strokeStyle = '#a65b4b'; g.lineWidth = 10; g.lineCap = 'round';
    const L = 70, x0 = W / 2 - 310, y0 = 630, x1 = W / 2 + 310, y1 = 1250;
    [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(([x, y, dx, dy]) => { g.beginPath(); g.moveTo(x, y + dy * L); g.lineTo(x, y); g.lineTo(x + dx * L, y); g.stroke(); });
    g.fillStyle = '#a65b4b'; g.font = '84px Allura, cursive'; g.fillText(`${event.bride_name} & ${event.groom_name}`, W / 2, 1370);
    g.fillStyle = '#5c2d25'; g.font = '30px Jost, sans-serif'; g.fillText(formatDate(event.event_date) || '', W / 2, 1425);
    g.font = '24px Jost, sans-serif'; g.fillText(url.replace(/^https?:\/\//, ''), W / 2, 1520);
    dl(c.toDataURL('image/png'), `${file}-card.png`);
  };

  return (
    <div className="panel">
      <h2>Guest QR code</h2>
      <p className="small muted" style={{ marginTop: 6 }}>Points only to this wedding. Use the PNG/SVG in your standee design.</p>
      <div className="row" style={{ alignItems: 'flex-start', marginTop: 10 }}>
        <div className="qr-box"><QRCodeSVG value={url} size={150} level="H" fgColor="#3d2621" marginSize={2} title={`QR code for ${url}`} /></div>
        <div style={{ flex: 1, minWidth: 180, display: 'grid', gap: 8 }}>
          <code className="small" style={{ wordBreak: 'break-all', background: '#fbf3ec', padding: '8px 10px', borderRadius: 8 }}>{url}</code>
          <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Copy aria-hidden="true" /> {copied ? 'Copied!' : 'Copy link'}</button>
          <a className="btn btn-ghost" href={url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /> Open guest page</a>
        </div>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={png}><Download aria-hidden="true" /> PNG (print)</button>
        <button className="btn btn-ghost" onClick={svg}><Download aria-hidden="true" /> SVG</button>
        <button className="btn btn-ghost" onClick={card}><Download aria-hidden="true" /> Branded card</button>
      </div>
      <div ref={canvasWrap} hidden><QRCodeCanvas value={url} size={2048} level="H" fgColor="#000000" bgColor="#ffffff" marginSize={4} /></div>
      <div ref={svgWrap} hidden><QRCodeSVG value={url} size={1024} level="H" fgColor="#000000" bgColor="#ffffff" marginSize={4} /></div>
    </div>
  );
}

/* ───────────── Google Drive folder import ───────────── */
function DriveImport({ event, onSynced, goto }) {
  const saved = event.drive_folder_id ? `https://drive.google.com/drive/folders/${event.drive_folder_id}` : '';
  const [link, setLink] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type, text }
  const [info, setInfo] = useState(null); // { mode, shareEmail }
  const [copied, setCopied] = useState(false);
  useEffect(() => { api(`/api/admin/events/${event.id}/drive`).then(setInfo).catch(() => setInfo({ mode: null })); }, [event.id]);

  const sync = async () => {
    if (!link.trim() || busy) return;
    setBusy(true); setMsg({ type: 'info', text: 'Reading the Drive folder…' });
    try {
      const d = await api(`/api/admin/events/${event.id}/drive`, { method: 'POST', body: { folder: link.trim() } });
      onSynced(d.event);
      setMsg({ type: 'ok', text: `“${d.folder.name}”: ${d.found} photos found · ${d.added} new${d.alreadySynced ? ` · ${d.alreadySynced} already added` : ''}.${d.added ? ' Next: build the face index.' : ''}` });
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2><Cloud aria-hidden="true" style={{ verticalAlign: '-4px', marginRight: 6 }} />Google Drive folder</h2>
      {info?.mode === 'private' ? (
        <>
          <p className="small muted" style={{ lineHeight: 1.6 }}>Your folder stays <b>private</b>. In Google Drive, share the wedding folder with this email as <b>Viewer</b> (just like sharing with a person), then paste the folder link below.</p>
          <div className="row" style={{ marginTop: 8 }}>
            <code className="small" style={{ wordBreak: 'break-all', background: '#fbf3ec', padding: '8px 10px', borderRadius: 8, flex: 1, minWidth: 200 }}>{info.shareEmail}</code>
            <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(info.shareEmail); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Copy aria-hidden="true" /> {copied ? 'Copied!' : 'Copy email'}</button>
          </div>
        </>
      ) : info?.mode === 'public' ? (
        <p className="small muted" style={{ lineHeight: 1.6 }}>Paste the wedding&apos;s Drive folder link (shared as “Anyone with the link can view”).</p>
      ) : info ? (
        <div className="notice notice-error" style={{ marginTop: 8 }}><span>Google Drive is not connected yet. Add <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> in Vercel and redeploy.{info.error ? ` (${info.error})` : ''}</span></div>
      ) : null}
      <p className="small muted" style={{ lineHeight: 1.6, marginTop: 8 }}>Originals stay in your Drive at full resolution. Added more photos later? Press Sync again — only new photos are added.</p>
      <div className="row" style={{ marginTop: 12 }}>
        <input className="input" style={{ flex: 1, minWidth: 220 }} value={link} onChange={(e) => setLink(e.target.value)}
          placeholder="https://drive.google.com/drive/folders/…" aria-label="Google Drive folder link" />
        <button className="btn btn-primary" disabled={!link.trim() || busy} onClick={sync}>{busy ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />} {saved ? 'Sync now' : 'Connect & sync'}</button>
      </div>
      {event.drive_synced_at && <p className="small muted" style={{ marginTop: 8 }}>Last synced {new Date(event.drive_synced_at).toLocaleString('en-IN')}</p>}
      {msg && <div className={`notice notice-${msg.type}`} style={{ marginTop: 10 }} aria-live="polite">
        <span>{msg.text}</span>
        {msg.type === 'ok' && <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => goto('Face index')}><ScanFace aria-hidden="true" /> Build face index</button>}
      </div>}
    </div>
  );
}

/* ───────────── Upload (adapted from Face Match uploader) ───────────── */
const CHUNK = 20;
const WORKERS = 3;

function Uploader({ event, onDone }) {
  const inputRef = useRef(null);
  const stopRef = useRef(false);
  const [files, setFiles] = useState([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState({ done: 0, total: 0, uploaded: 0, skipped: 0, failed: 0 });
  const [log, setLog] = useState('');

  const pick = (list) => {
    const ok = Array.from(list || []).filter((f) => /\.(jpe?g|png)$/i.test(f.name));
    setFiles(ok.slice(0, 3000));
    setLog(ok.length < (list?.length || 0) ? `${(list?.length || 0) - ok.length} non-JPG/PNG files ignored.` : '');
  };

  const run = async () => {
    if (!files.length || busy) return;
    setBusy(true); stopRef.current = false;
    const total = files.length;
    const p = { done: 0, total, uploaded: 0, skipped: 0, failed: 0 };
    setProg({ ...p });
    const supabase = getSupabaseBrowser();
    try {
      for (let off = 0; off < files.length && !stopRef.current; off += CHUNK) {
        const chunk = files.slice(off, off + CHUNK);
        setLog(`Checking ${off + 1}–${off + chunk.length} for duplicates…`);
        const hashes = await Promise.all(chunk.map(sha256File));
        const prep = await api(`/api/admin/events/${event.id}/upload-url`, {
          method: 'POST', body: { files: chunk.map((f, i) => ({ name: f.name, size: f.size, type: f.type, hash: hashes[i] })) },
        });
        p.skipped += prep.skipped.length; p.done += prep.skipped.length;
        const finished = [];
        const queue = [...prep.uploads];
        const worker = async () => {
          while (queue.length && !stopRef.current) {
            const u = queue.shift();
            const file = chunk[u.index];
            try {
              setLog(`Uploading ${file.name}`);
              const preview = await makePreview(file);
              const o = await supabase.storage.from('jw-originals').uploadToSignedUrl(u.originalPath, u.originalToken, file, { contentType: file.type || 'image/jpeg' });
              if (o.error) throw o.error;
              const pv = await supabase.storage.from('jw-previews').uploadToSignedUrl(u.previewPath, u.previewToken, preview, { contentType: 'image/jpeg' });
              if (pv.error) throw pv.error;
              finished.push({ name: u.name, fileHash: u.fileHash, originalPath: u.originalPath, previewPath: u.previewPath, bytes: file.size, contentType: file.type });
              p.uploaded += 1;
            } catch (e) {
              p.failed += 1;
              setLog(`Failed: ${file.name} — ${e.message}`);
            }
            p.done += 1;
            setProg({ ...p });
          }
        };
        await Promise.all(Array.from({ length: WORKERS }, worker));
        if (finished.length) await api(`/api/admin/events/${event.id}/upload-finalize`, { method: 'POST', body: { uploads: finished } });
        setProg({ ...p });
      }
      setLog(stopRef.current ? 'Upload paused. Choose the same files again to resume — duplicates are skipped automatically.'
        : `Done. ${p.uploaded} uploaded, ${p.skipped} duplicates skipped${p.failed ? `, ${p.failed} failed (re-select to retry)` : ''}. Next: build the face index.`);
      setFiles([]); if (inputRef.current) inputRef.current.value = '';
      onDone();
    } catch (e) {
      setLog(`Upload stopped: ${e.message}`);
    } finally { setBusy(false); }
  };

  const pct = prog.total ? (prog.done / prog.total) * 100 : 0;
  return (
    <div className="panel">
      <h2>Upload photographs</h2>
      <p className="small muted" style={{ lineHeight: 1.6 }}>Originals go straight to private storage at full resolution (JPG/PNG, max 50 MB each). A preview is generated in your browser for face indexing and guest browsing. Exact duplicates are skipped, so you can safely re-select a folder to resume.</p>
      <div className={`dropzone ${drag ? 'drag' : ''}`} style={{ marginTop: 14 }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files); }}>
        <ImagePlus aria-hidden="true" style={{ width: 40, height: 40, color: 'var(--rose)' }} />
        <p style={{ margin: '10px 0 14px' }}>Drag photos here, or</p>
        <input ref={inputRef} type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" hidden onChange={(e) => pick(e.target.files)} />
        <button className="btn btn-ghost" onClick={() => inputRef.current?.click()} disabled={busy}><Upload aria-hidden="true" /> Choose photos</button>
        <div className="small muted" style={{ marginTop: 10 }}>{files.length ? `${files.length} photos selected (${formatBytes(files.reduce((s, f) => s + f.size, 0))})` : 'Up to 3,000 photos per batch'}</div>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={!files.length || busy} onClick={run}>{busy ? <Loader2 className="spin" aria-hidden="true" /> : <Upload aria-hidden="true" />} Upload {files.length || ''} photos</button>
        {busy && <button className="btn btn-ghost" onClick={() => { stopRef.current = true; }}><Square aria-hidden="true" /> Pause</button>}
      </div>
      {(busy || prog.total > 0) && (
        <div style={{ marginTop: 16 }}>
          <div className="progress"><span style={{ width: `${pct}%` }} /></div>
          <div className="small muted" style={{ marginTop: 8 }}>{prog.done}/{prog.total} processed · {prog.uploaded} uploaded · {prog.skipped} duplicates · {prog.failed} failed</div>
        </div>
      )}
      {log && <div className="small" style={{ marginTop: 10, color: 'var(--cocoa)' }} aria-live="polite">{log}</div>}
    </div>
  );
}

/* ───────────── Face index ───────────── */
function Indexer({ event, stats, onChange, reload }) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const stopRef = useRef(false);

  const run = async (retryFailed = false) => {
    setRunning(true); stopRef.current = false; setMsg('Starting…');
    let errors = 0;
    try {
      for (;;) {
        if (stopRef.current) { setMsg('Paused. Press Build to continue where you left off.'); break; }
        const d = await api(`/api/admin/events/${event.id}/index`, { method: 'POST', body: { retryFailed } });
        errors += d.errors;
        onChange(d.event);
        setMsg(d.done ? `✓ Face index up to date. ${d.event.faces_count} faces across ${d.event.indexed_count} photos.${errors ? ` ${errors} photos failed — use “Retry failed”.` : ''}`
          : `Indexing… ${d.remaining} photos remaining`);
        if (d.done || d.processed === 0) break;
      }
    } catch (e) { setMsg(`Indexing stopped: ${e.message}`); }
    finally { setRunning(false); reload(); }
  };

  const pct = event.photos_count ? (event.indexed_count / event.photos_count) * 100 : 0;
  return (
    <div className="panel">
      <h2>AI face index (Amazon Rekognition)</h2>
      <p className="small muted" style={{ lineHeight: 1.6 }}>Each wedding has its own private face collection, so guests are only ever matched against this wedding&apos;s photos. Indexing is incremental — after new uploads, only the new photos are processed.</p>
      <div className="stats" style={{ marginTop: 14 }}>
        <div className="stat"><b>{event.indexed_count}/{event.photos_count}</b><span>Photos indexed</span></div>
        <div className="stat"><b>{event.faces_count}</b><span>Faces</span></div>
        <div className="stat"><b>{stats?.photosWithoutFaces || 0}</b><span>No faces found</span></div>
        <div className="stat"><b>{stats?.indexErrors || 0}</b><span>Errors</span></div>
      </div>
      <div className="progress" style={{ marginTop: 16 }}><span style={{ width: `${pct}%` }} /></div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" disabled={running} onClick={() => run(false)}>{running ? <Loader2 className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />} Build / update index</button>
        {running && <button className="btn btn-ghost" onClick={() => { stopRef.current = true; }}><Square aria-hidden="true" /> Pause</button>}
        {!running && (stats?.indexErrors || 0) > 0 && <button className="btn btn-ghost" onClick={() => run(true)}><RefreshCw aria-hidden="true" /> Retry failed</button>}
      </div>
      {msg && <p className="small" style={{ color: 'var(--cocoa)' }} aria-live="polite">{msg}</p>}
    </div>
  );
}

/* ───────────── Library ───────────── */
function Library({ event, onChange }) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setData(null);
    api(`/api/admin/events/${event.id}/photos?page=${page}&filter=${filter}`).then(setData).catch((e) => setErr(e.message));
  }, [event.id, page, filter]);
  useEffect(() => { load(); }, [load]);

  const del = async () => {
    if (!sel.size || !window.confirm(`Permanently delete ${sel.size} photo(s)? This removes originals, previews and face data.`)) return;
    setBusy(true);
    try { await api(`/api/admin/events/${event.id}/photos`, { method: 'DELETE', body: { photoIds: [...sel] } }); setSel(new Set()); load(); onChange(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const pages = data ? Math.ceil(data.total / data.pageSize) : 0;
  return (
    <div className="panel">
      <div className="spread">
        <h2>Photo library</h2>
        <div className="row">
          <select className="input" style={{ minHeight: 40, width: 'auto' }} value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} aria-label="Filter photos">
            <option value="all">All photos</option><option value="unindexed">Not indexed</option><option value="nofaces">No faces found</option><option value="errors">Index errors</option>
          </select>
          <button className="btn btn-ghost" onClick={load}><RefreshCw aria-hidden="true" /> Refresh</button>
          <button className="btn btn-danger" disabled={!sel.size || busy} onClick={del}><Trash2 aria-hidden="true" /> Delete {sel.size || ''}</button>
        </div>
      </div>
      {data?.storage && <p className="small muted">{data.total} photos · originals {formatBytes(data.storage.originalBytes)}{data.storage.quotaBytes ? ` of ${formatBytes(data.storage.quotaBytes)} quota` : ''}</p>}
      {err && <div className="notice notice-error">{err}</div>}
      {!data ? <div style={{ textAlign: 'center', padding: 30 }}><Loader2 className="spin" aria-label="Loading" /></div>
        : !data.photos.length ? <p className="muted">No photos here yet.</p>
          : (
            <div className="lib-grid" style={{ marginTop: 12 }}>
              {data.photos.map((p) => (
                <label key={p.id} className="lib-tile">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.preview_url ? <img src={p.preview_url} alt={p.original_filename} loading="lazy" /> : <div style={{ aspectRatio: 1 }} />}
                  <input type="checkbox" className="lib-check" checked={sel.has(p.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })} aria-label={`Select ${p.original_filename}`} />
                  <span className={`badge ${p.index_error ? 'warn' : ''}`}>{p.index_error ? 'error' : p.indexed_at ? `${p.face_count} face${p.face_count === 1 ? '' : 's'}` : 'not indexed'}</span>
                  <div className="lib-meta"><b title={p.original_filename}>{p.original_filename}</b>{formatBytes(p.bytes)}</div>
                </label>
              ))}
            </div>
          )}
      {pages > 1 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button className="btn btn-ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="small muted">Page {page + 1} of {pages}</span>
          <button className="btn btn-ghost" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

/* ───────────── Settings ───────────── */
function Settings({ event, patch, onDeleted }) {
  const [f, setF] = useState({ brideName: event.bride_name, groomName: event.groom_name, title: event.title, eventDate: event.event_date || '', venue: event.venue || '', slug: event.slug });
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: k === 'slug' ? slugify(e.target.value) : e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    if (f.slug !== event.slug && !window.confirm('Changing the gallery link breaks QR codes already printed. Continue?')) return;
    if (await patch(f)) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
  };
  const deleteAll = async () => {
    setBusy(true); setMsg('');
    try { const d = await api(`/api/admin/events/${event.id}/photos`, { method: 'DELETE', body: { all: true, confirmSlug: confirm } }); setMsg(`Deleted ${d.deleted} photos (${d.rekognition}).`); setConfirm(''); onDeleted(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <form className="panel" onSubmit={save}>
        <h2>Wedding details</h2>
        <div className="grid-2" style={{ marginTop: 14 }}>
          <div className="field"><label htmlFor="sb">Bride name</label><input id="sb" className="input" value={f.brideName} onChange={set('brideName')} required /></div>
          <div className="field"><label htmlFor="sg">Groom name</label><input id="sg" className="input" value={f.groomName} onChange={set('groomName')} required /></div>
          <div className="field"><label htmlFor="st">Event title</label><input id="st" className="input" value={f.title} onChange={set('title')} /></div>
          <div className="field"><label htmlFor="sd">Wedding date</label><input id="sd" type="date" className="input" value={f.eventDate} onChange={set('eventDate')} /></div>
          <div className="field"><label htmlFor="sv">Venue</label><input id="sv" className="input" value={f.venue} onChange={set('venue')} /></div>
          <div className="field"><label htmlFor="ss">Gallery link (/w/…)</label><input id="ss" className="input" value={f.slug} onChange={set('slug')} required /></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }}><Save aria-hidden="true" /> {saved ? 'Saved' : 'Save details'}</button>
      </form>
      <div className="panel" style={{ borderColor: '#ebbcb1' }}>
        <h2 style={{ color: '#8e3b2c' }}>Danger zone</h2>
        <p className="small muted">Delete every photo of this wedding: originals, previews, and its Rekognition face collection. Type <code>{event.slug}</code> to confirm.</p>
        <div className="row">
          <input className="input" style={{ maxWidth: 280 }} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={event.slug} aria-label="Type gallery link to confirm" />
          <button className="btn btn-danger" disabled={confirm !== event.slug || busy} onClick={deleteAll}>{busy ? <Loader2 className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />} Delete all photos</button>
        </div>
        {msg && <p className="small">{msg}</p>}
      </div>
    </>
  );
}
