import 'server-only';
import path from 'node:path';
import sharp from 'sharp';

/**
 * "Jab We Wed" premium frame for guest downloads: ivory mount, fine terracotta
 * keyline, corner marks (as on the printed QR standee) and a signature band
 * with the couple's names, the brand script and the Instagram handle.
 * The photo itself keeps its full resolution.
 */

const FONTS = path.join(process.cwd(), 'assets', 'fonts');
const SCRIPT = path.join(FONTS, 'Allura-Regular.ttf');
const CAPS = path.join(FONTS, 'Cinzel.ttf');
const SERIF = path.join(FONTS, 'CormorantGaramond-Italic.ttf');

const IVORY = '#fbf5ee';
const ROSE = '#a65b4b';
const COCOA = '#5c2d25';
const HANDLE = '@jabwewed.in';

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function text(markup, family, fontfile, px, color, spacing = 0) {
  const span = `<span foreground="${color}"${spacing ? ` letter_spacing="${Math.round(spacing * 1024)}"` : ''}>${markup}</span>`;
  const { data, info } = await sharp({ text: { text: span, font: `${family} ${Math.max(6, Math.round(px))}`, fontfile, dpi: 72, rgba: true } })
    .png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

function heartSvg(size, color) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.7 3.7 4.5 7 4.5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.3 0 5.4 3.2 4.2 6.6-1.7 4.8-9.2 9.4-9.2 9.4z" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
}

/** Frame one photo. Returns a JPEG Buffer. `couple` / `date` are optional captions. */
export async function framePhoto(input, { couple = '', date = '' } = {}) {
  const base = sharp(input, { failOn: 'none', limitInputPixels: 300_000_000 }).rotate();
  const { data: photo, info } = await base.toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const s = Math.min(W, H);
  const m = Math.round(s * 0.05); // side/top mount
  const band = Math.round(s * 0.17); // signature band under the photo
  const CW = W + 2 * m, CH = H + m + band;

  // Keyline + corner marks (pure SVG shapes, no fonts needed).
  const k = Math.max(1, Math.round(s * 0.0016));
  const gap = Math.round(m * 0.32);
  const c = Math.round(m * 0.26), cl = Math.round(s * 0.06), cw = Math.max(2, Math.round(s * 0.0032));
  const x0 = c, y0 = c, x1 = CW - c, y1 = CH - c;
  const corners = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]
    .map(([x, y, dx, dy]) => `<path d="M${x} ${y + dy * cl} L${x} ${y} L${x + dx * cl} ${y}" fill="none" stroke="${ROSE}" stroke-width="${cw}" stroke-linecap="round"/>`).join('');
  const lines = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
    <rect x="${m - gap}" y="${m - gap}" width="${W + 2 * gap}" height="${H + 2 * gap}" fill="none" stroke="${ROSE}" stroke-width="${k}"/>
    ${corners}
  </svg>`);

  // Signature band.
  const bandTop = m + H + gap;
  const bandH = CH - bandTop - c;
  const mid = bandTop + bandH / 2;
  const layers = [];

  const jab = await text('jab', 'Allura', SCRIPT, bandH * 0.5, ROSE);
  const wed = await text('we wed..', 'Allura', SCRIPT, bandH * 0.5, ROSE);
  const hs = Math.round(bandH * 0.22);
  const by = await text('BY SMF STUDIOS', 'Cinzel', CAPS, bandH * 0.1, COCOA, bandH * 0.035);
  const logoW = jab.width + Math.round(hs * 0.15) + hs + wed.width + Math.round(hs * 0.3);
  const logoH = Math.max(jab.height, wed.height);
  const blockH = logoH + by.height;
  let lx = Math.round(CW / 2 - logoW / 2);
  const ly = Math.round(mid - blockH / 2);
  layers.push({ input: jab.input, left: lx, top: ly });
  lx += jab.width + Math.round(hs * 0.15);
  layers.push({ input: heartSvg(hs, ROSE), left: lx, top: Math.round(ly + logoH * 0.36) });
  lx += hs + Math.round(hs * 0.3);
  layers.push({ input: wed.input, left: lx, top: ly });
  layers.push({ input: by.input, left: Math.round(CW / 2 - by.width / 2), top: ly + logoH - Math.round(by.height * 0.15) });

  // Side captions only when there is room beside the centre logo.
  const sideRoom = (CW - logoW) / 2 - m * 1.2;
  if (couple && sideRoom > s * 0.18) {
    let names = await text(esc(couple), 'Cormorant Garamond', SERIF, bandH * 0.2, COCOA);
    if (names.width > sideRoom) names = await text(esc(couple), 'Cormorant Garamond', SERIF, bandH * 0.2 * (sideRoom / names.width), COCOA);
    const d = date ? await text(esc(date.toUpperCase()), 'Cinzel', CAPS, bandH * 0.085, ROSE, bandH * 0.02) : null;
    const h = names.height + (d ? d.height : 0);
    const top = Math.round(mid - h / 2);
    layers.push({ input: names.input, left: m, top });
    if (d && d.width <= sideRoom) layers.push({ input: d.input, left: m, top: top + names.height });
  }
  if (sideRoom > s * 0.12) {
    let handle = await text(HANDLE, 'Cinzel', CAPS, bandH * 0.1, COCOA, bandH * 0.02);
    if (handle.width > sideRoom) handle = await text(HANDLE, 'Cinzel', CAPS, bandH * 0.1 * (sideRoom / handle.width), COCOA);
    layers.push({ input: handle.input, left: CW - m - handle.width, top: Math.round(mid - handle.height / 2) });
  }

  return sharp({ create: { width: CW, height: CH, channels: 3, background: IVORY } })
    .composite([{ input: photo, left: m, top: m }, { input: lines, left: 0, top: 0 }, ...layers])
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .withMetadata({ density: info.density || 300 })
    .toBuffer();
}

/** File name for a framed download: keep the original name, force .jpg. */
export function framedName(name) {
  const base = String(name || 'photo').replace(/\.[a-z0-9]{2,5}$/i, '');
  return `${base}-jab-we-wed.jpg`;
}
