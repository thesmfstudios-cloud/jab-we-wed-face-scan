import { NextResponse, after } from 'next/server';
import { getEventBySlug } from '@/lib/server/supabase-admin';
import { refreshEventInBackground } from '@/lib/server/auto-refresh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Called by the guest page. Starts a background refresh of the wedding (new
 * Drive photos + face scan). Throttled per wedding; returns immediately.
 */
export async function POST(_request, { params }) {
  try {
    const { slug } = await params;
    const event = await getEventBySlug(slug);
    if (event?.id && event.status !== 'archived') after(() => refreshEventInBackground(event.id));
  } catch { /* never block the guest */ }
  return NextResponse.json({ ok: true });
}
