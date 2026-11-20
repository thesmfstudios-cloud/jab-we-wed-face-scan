import 'server-only';
import { getAdminSupabase } from './supabase-admin';
import { loadAdminEvent } from './admin-events';
import { syncDriveFolder } from './drive-sync';
import { indexNextBatch } from './indexer';

const EVERY_SECONDS = 180; // at most one background refresh per wedding every 3 minutes
const BUDGET_MS = 50_000;

/**
 * Keep a wedding's gallery fresh without the admin: pick up new photos from its
 * Drive folder and face-scan anything not yet scanned. Runs in the background
 * (Next.js after() in route handlers — not in server components, where GET
 * fetches are memoized) when guests open the gallery or scan their face, and is
 * throttled per wedding through the Postgres rate-limit table.
 */
export async function refreshEventInBackground(eventId) {
  const started = Date.now();
  try {
    const supabase = getAdminSupabase();
    const { data: allowed, error } = await supabase.rpc('jw_rate_limit_hit', { p_key: `autorefresh:${eventId}`, p_window_seconds: EVERY_SECONDS, p_max: 1 });
    if (error || allowed === false) return { skipped: true };
    let event = await loadAdminEvent(eventId);
    if (!event || event.status === 'archived') return { skipped: true };
    const out = { added: 0, indexed: 0 };
    if (event.drive_folder_id) {
      try {
        const s = await syncDriveFolder(event, event.drive_folder_id);
        out.added = s.added;
        event = s.event;
      } catch (e) { out.syncError = e?.message; }
    }
    if (event.indexed_count < event.photos_count) {
      for (;;) {
        if (Date.now() - started > BUDGET_MS) break;
        const r = await indexNextBatch(event);
        out.indexed += r.processed - r.errors;
        if (r.done || r.processed === 0) break;
      }
    }
    if (out.added || out.indexed || out.syncError) console.log('auto-refresh', event.slug, JSON.stringify(out));
    return out;
  } catch (e) {
    console.error('auto-refresh failed:', e?.message);
    return { error: e?.message };
  }
}
