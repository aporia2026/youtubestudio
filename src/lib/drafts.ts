// Workflow draft system — auto-saves progress across pages
// Write-through: localStorage (fast cache) + DB (persistent truth)

export interface WorkflowDraft {
  id: string;
  title: string;           // derived from topic or idea title
  niche: string;
  updatedAt: number;
  step: 'idea' | 'script' | 'qa' | 'seo' | 'thumbnails' | 'voiceover' | 'done';

  // Idea stage
  ideaTitle?: string;
  ideaHook?: string;

  // Script stage
  topic?: string;
  tone?: string;
  style?: string;
  duration?: number;
  script?: string;
  wordCount?: number;
  modelId?: string;

  // QA stage
  qaScore?: number;
  qaVerdict?: string;
  fixedScript?: string;

  // SEO stage
  seoTitle?: string;
  seoDescription?: string;

  // Thumbnails stage
  thumbnailConcept?: string;

  // Voiceover stage
  voiceoverUrl?: string;
  voiceName?: string;

  // Project
  projectId?: string;
}

const DRAFTS_KEY = 'workflow_drafts';
const ACTIVE_DRAFT_KEY = 'active_draft_id';
const MAX_DRAFTS = 20;

function generateId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

export function getDrafts(): WorkflowDraft[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]');
  } catch { return []; }
}

export function getActiveDraftId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACTIVE_DRAFT_KEY);
}

export function getActiveDraft(): WorkflowDraft | null {
  const id = getActiveDraftId();
  if (!id) return null;
  return getDrafts().find(d => d.id === id) || null;
}

export function setActiveDraftId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) localStorage.setItem(ACTIVE_DRAFT_KEY, id);
  else localStorage.removeItem(ACTIVE_DRAFT_KEY);
}

function writeToLocalStorage(drafts: WorkflowDraft[]): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Quota exceeded — warn and prune, but don't silently swallow
    console.warn('[drafts] localStorage quota exceeded — pruning old drafts');
    try {
      const pruned = drafts.slice(0, Math.ceil(drafts.length / 2));
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(pruned));
    } catch {
      // Last resort: keep only the newest draft
      try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts.slice(0, 1))); } catch {}
    }
    // Show toast if available in context (non-blocking import)
    try {
      import('sonner').then(({ toast }) => {
        toast.warning('Browser storage is nearly full — older drafts may be removed. Your current draft is always saved to the cloud.');
      });
    } catch { /* ignore */ }
  }
}

// ─── DB sync (fire-and-forget) ────────────────────────────────────────────────

function syncToDb(draft: WorkflowDraft): void {
  // keepalive ensures the request completes even if the user navigates away
  // immediately after saving (e.g. from a QA → Voiceover handoff). Without it,
  // the browser aborts the fetch on unload and the DB never receives the update,
  // so the stale DB version wins on next hydrateDraftsFromDb call.
  // Browser cap is ~64 KB per keepalive request, which comfortably fits a script.
  fetch('/api/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
    keepalive: true,
  }).catch(() => { /* best-effort */ });
}

function deleteFromDb(id: string): void {
  fetch(`/api/drafts/${id}`, { method: 'DELETE', keepalive: true })
    .catch(() => { /* best-effort */ });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function saveDraft(draft: Partial<WorkflowDraft> & { title: string; niche: string; step: WorkflowDraft['step'] }): WorkflowDraft {
  const drafts = getDrafts();
  const existingIdx = draft.id ? drafts.findIndex(d => d.id === draft.id) : -1;

  const full: WorkflowDraft = {
    ...(existingIdx >= 0 ? drafts[existingIdx] : {}),
    ...draft,
    id: draft.id || generateId(),
    updatedAt: Date.now(),
  } as WorkflowDraft;

  if (existingIdx >= 0) {
    drafts[existingIdx] = full;
  } else {
    drafts.unshift(full);
  }

  if (drafts.length > MAX_DRAFTS) drafts.length = MAX_DRAFTS;

  writeToLocalStorage(drafts);
  setActiveDraftId(full.id);

  // Persist to DB in background — this is the durable copy
  syncToDb(full);

  return full;
}

export function deleteDraft(id: string): void {
  if (typeof window === 'undefined') return;
  const drafts = getDrafts().filter(d => d.id !== id);
  writeToLocalStorage(drafts);
  if (getActiveDraftId() === id) setActiveDraftId(null);
  deleteFromDb(id);
}

export function clearDrafts(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(DRAFTS_KEY);
  localStorage.removeItem(ACTIVE_DRAFT_KEY);
}

// ─── DB hydration (called on app mount) ──────────────────────────────────────

/** Fetch drafts from DB and merge into localStorage. DB wins for the same ID. */
export async function hydrateDraftsFromDb(): Promise<WorkflowDraft[]> {
  try {
    const res = await fetch('/api/drafts');
    if (!res.ok) return getDrafts();
    const { drafts: dbDrafts }: { drafts: WorkflowDraft[] } = await res.json();

    if (!dbDrafts || dbDrafts.length === 0) return getDrafts();

    // Merge: DB drafts take precedence for same ID; keep local-only drafts
    const local = getDrafts();
    const dbById = new Map(dbDrafts.map(d => [d.id, d]));
    const localOnlyDrafts = local.filter(d => !dbById.has(d.id));

    const merged = [...dbDrafts, ...localOnlyDrafts]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DRAFTS);

    writeToLocalStorage(merged);
    return merged;
  } catch {
    return getDrafts();
  }
}
