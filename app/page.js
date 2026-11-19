import { Brand, CameraRule, Decor, Footer } from '@/components/Brand';
import { Steps } from '@/components/Steps';
import { GalleryCodeForm } from '@/components/GalleryCodeForm';
import ComingSoon from '@/components/ComingSoon';
import { COMING_SOON } from '@/lib/site-config';

export default function Home() {
  if (COMING_SOON) return <ComingSoon />;
  return (
    <div className="page">
      <Decor />
      <main className="wrap" style={{ textAlign: 'center', paddingTop: 48 }}>
        <div className="fade-in"><Brand size="lg" href={null} /></div>
        <CameraRule />
        <h1 className="display fade-in">Find Your<br />Wedding Photos</h1>
        <p className="subtitle fade-in">Scan Your Face &amp; Download<br />Your Memories</p>

        <div style={{ marginTop: 34 }}>
          <a href="#find" className="btn btn-primary">Find My Photos</a>
        </div>

        <section style={{ marginTop: 56 }} aria-labelledby="how">
          <h2 id="how" className="visually-hidden">How it works</h2>
          <Steps />
        </section>

        <section id="find" className="card narrow" style={{ margin: '56px auto 0', padding: '30px 24px', scrollMarginTop: 30 }}>
          <div className="eyebrow">Your wedding gallery</div>
          <p className="lead" style={{ margin: '10px 0 18px' }}>
            Scan the QR code at the venue, or enter the gallery name shared by the couple.
          </p>
          <GalleryCodeForm />
          <p className="small muted" style={{ marginTop: 16, lineHeight: 1.6 }}>
            Every photo is free to download in full resolution. Your selfie is used only to find your photos and is never stored.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
