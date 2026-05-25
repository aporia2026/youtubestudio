'use client';

import { useCallback, useEffect, useReducer } from 'react';

/**
 * The three accordion sections in the editor inspector. Used as both the
 * data shape key and the keyboard-shortcut numeric mapping (1-3 in
 * declaration order).
 *
 * History note: the original plan called for four sections (Title+Zoom and
 * Motion split). During Phase 2 we collapsed them into a single
 * "Section settings" accordion that mirrors the existing
 * `SectionRowControls` component boundary. Cleaner navigation, less
 * duplication, one place to look for stripe / layout / color / zoom /
 * transition / fade — all the per-row Look & Motion settings. The
 * read-only Phase 1 already shipped with four sections; the localStorage
 * reader treats unknown keys as `false` so old state degrades cleanly.
 */
export const ACCORDION_KEYS = ['broll', 'overlay', 'sectionSettings'] as const;
export type AccordionKey = (typeof ACCORDION_KEYS)[number];
export type AccordionState = Record<AccordionKey, boolean>;

/** localStorage key for persisting accordion open/closed state across reloads. */
const ACCORDION_LS_KEY = 'production-doc-editor-accordion-state';

/** Default state: top section expanded, the rest collapsed. Honest to the
 *  "most-used section first" UX heuristic — B-roll is the heaviest tab. */
const DEFAULT_ACCORDION_STATE: AccordionState = {
  broll: true,
  overlay: false,
  sectionSettings: false,
};

function readAccordionLs(): AccordionState {
  if (typeof window === 'undefined') return DEFAULT_ACCORDION_STATE;
  try {
    const raw = window.localStorage.getItem(ACCORDION_LS_KEY);
    if (!raw) return DEFAULT_ACCORDION_STATE;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_ACCORDION_STATE;
    return {
      broll: parsed.broll === false ? false : true,
      overlay: Boolean(parsed.overlay),
      sectionSettings: Boolean(parsed.sectionSettings),
    };
  } catch {
    return DEFAULT_ACCORDION_STATE;
  }
}

function writeAccordionLs(state: AccordionState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACCORDION_LS_KEY, JSON.stringify(state));
  } catch {
    /* localStorage full / private mode — silently degrade */
  }
}

/**
 * Which big-editor tool is currently taking over the Stage area.
 * `null` means the Stage renders the live preview (default). Setting
 * a value swaps the Stage to render that tool's canvas; the inspector
 * and section strip stay visible. See Phase 2's stage-takeover plan.
 */
export type StageTool = 'overlay-position' | 'mask' | 'region' | null;

interface EditorUiState {
  activeSection: number;
  accordion: AccordionState;
  totalSections: number;
  stageTool: StageTool;
  cheatSheetOpen: boolean;
}

type EditorUiAction =
  | { type: 'set-active'; index: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'toggle-accordion'; key: AccordionKey }
  | { type: 'expand-accordion'; key: AccordionKey }
  | { type: 'set-total'; total: number }
  | { type: 'set-stage-tool'; tool: StageTool }
  | { type: 'set-cheat-sheet'; open: boolean }
  | { type: 'toggle-cheat-sheet' };

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, n));
}

function reducer(state: EditorUiState, action: EditorUiAction): EditorUiState {
  switch (action.type) {
    case 'set-active':
      // Switching sections automatically dismisses any active stage tool
      // — the tool's context (this section's overlay etc.) no longer
      // matches the new section.
      return {
        ...state,
        activeSection: clamp(action.index, 0, state.totalSections - 1),
        stageTool: null,
      };
    case 'next':
      return {
        ...state,
        activeSection: clamp(state.activeSection + 1, 0, state.totalSections - 1),
        stageTool: null,
      };
    case 'prev':
      return {
        ...state,
        activeSection: clamp(state.activeSection - 1, 0, state.totalSections - 1),
        stageTool: null,
      };
    case 'first':
      return { ...state, activeSection: 0, stageTool: null };
    case 'last':
      return { ...state, activeSection: Math.max(0, state.totalSections - 1), stageTool: null };
    case 'toggle-accordion': {
      const next = { ...state.accordion, [action.key]: !state.accordion[action.key] };
      return { ...state, accordion: next };
    }
    case 'expand-accordion': {
      if (state.accordion[action.key]) return state;
      const next = { ...state.accordion, [action.key]: true };
      return { ...state, accordion: next };
    }
    case 'set-total':
      return {
        ...state,
        totalSections: action.total,
        activeSection: clamp(state.activeSection, 0, Math.max(0, action.total - 1)),
      };
    case 'set-stage-tool':
      return { ...state, stageTool: action.tool };
    case 'set-cheat-sheet':
      return { ...state, cheatSheetOpen: action.open };
    case 'toggle-cheat-sheet':
      return { ...state, cheatSheetOpen: !state.cheatSheetOpen };
    default:
      return state;
  }
}

/**
 * Editor view's local UI state — *not* doc state. Doc edits go through the
 * page-level `updateRow` / `setDoc`. This hook tracks: which section is
 * active, which accordion sections are open, and exposes keyboard nav.
 *
 * Accordion open/closed state persists to localStorage so the user's
 * preference survives reloads. Active section resets to 0 on remount —
 * intentional; landing on the first section is a less confusing start
 * than restoring a stale selection.
 */
export function useEditorUiState(totalSections: number) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    activeSection: 0,
    accordion: readAccordionLs(),
    totalSections,
    stageTool: null as StageTool,
    cheatSheetOpen: false,
  }));

  useEffect(() => {
    dispatch({ type: 'set-total', total: totalSections });
  }, [totalSections]);

  useEffect(() => {
    writeAccordionLs(state.accordion);
  }, [state.accordion]);

  const setActiveSection = useCallback((index: number) => {
    dispatch({ type: 'set-active', index });
  }, []);
  const nextSection = useCallback(() => dispatch({ type: 'next' }), []);
  const prevSection = useCallback(() => dispatch({ type: 'prev' }), []);
  const firstSection = useCallback(() => dispatch({ type: 'first' }), []);
  const lastSection = useCallback(() => dispatch({ type: 'last' }), []);
  const toggleAccordion = useCallback((key: AccordionKey) => {
    dispatch({ type: 'toggle-accordion', key });
  }, []);
  const expandAccordion = useCallback((key: AccordionKey) => {
    dispatch({ type: 'expand-accordion', key });
  }, []);
  const setStageTool = useCallback((tool: StageTool) => {
    dispatch({ type: 'set-stage-tool', tool });
  }, []);
  const setCheatSheet = useCallback((open: boolean) => {
    dispatch({ type: 'set-cheat-sheet', open });
  }, []);
  const toggleCheatSheet = useCallback(() => {
    dispatch({ type: 'toggle-cheat-sheet' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      // Esc — dismiss the stage tool or the cheat sheet. Always wins,
      // even from inside an editable element, because the surface the
      // user is in may be exactly what they want to leave.
      if (e.key === 'Escape') {
        if (state.cheatSheetOpen) {
          e.preventDefault();
          dispatch({ type: 'set-cheat-sheet', open: false });
          return;
        }
        if (state.stageTool) {
          e.preventDefault();
          dispatch({ type: 'set-stage-tool', tool: null });
          return;
        }
      }
      // ? — toggle cheat sheet. Skip when inside an editable so the
      // user can type literal `?` into a textarea.
      if (e.key === '?' && !inEditable) {
        e.preventDefault();
        dispatch({ type: 'toggle-cheat-sheet' });
        return;
      }
      if (inEditable) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          dispatch({ type: 'next' });
          break;
        case 'ArrowLeft':
          e.preventDefault();
          dispatch({ type: 'prev' });
          break;
        case 'Home':
          e.preventDefault();
          dispatch({ type: 'first' });
          break;
        case 'End':
          e.preventDefault();
          dispatch({ type: 'last' });
          break;
        case '1':
          dispatch({ type: 'expand-accordion', key: 'broll' });
          break;
        case '2':
          dispatch({ type: 'expand-accordion', key: 'overlay' });
          break;
        case '3':
          dispatch({ type: 'expand-accordion', key: 'sectionSettings' });
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.stageTool, state.cheatSheetOpen]);

  return {
    activeSection: state.activeSection,
    accordion: state.accordion,
    stageTool: state.stageTool,
    cheatSheetOpen: state.cheatSheetOpen,
    setActiveSection,
    nextSection,
    prevSection,
    firstSection,
    lastSection,
    toggleAccordion,
    expandAccordion,
    setStageTool,
    setCheatSheet,
    toggleCheatSheet,
  };
}
