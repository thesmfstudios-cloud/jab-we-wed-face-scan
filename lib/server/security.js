import 'server-only';
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAdminSupabase } from './supabase-admin';

export const ADMIN_COOKIE = 'jww_admin';
const ADMIN_SESSION_HOURS = 12;

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(ab, bb) && String(a) === String(b);
}

function sessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 24) throw new Error('ADMIN_SESSION_SECRET must be set (24+ characters).');
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

/** Admin session value: "<expiresMs>.<nonce>.<hmac>" — bound to the current access code. */
export function createAdminSessionValue() {
  const expires = Date.now() + ADMIN_SESSION_HOURS * 3600 * 1000;
  const nonce = randomToken(12);
  const codeFingerprint = sha256(process.env.ADMIN_ACCESS_CODE || '').slice(0, 16);
  const payload = `${expires}.${nonce}`;
  return { value: `${payload}.${sign(`${payload}.${codeFingerprint}`)}`, maxAge: ADMIN_SESSION_HOURS * 3600 };
}

export function verifyAdminSessionValue(value) {
  try {
    const [expires, nonce, mac] = String(value || '').split('.');
    if (!expires || !nonce || !mac) return false;
    if (Number(expires) < Date.now()) return false;
    const codeFingerprint = sha256(process.env.ADMIN_ACCESS_CODE || '').slice(0, 16);
    const expected = sign(`${expires}.${nonce}.${codeFingerprint}`);
    return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function isAdmin(request) {
  return verifyAdminSessionValue(request.cookies.get(ADMIN_COOKIE)?.value);
}

/** Returns a 401 response if not admin, otherwise null. */
export function requireAdmin(request) {
  if (!isAdmin(request)) return NextResponse.json({ error: 'Please sign in to the admin dashboard.' }, { status: 401 });
  // Basic CSRF defence for cookie-authenticated mutations.
  if (request.method !== 'GET' && !sameOrigin(request)) {
    return NextResponse.json({ error: 'Cross-site request blocked.' }, { status: 403 });
  }
  return null;
}

export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients / same-origin GET navigations
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

export function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
}

/** Distributed fixed-window rate limit backed by Postgres. Fails open on DB errors. */
export async function rateLimit(request, action, max, windowSeconds) {
  try {
    const key = `${action}:${sha256(`${clientIp(request)}|${process.env.ADMIN_SESSION_SECRET || ''}`).slice(0, 32)}`;
    const { data, error } = await getAdminSupabase().rpc('jw_rate_limit_hit', {
      p_key: key, p_window_seconds: windowSeconds, p_max: max,
    });
    if (error) throw error;
    return data !== false;
  } catch (error) {
    console.error('rate limit check failed', error?.message);
    return true;
  }
}

export function jsonError(message, status = 400, extra = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Short-lived, per-photo download ticket for originals that the server
 * streams (private Google Drive photos): "<sessionId>.<photoId>.<expiresMs>.<hmac>".
 * Only issued by /api/download after the face-match session is verified.
 */
export function createDownloadTicket(sessionId, photoId, seconds) {
  const payload = `${sessionId}.${photoId}.${Date.now() + seconds * 1000}`;
  return `${payload}.${sign(`dl.${payload}`)}`;
}

export function verifyDownloadTicket(ticket) {
  try {
    const [sessionId, photoId, expires, mac] = String(ticket || '').split('.');
    if (!UUID_RE.test(sessionId || '') || !UUID_RE.test(photoId || '') || !mac) return null;
    if (!(Number(expires) > Date.now())) return null;
    const expected = sign(`dl.${sessionId}.${photoId}.${expires}`);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    return { sessionId, photoId };
  } catch {
    return null;
  }
}
