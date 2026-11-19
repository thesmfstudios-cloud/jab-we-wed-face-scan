import Link from 'next/link';
import { Brand, Decor } from './Brand';
import { CONTACT, COUPLE_PHOTO } from '@/lib/site-config';

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.4 8.4 0 1 1 21 11.5z" />
    </svg>
  );
}

/**
 * Single-screen "photos coming soon" landing page: couple photo, a warm note
 * that the photos are being prepared, and a WhatsApp inquiry button.
 */
export default function ComingSoon({ couple = '', date = '' }) {
  const wa = `https://wa.me/${CONTACT.whatsapp}?text=${encodeURIComponent(CONTACT.whatsappText)}`;
  return (
    <div className="page">
      <Decor />
      <main className="wrap soon">
        <div className="fade-in"><Brand size="sm" /></div>

        <div className="soon-arch fade-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={COUPLE_PHOTO} alt={couple ? `${couple} at their wedding` : 'The couple at their wedding'} width="900" height="1124" />
        </div>

        {couple && <h1 className="soon-couple">{couple}</h1>}
        {date && <div className="soon-date">{date}</div>}

        <div className="soon-badge"><span aria-hidden="true" />Photos coming soon</div>

        <h2 className="soon-title">Your memories are being beautifully crafted</h2>
        <p className="soon-hi" lang="hi">
          हर पल को हम प्यार से सँवार रहे हैं। कुछ दिन बाद यही QR फिर से स्कैन करें, फ़ोटो यहीं मिलेंगी।
        </p>

        <a href={wa} className="btn btn-primary btn-block soon-wa" target="_blank" rel="noreferrer">
          <WhatsAppIcon />WhatsApp for inquiry
        </a>
        <a href={`tel:${CONTACT.phoneTel}`} className="soon-phone">{CONTACT.phoneDisplay}</a>

        <div className="soon-foot">
          <div className="soon-thanks">Thank you for being a part of our celebration!</div>
          <div className="footer-links">
            <a href={`https://instagram.com/${CONTACT.instagram}`} target="_blank" rel="noreferrer">@{CONTACT.instagram}</a>
            <Link href="/privacy">Privacy</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
