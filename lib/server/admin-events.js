import 'server-only';
import { getAdminSupabase } from './supabase-admin';
import { UUID_RE } from './security';
import { SLUG_RE } from '../format';

export const ADMIN_EVENT_FIELDS = 'id,slug,title,bride_name,groom_name,event_date,venue,status,guest_access,photos_count,indexed_count,faces_count,drive_folder_id,drive_synced_at,created_at,updated_at';

export async function loadAdminEvent(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { data, error } = await getAdminSupabase().from('jw_events').select(ADMIN_EVENT_FIELDS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

/** Validate & normalise admin input for create/update. Returns { values, error }. */
export function parseEventInput(body, { partial = false } = {}) {
  const values = {};
  const err = (m) => ({ error: m });
  if (!partial || 'brideName' in body) {
    values.bride_name = clip(body.brideName, 80);
    if (!values.bride_name) return err('Bride name is required.');
  }
  if (!partial || 'groomName' in body) {
    values.groom_name = clip(body.groomName, 80);
    if (!values.groom_name) return err('Groom name is required.');
  }
  if (!partial || 'title' in body) {
    values.title = clip(body.title, 120) || `${values.bride_name || ''} & ${values.groom_name || ''} Wedding`.trim();
  }
  if (!partial || 'slug' in body) {
    values.slug = String(body.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(values.slug)) return err('Gallery link must be 3–64 lowercase letters, numbers or dashes.');
  }
  if ('eventDate' in body) {
    const d = clip(body.eventDate, 10);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return err('Invalid wedding date.');
    values.event_date = d;
  }
  if ('venue' in body) values.venue = clip(body.venue, 160);
  if ('status' in body) {
    if (!['draft', 'live', 'archived'].includes(body.status)) return err('Invalid status.');
    values.status = body.status;
  }
  if ('guestAccess' in body) values.guest_access = Boolean(body.guestAccess);
  return { values };
}
