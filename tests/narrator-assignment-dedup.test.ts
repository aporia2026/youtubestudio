/**
 * Locks down the duplicate-assignment guard in `POST /api/narrator/assignments`.
 *
 * The narration tab only renders one assignment per project (`find` over a
 * list ordered by updated_at). A second POST for the same project would
 * mask the first one in the UI — taking any uploaded audio with it. The
 * route guards against that by querying for an existing row in the
 * "active" status set and returning 409 with the existing share_token
 * when one is found. Terminal statuses (`approved`, `completed`) don't
 * block — those mean the previous job is done and a fresh one is fine.
 *
 * Tests mock `@vercel/postgres` (which the route imports directly) and the
 * narrator-db helpers so we can assert behaviour at the route boundary
 * without a real database.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock plumbing ──────────────────────────────────────────────────

interface RecordedCall {
  text: string;
  values: unknown[];
}

const sqlCalls: RecordedCall[] = [];

type Response = { rows: unknown[] };

/** FIFO queue of canned responses for the `sql` template-tag mock. */
const responseQueue: Response[] = [];

vi.mock('@vercel/postgres', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''),
      '',
    );
    sqlCalls.push({ text, values });
    const next = responseQueue.shift();
    return Promise.resolve(next ?? { rows: [], rowCount: 0 });
  },
}));

const createAssignmentMock = vi.fn();
const createSectionMock = vi.fn();
const listAllAssignmentsMock = vi.fn();

vi.mock('@/lib/narrator-db', () => ({
  createAssignment: (...args: unknown[]) => createAssignmentMock(...args),
  createSection: (...args: unknown[]) => createSectionMock(...args),
  listAllAssignments: (...args: unknown[]) => listAllAssignmentsMock(...args),
}));

vi.mock('@/lib/narrator-utils', () => ({
  splitScriptIntoSections: () => [
    { label: 'Section 1', script_text: 'hello', estimated_duration_seconds: 10 },
  ],
}));

vi.mock('@/lib/notify', () => ({
  notifyAssignmentReceived: vi.fn(async () => {}),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Imports must come AFTER the mocks so the route picks them up.
import { POST } from '@/app/api/narrator/assignments/route';

// ── Test fixtures ──────────────────────────────────────────────────

const validBody = {
  project_id: 'proj-uuid',
  script_id: 'script-uuid',
  narrator_id: 'narrator-uuid',
  script_text: 'hello world',
  wpm: 150,
  script_version: 1,
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request('https://app.test/api/narrator/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  sqlCalls.length = 0;
  responseQueue.length = 0;
  createAssignmentMock.mockReset();
  createSectionMock.mockReset();
  listAllAssignmentsMock.mockReset();
});

// ── Validation gate ────────────────────────────────────────────────

describe('POST /api/narrator/assignments — validation', () => {
  it('returns 400 when project_id is missing', async () => {
    const { project_id: _omit, ...rest } = validBody;
    void _omit;
    const res = await POST(makeReq(rest));
    expect(res.status).toBe(400);
    expect(createAssignmentMock).not.toHaveBeenCalled();
  });
});

// ── Dedup guard ────────────────────────────────────────────────────

describe('POST /api/narrator/assignments — dedup guard', () => {
  it('returns 409 with the existing share_token when an active assignment exists', async () => {
    // Dedup query returns an existing row.
    responseQueue.push({
      rows: [{ id: 'existing-assignment-uuid', share_token: 'existing-token' }],
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.existing).toEqual({
      id: 'existing-assignment-uuid',
      share_token: 'existing-token',
    });

    // The route must NOT have inserted an assignment or its sections.
    expect(createAssignmentMock).not.toHaveBeenCalled();
    expect(createSectionMock).not.toHaveBeenCalled();

    // Only the dedup query ran.
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toMatch(/FROM narrator_assignments/);
    expect(sqlCalls[0].text).toMatch(/status IN/);
  });

  it('proceeds to create when no active assignment exists (terminal statuses do not block)', async () => {
    // Dedup query returns no rows — the only matching rows for this project
    // are `completed` / `approved`, which the partial filter excludes.
    responseQueue.push({ rows: [] });
    // Subsequent sql`` for schedule_items update.
    responseQueue.push({ rows: [] });
    // Subsequent sql`` for narrator/project name lookup (notify side-effect).
    responseQueue.push({ rows: [] });

    createAssignmentMock.mockResolvedValue({
      id: 'new-assignment-uuid',
      share_token: 'new-token',
    });
    createSectionMock.mockResolvedValue({});

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.assignment.share_token).toBe('new-token');
    expect(createAssignmentMock).toHaveBeenCalledOnce();
    expect(createSectionMock).toHaveBeenCalled();

    // The dedup query was the FIRST query — order matters for the
    // "no side effects on conflict" guarantee.
    expect(sqlCalls[0].text).toMatch(/FROM narrator_assignments/);
  });
});
