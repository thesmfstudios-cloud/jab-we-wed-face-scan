'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle, ArrowLeft, Camera, Check, CheckCheck, ChevronLeft, ChevronRight, Download,
  ImagePlus, Info, Loader2, RefreshCw, Share, ShieldCheck, X,
} from 'lucide-react';
import { Brand, CameraRule, Decor, Footer, HeartRule } from './Brand';
import { Steps } from './Steps';
import { buildZip, captureVideoFrame, normalizeSelfie, planZipParts, triggerDownload } from '@/lib/client/media';

const SCAN_MESSAGES = [
  'Looking for your smile…',
  'Searching through the celebration…',
  'Finding every moment you were in…',
  'Almost there…',
];
const STORE_MINUTES = 50; // preview links last 60 min

export default function GuestFlow({ event }) {
  const [step, setStep] = useState('welcome');
  const [selfie, setSelfie] = useState(null); // { blob, url }
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { token, matches, indexIncomplete, expiresAt }
  const storeKey = `jww:${event.slug}`;

  // Restore a recent session after refresh.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storeKey) || 'null');
      if (saved && Date.now() - saved.savedAt < STORE_MINUTES * 60000 && new Date(saved.expiresAt) > new Date()) {
        setResult(saved);
        setStep('results');
      }
    } catch { /* ignore */ }
  }, [storeKey]);

  const reset = useCallback(() => {
    try { sessionStorage.removeItem(storeKey); } catch { /* ignore */ }
    setResult(null);
    setSelfie((s) => { if (s?.url) URL.revokeObjectURL(s.url); return null; });
    setError('');
    setStep('capture');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [storeKey]);

  const scan = async () => {
    if (!selfie || !consent) return;
    setError('');
    setStep('scanning');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const started = Date.now();
    try {
      const form = new FormData();
      form.append('event', event.slug);
      form.append('consent', 'yes');
      form.append('selfie', selfie.blob, 'selfie.jpg');
      const res = await fetch('/api/match', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      // keep the animation visible long enough to feel intentional
      const wait = 1800 - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
      if (!body.matches?.length) {
        setResult({ matches: [], indexIncomplete: body.indexIncomplete });
        setStep('nomatch');
        return;
      }
      const data = { token: body.token, matches: body.matches, indexIncomplete: body.indexIncomplete, expiresAt: body.expiresAt, savedAt: Date.now() };
      try { sessionStorage.setItem(storeKey, JSON.stringify(data)); } catch { /* ignore */ }
      setResult(data);
      setStep('results');
    } catch (e) {
      setError(e.message);
      setStep('capture');
    }
  };

  return (
    <div className="page">
      <Decor />
      <header className="wrap" style={{ textAlign: 'center', paddingTop: step === 'welcome' ? 44 : 22 }}>
        <Brand size={step === 'welcome' ? 'lg' : 'sm'} href={null} />
      </header>

      <main className="wrap" style={{ textAlign: 'center' }}>
        {step === 'welcome' && <Welcome event={event} onStart={() => { setStep('capture'); window.scrollTo({ top: 0 }); }} />}
        {step === 'capture' && (
          <Capture event={event} selfie={selfie} setSelfie={setSelfie} consent={consent} setConsent={setConsent}
            error={error} setError={setError} onScan={scan} onBack={() => setStep('welcome')} />
        )}
        {step === 'scanning' && <Scanning selfie={selfie} />}
        {step === 'nomatch' && <NoMatch indexIncomplete={result?.indexIncomplete} onRetry={reset} />}
        {step === 'results' && result && <Results event={event} result={result} onRestart={reset} />}
      </main>
      <Footer />
    </div>
  );
}

/* ───────────────────────── Welcome ───────────────────────── */
function Welcome({ event, onStart }) {
  return (
    <div className="fade-in">
      <CameraRule />
      <div className="eyebrow">Welcome to the wedding of</div>
      <h1 className="couple" style={{ margin: '14px 0 6px' }}>{event.couple}</h1>
      {(event.date || event.venue) && (
        <p className="serif" style={{ fontSize: 20, color: 'var(--cocoa)', margin: '6px 0 0', letterSpacing: '.04em' }}>
          {[event.date, event.venue].filter(Boolean).join(' · ')}
        </p>
      )}
      <HeartRule />
      <h2 className="display" style={{ fontSize: 'clamp(26px, 6.4vw, 46px)' }}>Find Your<br />Wedding Photos</h2>
      <p className="subtitle">Scan Your Face &amp; Download<br />Your Memories</p>
      <div style={{ marginTop: 30 }}>
        <button className="btn btn-primary" onClick={onStart}><Camera aria-hidden="true" /> Find My Photos</button>
      </div>
      <p className="small muted" style={{ marginTop: 14 }}>Free full-resolution downloads · No sign-up</p>
      <div style={{ marginTop: 46 }}><Steps /></div>
    </div>
  );
}

/* ───────────────────────── Capture ───────────────────────── */
function Capture({ selfie, setSelfie, consent, setConsent, error, setError, onScan, onBack }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const nativeCamRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);
  useEffect(() => stopCamera, [stopCamera]);

  const setBlob = async (blob) => {
    setBusy(true);
    setError('');
    try {
      const jpeg = await normalizeSelfie(blob);
      setSelfie((old) => { if (old?.url) URL.revokeObjectURL(old.url); return { blob: jpeg, url: URL.createObjectURL(jpeg) }; });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const startCamera = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) { nativeCamRef.current?.click(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      streamRef.current = stream;
      setSelfie((old) => { if (old?.url) URL.revokeObjectURL(old.url); return null; });
      setCameraOn(true);
      requestAnimationFrame(() => { if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); } });
    } catch (e) {
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      setError(denied
        ? 'Camera access was blocked. Allow camera access in your browser settings, or upload a selfie from your gallery instead.'
        : 'We could not start the camera. You can upload a selfie from your gallery instead.');
    }
  };

  const capture = async () => {
    try {
      const blob = await captureVideoFrame(videoRef.current);
      stopCamera();
      await setBlob(blob);
    } catch (e) { setError(e.message); }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    stopCamera();
    await setBlob(f);
  };

  return (
    <div className="narrow fade-in" style={{ margin: '0 auto' }}>
      <h1 className="display" style={{ fontSize: 'clamp(24px, 6vw, 38px)', marginTop: 18 }}>Scan Your Face</h1>
      <p className="muted" style={{ margin: '10px auto 22px', maxWidth: 420, lineHeight: 1.6 }}>
        Take a clear, front-facing selfie in good light — no sunglasses or masks.
      </p>

      <div className="card" style={{ padding: 18 }}>
        <div className="frame" style={{ maxWidth: 340, margin: '0 auto' }}>
          <span className="c3" /><span className="c4" />
          <div className="frame-inner">
            {cameraOn ? (
              <>
                <video ref={videoRef} className="mirror" playsInline muted autoPlay aria-label="Camera preview" />
                <div className="face-guide" aria-hidden="true" />
              </>
            ) : selfie ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selfie.url} alt="Your selfie preview" />
            ) : busy ? (
              <Loader2 className="spin" aria-label="Preparing photo" style={{ color: 'var(--terracotta)' }} />
            ) : (
              <div className="frame-empty">
                <Camera aria-hidden="true" />
                <div className="serif" style={{ fontSize: 19, color: 'var(--cocoa)' }}>Your selfie will appear here</div>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
          {cameraOn ? (
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={capture}><Camera aria-hidden="true" /> Capture</button>
              <button className="btn btn-ghost" onClick={stopCamera}>Cancel</button>
            </div>
          ) : (
            <div className="grid-2" style={{ gap: 10 }}>
              <button className="btn btn-ghost" onClick={startCamera} disabled={busy}><Camera aria-hidden="true" /> {selfie ? 'Retake' : 'Take selfie'}</button>
              <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}><ImagePlus aria-hidden="true" /> Upload photo</button>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
          <input ref={nativeCamRef} type="file" accept="image/*" capture="user" hidden onChange={onFile} />
        </div>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 16, textAlign: 'left' }}><AlertCircle aria-hidden="true" /><span>{error}</span></div>}

        <div className="notice notice-info" style={{ marginTop: 16, textAlign: 'left' }}>
          <ShieldCheck aria-hidden="true" style={{ color: 'var(--terracotta)' }} />
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I agree that my selfie is used only to find my photos from this wedding. It is processed securely and <strong>not stored</strong>. <Link href="/privacy" target="_blank" style={{ color: 'var(--terracotta)' }}>Privacy policy</Link></span>
          </label>
        </div>

        <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} disabled={!selfie || !consent || busy || cameraOn} onClick={onScan}>
          Find My Photos
        </button>
        {!selfie && !cameraOn && <p className="small muted" style={{ margin: '10px 0 0' }}>Add a selfie and tick the consent box to continue.</p>}
      </div>

      <button className="btn btn-quiet" style={{ marginTop: 14 }} onClick={() => { stopCamera(); onBack(); }}><ArrowLeft aria-hidden="true" /> Back</button>
    </div>
  );
}

/* ───────────────────────── Scanning ───────────────────────── */
function Scanning({ selfie }) {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((n) => (n + 1) % SCAN_MESSAGES.length), 1600); return () => clearInterval(t); }, []);
  return (
    <div className="narrow fade-in" style={{ margin: '24px auto 0' }} role="status" aria-live="polite">
      <div className="frame" style={{ maxWidth: 280, margin: '0 auto' }}>
        <span className="c3" /><span className="c4" />
        <div className="frame-inner">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {selfie && <img src={selfie.url} alt="" style={{ filter: 'saturate(.85) brightness(1.03)' }} />}
          <div className="scanline" aria-hidden="true" />
        </div>
      </div>
      <h1 className="display" style={{ fontSize: 'clamp(22px, 5.6vw, 32px)', marginTop: 26 }}>Finding your photos</h1>
      <p className="serif" style={{ fontSize: 21, color: 'var(--terracotta)', minHeight: 30, margin: '10px 0 0', fontStyle: 'italic' }}>{SCAN_MESSAGES[i]}</p>
      <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 14 }}>
        <span className="pulse-dot" /><span className="pulse-dot" style={{ animationDelay: '.2s' }} /><span className="pulse-dot" style={{ animationDelay: '.4s' }} />
      </div>
    </div>
  );
}

/* ───────────────────────── No match ───────────────────────── */
function NoMatch({ indexIncomplete, onRetry }) {
  return (
    <div className="narrow fade-in" style={{ margin: '24px auto 0' }}>
      <div className="card" style={{ padding: '30px 24px' }}>
        <h1 className="serif" style={{ fontSize: 32, color: 'var(--cocoa)', fontWeight: 600, margin: 0 }}>We couldn&apos;t find you yet</h1>
        <p className="muted" style={{ lineHeight: 1.65, margin: '12px 0 18px' }}>
          {indexIncomplete
            ? 'The photographers are still adding photos to this gallery. Please try again a little later — more moments are on their way.'
            : 'We didn’t find a confident match. Try another selfie facing the camera in brighter light, without sunglasses, hats or filters.'}
        </p>
        <ul style={{ textAlign: 'left', lineHeight: 1.9, color: 'var(--ink)', margin: '0 0 22px', paddingLeft: 20 }}>
          <li>Face the camera straight on</li>
          <li>Use natural light; avoid strong backlight</li>
          <li>Remove sunglasses and keep hair off your face</li>
        </ul>
        <button className="btn btn-primary" onClick={onRetry}><RefreshCw aria-hidden="true" /> Try another selfie</button>
      </div>
    </div>
  );
}

/* ───────────────────────── Results ───────────────────────── */
function Results({ event, result, onRestart }) {
  const { matches, token, indexIncomplete } = result;
  const [selected, setSelected] = useState(() => new Set());
  const [viewer, setViewer] = useState(-1);
  const [job, setJob] = useState(null); // { label, done, total }
  const [notice, setNotice] = useState(null);
  const [loaded, setLoaded] = useState({});
  const abortRef = useRef(null);
  const selectMode = selected.size > 0;

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const authorize = async (ids) => {
    const files = [];
    for (let i = 0; i < ids.length; i += 200) {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ photoIds: ids.slice(i, i + 200) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(body.error || 'Download failed.');
        err.code = body.code;
        throw err;
      }
      files.push(...body.files);
    }
    return files;
  };

  const handleError = (e) => {
    if (e?.name === 'AbortError') { setNotice({ type: 'info', text: 'Download cancelled.' }); return; }
    setNotice({ type: 'error', text: e.message, expired: e.code === 'SESSION_EXPIRED' });
  };

  const downloadOne = async (id) => {
    setNotice(null);
    try {
      const [file] = await authorize([id]);
      triggerDownload(file.url, file.name);
    } catch (e) { handleError(e); }
  };

  const shareOne = async (id) => {
    setNotice(null);
    try {
      setJob({ label: 'Preparing photo', done: 0, total: 1 });
      const [file] = await authorize([id]);
      const blob = await (await fetch(file.fetchUrl || file.url)).blob();
      const f = new File([blob], file.name, { type: blob.type || 'image/jpeg' });
      setJob(null);
      if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: `${event.couple} wedding` });
      else triggerDownload(URL.createObjectURL(blob), file.name);
    } catch (e) { setJob(null); if (e?.name !== 'AbortError') handleError(e); }
  };

  const downloadMany = async (ids) => {
    if (!ids.length) return;
    if (ids.length === 1) return downloadOne(ids[0]);
    setNotice(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setJob({ label: 'Preparing your photos', done: 0, total: ids.length });
      const files = await authorize(ids);
      const parts = planZipParts(files);
      const base = `${event.couple.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'wedding'}-photos`;
      let offset = 0;
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const label = parts.length > 1 ? `Packing ZIP ${p + 1} of ${parts.length}` : 'Packing your ZIP';
        const blob = await buildZip(part, {
          signal: controller.signal,
          onProgress: (d) => setJob({ label, done: offset + d, total: files.length }),
        });
        offset += part.length;
        const url = URL.createObjectURL(blob);
        triggerDownload(url, parts.length > 1 ? `${base}-part-${p + 1}.zip` : `${base}.zip`);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      setNotice({ type: 'ok', text: `${files.length} photos downloaded in full resolution${parts.length > 1 ? ` across ${parts.length} ZIP files` : ''}.` });
    } catch (e) {
      handleError(e);
    } finally {
      setJob(null);
      abortRef.current = null;
    }
  };

  const allIds = matches.map((m) => m.id);
  const current = viewer >= 0 ? matches[viewer] : null;

  return (
    <div className="fade-in" style={{ textAlign: 'left' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="eyebrow" style={{ marginTop: 12 }}>{event.couple}</div>
        <h1 className="display" style={{ fontSize: 'clamp(24px, 6vw, 42px)', marginTop: 12 }}>Your Wedding Memories<br />Are Ready!</h1>
        <p className="serif" style={{ fontSize: 21, color: 'var(--terracotta)', fontStyle: 'italic', margin: '12px 0 0' }}>
          We found {matches.length} {matches.length === 1 ? 'photo' : 'photos'} of you
        </p>
      </div>

      {indexIncomplete && (
        <div className="notice notice-info" style={{ marginTop: 18 }}><Info aria-hidden="true" style={{ color: 'var(--terracotta)' }} /><span>More photos are still being added to this gallery. Come back later and scan again to find new ones.</span></div>
      )}

      <div className="toolbar" style={{ marginTop: 22 }}>
        <div className="count" aria-live="polite">{selectMode ? `${selected.size} selected` : `${matches.length} photos · tap to view`}</div>
        <div className="actions">
          {selectMode ? (
            <>
              <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
              <button className="btn btn-primary" disabled={!!job} onClick={() => downloadMany([...selected])}><Download aria-hidden="true" /> Download {selected.size}</button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => setSelected(new Set(allIds))}><CheckCheck aria-hidden="true" /> Select</button>
              <button className="btn btn-primary" disabled={!!job} onClick={() => downloadMany(allIds)}><Download aria-hidden="true" /> Download all</button>
            </>
          )}
        </div>
      </div>

      {job && (
        <div className="card" style={{ padding: 16, marginTop: 14 }} role="status" aria-live="polite">
          <div className="spread small" style={{ marginBottom: 10 }}>
            <span><Loader2 className="spin" aria-hidden="true" style={{ width: 16, height: 16, verticalAlign: '-3px', marginRight: 6 }} />{job.label}… {job.done}/{job.total}</span>
            {abortRef.current && <button className="btn btn-quiet" onClick={() => abortRef.current?.abort()}>Cancel</button>}
          </div>
          <div className="progress"><span style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} /></div>
          <p className="small muted" style={{ margin: '10px 0 0' }}>Keep this page open — full-resolution photos can take a moment.</p>
        </div>
      )}

      {notice && (
        <div className={`notice notice-${notice.type === 'error' ? 'error' : notice.type === 'ok' ? 'ok' : 'info'}`} style={{ marginTop: 14 }} role="status">
          {notice.type === 'ok' ? <Check aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
          <span>{notice.text} {notice.expired && <button className="btn btn-quiet" onClick={onRestart}>Scan again</button>}</span>
        </div>
      )}

      <div className="gallery">
        {matches.map((m, idx) => (
          <button key={m.id} className={`tile ${selected.has(m.id) ? 'selected' : ''} ${loaded[m.id] ? '' : 'skeleton'}`}
            style={{ animationDelay: `${Math.min(idx, 12) * 40}ms` }}
            aria-label={`${selectMode ? (selected.has(m.id) ? 'Deselect' : 'Select') : 'Open'} photo ${idx + 1}`}
            aria-pressed={selectMode ? selected.has(m.id) : undefined}
            onClick={() => (selectMode ? toggle(m.id) : setViewer(idx))}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {m.previewUrl && <img src={m.previewUrl} alt="" loading={idx < 8 ? 'eager' : 'lazy'} onLoad={() => setLoaded((l) => ({ ...l, [m.id]: true }))} />}
            <span className="tick" role="checkbox" aria-checked={selected.has(m.id)} aria-label="Select photo"
              onClick={(e) => { e.stopPropagation(); toggle(m.id); }}><Check aria-hidden="true" /></span>
          </button>
        ))}
      </div>

      <div style={{ textAlign: 'center', marginTop: 28 }}>
        <p className="small muted">Previews are shown here. Every download is the original, full-resolution photograph — free.</p>
        <button className="btn btn-quiet" onClick={onRestart}><RefreshCw aria-hidden="true" /> Scan a different face</button>
      </div>

      {current && (
        <Lightbox
          index={viewer}
          total={matches.length}
          photo={current}
          onClose={() => setViewer(-1)}
          onPrev={() => setViewer((v) => (v - 1 + matches.length) % matches.length)}
          onNext={() => setViewer((v) => (v + 1) % matches.length)}
          onDownload={() => downloadOne(current.id)}
          onShare={() => shareOne(current.id)}
        />
      )}
    </div>
  );
}

function Lightbox({ index, total, photo, onClose, onPrev, onNext, onDownload, onShare }) {
  const touch = useRef(null);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && !!navigator.canShare && /iPhone|iPad|Android/i.test(navigator.userAgent));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowLeft') onPrev(); if (e.key === 'ArrowRight') onNext(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose, onPrev, onNext]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Photo ${index + 1} of ${total}`}
      onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - (touch.current ?? 0); if (Math.abs(dx) > 50) (dx > 0 ? onPrev : onNext)(); }}>
      <div className="lightbox-top">
        <span className="small" style={{ letterSpacing: '.14em' }}>{index + 1} / {total}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="lightbox-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.previewUrl} alt={`Wedding photo ${index + 1}`} />
      </div>
      <div className="lightbox-bottom">
        <button className="icon-btn" onClick={onPrev} aria-label="Previous photo"><ChevronLeft /></button>
        <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
          {canShare && <button className="btn btn-ghost" style={{ minHeight: 44 }} onClick={onShare}><Share aria-hidden="true" /> Save</button>}
          <button className="btn btn-primary" style={{ minHeight: 44 }} onClick={onDownload}><Download aria-hidden="true" /> Download</button>
        </div>
        <button className="icon-btn" onClick={onNext} aria-label="Next photo"><ChevronRight /></button>
      </div>
    </div>
  );
}
