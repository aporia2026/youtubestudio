'use client';

/**
 * Style Manager — list / create / edit / delete production-doc styles.
 * Built-ins are read-only at the top with a lock pill. v2 adds private
 * styles that carry a plain-English descriptor + up to 8 reference
 * images, and a `preferred_cloud_model` pin (default NanoBanana Pro,
 * winner of the Phase 0 spike — see _plans/2026-05-21-...md).
 *
 * Talks to:
 *   GET    /api/production-doc/styles                       — list
 *   POST   /api/production-doc/styles                       — create
 *                                                            (with body.draft=true
 *                                                            for the v2 editor
 *                                                            lifecycle: editor
 *                                                            opens a draft row,
 *                                                            uploads refs against
 *                                                            it, then PATCHes
 *                                                            with {save:true})
 *   PATCH  /api/production-doc/styles/[id]                  — update
 *   DELETE /api/production-doc/styles/[id]                  — delete
 *   GET    /api/production-doc/styles/[id]/refs             — list refs
 *   POST   /api/production-doc/styles/[id]/refs             — presign + insert
 *   DELETE /api/production-doc/styles/[id]/refs/[refId]     — remove
 *
 * On any successful mutation the dialog calls `onChanged()` so the
 * parent page can refresh its picker from the same /styles endpoint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { I2I_MODELS, DEFAULT_CLOUD_I2I_MODEL } from '@/lib/image-models-i2i';

/**
 * Promise-wrapped confirmation toast. Replaces native `window.confirm()`
 * which blocks the event loop, looks jarring inside a React modal, and
 * doesn't theme with the rest of the app. Sonner's `cancel` slot gives
 * us a two-button toast; the promise resolves true/false based on which
 * button (or auto-dismiss) the user picks.
 *
 * `destructive: true` colours the confirm button red to signal that
 * the action is irreversible (delete a ref, delete a style, etc).
 */
function confirmToast(message: string, opts: { destructive?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (answer: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(answer);
    };
    toast(message, {
      duration: 12000,
      action: {
        label: opts.destructive ? 'Yes, remove' : 'Confirm',
        onClick: () => finish(true),
      },
      cancel: {
        label: 'Cancel',
        onClick: () => finish(false),
      },
      // Toast dismiss (programmatic or auto-close after duration) is
      // treated as a "no" — same semantics as window.confirm returning
      // false when the user closes the dialog without choosing.
      onAutoClose: () => finish(false),
      onDismiss: () => finish(false),
    });
  });
}

export interface StyleSummary {
  id: string;
  label: string;
  description?: string;
  ai_image_suffix: string;
  mixing_rules?: string;
  allow_overlay_stock: boolean;
  origin: 'built-in' | 'saved';
  // v2 — undefined on built-ins
  style_prompt?: string;
  preferred_cloud_model?: string;
  version?: number;
  owner_id?: string;
}

interface StyleRefSummary {
  id: string;
  position: number;
  role: 'style' | 'character' | 'palette' | 'composition';
  weight: number;
  r2_key: string;
  mime_type: string;
  size_bytes: number | null;
  rejected_by_provider: boolean;
  rejection_reason: string | null;
  rejection_provider: string | null;
  download_url: string;
  // Migration 0082 — post-upload MIME sniff state. NULL = not yet
  // validated (validator may still be running); TRUE = passed;
  // FALSE = failed (content_validation_error has the reason).
  content_validated: boolean | null;
  content_validation_error: string | null;
}

interface TestRenderSummary {
  id: string;
  style_version: number;
  test_prompt: string;
  output_url: string;
  model_used: string;
  duration_ms: number;
  created_at: string;
}

interface DraftStyle {
  name: string;
  description: string;
  ai_image_suffix: string;
  mixing_rules: string;
  allow_overlay_stock: boolean;
  based_on_built_in: string | null;
  // v2 fields
  style_prompt: string;
  preferred_cloud_model: string;
}

const EMPTY_DRAFT: DraftStyle = {
  name: '',
  description: '',
  ai_image_suffix: '',
  mixing_rules: '',
  allow_overlay_stock: false,
  based_on_built_in: null,
  style_prompt: '',
  preferred_cloud_model: DEFAULT_CLOUD_I2I_MODEL,
};

const ALLOWED_REF_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_REF_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_REFS = 8;

/** I2I models surfaced in the picker. Derived from the dedicated i2i
 *  registry (`src/lib/image-models-i2i.ts`) so a new entry there
 *  appears here automatically. Plain-English labels per the council's
 *  Outsider feedback (rule 10): the dropdown should have an opinion,
 *  not list raw provider names. */
const I2I_MODEL_OPTIONS = I2I_MODELS.map((m) => ({
  value: m.value,
  label: m.label,
  hint: m.hint,
  isLocal: m.provider === 'comfyui-local',
  recommended: m.value === DEFAULT_CLOUD_I2I_MODEL,
}));

interface Props {
  styles: StyleSummary[];
  /** Called after every mutation so the parent reloads the picker. */
  onChanged: () => void;
  onClose: () => void;
}

export function StyleManagerDialog({ styles, onChanged, onClose }: Props) {
  /** id of the saved style being edited, "new" for the create form, or null for browse mode. */
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<DraftStyle>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  // v2 draft lifecycle: when the user clicks "Create new style", the
  // server immediately creates a draft row (owner-private, draft=true,
  // invisible to listAllStyles). We track that id here so subsequent
  // ref uploads can target it. On Save, we PATCH the row with
  // {save:true} which flips draft=false and stamps approved_at.
  const [draftStyleId, setDraftStyleId] = useState<string | null>(null);
  const [refs, setRefs] = useState<StyleRefSummary[]>([]);
  const [refUploadBusy, setRefUploadBusy] = useState(false);
  const refsAbortRef = useRef<AbortController | null>(null);
  // Mirror `styles` into a ref so the editing-change effect can read
  // the latest list without re-firing on every parent reload. See
  // the long comment on that effect below for the rationale.
  const stylesRef = useRef(styles);
  useEffect(() => { stylesRef.current = styles; }, [styles]);

  // Whenever the picker swaps between rows or built-ins, re-seed
  // the draft from the chosen style so edits start from a sensible
  // baseline. Critically: `styles` is NOT in the deps. The parent
  // reloads the styles list on every onChanged() (after save,
  // delete, ref upload completes), so listing `styles` here re-fires
  // this effect mid-edit and silently clobbers any field the user
  // changed in the same tick. Effect runs only on `editing` change;
  // we deliberately read the *latest* `styles` reference via a ref
  // so a swap to a newly-created style after save still picks up
  // its row. eslint disabled because the rule can't see through the
  // ref-based read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editing === null) {
      setRefs([]);
      setDraftStyleId(null);
      return;
    }
    if (editing === 'new') {
      setDraft(EMPTY_DRAFT);
      setRefs([]);
      // draftStyleId stays null until the first ref upload triggers
      // the draft-row create (lazy — a user who cancels without
      // touching refs leaves no orphan rows in the DB).
      setDraftStyleId(null);
      return;
    }
    const target = stylesRef.current.find((s) => s.id === editing);
    if (!target) return;
    setDraft({
      name: target.label,
      description: target.description ?? '',
      ai_image_suffix: target.ai_image_suffix,
      mixing_rules: target.mixing_rules ?? '',
      allow_overlay_stock: target.allow_overlay_stock,
      based_on_built_in: target.origin === 'built-in' ? target.id : null,
      style_prompt: target.style_prompt ?? '',
      preferred_cloud_model: target.preferred_cloud_model ?? DEFAULT_CLOUD_I2I_MODEL,
    });
    // Saved styles (not built-ins) can have refs — load them.
    if (target.origin === 'saved') {
      setDraftStyleId(target.id);
      void loadRefsFor(target.id);
    } else {
      setDraftStyleId(null);
      setRefs([]);
    }
  }, [editing]);

  /** Fetch refs for an existing style id and stash them in local state.
   *  Aborts any prior in-flight request so a fast row-swap doesn't
   *  race a stale response into the wrong style's UI. */
  const loadRefsFor = useCallback(async (styleId: string) => {
    refsAbortRef.current?.abort();
    const ctrl = new AbortController();
    refsAbortRef.current = ctrl;
    try {
      const res = await fetch(`/api/production-doc/styles/${styleId}/refs`, { signal: ctrl.signal });
      if (!res.ok) {
        if (res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          toast.error(data?.error || 'Failed to load reference images');
        }
        setRefs([]);
        return;
      }
      const data = await res.json();
      setRefs((data?.refs as StyleRefSummary[]) ?? []);
    } catch (err) {
      // AbortError is expected when the user swaps rows quickly.
      if (err instanceof Error && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Failed to load reference images');
    }
  }, []);

  /** Ensure a draft style row exists before the first ref upload on a
   *  freshly-opened "Create new style" form. Returns the draft id. */
  const ensureDraftStyle = useCallback(async (): Promise<string> => {
    if (draftStyleId) return draftStyleId;
    const res = await fetch('/api/production-doc/styles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft: true,
        name: draft.name.trim() || 'Untitled style',
        style_prompt: draft.style_prompt.trim() || null,
        preferred_cloud_model: draft.preferred_cloud_model || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.style?.id) {
      throw new Error(data?.error || 'Failed to create draft style');
    }
    setDraftStyleId(data.style.id as string);
    return data.style.id as string;
  }, [draftStyleId, draft.name, draft.style_prompt, draft.preferred_cloud_model]);

  /** Upload one image file to R2 via the presigned-PUT pattern, then
   *  re-fetch the refs list. Two-step (POST metadata → PUT bytes) so
   *  large files don't pass through a Vercel function. */
  const handleUploadRef = useCallback(async (file: File) => {
    if (refs.length >= MAX_REFS) {
      toast.error(`Max ${MAX_REFS} reference images per style`);
      return;
    }
    if (!ALLOWED_REF_MIME.includes(file.type)) {
      toast.error(`Unsupported file type. JPEG, PNG, or WebP only.`);
      return;
    }
    if (file.size > MAX_REF_SIZE_BYTES) {
      toast.error(`Image too large — max 25 MB`);
      return;
    }
    setRefUploadBusy(true);
    try {
      const styleId = await ensureDraftStyle();
      // Step 1: presign + DB row insert
      const presignRes = await fetch(`/api/production-doc/styles/${styleId}/refs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
        }),
      });
      const presignData = await presignRes.json().catch(() => ({}));
      if (!presignRes.ok || !presignData?.uploadUrl) {
        toast.error(presignData?.error || 'Failed to start upload');
        return;
      }
      // Step 2: PUT the actual bytes to R2 directly. Same-origin
      // cookies aren't needed; the signed URL carries the auth.
      const putRes = await fetch(presignData.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!putRes.ok) {
        toast.error(`Upload to R2 failed (${putRes.status})`);
        return;
      }
      // Step 3: trigger the post-upload MIME sniff (migration 0082).
      // The PUT succeeded but R2 has no idea what's actually in the
      // bytes — only what the client declared. A range-GET + magic-
      // byte check catches SVG-as-JPEG / HTML-as-PNG / random binary
      // before the ref can flow into any generation. Refs with
      // `content_validated != TRUE` are skipped at dispatch.
      //
      // The validate endpoint is best-effort here — if it errors,
      // the ref stays `content_validated = NULL` (not blocked, just
      // not yet dispatchable). User can retry by clicking the ref.
      const refId = presignData.ref?.id as string | undefined;
      if (refId) {
        try {
          const valRes = await fetch(
            `/api/production-doc/styles/${styleId}/refs/${refId}/validate`,
            { method: 'POST' },
          );
          if (!valRes.ok && valRes.status !== 422) {
            // Non-422 means the validation didn't run cleanly; non-
            // fatal — ref persists, just stays unvalidated.
            console.warn('[style refs] validate endpoint returned', valRes.status);
          }
        } catch (valErr) {
          // Validation failure is non-fatal for the upload; just log.
          console.warn('[style refs] validate request failed', valErr);
        }
      }
      // Step 4: refresh the local refs list to pick up the new row
      // with a freshly-minted presigned download URL AND its
      // validation state.
      await loadRefsFor(styleId);
      toast.success('Reference image added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setRefUploadBusy(false);
    }
  }, [refs.length, ensureDraftStyle, loadRefsFor]);

  /** Remove a single ref from the active style. Best-effort R2
   *  cleanup happens server-side. */
  const handleDeleteRef = useCallback(async (refId: string) => {
    if (!draftStyleId) return;
    const ok = await confirmToast('Remove this reference image?', { destructive: true });
    if (!ok) return;
    try {
      const res = await fetch(`/api/production-doc/styles/${draftStyleId}/refs/${refId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to delete reference');
        return;
      }
      await loadRefsFor(draftStyleId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [draftStyleId, loadRefsFor]);

  // ── Test render (Phase 5) ─────────────────────────────────────────
  // The test prompt + a small gallery of recent renders. Test renders
  // require a draftStyleId (refs uploaded → draft row exists) so they
  // only surface after the user has built up enough of a style to be
  // worth testing.
  const [testPrompt, setTestPrompt] = useState('A stick figure character waving hello on a plain white background.');
  const [testRenderBusy, setTestRenderBusy] = useState(false);
  const [testRenders, setTestRenders] = useState<TestRenderSummary[]>([]);

  /** Refresh the test-render gallery for the active style. */
  const loadTestRendersFor = useCallback(async (styleId: string) => {
    try {
      const res = await fetch(`/api/production-doc/styles/${styleId}/test-render`);
      if (!res.ok) return;
      const data = await res.json();
      setTestRenders((data?.renders as TestRenderSummary[]) ?? []);
    } catch {
      // Gallery is best-effort; a load failure is non-blocking.
    }
  }, []);

  /** Fire a single test render against the active style. The endpoint
   *  uses the style's preferred_cloud_model + currently-active refs
   *  (rejected ones automatically excluded). On 409
   *  REFERENCE_REJECTED, the offending refs have already been
   *  flagged server-side — just reload refs so the UI updates.
   *
   *  Captures `draftStyleId` at submit time. A test render takes 60–
   *  150s on cloud; the user can swap to a different style mid-flight.
   *  On resolve we compare the captured id against the current one
   *  and discard the result if the user has moved on — otherwise the
   *  finished render would paint into the wrong style's gallery. */
  const handleRunTest = useCallback(async () => {
    if (!draftStyleId) {
      toast.error('Upload at least one reference image first');
      return;
    }
    if (!testPrompt.trim()) {
      toast.error('Enter a test prompt first');
      return;
    }
    const startedFor = draftStyleId;
    setTestRenderBusy(true);
    try {
      const res = await fetch(`/api/production-doc/styles/${startedFor}/test-render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_prompt: testPrompt.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      // User swapped styles mid-flight — drop this result silently
      // so it doesn't paint into the wrong gallery.
      if (startedFor !== draftStyleId) return;
      if (res.status === 409 && data?.code === 'REFERENCE_REJECTED') {
        toast.error(`Provider rejected ${data.rejectedRefIds?.length ?? 'one or more'} refs — they've been flagged in the grid above. Click "Clear rejection" on a thumb to try it again.`);
        await loadRefsFor(startedFor);
        return;
      }
      if (!res.ok) {
        toast.error(data?.error || 'Test render failed');
        return;
      }
      toast.success(`Test render done in ${((data.render.duration_ms ?? 0) / 1000).toFixed(1)}s`);
      await loadTestRendersFor(startedFor);
    } catch (err) {
      // Same swap-guard: silent drop if user moved on.
      if (startedFor !== draftStyleId) return;
      toast.error(err instanceof Error ? err.message : 'Test render failed');
    } finally {
      // Only clear the busy state if we're still on the same style.
      // Otherwise the new style's UI might appear in a "rendering…"
      // state for no reason.
      if (startedFor === draftStyleId) setTestRenderBusy(false);
    }
  }, [draftStyleId, testPrompt, loadRefsFor, loadTestRendersFor]);

  // Load the gallery whenever the editor swaps onto an existing
  // saved style (its draftStyleId is already known on the row).
  useEffect(() => {
    if (draftStyleId) {
      void loadTestRendersFor(draftStyleId);
    } else {
      setTestRenders([]);
    }
  }, [draftStyleId, loadTestRendersFor]);

  /** Clear a provider-rejection flag so the next generation attempt
   *  includes the ref again. Editor "Clear rejection" affordance. */
  const handleClearRejection = useCallback(async (refId: string) => {
    if (!draftStyleId) return;
    try {
      const res = await fetch(`/api/production-doc/styles/${draftStyleId}/refs/${refId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear_rejection: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to clear rejection');
        return;
      }
      await loadRefsFor(draftStyleId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clear failed');
    }
  }, [draftStyleId, loadRefsFor]);

  function startCreateFrom(builtIn: StyleSummary) {
    setDraft({
      name: `${builtIn.label} (copy)`,
      description: builtIn.description ?? '',
      ai_image_suffix: builtIn.ai_image_suffix,
      mixing_rules: builtIn.mixing_rules ?? '',
      allow_overlay_stock: builtIn.allow_overlay_stock,
      based_on_built_in: builtIn.id,
      style_prompt: '',
      preferred_cloud_model: DEFAULT_CLOUD_I2I_MODEL,
    });
    setRefs([]);
    setDraftStyleId(null);
    setEditing('new');
  }

  async function handleSave() {
    if (!draft.name.trim()) {
      toast.error('Name is required');
      return;
    }
    // ai_image_suffix is no longer strictly required from this UI —
    // the backend backfills it from style_prompt on save when empty.
    // We do require at least ONE of style_prompt / ai_image_suffix
    // / refs so the resulting style isn't a content-free shell.
    if (!draft.ai_image_suffix.trim() && !draft.style_prompt.trim() && refs.length === 0) {
      toast.error('Add a style descriptor, suffix, or at least one reference image');
      return;
    }
    setBusy(true);
    try {
      const isNew = editing === 'new';

      // Common body shape — used both for PATCH on existing and for
      // PATCH on the draft (and for the legacy POST-only fallback,
      // though we no longer hit it from the UI).
      const bodyFields = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        ai_image_suffix: draft.ai_image_suffix.trim(),
        mixing_rules: draft.mixing_rules.trim() || null,
        allow_overlay_stock: draft.allow_overlay_stock,
        based_on_built_in: draft.based_on_built_in,
        style_prompt: draft.style_prompt.trim() || null,
        preferred_cloud_model: draft.preferred_cloud_model || null,
      };

      let finalStyleId: string | null = null;

      if (isNew) {
        // Two cases:
        // (a) draftStyleId exists — a ref was uploaded, so a draft row
        //     was created lazily. PATCH it with {save:true} to flip
        //     draft=false + stamp approved_at.
        // (b) draftStyleId is null — no refs uploaded; create a draft
        //     and immediately save it in two requests (POST → PATCH).
        const targetId = draftStyleId ?? await ensureDraftStyle();
        const res = await fetch(`/api/production-doc/styles/${targetId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...bodyFields, save: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || 'Failed to create style');
          return;
        }
        finalStyleId = data?.style?.id ?? targetId;
      } else {
        // Edit-existing path. Existing styles keep their draft=false
        // state and we just bump version + write the changed fields.
        const res = await fetch(`/api/production-doc/styles/${editing}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyFields),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || 'Failed to update style');
          return;
        }
        finalStyleId = (editing as string);
      }

      toast.success(isNew ? 'Style created' : 'Style updated');
      // After a create, switch to editing the freshly-saved row so
      // the user sees it in the sidebar and can keep tweaking. After
      // an update, stay on the same row.
      if (isNew && finalStyleId) {
        setEditing(finalStyleId);
        setDraftStyleId(finalStyleId);
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string, label: string) {
    const ok = await confirmToast(
      `Delete the style "${label}"? Production docs already generated with it are unaffected.`,
      { destructive: true },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/production-doc/styles/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete style');
        return;
      }
      toast.success('Style deleted');
      if (editing === id) setEditing(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const builtIns = styles.filter((s) => s.origin === 'built-in');
  const saved = styles.filter((s) => s.origin === 'saved');

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-4xl rounded-xl max-h-[88vh] flex flex-col"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Visual styles
              </h2>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Built-in styles are read-only. Save your own to reuse them across production docs.
              </div>
            </div>
            <button onClick={onClose} style={{ color: 'var(--text-muted)' }} title="Close" aria-label="Close style manager dialog">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
            {/* Sidebar: list */}
            <div className="md:w-64 md:flex-shrink-0 overflow-y-auto md:border-r" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
              <div className="p-3">
                <button
                  onClick={() => setEditing('new')}
                  className="w-full text-xs px-3 py-2 rounded-lg font-semibold"
                  style={{
                    background: editing === 'new' ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.12)',
                    color: 'var(--accent-purple-bright)',
                    border: '1px dashed rgba(124,58,237,0.4)',
                  }}
                >
                  + Create new style
                </button>
              </div>

              <SectionLabel>Built-in</SectionLabel>
              {builtIns.map((s) => (
                <SidebarRow
                  key={s.id}
                  label={s.label}
                  description={s.description}
                  active={editing === s.id}
                  pill="locked"
                  onClick={() => setEditing(s.id)}
                />
              ))}

              <SectionLabel>Your styles ({saved.length})</SectionLabel>
              {saved.length === 0 ? (
                <div className="px-3 py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                  No saved styles yet. Pick a built-in and use “Save as new” to get started.
                </div>
              ) : (
                saved.map((s) => (
                  <SidebarRow
                    key={s.id}
                    label={s.label}
                    description={s.description}
                    active={editing === s.id}
                    onClick={() => setEditing(s.id)}
                  />
                ))
              )}
            </div>

            {/* Right pane: detail / editor */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {editing === null ? (
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Pick a style from the sidebar to view or edit it, or create a new one.
                </div>
              ) : (() => {
                const target = editing === 'new' ? null : styles.find((s) => s.id === editing);
                const isBuiltIn = target?.origin === 'built-in';
                const isNew = editing === 'new';
                const readOnly = isBuiltIn;

                return (
                  <>
                    {isBuiltIn && (
                      <div
                        className="text-xs p-3 rounded-lg flex items-start gap-2"
                        style={{ background: 'rgba(245,158,11,0.08)', color: 'var(--text-secondary)', border: '1px solid rgba(245,158,11,0.3)' }}
                      >
                        <span style={{ color: '#fbbf24', flexShrink: 0 }}>🔒</span>
                        <span>
                          This is a built-in style — it cannot be edited directly. Use the
                          <strong> Save as new </strong> button below to create a customisable copy.
                        </span>
                      </div>
                    )}

                    {/* First-time onboarding banner for new styles.
                        Three lines explaining the v2 concepts users hit
                        first: descriptor + refs + model picker. Hidden
                        on saved styles (the user has presumably seen
                        this once) and on built-ins (read-only). */}
                    {isNew && (
                      <details
                        className="text-xs p-3 rounded-lg"
                        style={{ background: 'rgba(99,102,241,0.06)', color: 'var(--text-secondary)', border: '1px solid rgba(99,102,241,0.2)' }}
                      >
                        <summary className="cursor-pointer font-semibold" style={{ color: 'var(--accent-purple-bright)' }}>
                          💡 How styles work — read me first
                        </summary>
                        <div className="mt-2 space-y-1.5">
                          <p>
                            <strong>Descriptor</strong> tells the AI what the look is in plain English (e.g. <em>"hand-drawn stick figure doodle, thick black outlines, white background"</em>).
                          </p>
                          <p>
                            <strong>Reference images</strong> are real examples of the style. The AI matches them more strongly than any descriptor can — upload 1–8 images that show the aesthetic you want consistently.
                          </p>
                          <p>
                            <strong>Generation model</strong> picks between cloud (~$0.05/image, always available) and local (free, requires LOCAL_STUDIO=1 + ComfyUI running). Cloud NanoBanana Pro is the default — won our doodle quality test.
                          </p>
                          <p style={{ color: 'var(--text-muted)' }}>
                            After saving, this style is private to you and persists across sessions. Every doc you generate with it pins to its version, so editing the style later doesn't break older docs.
                          </p>
                        </div>
                      </details>
                    )}

                    {/* Name */}
                    <Field label="Name" hint="Shown in the picker. Keep it short.">
                      <input
                        type="text"
                        value={draft.name}
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                        readOnly={readOnly}
                        className="input-field w-full text-sm"
                        placeholder="e.g. Doodle Explainer (my version)"
                        maxLength={80}
                      />
                    </Field>

                    {/* Description */}
                    <Field label="Description (optional)" hint="One-liner shown under the label.">
                      <input
                        type="text"
                        value={draft.description}
                        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                        readOnly={readOnly}
                        className="input-field w-full text-sm"
                        placeholder="e.g. Stick figures with real logos overlaid where useful"
                        maxLength={240}
                      />
                    </Field>

                    {/* Style descriptor (v2 — plain English, replaces the
                        raw suffix as the primary "what does this style
                        look like" field. Backend backfills the legacy
                        ai_image_suffix from this on save when the
                        suffix is empty, so the prompt-builder keeps
                        working unchanged downstream.) */}
                    <Field
                      label="Style descriptor"
                      hint="Plain-English description of the look. Combined with reference images, this is what the AI uses to match your style."
                    >
                      <textarea
                        value={draft.style_prompt}
                        onChange={(e) => setDraft((d) => ({ ...d, style_prompt: e.target.value }))}
                        readOnly={readOnly}
                        className="input-field w-full text-sm"
                        style={{ minHeight: 80, resize: 'vertical' }}
                        placeholder="e.g. Hand-drawn stick figure doodle, thick black ink outlines, plain white background, one or two flat accent colors per scene, no shading or gradients."
                        maxLength={2000}
                      />
                    </Field>

                    {/* Reference images (v2) — up to 8. Skipped for
                        built-ins; they have no refs. */}
                    {!isBuiltIn && (
                      <Field
                        label={`Reference images (${refs.length} / ${MAX_REFS})`}
                        hint="Upload 5–8 example images that show the visual style you want. The AI uses these to match the look exactly. Drag to reorder later — first image carries the most weight."
                      >
                        <RefsGrid
                          refs={refs}
                          uploadBusy={refUploadBusy}
                          canUpload={refs.length < MAX_REFS}
                          onUpload={handleUploadRef}
                          onDelete={handleDeleteRef}
                          onClearRejection={handleClearRejection}
                        />
                      </Field>
                    )}

                    {/* Preferred cloud model (v2). Only meaningful when
                        the style carries refs — for refless legacy
                        styles, the existing text-to-image dispatcher
                        ignores this field. Kept visible always so
                        users can pick the model up-front if they want. */}
                    {!isBuiltIn && (
                      <Field
                        label="Cloud generation model"
                        hint="Which AI model runs your style in the cloud. NanoBanana Pro is the default — it won our doodle quality test on speed."
                      >
                        <select
                          value={draft.preferred_cloud_model}
                          onChange={(e) => setDraft((d) => ({ ...d, preferred_cloud_model: e.target.value }))}
                          disabled={readOnly}
                          className="input-field w-full text-sm"
                        >
                          {I2I_MODEL_OPTIONS.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}{m.recommended ? ' — recommended' : ''}
                            </option>
                          ))}
                        </select>
                        {/* Show the picked model's hint below as a sub-label */}
                        {(() => {
                          const picked = I2I_MODEL_OPTIONS.find((m) => m.value === draft.preferred_cloud_model);
                          return picked?.hint ? (
                            <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                              {picked.hint}
                            </div>
                          ) : null;
                        })()}
                      </Field>
                    )}

                    {/* Test render (v2 — Phase 5). Only meaningful when
                        the style has refs attached; refless styles fall
                        back to T2I which the production-doc image route
                        already supports without a dedicated test path.
                        Cloud and local providers both supported via the
                        unified dispatcher in `image-gen-i2i.ts`. */}
                    {!isBuiltIn && draftStyleId && refs.length > 0 && (() => {
                      const pickedSpec = I2I_MODEL_OPTIONS.find((m) => m.value === draft.preferred_cloud_model);
                      const isLocalPick = pickedSpec?.isLocal === true;
                      // Per-provider cost + speed hints. Local is free
                      // but requires LOCAL_STUDIO=1 + ComfyUI running.
                      const buttonLabel = isLocalPick
                        ? (testRenderBusy ? 'Rendering… (~60s)' : 'Run test (free, local)')
                        : (testRenderBusy ? 'Rendering… (~90s)' : 'Run test (~$0.05)');
                      const busyHint = isLocalPick
                        ? 'Qwen-Image i2i typically takes 30–90 s.'
                        : 'NanoBanana Pro typically takes 60–150 s.';
                      return (
                      <Field
                        label="Test render"
                        hint="Generate one image with your refs + this prompt to see how the style behaves before saving."
                      >
                        <div className="space-y-2">
                          <textarea
                            value={testPrompt}
                            onChange={(e) => setTestPrompt(e.target.value)}
                            className="input-field w-full text-xs"
                            style={{ minHeight: 50, resize: 'vertical' }}
                            placeholder="Describe a scene to render for testing"
                            maxLength={2000}
                          />
                          <div className="flex items-center justify-between gap-2">
                            <button
                              onClick={handleRunTest}
                              disabled={testRenderBusy || !testPrompt.trim()}
                              className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                              style={{
                                background: 'rgba(124,58,237,0.15)',
                                color: 'var(--accent-purple-bright)',
                                border: '1px solid rgba(124,58,237,0.3)',
                                opacity: testRenderBusy || !testPrompt.trim() ? 0.5 : 1,
                              }}
                            >
                              {buttonLabel}
                            </button>
                            {testRenderBusy && (
                              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {busyHint}
                              </span>
                            )}
                          </div>
                          {testRenders.length > 0 && (
                            <div className="grid grid-cols-3 gap-2 mt-3">
                              {testRenders.map((r) => (
                                <a
                                  key={r.id}
                                  href={r.output_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block rounded-lg overflow-hidden relative group"
                                  style={{
                                    border: '1px solid var(--border)',
                                    aspectRatio: '16 / 9',
                                    background: 'var(--bg-tertiary)',
                                  }}
                                  title={`v${r.style_version} · ${r.model_used} · ${r.test_prompt.slice(0, 120)}`}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={r.output_url}
                                    alt={r.test_prompt.slice(0, 80)}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  />
                                  <div
                                    className="absolute bottom-0 left-0 right-0 text-[9px] px-1 py-0.5"
                                    style={{ background: 'rgba(0,0,0,0.7)', color: 'white' }}
                                  >
                                    v{r.style_version} · {(r.duration_ms / 1000).toFixed(1)}s
                                  </div>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      </Field>
                      );
                    })()}

                    {/* AI image suffix — demoted to "advanced" in v2.
                        Kept visible so power users can still pin a
                        specific suffix; backend backfills from
                        style_prompt on save when this is empty. */}
                    <details>
                      <summary className="text-xs font-medium cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                        Advanced: prompt suffix override
                      </summary>
                      <div className="mt-2">
                        <Field
                          label="AI image suffix (optional)"
                          hint="Appended verbatim to every AI image prompt. Leave empty to auto-fill from your style descriptor on save."
                        >
                          <textarea
                            value={draft.ai_image_suffix}
                            onChange={(e) => setDraft((d) => ({ ...d, ai_image_suffix: e.target.value }))}
                            readOnly={readOnly}
                            className="input-field w-full text-xs"
                            style={{ minHeight: 60, resize: 'vertical', fontFamily: 'monospace' }}
                            placeholder="(auto-fills from style descriptor if left empty)"
                            maxLength={1200}
                          />
                        </Field>
                      </div>
                    </details>

                    {/* Allow overlay */}
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.allow_overlay_stock}
                        onChange={(e) => setDraft((d) => ({ ...d, allow_overlay_stock: e.target.checked }))}
                        disabled={readOnly}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                          Allow real-image overlays
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Lets the model populate <code style={{ fontFamily: 'monospace' }}>overlay_stock_terms</code> on rows where a real
                          logo / screenshot / photo should be composited on top of the AI-generated visual in post.
                        </div>
                      </div>
                    </label>

                    {/* Mixing rules — visible when overlays are allowed */}
                    {draft.allow_overlay_stock && (
                      <Field
                        label="Mixing rules"
                        hint="Free-form instructions injected into the system prompt. Tell the model WHEN to populate overlay_stock_terms vs. leave it empty."
                      >
                        <textarea
                          value={draft.mixing_rules}
                          onChange={(e) => setDraft((d) => ({ ...d, mixing_rules: e.target.value }))}
                          readOnly={readOnly}
                          className="input-field w-full text-xs"
                          style={{ minHeight: 180, resize: 'vertical' }}
                          placeholder={'e.g.\n• When the script names a real company — overlay_stock_terms: "<brand> logo official PNG"\n• When the script names real software — overlay_stock_terms: "<thing> screenshot"\n• Otherwise leave empty and keep the row pure doodle.'}
                          maxLength={8000}
                        />
                      </Field>
                    )}

                    {/* Action row */}
                    <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                      <div>
                        {target && target.origin === 'saved' && (
                          <button
                            onClick={() => handleDelete(target.id, target.label)}
                            disabled={busy}
                            className="text-xs px-3 py-1.5 rounded-lg"
                            style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {isBuiltIn && target && (
                          <button
                            onClick={() => startCreateFrom(target)}
                            className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                            style={{ background: 'rgba(124,58,237,0.12)', color: 'var(--accent-purple-bright)', border: '1px solid rgba(124,58,237,0.3)' }}
                          >
                            Save as new
                          </button>
                        )}
                        {!readOnly && (() => {
                          // v2 save validation: name required, plus at
                          // least one of suffix / descriptor / refs.
                          const hasContent =
                            draft.ai_image_suffix.trim().length > 0 ||
                            draft.style_prompt.trim().length > 0 ||
                            refs.length > 0;
                          const disabled = busy || !draft.name.trim() || !hasContent;
                          return (
                            <button
                              onClick={handleSave}
                              disabled={disabled}
                              className="text-xs px-4 py-1.5 rounded-lg font-semibold"
                              style={{
                                background: 'var(--accent-purple-bright)',
                                color: 'white',
                                opacity: disabled ? 0.5 : 1,
                              }}
                            >
                              {busy ? 'Saving…' : isNew ? 'Create style' : 'Save changes'}
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

function SidebarRow({
  label,
  description,
  active,
  pill,
  onClick,
}: {
  label: string;
  description?: string;
  active: boolean;
  pill?: 'locked';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 transition-colors"
      style={{
        background: active ? 'rgba(124,58,237,0.18)' : 'transparent',
        borderLeft: active ? '2px solid var(--accent-purple-bright)' : '2px solid transparent',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium truncate" style={{ color: active ? 'var(--accent-purple-bright)' : 'var(--text-primary)' }}>
          {label}
        </span>
        {pill === 'locked' && (
          <span
            className="text-[9px] px-1 rounded"
            style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
            title="Built-in — read only"
          >
            🔒
          </span>
        )}
      </div>
      {description && (
        <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {description}
        </div>
      )}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Reference-image grid for a style. Renders the existing thumbs plus
 * an "add" tile when under the cap. Each thumb has a hover-revealed
 * delete X; refs flagged by a provider rejection render with a red
 * ring + tooltip + "Clear rejection" menu item.
 */
function RefsGrid({
  refs,
  uploadBusy,
  canUpload,
  onUpload,
  onDelete,
  onClearRejection,
}: {
  refs: StyleRefSummary[];
  uploadBusy: boolean;
  canUpload: boolean;
  onUpload: (file: File) => Promise<void>;
  onDelete: (refId: string) => Promise<void>;
  onClearRejection: (refId: string) => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function pickFile() {
    fileInputRef.current?.click();
  }
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      void onUpload(file);
    }
    // Reset so picking the same filename twice still fires onChange.
    e.target.value = '';
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void onUpload(file);
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  return (
    <div className="grid grid-cols-4 gap-2" onDrop={onDrop} onDragOver={onDragOver}>
      {refs.map((r) => (
        <div
          key={r.id}
          className="relative group rounded-lg overflow-hidden"
          style={{
            // Three border states (priority order): provider-
            // rejected (solid red), content-sniff failed (solid
            // red), content-sniff still running (dashed yellow),
            // healthy (default border). Visual hierarchy mirrors
            // the badge logic above.
            border: r.rejected_by_provider || r.content_validated === false
              ? '2px solid rgba(239,68,68,0.7)'
              : r.content_validated === null
                ? '2px dashed rgba(234,179,8,0.7)'
                : '1px solid var(--border)',
            aspectRatio: '1 / 1',
            background: 'var(--bg-tertiary)',
          }}
          title={
            r.rejected_by_provider
              ? `Rejected by ${r.rejection_provider ?? 'provider'}: ${r.rejection_reason ?? 'no reason given'}`
              : r.content_validated === false
                ? `Content validation failed: ${r.content_validation_error ?? 'magic-byte mismatch'}`
                : r.content_validated === null
                  ? 'Validating uploaded content — checking magic bytes against declared MIME type.'
                  : `Position ${r.position + 1}`
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={r.download_url}
            alt={`Reference ${r.position + 1}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          {/* Position badge */}
          <div
            className="absolute top-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(0,0,0,0.6)', color: 'white' }}
          >
            #{r.position + 1}
          </div>
          {/* Rejection indicator (provider refusal) */}
          {r.rejected_by_provider && (
            <div
              className="absolute top-1 right-1 text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(239,68,68,0.9)', color: 'white' }}
              title={r.rejection_reason ?? 'Rejected by provider'}
            >
              REJECTED
            </div>
          )}
          {/* Post-upload content-validation state (migration 0082).
              Only shown when the ref hasn't been provider-rejected
              (otherwise REJECTED takes the corner slot). Three
              states the user sees:
                - validated TRUE  → no badge (the happy path)
                - validated NULL  → spinning yellow "VALIDATING" badge
                - validated FALSE → red "INVALID" badge + hover reason */}
          {!r.rejected_by_provider && r.content_validated === null && (
            <div
              className="absolute top-1 right-1 text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(234,179,8,0.9)', color: 'white' }}
              title="Validating uploaded content — refs aren't dispatchable until this finishes."
            >
              VALIDATING…
            </div>
          )}
          {!r.rejected_by_provider && r.content_validated === false && (
            <div
              className="absolute top-1 right-1 text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(239,68,68,0.9)', color: 'white' }}
              title={r.content_validation_error ?? 'Content sniff failed'}
            >
              INVALID
            </div>
          )}
          {/* Hover actions */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: 'rgba(0,0,0,0.5)' }}
          >
            {r.rejected_by_provider && (
              <button
                onClick={() => void onClearRejection(r.id)}
                className="text-[10px] px-2 py-0.5 rounded"
                style={{ background: 'rgba(255,255,255,0.9)', color: '#111' }}
                aria-label={`Clear rejection flag on reference image ${r.position + 1}`}
              >
                Clear rejection
              </button>
            )}
            <button
              onClick={() => void onDelete(r.id)}
              className="text-[10px] px-2 py-0.5 rounded"
              style={{ background: 'rgba(239,68,68,0.9)', color: 'white' }}
              aria-label={`Remove reference image ${r.position + 1}`}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {canUpload && (
        <button
          type="button"
          onClick={pickFile}
          disabled={uploadBusy}
          className="rounded-lg flex flex-col items-center justify-center text-xs"
          style={{
            border: '2px dashed var(--border)',
            background: 'var(--bg-tertiary)',
            color: 'var(--text-muted)',
            aspectRatio: '1 / 1',
            opacity: uploadBusy ? 0.5 : 1,
            cursor: uploadBusy ? 'progress' : 'pointer',
          }}
          title="Drop an image or click to pick"
        >
          {uploadBusy ? (
            <span>Uploading…</span>
          ) : (
            <>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span className="mt-1">Add ref</span>
            </>
          )}
        </button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_REF_MIME.join(',')}
        onChange={onFileChange}
        style={{ display: 'none' }}
      />
    </div>
  );
}
