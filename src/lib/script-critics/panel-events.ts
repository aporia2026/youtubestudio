/**
 * Event types emitted by the live Court of Critics runner.
 *
 * The runner is an AsyncGenerator<PanelEvent>; each event is also persisted
 * to `critic_panel_events` so the courtroom can be replayed (and a client
 * that disconnects mid-run can rejoin from sequence_no + 1).
 *
 * Phase + event_type pairs are CHECK-constrained at the DB level — keep
 * the unions below in lock-step with the constraints in migration 0025.
 */
import type {
  ScriptCharter,
  ScriptCriticId,
  ScriptCriticReport,
  ScriptDeliberationNote,
  ScriptPanelVerdict,
} from './types';

export type PanelEventPhase = 'panel' | 'charter' | 'draft' | 'deliberation' | 'chair';
export type PanelEventType = 'start' | 'complete' | 'error';

interface BaseEvent {
  /** 1-based monotonic per panel. The route tags this on persistence. */
  sequence_no: number;
  phase: PanelEventPhase;
  /** Set for per-critic events (draft, deliberation); null for charter / chair / panel. */
  critic_id: ScriptCriticId | null;
  event_type: PanelEventType;
  captured_at: string;
}

export interface PanelStartEvent extends BaseEvent {
  phase: 'panel';
  critic_id: null;
  event_type: 'start';
  payload: {
    niche: string;
    pass_number: number;
    aggressiveness: string;
    model_id: string;
    /** Truncated preview so the UI can show what's being judged without
     *  paying for the whole script body in every event tail. */
    script_preview: string;
  };
}

export interface PanelCompleteEvent extends BaseEvent {
  phase: 'panel';
  critic_id: null;
  event_type: 'complete';
  payload: {
    verdict: ScriptPanelVerdict;
    duration_ms: number;
  };
}

export interface PanelErrorEvent extends BaseEvent {
  phase: 'panel';
  critic_id: null;
  event_type: 'error';
  payload: { message: string };
}

export interface CharterStartEvent extends BaseEvent {
  phase: 'charter';
  critic_id: null;
  event_type: 'start';
  payload: Record<string, never>;
}

export interface CharterCompleteEvent extends BaseEvent {
  phase: 'charter';
  critic_id: null;
  event_type: 'complete';
  payload: { charter: ScriptCharter };
}

export interface CharterErrorEvent extends BaseEvent {
  phase: 'charter';
  critic_id: null;
  event_type: 'error';
  payload: { message: string };
}

export interface DraftStartEvent extends BaseEvent {
  phase: 'draft';
  critic_id: ScriptCriticId;
  event_type: 'start';
  payload: Record<string, never>;
}

export interface DraftCompleteEvent extends BaseEvent {
  phase: 'draft';
  critic_id: ScriptCriticId;
  event_type: 'complete';
  payload: { draft: ScriptCriticReport };
}

export interface DraftErrorEvent extends BaseEvent {
  phase: 'draft';
  critic_id: ScriptCriticId;
  event_type: 'error';
  payload: { message: string };
}

export interface DeliberationStartEvent extends BaseEvent {
  phase: 'deliberation';
  critic_id: ScriptCriticId;
  event_type: 'start';
  payload: Record<string, never>;
}

export interface DeliberationCompleteEvent extends BaseEvent {
  phase: 'deliberation';
  critic_id: ScriptCriticId;
  event_type: 'complete';
  payload: { note: ScriptDeliberationNote };
}

export interface DeliberationErrorEvent extends BaseEvent {
  phase: 'deliberation';
  critic_id: ScriptCriticId;
  event_type: 'error';
  payload: { message: string };
}

export interface ChairStartEvent extends BaseEvent {
  phase: 'chair';
  critic_id: null;
  event_type: 'start';
  payload: { model_id: string };
}

export interface ChairCompleteEvent extends BaseEvent {
  phase: 'chair';
  critic_id: null;
  event_type: 'complete';
  payload: { verdict: ScriptPanelVerdict };
}

export interface ChairErrorEvent extends BaseEvent {
  phase: 'chair';
  critic_id: null;
  event_type: 'error';
  payload: { message: string };
}

export type PanelEvent =
  | PanelStartEvent
  | PanelCompleteEvent
  | PanelErrorEvent
  | CharterStartEvent
  | CharterCompleteEvent
  | CharterErrorEvent
  | DraftStartEvent
  | DraftCompleteEvent
  | DraftErrorEvent
  | DeliberationStartEvent
  | DeliberationCompleteEvent
  | DeliberationErrorEvent
  | ChairStartEvent
  | ChairCompleteEvent
  | ChairErrorEvent;

/**
 * Persisted row shape — mirrors `critic_panel_events`. The `payload`
 * column is JSONB; this is the typed view of it.
 */
export interface CriticPanelEventRow {
  id: string;
  workspace_id: string;
  panel_id: string;
  sequence_no: number;
  phase: PanelEventPhase;
  critic_id: ScriptCriticId | null;
  event_type: PanelEventType;
  payload: Record<string, unknown>;
  captured_at: string;
}

/**
 * Persisted row shape — mirrors `critic_panels`. JSONB columns are typed
 * loosely (Record) because the runner already validates them on the way in;
 * the route helpers cast to the precise types when serving.
 */
export interface CriticPanelRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  source_script_id: string | null;
  script_text: string;
  niche: string;
  pass_number: number;
  aggressiveness: string;
  model_id: string;
  status: 'running' | 'completed' | 'failed';
  error_message: string | null;
  verdict: ScriptPanelVerdict | null;
  charter: ScriptCharter | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}
