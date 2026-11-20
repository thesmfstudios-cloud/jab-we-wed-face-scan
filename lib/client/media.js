'use client';

import { Zip, ZipPassThrough } from 'fflate';

/** Decode any browser-readable image, fix orientation, downscale, re-encode as JPEG. */
export async function normalizeSelfie(blob, maxSide = 1600) {
  if (blob.size > 30 * 1024 * 1024) throw new Error('That photo is too large. Please choose a smaller one.');
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('We could not read that photo. Please take a new selfie or choose a JPG/PNG.'));
      el.src = url;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (Math.min(w, h) < 240) throw new Error('That photo is too small. Please use a clearer selfie.');
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d', { alpha: false }).drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (!out) throw new Error('Could not prepare your selfie.');
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function captureVideoFrame(video, maxSide = 1600) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new Error('Camera is not ready yet.');
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Capture failed.'))), 'image/jpeg', 0.92));
}

export function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const PART_BYTES = 450 * 1024 * 1024;
const PART_FILES = 150;
const DEFAULT_GUESS = 8 * 1024 * 1024;

/** Split files into ZIP parts small enough for phones to hold in memory. */
export function planZipParts(files) {
  const parts = [];
  let cur = [], bytes = 0;
  for (const f of files) {
    const b = Number(f.bytes) || DEFAULT_GUESS;
    if (cur.length && (bytes + b > PART_BYTES || cur.length >= PART_FILES)) { parts.push(cur); cur = []; bytes = 0; }
    cur.push(f); bytes += b;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function uniqueName(name, used) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name, n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${n++})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Stream full-resolution originals (via short-lived signed URLs) into a ZIP
 * in the browser. Avoids serverless response-size limits; files are stored
 * uncompressed (JPEGs don't compress) so quality is untouched.
 */
export async function buildZip(files, { onProgress, signal } = {}) {
  const chunks = [];
  let zipError = null;
  const zip = new Zip((err, data) => { if (err) zipError = err; else chunks.push(data); });
  const used = new Set();
  let done = 0;
  for (const f of files) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const res = await fetch(f.fetchUrl || f.url, { signal });
    if (!res.ok || !res.body) throw new Error(`Could not fetch ${f.name}.`);
    const entry = new ZipPassThrough(uniqueName(f.name, used));
    entry.mtime = new Date();
    zip.add(entry);
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      entry.push(value, false);
    }
    entry.push(new Uint8Array(0), true);
    if (zipError) throw zipError;
    done += 1;
    onProgress?.(done, files.length);
  }
  zip.end();
  if (zipError) throw zipError;
  return new Blob(chunks, { type: 'application/zip' });
}
