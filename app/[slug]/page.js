import { notFound, redirect } from 'next/navigation';
import { slugify } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Short links for printed QR codes, e.g. photos.jabwewed.in/01-Anjali-anukool
 * → /w/01-anjali-anukool. Static routes (/admin, /privacy, /w/...) take
 * priority over this dynamic segment, so they are unaffected.
 */
export default async function ShortLink({ params }) {
  const { slug } = await params;
  const clean = slugify(decodeURIComponent(String(slug || '')));
  if (!clean || clean.length < 3) notFound();
  redirect(`/w/${clean}`);
}
