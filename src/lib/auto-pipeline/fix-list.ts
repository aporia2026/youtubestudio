/**
 * Flatten a critic-panel verdict into a single ordered "fix list"
 * that both the qa_retry handler (prompt augment) and the UI
 * (visible fix display) read from.
 *
 * Single source of truth — per the user's mid-build requirement
 * (2026-05-12): "make sure the fix list is shown in the UI too, not
 * just sent to the model." The orchestrator builds the list once,
 * persists it on `pipeline_stage_artefacts.metadata_jsonb.applied_fixes`,
 * and both the prompt builder and the UI read from that field.
 *
 * Pure helpers — no DB, no SDK. Unit-testable in isolation.
 */

import type { ScriptPanelVerdict } from '../script-critics/types';

export type FixSeverity = 'high' | 'medium' | 'low';

export interface FlatFix {
  /** Stable id for React keys + de-dup. */
  id: string;
  severity: FixSeverity;
  /** The actionable instruction. */
  text: string;
  /** Optional source — which critic raised it, when known. */
  source?: string;
  /** Optional original-line reference — when the critic quotes the
   *  script line that needs to change. */
  scriptLineRef?: string;
}

/**
 * Build the canonical fix list from a verdict.
 *
 * Order: high severity first (so they bubble to the top of both
 * the UI display and the prompt augment), then medium, then low.
 * Within a severity tier we keep input order so reading the
 * verdict in panel-render order gives the same ordering.
 *
 * De-dup: identical (severity, text) entries collapsed —
 * different critics often surface the same issue.
 */
export function flattenVerdictToFixes(verdict: ScriptPanelVerdict): FlatFix[] {
  const raw: FlatFix[] = [];
  let counter = 0;
  const nextId = () => `fix-${counter++}`;

  // critical_issues: always severity=high.
  if (Array.isArray(verdict.critical_issues)) {
    for (const issue of verdict.critical_issues) {
      if (!issue || typeof issue !== 'object') continue;
      const text = pickString(issue, ['issue', 'description', 'text']);
      if (!text) continue;
      raw.push({
        id: nextId(),
        severity: 'high',
        text,
        source: pickString(issue, ['critic', 'raised_by']),
        scriptLineRef: pickString(issue, ['script_line', 'line_ref', 'quote']),
      });
    }
  }

  // rewrite_suggestions: per the type, each entry is
  // `{ original, improved, reason }`. We turn that into a single
  // actionable fix string: "Rewrite [original] → [improved]
  // (reason)". Walked through an `unknown[]` cast so a
  // model-emitted malformed entry (e.g. a flat string) still gets
  // a useful fallback. Severity defaults to medium — the verdict
  // type doesn't expose a priority field on suggestions today.
  if (Array.isArray(verdict.rewrite_suggestions)) {
    for (const suggRaw of verdict.rewrite_suggestions as unknown[]) {
      if (typeof suggRaw === 'string') {
        if (!suggRaw.trim()) continue;
        raw.push({ id: nextId(), severity: 'medium', text: suggRaw.trim() });
        continue;
      }
      if (suggRaw && typeof suggRaw === 'object') {
        const original = pickString(suggRaw, ['original', 'quote', 'script_line']);
        const improved = pickString(suggRaw, ['improved', 'replacement', 'suggestion', 'text']);
        const reason = pickString(suggRaw, ['reason', 'description', 'critic_note']);
        let text: string | undefined;
        if (original && improved) {
          text = reason
            ? `Rewrite "${original}" → "${improved}" (${reason})`
            : `Rewrite "${original}" → "${improved}"`;
        } else {
          text = improved ?? reason ?? original;
        }
        if (!text) continue;
        raw.push({
          id: nextId(),
          severity: normaliseSeverity(pickString(suggRaw, ['priority', 'severity']) ?? 'medium'),
          text,
          source: pickString(suggRaw, ['critic', 'raised_by']),
          scriptLineRef: original,
        });
      }
    }
  }

  // Sort by severity (high → medium → low), preserve input order
  // within tier.
  const severityRank: Record<FixSeverity, number> = { high: 0, medium: 1, low: 2 };
  const ordered = raw
    .map((fix, idx) => ({ fix, idx }))
    .sort((a, b) => {
      const r = severityRank[a.fix.severity] - severityRank[b.fix.severity];
      return r !== 0 ? r : a.idx - b.idx;
    })
    .map(({ fix }) => fix);

  // De-dup by (severity, normalised-text).
  const seen = new Set<string>();
  const deduped: FlatFix[] = [];
  for (const fix of ordered) {
    const key = `${fix.severity}::${fix.text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(fix);
  }
  return deduped;
}

/**
 * Build the script-gen prompt augment from a fix list. Used by the
 * qa_retry handler to feed the prior critic feedback into the next
 * script generation pass.
 *
 * Returns an empty string when there are no fixes — the caller can
 * concat unconditionally.
 */
export function buildPromptAugmentFromFixes(fixes: FlatFix[]): string {
  if (fixes.length === 0) return '';

  const high = fixes.filter((f) => f.severity === 'high');
  const medium = fixes.filter((f) => f.severity === 'medium');
  const low = fixes.filter((f) => f.severity === 'low');

  const lines: string[] = [];
  lines.push('## CRITIC FEEDBACK FROM PREVIOUS PASS — APPLY THESE FIXES');
  lines.push('');
  lines.push('The previous pass scored below the quality threshold. The critic panel');
  lines.push('identified the following issues. Address every HIGH-severity item; address');
  lines.push('MEDIUM items where you can without contradicting the original brief.');
  lines.push('');

  if (high.length > 0) {
    lines.push('### MUST FIX (high severity)');
    for (const f of high) lines.push(`- ${f.text}${f.scriptLineRef ? ` (re: "${f.scriptLineRef}")` : ''}`);
    lines.push('');
  }
  if (medium.length > 0) {
    lines.push('### SHOULD FIX (medium severity)');
    for (const f of medium) lines.push(`- ${f.text}${f.scriptLineRef ? ` (re: "${f.scriptLineRef}")` : ''}`);
    lines.push('');
  }
  if (low.length > 0) {
    lines.push('### NICE TO FIX (low severity)');
    for (const f of low) lines.push(`- ${f.text}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── helpers ────────────────────────────────────────────────────────

function pickString(obj: unknown, keys: string[]): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function normaliseSeverity(raw: string): FixSeverity {
  const lower = raw.toLowerCase();
  if (lower.includes('high') || lower.includes('critical') || lower.includes('p0')) return 'high';
  if (lower.includes('low') || lower.includes('minor') || lower.includes('p2')) return 'low';
  return 'medium';
}
