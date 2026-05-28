/**
 * Tests for `src/lib/provider-generations-reconcile.ts` — the nightly
 * orphan-recovery logic. Phase 2.2 of the 2026-05-29 persistence-
 * rebuild plan.
 *
 * SQL is mocked at the @vercel/postgres boundary; we drive the query
 * planner's responses per-test by setting `sqlResponses`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

interface CapturedCall {
  text: string;
  values: unknown[];
}

const sqlCalls: CapturedCall[] = [];
const sqlResponses: Array<{ rows: unknown[]; rowCount?: number }> = [];

vi.mock('@vercel/postgres', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(sqlResponses.shift() ?? { rows: [], rowCount: 0 });
  },
}));

import { reconcileOrphanGenerations } from '@/lib/provider-generations-reconcile';

beforeEach(() => {
  sqlCalls.length = 0;
  sqlResponses.length = 0;
});

const PROJECT_ID = 'c0ffee00-0000-4000-8000-000000000001';
const ID_A = 'c0ffee00-0000-4000-8000-aaaaaaaaaaaa';
const ID_B = 'c0ffee00-0000-4000-8000-bbbbbbbbbbbb';
const ID_C = 'c0ffee00-0000-4000-8000-cccccccccccc';

describe('reconcileOrphanGenerations', () => {
  it('returns a zero-count result when there are no candidates', async () => {
    sqlResponses.push({ rows: [], rowCount: 0 });
    const result = await reconcileOrphanGenerations();
    expect(result.candidates).toBe(0);
    expect(result.recovered).toBe(0);
    expect(result.refundPending).toBe(0);
    expect(result.alreadyAttached).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("transitions to 'attached' when project_assets already has the row", async () => {
    // Candidate query
    sqlResponses.push({
      rows: [
        {
          id: ID_A,
          project_id: PROJECT_ID,
          row_index: 5,
          slot: 'image',
          response_url: 'https://r2/image.png',
        },
      ],
    });
    // Existence check finds a matching row
    sqlResponses.push({ rows: [{ data: 'https://r2/image.png' }] });
    // markAttached UPDATE
    sqlResponses.push({ rows: [], rowCount: 1 });

    const result = await reconcileOrphanGenerations();

    expect(result.alreadyAttached).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.refundPending).toBe(0);
    const updateCall = sqlCalls[sqlCalls.length - 1]!;
    expect(updateCall.text).toContain("status = 'attached'");
  });

  it("recovers an image-slot orphan by writing project_assets and transitions to 'recovered'", async () => {
    // Candidate query
    sqlResponses.push({
      rows: [
        {
          id: ID_A,
          project_id: PROJECT_ID,
          row_index: 5,
          slot: 'image',
          response_url: 'https://r2/image.png',
        },
      ],
    });
    // Existence check: no matching project_assets row
    sqlResponses.push({ rows: [] });
    // writeProjectAsset UPSERT
    sqlResponses.push({ rows: [], rowCount: 1 });
    // markRecovered UPDATE
    sqlResponses.push({ rows: [], rowCount: 1 });

    const result = await reconcileOrphanGenerations();

    expect(result.recovered).toBe(1);
    expect(result.alreadyAttached).toBe(0);
    expect(result.refundPending).toBe(0);
    // The writeProjectAsset call is the only INSERT — confirm it
    // wrote the bare URL (image-slot shape, no wrapper object).
    const writeCall = sqlCalls.find((c) => c.text.includes('INSERT INTO project_assets'));
    expect(writeCall).toBeDefined();
    expect(writeCall!.values).toContain('"https://r2/image.png"');
  });

  it("recovers an overlay-slot orphan by synthesizing { status: 'done', url }", async () => {
    sqlResponses.push({
      rows: [
        {
          id: ID_B,
          project_id: PROJECT_ID,
          row_index: 3,
          slot: 'overlay',
          response_url: 'https://r2/overlay.png',
        },
      ],
    });
    sqlResponses.push({ rows: [] }); // no existing
    sqlResponses.push({ rows: [], rowCount: 1 }); // writeProjectAsset
    sqlResponses.push({ rows: [], rowCount: 1 }); // markRecovered

    const result = await reconcileOrphanGenerations();

    expect(result.recovered).toBe(1);
    const writeCall = sqlCalls.find((c) => c.text.includes('INSERT INTO project_assets'));
    expect(writeCall).toBeDefined();
    expect(writeCall!.values).toContain(
      JSON.stringify({ status: 'done', url: 'https://r2/overlay.png' }),
    );
  });

  it("marks clip-slot orphans 'refund_pending' (cannot synthesise brollClipId)", async () => {
    sqlResponses.push({
      rows: [
        {
          id: ID_C,
          project_id: PROJECT_ID,
          row_index: 7,
          slot: 'clip',
          response_url: 'https://r2/video.mp4',
        },
      ],
    });
    sqlResponses.push({ rows: [], rowCount: 1 }); // markRefundPending

    const result = await reconcileOrphanGenerations();

    expect(result.refundPending).toBe(1);
    expect(result.recovered).toBe(0);
    const updateCall = sqlCalls[sqlCalls.length - 1]!;
    expect(updateCall.text).toContain("status = 'refund_pending'");
    expect(updateCall.values).toContain('slot-not-recoverable:clip');
  });

  it("marks 'refund_pending' when project_id / row_index / slot / response_url is missing", async () => {
    sqlResponses.push({
      rows: [
        {
          id: ID_A,
          project_id: null,
          row_index: 0,
          slot: 'image',
          response_url: 'https://r2/x.png',
        },
      ],
    });
    sqlResponses.push({ rows: [], rowCount: 1 }); // markRefundPending

    const result = await reconcileOrphanGenerations();

    expect(result.refundPending).toBe(1);
    expect(sqlCalls[sqlCalls.length - 1]!.values).toContain('missing-context');
  });

  it("marks 'refund_pending' when writeProjectAsset throws (project FK violation, etc.)", async () => {
    sqlResponses.push({
      rows: [
        {
          id: ID_A,
          project_id: PROJECT_ID,
          row_index: 5,
          slot: 'image',
          response_url: 'https://r2/x.png',
        },
      ],
    });
    sqlResponses.push({ rows: [] }); // no existing
    // writeProjectAsset throws via the next sql call rejecting
    sqlResponses.push(Promise.reject(new Error('FK violation: project deleted')) as unknown as { rows: unknown[] });
    sqlResponses.push({ rows: [], rowCount: 1 }); // markRefundPending

    const result = await reconcileOrphanGenerations();

    expect(result.refundPending).toBe(1);
    expect(result.recovered).toBe(0);
    const updateCall = sqlCalls[sqlCalls.length - 1]!;
    expect(updateCall.text).toContain("status = 'refund_pending'");
    expect((updateCall.values[0] as string)).toMatch(/write-failed/);
  });

  it('returns an error count without crashing when the candidate query itself fails', async () => {
    sqlResponses.push(Promise.reject(new Error('connection refused')) as unknown as { rows: unknown[] });

    const result = await reconcileOrphanGenerations();

    expect(result.errors).toBe(1);
    expect(result.candidates).toBe(0);
  });

  it('queries with the 1-hour age cutoff and respects the batch LIMIT', async () => {
    sqlResponses.push({ rows: [] });
    await reconcileOrphanGenerations();

    const candidateQuery = sqlCalls[0]!;
    expect(candidateQuery.text).toContain("status = 'delivered'");
    expect(candidateQuery.text).toContain('updated_at < ?');
    expect(candidateQuery.text).toContain('LIMIT ?');
    // The age cutoff parameter should be a recent ISO timestamp.
    expect(candidateQuery.values[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(candidateQuery.values[1]).toBe(500);
  });
});
