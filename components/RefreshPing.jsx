'use client';

import { useEffect } from 'react';

/** Tells the server a guest is here, so it picks up & face-scans new photos in the background. */
export default function RefreshPing({ slug }) {
  useEffect(() => {
    if (slug) fetch(`/api/events/${encodeURIComponent(slug)}/refresh`, { method: 'POST', keepalive: true }).catch(() => {});
  }, [slug]);
  return null;
}
