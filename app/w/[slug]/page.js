import { Brand, Decor, Footer } from '@/components/Brand';
import GuestFlow from '@/components/GuestFlow';
import ComingSoon from '@/components/ComingSoon';
import { getEventBySlug, isGuestOpen } from '@/lib/server/supabase-admin';
import { coupleNames, formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

async function load(slug) {
  try {
    return await getEventBySlug(slug);
  } catch (error) {
    console.error('event load failed', error?.message);
    return undefined; // distinguishes "error" from "not found" (null)
  }
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const event = await load(slug);
  if (!event || event.status === 'draft') return { title: 'Wedding gallery', robots: { index: false } };
  return {
    title: `${coupleNames(event)} — Find your photos`,
    description: `Find and download your photos from ${coupleNames(event)}'s wedding. By SMF Studios.`,
    robots: { index: false, follow: false },
  };
}

export default async function WeddingPage({ params }) {
  const { slug } = await params;
  const event = await load(slug);
  // Gallery not created yet, still a draft, or not opened to guests:
  // show the "photos coming soon" landing page with the WhatsApp inquiry.
  if (event === null || event?.status === 'draft' || (event && !isGuestOpen(event) && event.status !== 'archived')) {
    const ready = event && event.status !== 'draft';
    return <ComingSoon couple={ready ? coupleNames(event) : ''} date={ready ? formatDate(event.event_date) : ''} />;
  }

  if (event === undefined || !isGuestOpen(event)) {
    const archived = event?.status === 'archived';
    return (
      <div className="page">
        <Decor />
        <main className="wrap narrow" style={{ textAlign: 'center', paddingTop: 56 }}>
          <Brand size="md" />
          {event && <h1 className="couple" style={{ marginTop: 28 }}>{coupleNames(event)}</h1>}
          <div className="card" style={{ padding: 26, marginTop: 24 }}>
            <p className="lead" style={{ margin: 0 }}>
              {event === undefined
                ? 'We could not open this gallery right now. Please try again in a moment.'
                : archived
                  ? 'This wedding gallery has been archived and is no longer available for downloads.'
                  : 'The photographers are still preparing this gallery. Please check back soon.'}
            </p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <GuestFlow
      event={{
        slug: event.slug,
        couple: coupleNames(event),
        title: event.title,
        date: formatDate(event.event_date),
        venue: event.venue || '',
      }}
    />
  );
}
