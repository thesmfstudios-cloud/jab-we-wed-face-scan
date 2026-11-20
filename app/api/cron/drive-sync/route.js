import { NextResponse } from 'next/server';
import { getAdminSupabase } from '@/lib/server/supabase-admin';
import { ADMIN_EVENT_FIELDS } from '@/lib/server/admin-events';
import { safeEqual } from '@/lib/server/security';
import { friendlyDriveError } from '@/lib/server/google-drive';
import { syncDriveFolder } from '@/lib/server/drive-sync';
import { indexNextBatch } from '@/lib/server/indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BUDGET_MS = 240_000; // stop starting new batches after 4 minutes

/**
 * Automatic Drive sync + face scan for every wedding linked to a Drive folder.
 * Runs on the Vercel cron schedule (vercel.json) and can be called by hand.
 * Auth: "Authorization: Bearer <CRON_SECRET>" (what Vercel cron sends) or ?secret=.
 * Optional ?event=<slug> limits it to one wedding. Each run continues where
 * the last one stopped, so a big wedding is finished over a few runs.
 */
export async function GET(request) {
  const secret = process.env.CRON_SECRET || '';
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || request.nextUrl.searchParams.get('secret') || '';
  if (secret.length < 16 || !safeEqual(given, secret)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const started = Date.now();
  const supabase = getAdminSupabase();
  let q = supabase.from('jw_events').select(ADMIN_EVENT_FIELDS).not('drive_folder_id', 'is', null).neq('status', 'archived');
  const only = request.nextUrl.searchParams.get('event');
  if (only) q = q.eq('slug', only.toLowerCase());
  const { data: events, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const report = [];
  for (const event of events || []) {
    const r = { slug: event.slug };
    report.push(r);
    try {
      const s = await syncDriveFolder(event, event.drive_folder_id);
      Object.assign(r, { found: s.found, added: s.added });
    } catch (e) {
      r.syncError = friendlyDriveError(e);
    }
    try {
      let batch;
      r.indexed = 0; r.errors = 0;
      do {
        if (Date.now() - started > BUDGET_MS) { r.stoppedEarly = true; break; }
        batch = await indexNextBatch(event);
        r.indexed += batch.processed - batch.errors; r.errors += batch.errors;
      } while (!batch.done && batch.processed > 0);
      if (batch) Object.assign(r, { remaining: batch.remaining, photos: batch.event.photos_count, faces: batch.event.faces_count });
    } catch (e) {
      r.indexError = e?.message || 'Indexing failed';
    }
  }
  console.log('drive auto-sync', JSON.stringify(report));
  return NextResponse.json({ ok: true, tookMs: Date.now() - started, events: report });
}
