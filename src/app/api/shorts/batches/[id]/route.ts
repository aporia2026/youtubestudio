import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  getBatchWithShorts,
  updateBatchDefaults,
  updateBatchStatus,
  BatchStateTransitionError,
} from '@/lib/shorts-batches';
import type { ShortsBatchDefaults, ShortsBatchStatus } from '@/lib/shorts-batches-types';

/**
 * GET /api/shorts/batches/[id]
 *
 * Returns the batch row + every child short, ordered by created_at.
 * Drives the step-3 progress view, step-4 review queue, and step-5
 * upload page — all four steps read from this single endpoint.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const bundle = await getBatchWithShorts(id, session.ws);
    if (!bundle) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    return NextResponse.json(bundle);
  },
);

/**
 * PATCH /api/shorts/batches/[id]
 *
 * Two distinct PATCH shapes the route handles:
 *   - { defaults: Partial<ShortsBatchDefaults> } — merge into the
 *     batch's `defaults` JSONB. Only allowed while status='setup'.
 *   - { status: ShortsBatchStatus } — transition the batch state
 *     machine. Returns 409 on an illegal transition.
 *
 * Sending both at once is allowed; defaults is applied first, then
 * the status transition. If either fails the response carries the
 * specific error.
 */
export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    let body: { defaults?: Partial<ShortsBatchDefaults>; status?: ShortsBatchStatus } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.defaults && !body.status) {
      return NextResponse.json(
        { error: 'PATCH body must include `defaults` and/or `status`.' },
        { status: 400 },
      );
    }

    if (body.defaults) {
      const updated = await updateBatchDefaults(id, session.ws, body.defaults);
      if (!updated) {
        // Either missing or no longer in 'setup'. Disambiguate.
        const bundle = await getBatchWithShorts(id, session.ws);
        if (!bundle) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
        return NextResponse.json(
          {
            error: `Defaults can only be edited while the batch is in 'setup' (current: '${bundle.batch.status}').`,
          },
          { status: 409 },
        );
      }
    }

    if (body.status) {
      try {
        const updated = await updateBatchStatus(id, session.ws, body.status);
        if (!updated) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
      } catch (err) {
        if (err instanceof BatchStateTransitionError) {
          return NextResponse.json({ error: err.message }, { status: 409 });
        }
        throw err;
      }
    }

    const after = await getBatchWithShorts(id, session.ws);
    return NextResponse.json(after);
  },
);
