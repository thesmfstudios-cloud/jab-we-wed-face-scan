import { NextResponse } from 'next/server';
import { jsonError, requireAdmin } from '@/lib/server/security';
import { loadAdminEvent } from '@/lib/server/admin-events';
import { indexNextBatch } from '@/lib/server/indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Index the next batch of photos for one wedding. The dashboard calls this in a loop. */
export async function POST(request, { params }) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const event = await loadAdminEvent(id);
    if (!event) return jsonError('Wedding not found.', 404);
    const body = await request.json().catch(() => ({}));
    const result = await indexNextBatch(event, { retryFailed: body.retryFailed === true });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('indexing failed:', error?.message);
    if (error?.code === 'REKOGNITION_NOT_CONFIGURED') return jsonError('Amazon Rekognition is not configured. Add AWS keys in Vercel.', 503);
    return jsonError(error?.message || 'Could not build face index.', 500);
  }
}
