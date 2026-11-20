-- Jab We Wed — Google Drive folder import.
-- Full-resolution originals stay in the photographer's Google Drive folder
-- (shared "Anyone with the link"). The app only stores a small preview per
-- photo (for face indexing and guest browsing) plus the Drive file id.

alter table public.jw_events add column if not exists drive_folder_id text;
alter table public.jw_events add column if not exists drive_synced_at timestamptz;

alter table public.jw_photos add column if not exists drive_file_id text;
create unique index if not exists jw_photos_event_drive_uq
  on public.jw_photos(event_id, drive_file_id) where drive_file_id is not null;
create index if not exists jw_photos_pending_idx
  on public.jw_photos(event_id) where processing_status = 'pending';

-- Count Drive photos waiting for their preview as "photos" too, so the
-- dashboard and guests see that the index is not complete yet.
create or replace function public.jw_refresh_event_counts(p_event_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.jw_events e set
    photos_count = (select count(*) from public.jw_photos p where p.event_id = p_event_id and p.processing_status in ('ready','pending')),
    indexed_count = (select count(*) from public.jw_photos p where p.event_id = p_event_id and p.indexed_at is not null),
    faces_count = (select coalesce(sum(face_count),0) from public.jw_photos p where p.event_id = p_event_id),
    updated_at = now()
  where e.id = p_event_id;
$$;
revoke all on function public.jw_refresh_event_counts(uuid) from public, anon, authenticated;
grant execute on function public.jw_refresh_event_counts(uuid) to service_role;
