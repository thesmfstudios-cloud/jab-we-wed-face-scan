import 'server-only';
import sharp from 'sharp';

/**
 * Server-side twin of the browser uploader's makePreview(): rotate per EXIF,
 * fit within 1600px, JPEG, and keep it under ~900 KB (Rekognition's byte
 * limit is 5 MB; small previews also load fast for guests).
 */
export async function makeServerPreview(input) {
  let max = 1600;
  let quality = 85;
  let out = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    out = await sharp(input, { failOn: 'none', limitInputPixels: 300_000_000 })
      .rotate()
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= 900 * 1024) break;
    quality = Math.max(60, quality - 6);
    if (quality <= 66) max = Math.max(1100, Math.round(max * 0.88));
  }
  return out;
}
