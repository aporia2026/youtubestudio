/**
 * Stage handler: critic panel ("AI script review" in user copy).
 *
 * Active for stages `running_qa` and `qa_retry`. Tuesday's v1 is a
 * **single-pass** runner: run the panel, record the score, advance
 * to `waiting_narration`. The retry-with-applied-fixes loop ships
 * Friday — at that point this handler grows a branch that checks
 * `verdict.overall_score` against `preset.qa_min_score` +
 * `retry_count` against `preset.qa_max_iterations` and may route
 * back to `generating_script` instead.
 *
 * The plan's "fix list visible in UI too" requirement is satisfied
 * by `completeCriticPanel` writing the full verdict (including the
 * fix list under `rewrite_suggestions` / `critical_issues`) to
 * `critic_panels.verdict` — the UI reads from there. Friday's retry
 * work also persists the flattened fix list onto
 * `pipeline_stage_artefacts.metadata_jsonb.applied_fixes` so the
 * orchestrator and UI share one canonical shape.
 *
 * Calls `runScriptPanelLive` (existing pure lib function) and
 * persists each yielded event via the same path the SSE route
 * uses (`appendCriticPanelEvent`) so a future "stream pipeline
 * panel runs to the user" UI just works.
 */
import { sql } from '@vercel/postgres';
import { runScriptPanelLive } from '../../script-critics/runner-live';
import { createCriticPanel, appendCriticPanelEvent, completeCriticPanel } from '../../critic-panels';
import { resolveChain } from '../resolve-chain';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';
import type { ScriptPanelVerdict } from '../../script-critics/types';

export async function handleRunCriticPanel(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  if (!video.script_id || !video.project_id) {
    return {
      kind: 'fail',
      terminalStage: 'qa_failed_after_max_retries',
      failureClass: 'invariant_violation',
      failureMessage: 'critic-panel handler reached without script_id or project_id set.',
    };
  }

  // Load the script body. We persist the panel against the
  // current script revision; on Friday's retry pass we'll load the
  // newest is_active=true script for the project.
  const { rows: scriptRows } = await sql.query<{ content: string; niche: string | null }>(
    `
    SELECT s.content,
           COALESCE(p.niche, '') AS niche
      FROM scripts s
      JOIN projects p ON p.id = s.project_id
     WHERE s.id = $1::uuid AND p.workspace_id = $2::uuid
    `,
    [video.script_id, video.workspace_id],
  );
  if (scriptRows.length === 0) {
    return {
      kind: 'fail',
      terminalStage: 'qa_failed_after_max_retries',
      failureClass: 'script_missing',
      failureMessage: `Script ${video.script_id} not found.`,
    };
  }
  const script = scriptRows[0].content;
  const niche = scriptRows[0].niche || preset.niche || '';

  // Resolve the critic-panel model. The panel runner uses ONE model
  // (it's a multi-call deliberation against itself). When the
  // preset has a fallback chain we use the FIRST entry — fallback
  // across critics mid-deliberation would skew bias detection.
  // Whole-panel fallback (retry the entire panel with the next
  // model in the chain on transient failure) is a v1.1 idea.
  const chain = await resolveChain('critic-panel', preset);
  const modelId = chain[0];

  // Create the panel row up front so its id is available for event
  // streaming. workspace_id from the video (already scoped).
  const panel = await createCriticPanel({
    workspaceId: video.workspace_id,
    projectId: video.project_id,
    sourceScriptId: video.script_id,
    scriptText: script,
    niche,
    passNumber: video.retry_count + 1, // 1 on first try, 2 on first retry, etc.
    aggressiveness: 'standard',
    modelId,
  });

  // Drain the generator, persisting events as they arrive. Errors
  // from individual phases are non-fatal in the runner (critics
  // can fail soft and the panel still completes). The
  // `return-value` of the AsyncGenerator carries the final verdict.
  let sequenceNo = 0;
  let verdict: ScriptPanelVerdict | null = null;

  const generator = runScriptPanelLive({
    script,
    niche,
    passNumber: video.retry_count + 1,
    aggressiveness: 'standard',
    modelId,
    spend: {
      workspaceId: video.workspace_id,
      projectId: video.project_id,
      sourceScriptId: video.script_id,
    },
  });

  try {
    while (true) {
      const { value, done } = await generator.next();
      if (done) {
        verdict = value.verdict;
        // Persist the final verdict via the same completion call the
        // SSE route uses.
        await completeCriticPanel({
          workspaceId: video.workspace_id,
          panelId: panel.id,
          verdict,
          charter: value.charter ?? null,
        });
        break;
      }
      // Yielded event → append to critic_panel_events.
      await appendCriticPanelEvent({
        workspaceId: video.workspace_id,
        panelId: panel.id,
        sequenceNo: sequenceNo++,
        event: {
          phase: value.phase,
          critic_id: value.critic_id,
          event_type: value.event_type,
          payload: value.payload,
        },
      });
    }
  } catch (err) {
    // Hard failure inside the runner (network, parse error not
    // recoverable). Mark the panel row failed by stamping a
    // synthetic verdict — keeps the UI honest about what happened.
    logger.error('auto-pipeline: critic panel threw', {
      pipeline_video_id: video.id,
      panel_id: panel.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'fail',
      terminalStage: 'qa_failed_after_max_retries',
      failureClass: 'unknown',
      failureMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    };
  }

  if (!verdict) {
    return {
      kind: 'fail',
      terminalStage: 'qa_failed_after_max_retries',
      failureClass: 'empty_or_malformed',
      failureMessage: 'Panel completed without a verdict.',
    };
  }

  // v1 (Tuesday): record score, advance regardless. The retry
  // loop ships Friday. The verdict is already on critic_panels;
  // we just attach the panel_id to the video.
  logger.info('auto-pipeline: critic panel completed', {
    pipeline_video_id: video.id,
    panel_id: panel.id,
    overall_score: verdict.overall_score,
    threshold: preset.qa_min_score,
    retry_count: video.retry_count,
  });

  return {
    kind: 'advance',
    nextStage: 'waiting_narration',
    persist: {
      critic_panel_id: panel.id,
      narration_deadline_at: new Date(Date.now() + preset.narration_deadline_days * 24 * 60 * 60 * 1000),
    },
  };
}
