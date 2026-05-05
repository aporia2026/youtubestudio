'use client';

// Context plumbing for the schedule-link banner's "Save" affordance. Each
// generator page (Script, SEO, QA, Production Doc, Thumbnails, Voiceover)
// declares an artifact + how to push it via `useRegisterScheduleWriteBack`,
// and the shared <ScheduleLinkBanner /> reads from this context to render the
// Save button, dirty indicator, and post-save "Mark complete" follow-up.
//
// Design notes:
//
//   - Save NEVER auto-advances the schedule item's status. Advance is a
//     deliberate second click via the toast or banner subtitle. This was an
//     explicit user requirement ("prevents crucial mistakes") — clicking Save
//     mid-iteration must not silently move a card to the next pipeline stage.
//
//   - The handle passed to `useRegisterScheduleWriteBack` is rebuilt every
//     render. We snapshot the primitive flags (artifactLabel, isReady, isDirty,
//     nextStatus) into the registered saver — those drive the banner's render
//     output. The function fields (buildPatch, describeSaved, onSaved) are
//     read through a ref so the saver always invokes the latest closure
//     without re-registering on every render. This avoids the classic stale-
//     closure bug (where Save sends data captured at first mount).
//
//   - Auto-stamp (`useScheduleAutoStamp`) is intentionally separate. It runs
//     once per `runKey` change and only writes the metadata fingerprint to
//     `custom_fields`, never any artifact field. Failures are silent — this is
//     a side-channel for the schedule grid's "QA'd / SEO'd" indicators, not a
//     primary save path.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import {
  fetchScheduleItem,
  writeBackToSchedule,
} from '@/lib/schedule-link';

export interface ScheduleNextStatus {
  /** Pipeline status key (must exist in the item's channel pipeline; otherwise the server no-ops). */
  key: string;
  /** Friendly label for buttons + toasts ("Recording", "Editing"). */
  label: string;
}

export interface ScheduleSaverHandle {
  /** Display name for the artifact ("Script", "QA report", "Thumbnails"). Drives button copy + toast. */
  artifactLabel: string;
  /** Whether the page has produced an artifact ready to save. Disables button when false. */
  isReady: boolean;
  /** Unsaved changes since last save. Drives the dirty dot + the button's primary/neutral styling. */
  isDirty: boolean;
  /** Human reason shown in the disabled-button tooltip ("No script generated yet"). */
  notReadyReason?: string;
  /** Optional pipeline target offered as a follow-up after save. Save itself never advances. */
  nextStatus?: ScheduleNextStatus;
  /** Returns the PATCH body. Called fresh on every save click — read latest
   *  state inside. May be async (e.g., the Script Generator does a project /
   *  script POST first, then writes the resulting ids back to the item). */
  buildPatch: () =>
    | { patch: Record<string, unknown>; customFieldsMerge?: Record<string, unknown> }
    | Promise<{ patch: Record<string, unknown>; customFieldsMerge?: Record<string, unknown> }>;
  /** Optional one-line description for the success toast ("title + 12 tags + description"). */
  describeSaved?: () => string;
  /** Called after a successful save so the page can clear its dirty flag (e.g., update lastSavedHash). */
  onSaved?: () => void;
}

interface ScheduleLinkContextValue {
  item: ScheduleItem | null;
  saver: ScheduleSaverHandle | null;
  lastSavedAt: number | null;
  saving: boolean;
  triggerSave: () => Promise<boolean>;
  triggerAdvance: () => Promise<boolean>;
  registerSaver: (h: ScheduleSaverHandle | null) => void;
  refreshItem: () => void;
}

const ScheduleLinkContext = createContext<ScheduleLinkContextValue | null>(null);

export function useScheduleLinkContext(): ScheduleLinkContextValue | null {
  return useContext(ScheduleLinkContext);
}

interface ProviderProps {
  /** Initial item from the parent's preload. The provider becomes the source of truth after mount. */
  item: ScheduleItem | null;
  children: ReactNode;
}

export function ScheduleLinkProvider({ item: initialItem, children }: ProviderProps) {
  const [item, setItem] = useState<ScheduleItem | null>(initialItem);
  const [saver, setSaverState] = useState<ScheduleSaverHandle | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Keep the registered saver in a ref so trigger callbacks always see the
  // latest snapshot (avoids React state staleness inside async closures).
  const saverRef = useRef<ScheduleSaverHandle | null>(null);
  // savingRef mirrors the `saving` state synchronously so a double-click
  // (two save invocations within the same React batch, before the first
  // setSaving(true) has flushed) can't both pass the `if (saving) return`
  // guard. This is the textbook fix for "fast double-click submits twice".
  const savingRef = useRef(false);
  // Track mounted so post-save state updates after unmount are no-ops.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Sync local state when the parent navigates to a *different* schedule item
  // (id changes). On a same-id rerender we keep the locally-refreshed copy
  // so a save → refresh cycle isn't clobbered by a stale parent prop.
  const initialId = initialItem?.id ?? null;
  useEffect(() => {
    setItem(curr => {
      if (!initialItem) return null;
      if (!curr || curr.id !== initialItem.id) return initialItem;
      return curr;
    });
  }, [initialId, initialItem]);

  // Refresh on tab focus (user may have edited the item in another tab).
  useEffect(() => {
    if (!item?.id) return;
    const id = item.id;
    function refresh() {
      if (typeof document === 'undefined') return;
      if (document.visibilityState !== 'visible') return;
      fetchScheduleItem(id).then(fresh => {
        if (!mountedRef.current) return;
        if (fresh) setItem(curr => (curr && curr.id === fresh.id ? fresh : curr));
      });
    }
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [item?.id]);

  const refreshItem = useCallback(() => {
    if (!item?.id) return;
    const id = item.id;
    fetchScheduleItem(id).then(fresh => {
      if (!mountedRef.current) return;
      if (fresh) setItem(curr => (curr && curr.id === fresh.id ? fresh : curr));
    });
  }, [item?.id]);

  const registerSaver = useCallback((h: ScheduleSaverHandle | null) => {
    saverRef.current = h;
    setSaverState(h);
  }, []);

  const triggerSave = useCallback(async (): Promise<boolean> => {
    const id = item?.id;
    const h = saverRef.current;
    if (!id || !h || !h.isReady || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      let body: { patch: Record<string, unknown>; customFieldsMerge?: Record<string, unknown> };
      try {
        const maybe = h.buildPatch();
        body = maybe instanceof Promise ? await maybe : maybe;
      } catch (err) {
        // The page-level buildPatch is responsible for showing a specific
        // error toast (e.g. "Could not save the script"). We just log here
        // and bail; double-toasting would be confusing.
        console.error('buildPatch threw', err);
        return false;
      }
      if (!mountedRef.current) return false;
      const ok = await writeBackToSchedule(id, body.patch, {
        customFieldsMerge: body.customFieldsMerge,
        // Never advance on the primary save — advance is a second click.
      });
      if (!mountedRef.current) return ok;
      if (ok) {
        const detail = h.describeSaved?.();
        toast.success(detail ? `Saved ${h.artifactLabel} · ${detail}` : `Saved ${h.artifactLabel}`);
        setLastSavedAt(Date.now());
        try { h.onSaved?.(); } catch (err) { console.error('onSaved threw', err); }
        // Refresh so the banner's status pill, etc. reflect any server-side
        // side effects (e.g., the auto-stamp that may have raced ahead).
        refreshItem();
      }
      return ok;
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [item?.id, refreshItem]);

  const triggerAdvance = useCallback(async (): Promise<boolean> => {
    const id = item?.id;
    const h = saverRef.current;
    const targetKey = h?.nextStatus?.key;
    const targetLabel = h?.nextStatus?.label;
    if (!id || !targetKey || savingRef.current) return false;
    if (item?.status === targetKey) {
      toast.message(`Already at ${targetLabel ?? targetKey}`);
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      // Direct fetch (rather than writeBackToSchedule) so we can distinguish
      // between "advanced" and "no-op because already past target". The API
      // returns `advanced: null` when the strict-ordering check fails — surface
      // that to the user instead of going silent.
      const res = await fetch(`/api/schedule/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_advance_to: targetKey }),
      });
      if (!res.ok) {
        if (res.status === 404) toast.warning('Linked schedule item is gone');
        else toast.error('Could not advance the schedule item');
        return false;
      }
      const data: { advanced?: { prev_status: string; new_status: string } | null } =
        await res.json().catch(() => ({}));
      if (data.advanced) {
        const { prev_status, new_status } = data.advanced;
        toast.success(`Moved to ${targetLabel ?? new_status}`, {
          action: {
            label: 'Undo',
            onClick: async () => {
              // Re-fetch current status so a manual move between advance +
              // undo isn't silently reverted by a stale closure.
              const fresh = await fetchScheduleItem(id);
              if (!fresh) { toast.error('Item is gone'); return; }
              if (fresh.status !== new_status) {
                toast.message('Status already changed — nothing to undo');
                return;
              }
              const r = await fetch(`/api/schedule/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: prev_status }),
              });
              if (r.ok) { toast.message('Undone'); refreshItem(); }
              else toast.error('Undo failed');
            },
          },
        });
        if (mountedRef.current) refreshItem();
      } else {
        toast.message(`Already past ${targetLabel ?? targetKey}`);
      }
      return true;
    } catch (err) {
      console.error('triggerAdvance', err);
      toast.error('Could not advance the schedule item');
      return false;
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [item?.id, item?.status, refreshItem]);

  const value = useMemo<ScheduleLinkContextValue>(() => ({
    item,
    saver,
    lastSavedAt,
    saving,
    triggerSave,
    triggerAdvance,
    registerSaver,
    refreshItem,
  }), [item, saver, lastSavedAt, saving, triggerSave, triggerAdvance, registerSaver, refreshItem]);

  return (
    <ScheduleLinkContext.Provider value={value}>{children}</ScheduleLinkContext.Provider>
  );
}

/**
 * Page-level hook: declare the current artifact + how to push it.
 *
 * The handle's primitive fields (artifactLabel, isReady, isDirty, nextStatus)
 * are snapshotted into the registered saver so the banner re-renders when they
 * change. The function fields (buildPatch, describeSaved, onSaved) are read
 * through a ref on every invocation — pages don't need to memoize them.
 *
 * No-op when called outside a <ScheduleLinkProvider>; this lets pages call
 * the hook unconditionally even when there's no linked schedule item.
 */
export function useRegisterScheduleWriteBack(handle: ScheduleSaverHandle): void {
  const ctx = useContext(ScheduleLinkContext);

  // Latest closures live in a ref so we don't re-register on every render
  // just because callbacks changed identity.
  const handleRef = useRef(handle);
  handleRef.current = handle;

  const { artifactLabel, isReady, isDirty, notReadyReason } = handle;
  const nextKey = handle.nextStatus?.key;
  const nextLabel = handle.nextStatus?.label;

  // Why: depend on `registerSaver` (stable useCallback) — NOT `ctx`. The
  // provider's `value` useMemo recomputes whenever `saver` changes, so
  // `ctx` is a new reference after every register call. Keying on `ctx`
  // creates a feedback loop: register → setSaverState → new ctx → effect
  // re-fires → register → … which pegs CPU at idle and OOMs the tab.
  const registerSaver = ctx?.registerSaver;

  // Two-effect setup: the first registers a fresh snapshot whenever the
  // primitive flags change (overwriting in place — no null-then-set
  // flicker). The second runs only on unmount, clearing the saver so the
  // banner doesn't render a stale Save button after the page is gone.
  useEffect(() => {
    if (!registerSaver) return;
    const snapshot: ScheduleSaverHandle = {
      artifactLabel,
      isReady,
      isDirty,
      notReadyReason,
      nextStatus: nextKey ? { key: nextKey, label: nextLabel ?? nextKey } : undefined,
      buildPatch: () => Promise.resolve(handleRef.current.buildPatch()),
      describeSaved: () => handleRef.current.describeSaved?.() ?? '',
      onSaved: () => handleRef.current.onSaved?.(),
    };
    registerSaver(snapshot);
  }, [registerSaver, artifactLabel, isReady, isDirty, notReadyReason, nextKey, nextLabel]);

  useEffect(() => {
    if (!registerSaver) return;
    return () => { registerSaver(null); };
  }, [registerSaver]);
}

/**
 * Page-level hook: silently stamp metadata onto `custom_fields` when an
 * artifact becomes ready. Fires once per `runKey` change. Failures are
 * intentionally silent — the schedule grid uses these stamps for status
 * indicators, not as the canonical save path.
 *
 * Pass a stable `runKey` (e.g., a generation id, or `null` when nothing is
 * ready). The stamp won't fire on the same `runKey` twice.
 */
export function useScheduleAutoStamp({
  key,
  value,
  runKey,
}: {
  /** custom_fields key to stamp under (e.g., 'latest_qa', 'latest_seo'). */
  key: string;
  /** Returns the metadata payload, or null to skip. Called only when about to fire. */
  value: () => Record<string, unknown> | null;
  /** Stable identifier for the current artifact. New value → fire once. Null → never fire. */
  runKey: string | null;
}): void {
  const ctx = useContext(ScheduleLinkContext);
  // Read latest `value` closure from a ref — same stale-closure protection as
  // the registration hook above.
  const valueRef = useRef(value);
  valueRef.current = value;
  // Track which runKey we've already stamped to avoid re-firing on rerender.
  const seenRef = useRef<string | null>(null);

  const itemId = ctx?.item?.id ?? null;

  useEffect(() => {
    if (!itemId || !runKey) return;
    if (seenRef.current === runKey) return;
    let payload: Record<string, unknown> | null;
    try {
      payload = valueRef.current();
    } catch (err) {
      console.error('auto-stamp value() threw', err);
      return;
    }
    if (!payload) return;
    seenRef.current = runKey;
    fetch(`/api/schedule/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_fields_merge: { [key]: payload } }),
    }).catch(err => { console.error('auto-stamp PATCH failed', err); });
  }, [itemId, runKey, key]);

  // Reset seen-tracker when the linked item changes — a different item should
  // get its own first stamp.
  useEffect(() => { seenRef.current = null; }, [itemId]);
}

/**
 * Declarative registration helper. Drop one of these as a child of
 * <ScheduleLinkProvider> to wire up the page's saver + (optional) auto-stamp
 * without splitting the page into a wrapper component just to host the hooks.
 *
 * Renders nothing.
 */
export function ScheduleSaverRegistration({
  handle,
  autoStamp,
}: {
  handle: ScheduleSaverHandle;
  autoStamp?: {
    /** custom_fields key to stamp under (e.g. 'latest_qa'). */
    key: string;
    /** Returns the metadata payload, or null to skip. */
    value: () => Record<string, unknown> | null;
    /** Stable identifier for the current artifact. New value → fire once. Null → never fire. */
    runKey: string | null;
  };
}): null {
  useRegisterScheduleWriteBack(handle);
  // Hook rules: call unconditionally. When `autoStamp` is omitted, pass a
  // safely-null runKey so the effect bails out before the PATCH.
  useScheduleAutoStamp({
    key: autoStamp?.key ?? 'noop',
    value: autoStamp?.value ?? (() => null),
    runKey: autoStamp ? autoStamp.runKey : null,
  });
  return null;
}
