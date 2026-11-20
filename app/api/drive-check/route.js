import { NextResponse } from 'next/server';
import { driveMode, getDriveFolder, listDriveImages, openDriveFile } from '@/lib/server/google-drive';
import { makeServerPreview } from '@/lib/server/preview';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// TEMPORARY preview-only check of link mode against the real Google Drive.
export async function GET() {
  const out = { mode: driveMode() };
  try {
    const id = '1NiMBS20pOexZbjvLZwp26B0Mpo34eU4r';
    out.folder = await getDriveFolder(id);
    out.images = await listDriveImages(id);
    const f = out.images.find((i) => /IMG_/.test(i.name)) || out.images[0];
    const res = await openDriveFile(f.id);
    const buf = Buffer.from(await res.arrayBuffer());
    out.download = { name: f.name, type: res.headers.get('content-type'), bytes: buf.length };
    const pv = await makeServerPreview(buf);
    out.preview = pv.length;
  } catch (e) { out.error = e.message; out.status = e.status; }
  return NextResponse.json(out);
}
