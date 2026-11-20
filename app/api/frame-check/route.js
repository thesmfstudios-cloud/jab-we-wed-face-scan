import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { framePhoto } from '@/lib/server/frame';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// TEMPORARY preview-only check that the frame renders on Vercel.
export async function GET(request) {
  try {
    const t = Date.now();
    const img = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#7a8fa3' } }).jpeg().toBuffer();
    const out = await framePhoto(img, { couple: 'Anjali & Anukool', date: '12 December 2026' });
    if (request.nextUrl.searchParams.get('img')) {
      const small = await sharp(out).resize(900).png().toBuffer();
      return new Response(small, { headers: { 'Content-Type': 'image/png' } });
    }
    const m = await sharp(out).metadata();
    const path = (await import('node:path')).default;
    const F = path.join(process.cwd(), 'assets', 'fonts');
    const w = async (font, file) => (await sharp({ text: { text: 'jab we wed', font: `${font} 100`, fontfile: path.join(F, file), dpi: 72, rgba: true } }).png().toBuffer({ resolveWithObject: true })).info.width;
    const widths = { allura: await w('Allura', 'Allura-Regular.ttf'), cinzel: await w('Cinzel', 'Cinzel.ttf'), serif: await w('Cormorant Garamond', 'CormorantGaramond-Italic.ttf'), fallback: await w('sans', 'nope.ttf').catch((e) => e.message) };
    return NextResponse.json({ ok: true, ms: Date.now() - t, bytes: out.length, width: m.width, height: m.height, widths });
  } catch (e) { return NextResponse.json({ ok: false, error: e.message, stack: String(e.stack).slice(0, 500) }); }
}
