'use client';

import { Suspense, useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, loadFullContextForItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ScheduleLinkProvider, ScheduleSaverRegistration } from '@/components/ui/ScheduleLinkContext';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { SaveAsProject } from '@/components/ui/SaveAsProject';
import { ExportScript } from '@/components/ui/ExportScript';
import { CopyForElevenLabs } from '@/components/ui/CopyForElevenLabs';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { ScoreRing } from '@/components/ui/ScoreRing';
import { saveDraft, getActiveDraft } from '@/lib/drafts';
import { EMPTY_CONSTRAINTS, hasAnyConstraint, type ScriptConstraints } from '@/lib/script-options';
import { countWords, scoreLabel } from '@/lib/utils';
import { saveQAEntry, getQAHistory, deleteQAEntry, clearQAHistory, getRecentNiches, type QAHistoryEntry } from '@/lib/history';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { TemplateContextPicker } from '@/components/ui/TemplateContextPicker';

type Aggressiveness = 'standard' | 'brutal' | 'nuclear';

interface QACategory {
  score: number;
  assessment: string;
  issues?: string[];
  weak_spots?: string[];
  missing_elements?: string[];
  fix: string;
}

interface CriticalIssue {
  severity: 'critical' | 'major' | 'minor';
  location: string;
  issue: string;
  fix: string;
}

interface RewriteSuggestion {
  original: string;
  improved: string;
  reason: string;
}

interface QAResult {
  overall_score: number;
  verdict: string;
  will_it_perform: string;
  categories: {
    hook_strength: QACategory;
    retention_potential: QACategory;
    content_quality: QACategory;
    audience_targeting: QACategory;
    cta_effectiveness: QACategory;
    seo_optimization: QACategory;
    pacing_flow: QACategory;
  };
  critical_issues: CriticalIssue[];
  strengths: string[];
  rewrite_suggestions: RewriteSuggestion[];
  title_suggestions: string[];
  thumbnail_ideas: string[];
  next_pass_focus: string;
}

const SEVERITY_COLORS = {
  critical: { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', text: '#ef4444', label: '🔴 Critical' },
  major: { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', text: '#f59e0b', label: '🟡 Major' },
  minor: { bg: 'rgba(99,102,241,0.1)', border: 'rgba(99,102,241,0.3)', text: '#6366f1', label: '🔵 Minor' },
};

const CATEGORY_LABELS: Record<string, { label: string; emoji: string }> = {
  hook_strength: { label: 'Hook Strength', emoji: '🎣' },
  retention_potential: { label: 'Retention', emoji: '📊' },
  content_quality: { label: 'Content Quality', emoji: '💎' },
  audience_targeting: { label: 'Audience Fit', emoji: '🎯' },
  cta_effectiveness: { label: 'CTA', emoji: '📢' },
  seo_optimization: { label: 'SEO', emoji: '🔍' },
  pacing_flow: { label: 'Pacing & Flow', emoji: '⚡' },
  human_authenticity: { label: 'Human Feel', emoji: '🧠' },
  natural_speech: { label: 'Natural Speech', emoji: '🗣️' },
  logic_coherence: { label: 'Logic & Flow', emoji: '🔗' },
};

export default function QAPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <QAPage />
    </Suspense>
  );
}

function QAPage() {
  const search = useSearchParams();
  const scheduleItemId = getScheduleLinkId(search);
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);

  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('qa-engine'));
  const [script, setScript] = useState('');
  // The video title/topic this QA session is for. Surfaced in the header so the user
  // always knows which script they're reviewing. Set from generator handoff, schedule
  // link, active draft, or session backup.
  const [topic, setTopic] = useState('');
  const [niche, setNiche] = useState('Cybersecurity & Antivirus');
  const [aggressiveness, setAggressiveness] = useState<Aggressiveness>('brutal');
  // Saved-template + per-call context for the reviewer. Mirrors the
  // pattern in the script generator. The default QA template (if any)
  // is auto-selected by TemplateContextPicker on mount.
  const [qaTemplateId, setQaTemplateId] = useState<string | null>(null);
  const [qaContext, setQaContext] = useState('');
  const [running, setRunning] = useState(false);
  const [passNumber, setPassNumber] = useState(1);
  const [results, setResults] = useState<QAResult[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [activeTab, setActiveTab] = useState<'scores' | 'issues' | 'rewrites' | 'suggestions' | 'apply'>('scores');
  const [approvedFixes, setApprovedFixes] = useState<Set<string>>(new Set());
  const [applyingFixes, setApplyingFixes] = useState(false);
  const [fixedScript, setFixedScript] = useState('');
  const fixedScriptRef = useRef<HTMLDivElement>(null);
  const [qaHistory, setQaHistory] = useState<QAHistoryEntry[]>(() => getQAHistory());
  const [nicheHints, setNicheHints] = useState<string[]>([]);
  // Linked project + script (set when "Save as Project" is used, or carried from an active draft).
  // When present, QA sessions and fixed-script revisions are persisted to the projects/scripts/qa_sessions tables.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scriptId, setScriptId] = useState<string | null>(null);
  // Persisted-to-project flag so "Save as Project" toasts land once even if the user re-runs fixes.
  const [savingProject, setSavingProject] = useState(false);
  // Constraints inherited from the Script Generator (skip hook, skip CTA, custom
  // exclusions). Passed to /api/qa/analyze so the reviewer doesn't penalize
  // intentionally-omitted elements. User can view/toggle them on this page too.
  const [constraints, setConstraints] = useState<ScriptConstraints>(EMPTY_CONSTRAINTS);
  // Tracks which QA pass (by runKey) was last explicitly saved via the banner.
  // When the latest pass's runKey diverges from this, the Save button shows a
  // dirty-dot indicator.
  const [lastSavedQaRunKey, setLastSavedQaRunKey] = useState<string | null>(null);
  // Tracks the exact script content last saved to the linked project. Drives
  // the dirty indicator in concert with `lastSavedQaRunKey` so re-saving a
  // post-QA edited script (or applying new fixes) lights up the button.
  const [lastSavedQaScript, setLastSavedQaScript] = useState<string>('');

  // Load prefill from Script Generator. Also restore any previously-backed-up session
  // so a refresh or HMR cycle doesn't wipe a multi-pass QA run.
  //
  // All restore writes use functional setters (prev => prev || backup) so that:
  //   (a) a fresh qa_prefill set earlier in the same effect wins over a stale backup, and
  //   (b) Fast-Refresh re-runs of this mount effect can't clobber in-memory state that
  //       was accumulated after the original mount — the closure's initial `script`/`results`
  //       are stale, but the functional-setter `prev` is always current.
  // Schedule-link preload: if launched with ?scheduleItemId, pull the linked
  // item's script (via its project) so the QA screen starts populated. Also
  // links the active project so QA results write back to the right script
  // version.
  useEffect(() => {
    if (!scheduleItemId || schedulePrefilled) return;
    let cancelled = false;
    (async () => {
      const item = await fetchScheduleItem(scheduleItemId);
      if (cancelled || !item) return;
      setScheduleItem(item);
      setSchedulePrefilled(true);
      const ctx = await loadFullContextForItem(item);
      if (cancelled) return;
      if (ctx.niche) setNiche(curr => curr || ctx.niche);
      if (ctx.topic) setTopic(curr => curr || ctx.topic);
      if (ctx.script) {
        setScript(prev => prev || ctx.script!);
        // The prefilled script is the current active script on the linked
        // project — already on disk. Mark it as "last saved" so the banner's
        // dirty indicator doesn't light up the moment the page hydrates.
        setLastSavedQaScript(prev => prev || ctx.script!.trim());
      }
      // Carry forward the project linkage so saved QA sessions and applied
      // fixes land on the same script row that the schedule item points to.
      if (item.project_id) setProjectId(curr => curr || item.project_id);
      if (item.script_id) setScriptId(curr => curr || item.script_id);
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
    // `script` intentionally omitted from deps — we only peek at its initial value on mount.
     
  }, [scheduleItemId, schedulePrefilled]);

  useEffect(() => {
    setNicheHints(getRecentNiches());
    let hadPrefill = false;
    try {
      const prefill = localStorage.getItem('qa_prefill');
      if (prefill) {
        localStorage.removeItem('qa_prefill');
        const data = JSON.parse(prefill);
        if (data.script) { setScript(data.script); hadPrefill = true; }
        if (data.niche) setNiche(data.niche);
        if (data.topic) setTopic(data.topic);
        if (data.constraints) setConstraints({ ...EMPTY_CONSTRAINTS, ...data.constraints });
      }
    } catch {}
    // Sending a fresh script from the generator (qa_prefill) OR arriving via a
    // schedule-link (?scheduleItemId=…) is an explicit "new session" intent —
    // drop the prior backup so stale results / fixedScript / project linkage
    // don't bleed into the new context. Without this guard, clicking
    // "Send to QA" on a schedule item restores a 24h-old unrelated session.
    const hasScheduleLink = typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).has('scheduleItemId');
    if (hadPrefill || hasScheduleLink) {
      try { localStorage.removeItem('qa_session_backup'); } catch {}
    } else {
      try {
        const backup = localStorage.getItem('qa_session_backup');
        if (backup) {
          const s = JSON.parse(backup) as {
            script?: string;
            niche?: string;
            topic?: string;
            aggressiveness?: Aggressiveness;
            results?: QAResult[];
            activeResult?: number;
            fixedScript?: string;
            passNumber?: number;
            projectId?: string | null;
            scriptId?: string | null;
            constraints?: ScriptConstraints;
            ts?: number;
          };
          // 24h freshness cap — beyond that, don't auto-restore (stale).
          if (s && s.ts && Date.now() - s.ts < 24 * 60 * 60 * 1000) {
            if (s.script) setScript(prev => prev || s.script!);
            if (s.niche) setNiche(prev => prev || s.niche!);
            if (s.topic) setTopic(prev => prev || s.topic!);
            if (s.aggressiveness) setAggressiveness(prev => prev === 'brutal' ? s.aggressiveness! : prev);
            if (s.results?.length) {
              setResults(prev => prev.length ? prev : s.results!);
              setActiveResult(prev => prev || (s.activeResult ?? s.results!.length - 1));
              setPassNumber(prev => prev > 1 ? prev : (s.passNumber ?? s.results!.length + 1));
            }
            if (s.fixedScript) setFixedScript(prev => prev || s.fixedScript!);
            if (s.projectId) setProjectId(prev => prev || s.projectId!);
            if (s.scriptId) setScriptId(prev => prev || s.scriptId!);
            // Functional setter so we don't clobber constraints the prefill
            // block (a few lines up) just set synchronously — the `constraints`
            // closure here is the stale initial EMPTY_CONSTRAINTS value.
            if (s.constraints) {
              setConstraints(prev => hasAnyConstraint(prev) ? prev : { ...EMPTY_CONSTRAINTS, ...s.constraints });
            }
          }
        }
      } catch {}
    }
    // If an active draft is linked to a project, inherit the project/script ids so
    // QA runs persist to the right place.
    try {
      const active = getActiveDraft();
      if (active?.projectId) setProjectId(prev => prev || active.projectId!);
      const draftTitle = active?.title || active?.topic;
      if (draftTitle) setTopic(prev => prev || draftTitle);
    } catch {}
     
  }, []);

  // Back up the QA session to localStorage so it survives refresh/HMR.
  // Debounced 800ms — typing in the script textarea triggers this effect on every keystroke,
  // and JSON.stringify(results) for a 9-pass session is ~100 KB. Without the debounce we'd
  // burn CPU and hit the quota much faster.
  useEffect(() => {
    if (!script && results.length === 0 && !fixedScript) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem('qa_session_backup', JSON.stringify({
          script, niche, topic, aggressiveness,
          results, activeResult, fixedScript, passNumber,
          projectId, scriptId, constraints,
          ts: Date.now(),
        }));
      } catch {
        // Quota exceeded — drop older passes to make room. This is the only meaningful
        // thing to trim; the script/fixedScript together are usually <50 KB.
        try {
          localStorage.setItem('qa_session_backup', JSON.stringify({
            script, niche, topic, aggressiveness,
            results: results.slice(-3),
            activeResult: Math.min(activeResult, 2),
            fixedScript, passNumber, projectId, scriptId, constraints,
            ts: Date.now(),
          }));
        } catch { /* give up — in-memory state is still intact */ }
      }
    }, 800);
    return () => clearTimeout(t);
  }, [script, niche, topic, aggressiveness, results, activeResult, fixedScript, passNumber, projectId, scriptId, constraints]);

  function toggleFix(key: string) {
    setApprovedFixes(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function selectAllFixes() {
    if (!currentResult) return;
    const all = new Set<string>();
    currentResult.critical_issues?.forEach((_, i) => all.add(`issue-${i}`));
    currentResult.rewrite_suggestions?.forEach((_, i) => all.add(`rewrite-${i}`));
    setApprovedFixes(all);
  }

  async function applyFixes() {
    if (approvedFixes.size === 0) { toast.error('Select at least one fix to apply'); return; }
    if (!script.trim()) { toast.error('No script to fix'); return; }
    if (!currentResult) return;

    setApplyingFixes(true);
    setFixedScript('');
    setActiveTab('apply');

    const fixes: string[] = [];
    currentResult.critical_issues?.forEach((issue, i) => {
      if (approvedFixes.has(`issue-${i}`)) fixes.push(`Fix "${issue.location}": ${issue.fix}`);
    });
    currentResult.rewrite_suggestions?.forEach((rw, i) => {
      if (approvedFixes.has(`rewrite-${i}`)) fixes.push(`Replace "${rw.original}" → "${rw.improved}" (${rw.reason})`);
    });

    try {
      const res = await fetch('/api/qa/apply-fixes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          script,
          qaFeedback: [
            `Score: ${currentResult.overall_score}/100`,
            `Verdict: ${currentResult.verdict}`,
            currentResult.will_it_perform ? `Performance: ${currentResult.will_it_perform}` : '',
            currentResult.next_pass_focus ? `Key focus: ${currentResult.next_pass_focus}` : '',
            '\nWeakest Categories:',
            ...Object.entries(currentResult.categories || {})
              .filter(([, cat]) => (cat as { score: number }).score < 70)
              .map(([key, cat]) => {
                const c = cat as { score: number; assessment?: string; fix?: string };
                return `- ${key}: ${c.score}/100 — ${c.assessment || ''}${c.fix ? ` → Fix: ${c.fix}` : ''}`;
              }),
            '\nApproved Issues to Fix:',
            ...(currentResult.critical_issues || []).filter((_: unknown, i: number) =>
              approvedFixes.has(`issue-${i}`)
            ).map((issue: { severity: string; location: string; issue: string; fix: string }) =>
              `[${issue.severity}] ${issue.location}: ${issue.issue} → Fix: ${issue.fix}`
            ),
            ...(currentResult.strengths?.length ? [`\nStrengths to Preserve: ${currentResult.strengths.join(', ')}`] : []),
          ].filter(Boolean).join('\n'),
          approvedFixes: fixes,
          constraints: hasAnyConstraint(constraints) ? constraints : undefined,
        }),
      });

      if (!res.ok) {
        // Surface the actual server error so we don't have to guess. The
        // route returns JSON `{ error: "..." }` on failure, but fall back
        // to plain text + status code if that parse fails.
        let detail = `HTTP ${res.status}`;
        try {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } else {
            const text = await res.text();
            if (text) detail = text.slice(0, 200);
          }
        } catch {}
        throw new Error(`Apply fixes failed: ${detail}`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No stream from server');

      let full = '';
      let streamError: unknown = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });
          setFixedScript(full);
          fixedScriptRef.current?.scrollTo({ top: fixedScriptRef.current.scrollHeight });
        }
      } catch (e) {
        streamError = e;
      }
      // The server may error mid-stream (the AI provider hangs up, the
      // function hits maxDuration, etc). If we got partial content, keep
      // it; otherwise surface the failure.
      if (streamError && full.length === 0) {
        const msg = streamError instanceof Error ? streamError.message : 'streaming failed';
        throw new Error(`Apply fixes failed mid-stream: ${msg}`);
      }
      if (streamError) {
        toast.error('Stream cut off — using partial result');
      }

      // Persist the improved script so it survives navigation:
      //   1. Active draft gets `fixedScript` + `script` updated to the new version
      //      (Generator's resume reads `draft.script`, so future navigation prefills the fixed text).
      //   2. If linked to a project, POST a new version to /api/projects/:id/scripts.
      try {
        const active = getActiveDraft();
        const draftTitle = active?.title || niche || 'QA-improved script';
        const draft = saveDraft({
          id: active?.id,
          title: draftTitle,
          niche,
          step: 'qa',
          topic: active?.topic,
          modelId,
          script: full,
          fixedScript: full,
          qaScore: currentResult.overall_score,
          qaVerdict: currentResult.verdict,
          projectId: projectId || active?.projectId,
        });
        // If we had an untracked projectId previously, carry it forward
        if (!projectId && draft.projectId) setProjectId(draft.projectId);
      } catch {}

      if (projectId) {
        // Fire-and-forget version bump — keepalive so it survives a subsequent
        // handoff-navigation that would otherwise abort the fetch.
        fetch(`/api/projects/${projectId}/scripts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: full, modelId }),
          keepalive: true,
        })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data?.script?.id) setScriptId(data.script.id); })
          .catch(() => { /* best-effort */ });
      }

      toast.success('Fixed script generated and saved to your draft!');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply fixes');
    } finally {
      setApplyingFixes(false);
    }
  }

  // Save the current (best) script as a new project and link it.
  // Called from the Next-Steps CTA bar so users don't have to scroll to the Apply Fixes tab.
  async function saveAsProjectQuick(title?: string): Promise<string | null> {
    const contentToSave = fixedScript || script;
    if (!contentToSave.trim()) { toast.error('Nothing to save yet'); return null; }
    const resolvedTitle = (title || niche || 'Untitled video').trim();
    setSavingProject(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: resolvedTitle,
          niche: niche || 'General',
          topic: resolvedTitle,
          script: contentToSave,
          modelId,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      const id = data.project?.id || data.id;
      if (id) {
        setProjectId(id);
        // Write the linkage back to the active draft.
        try {
          const active = getActiveDraft();
          saveDraft({
            id: active?.id,
            title: resolvedTitle,
            niche: niche || '',
            step: 'qa',
            topic: active?.topic,
            modelId,
            script: contentToSave,
            fixedScript: fixedScript || undefined,
            projectId: id,
            qaScore: currentResult?.overall_score,
            qaVerdict: currentResult?.verdict,
          });
        } catch {}
        toast.success('Saved to project — QA history is now tied to it');
        return id;
      }
      return null;
    } catch {
      toast.error('Failed to save project');
      return null;
    } finally {
      setSavingProject(false);
    }
  }

  // Update the active draft's script field with the "best" script we have,
  // then navigate to the given route. Used by all CTA handoffs so the destination
  // page resumes with the improved script — not the pre-QA version.
  function handoffWithBestScript(path: string, prefillKey?: string, prefillValue?: unknown) {
    const best = fixedScript || script;
    if (!best.trim()) { toast.error('No script to carry forward yet'); return; }
    try {
      const active = getActiveDraft();
      saveDraft({
        id: active?.id,
        title: active?.title || niche || 'QA-improved script',
        niche,
        step: 'qa',
        topic: active?.topic,
        modelId,
        script: best,
        fixedScript: fixedScript || undefined,
        projectId: projectId || active?.projectId,
        qaScore: currentResult?.overall_score,
        qaVerdict: currentResult?.verdict,
      });
    } catch {}
    if (prefillKey) {
      try { localStorage.setItem(prefillKey, JSON.stringify(prefillValue)); } catch {}
    }
    window.location.href = path;
  }

  async function runQA() {
    if (!script.trim() || script.length < 100) {
      toast.error('Please paste a script (minimum 100 characters)');
      return;
    }
    setRunning(true);
    try {
      const lastResult = results.length > 0 ? results[results.length - 1] : null;
      const previousFeedback = lastResult
        ? [
            `Previous Score: ${lastResult.overall_score}/100`,
            `Verdict: ${lastResult.verdict}`,
            lastResult.will_it_perform ? `Performance outlook: ${lastResult.will_it_perform}` : '',
            lastResult.next_pass_focus ? `Focus area: ${lastResult.next_pass_focus}` : '',
            '\nPrevious Issues:',
            ...(lastResult.critical_issues || []).map((issue: { severity: string; location: string; issue: string }) =>
              `- [${issue.severity}] ${issue.location}: ${issue.issue}`
            ),
            '\nPrevious Category Details:',
            ...Object.entries(lastResult.categories || {}).map(([key, cat]) => {
              const c = cat as { score: number; assessment?: string; fix?: string };
              return `- ${key}: ${c.score}/100 — ${c.assessment || ''}${c.fix ? ` (Fix: ${c.fix})` : ''}`;
            }),
          ].filter(Boolean).join('\n')
        : undefined;

      const res = await fetch('/api/qa/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          script,
          niche,
          aggressiveness,
          passNumber,
          previousFeedback,
          projectId: projectId || undefined,
          scriptId: scriptId || undefined,
          constraints: hasAnyConstraint(constraints) ? constraints : undefined,
          templateId: qaTemplateId || undefined,
          context: qaContext || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Server error' }));
        throw new Error(err.error || 'QA failed');
      }

      const data = await res.json();
      const newResults = [...results, data.result];
      setResults(newResults);
      setActiveResult(newResults.length - 1);
      setPassNumber(p => p + 1);
      // Save to QA history — includes the full script + the full results array up to
      // this pass so clicking a history entry can fully rehydrate the session
      // (Next-Steps CTA, score rings, tabs, EL buttons all reappear).
      // Entries written before this field existed will only have scriptPreview and
      // restore via a metadata-only fallback with an informational toast.
      saveQAEntry({
        niche,
        aggressiveness,
        modelId,
        scriptPreview: script.slice(0, 300),
        overallScore: data.result.overall_score,
        verdict: data.result.verdict || '',
        passCount: newResults.length,
        script,
        results: newResults,
      });
      setQaHistory(getQAHistory());
      // Auto-save draft
      const activeDraft = getActiveDraft();
      if (activeDraft) {
        saveDraft({ ...activeDraft, step: 'qa', qaScore: data.result.overall_score, qaVerdict: data.result.verdict });
      }
      toast.success(`QA Pass ${passNumber} complete! Score: ${data.result.overall_score}/100`);

      // Schedule writeback now goes through the saver registration:
      //   - <ScheduleSaverRegistration autoStamp={...}> silently stamps
      //     `latest_qa` after each pass, so the schedule grid shows the latest
      //     score without any user action.
      //   - The banner's "Save QA report" button re-pushes the same metadata
      //     with a confirmation toast for users who want explicit feedback
      //     that the linked item was updated.
      // QA is advisory; no automatic status auto-advance.
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'QA analysis failed');
    } finally {
      setRunning(false);
    }
  }

  function resetQA() {
    setResults([]);
    setPassNumber(1);
    setActiveResult(0);
    setApprovedFixes(new Set());
    setFixedScript('');
    setActiveTab('scores');
  }

  /** Wipe the entire QA page back to a blank slate — script, results, fixed
   * script, approved fixes, project/script linkage, and the localStorage
   * backup. Niche/aggressiveness/model stay because those are usually the
   * user's preferences, not session state. */
  function startNewSession() {
    const hasWork = script.trim().length > 0 || results.length > 0 || fixedScript.length > 0;
    if (hasWork && typeof window !== 'undefined' &&
        !confirm('Start a new QA session? The current script and all pass results will be cleared from this page. (Past runs remain in QA History below.)')) {
      return;
    }
    setScript('');
    setTopic('');
    setResults([]);
    setPassNumber(1);
    setActiveResult(0);
    setApprovedFixes(new Set());
    setFixedScript('');
    setActiveTab('scores');
    setProjectId(null);
    setScriptId(null);
    setConstraints(EMPTY_CONSTRAINTS);
    try { localStorage.removeItem('qa_session_backup'); } catch {}
    toast.success('New QA session — paste a script to get started.');
  }

  const currentResult = results[activeResult];

  // Saver derived values. QA's primary artifact is a *script* (either the
  // original input or — preferred when it exists — the fixed script after
  // applying QA suggestions). On Save we:
  //   - POST a new script revision to the linked project (or create a new
  //     project if none is linked yet), same update-in-place pattern as
  //     Script Generator's banner save,
  //   - PATCH the schedule item with project_id + new script_id,
  //   - shallow-merge a `latest_qa` fingerprint when there's a QA pass.
  //
  // The auto-stamp keeps firing on each new pass so the schedule grid can
  // show "QA'd" without requiring a save.
  const latestQaResult = results.length > 0 ? results[results.length - 1] : null;
  const latestQaScore = latestQaResult?.overall_score ?? null;
  // The script to push: prefer the post-fix version, fall back to the
  // original input. Same convention QA uses for "Save as Project" /
  // "Send to narrator" / etc. (lib/qa-utils notwithstanding).
  const effectiveQaScript = (fixedScript || script).trim();
  const qaWordCount = effectiveQaScript ? countWords(effectiveQaScript) : 0;
  // Save is enabled when there's *something* worth saving — either a script
  // (with or without a QA pass) or a QA pass alone (metadata-only stamp).
  const qaIsReady = effectiveQaScript.length > 0 || !!latestQaResult;
  const qaRunKey = latestQaResult
    ? `${results.length}:${latestQaScore ?? 'null'}:${latestQaResult.verdict ?? ''}`
    : null;
  // Dirty when *either* a new pass landed or the script diverged from
  // what was last pushed. Either condition lights up the dirty indicator.
  const qaScriptIsDirty = effectiveQaScript.length > 0 && effectiveQaScript !== lastSavedQaScript;
  const qaPassIsDirty = !!qaRunKey && qaRunKey !== lastSavedQaRunKey;
  const qaIsDirty = qaIsReady && (qaScriptIsDirty || qaPassIsDirty);

  return (
    <ScheduleLinkProvider item={scheduleItem}>
      <ScheduleSaverRegistration
        handle={{
          artifactLabel: 'script',
          isReady: qaIsReady,
          isDirty: qaIsDirty,
          notReadyReason: 'Paste a script or run a QA pass first',
          // Saving a script from QA → schedule item moves to "scripting"
          // (no-op if it's already past). Server enforces strict-forward
          // ordering so this can't accidentally rewind.
          nextStatus: { key: 'scripting', label: 'Scripting' },
          buildPatch: async () => {
            const trimmed = effectiveQaScript;
            const patch: Record<string, unknown> = {};
            const merge: Record<string, unknown> = {};

            // Stamp the QA fingerprint (no-op when the user hasn't run QA
            // yet — they may be on this page just to land a script revision).
            if (latestQaResult) {
              merge.latest_qa = {
                score: latestQaResult.overall_score,
                verdict: latestQaResult.verdict,
                pass_count: results.length,
                ran_at: new Date().toISOString(),
                model_id: modelId,
                aggressiveness,
              };
            }

            // Push the script to a project — either a new revision on the
            // already-linked project or a fresh project + initial script.
            if (trimmed) {
              const targetProjectId = projectId ?? scheduleItem?.project_id ?? null;
              try {
                if (targetProjectId) {
                  const r = await fetch(`/api/projects/${targetProjectId}/scripts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: trimmed, modelId }),
                  });
                  if (!r.ok) throw new Error('Failed to save script revision');
                  const data = await r.json();
                  patch.project_id = targetProjectId;
                  if (data.script?.id) patch.script_id = data.script.id;
                  setScriptId(data.script?.id ?? null);
                } else {
                  const titleSeed = (topic || scheduleItem?.title || '').trim() || 'QA Script';
                  const r = await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      title: titleSeed,
                      niche: niche || 'General',
                      topic: titleSeed,
                      script: trimmed,
                      modelId,
                    }),
                  });
                  if (!r.ok) throw new Error('Failed to create project');
                  const data = await r.json();
                  const newProjectId: string | null = data.project?.id ?? data.id ?? null;
                  const newScriptId: string | null = data.script?.id ?? null;
                  if (newProjectId) {
                    patch.project_id = newProjectId;
                    setProjectId(newProjectId);
                  }
                  if (newScriptId) {
                    patch.script_id = newScriptId;
                    setScriptId(newScriptId);
                  }
                }
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Could not save the script');
                throw err;
              }
            }

            return {
              patch,
              customFieldsMerge: Object.keys(merge).length > 0 ? merge : undefined,
            };
          },
          describeSaved: () => {
            const parts: string[] = [];
            if (effectiveQaScript) parts.push(`${qaWordCount} words`);
            if (latestQaResult) parts.push(`QA ${latestQaResult.overall_score}/100`);
            return parts.join(' · ');
          },
          onSaved: () => {
            setLastSavedQaRunKey(qaRunKey);
            setLastSavedQaScript(effectiveQaScript);
          },
        }}
        autoStamp={{
          key: 'latest_qa',
          value: () => latestQaResult ? {
            score: latestQaResult.overall_score,
            verdict: latestQaResult.verdict,
            pass_count: results.length,
            ran_at: new Date().toISOString(),
            model_id: modelId,
            aggressiveness,
          } : null,
          runKey: qaRunKey,
        }}
      />
    <div className="p-8 max-w-7xl mx-auto">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="QA Engine" />}
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(236,72,153,0.3), rgba(245,158,11,0.2))', border: '1px solid rgba(236,72,153,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#ec4899' }}>
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M11 8v3l2 2" />
            </svg>
          </div>
          <span className="badge badge-pink">Multi-Pass QA Engine</span>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Script QA Engine</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
              Brutally critique your script — as many passes as needed
            </p>
            {topic && (
              <div
                className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg max-w-full"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                title={topic}
              >
                <span className="text-[10px] uppercase tracking-wider font-semibold shrink-0" style={{ color: 'var(--text-muted)' }}>
                  Reviewing
                </span>
                <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {topic}
                </span>
              </div>
            )}
          </div>
          <button
            onClick={startNewSession}
            className="btn-secondary text-sm shrink-0"
            title="Clear the current script and all passes — keep niche/aggressiveness/model. Past runs stay in QA History."
          >
            ✨ New QA Session
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">
        {/* LEFT PANEL */}
        <div className="space-y-4">
          <div className="glass rounded-xl p-6 space-y-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>QA Configuration</h2>

            <ModelSelector value={modelId} onChange={setModelId} />

            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche Context</label>
              <AutocompleteInput
                value={niche}
                onChange={setNiche}
                suggestions={nicheHints}
                placeholder="e.g. Cybersecurity & Antivirus"
              />
            </div>

            {/* QA Review Exclusions — the reviewer won't flag anything on this
                list as an issue, and won't suggest adding anything on it. Works
                for scripts sent from the Generator (constraints inherited via
                qa_prefill) AND for standalone manual QA runs on a pasted script. */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                QA Review Exclusions
                {hasAnyConstraint(constraints) && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.2)', color: 'var(--accent-purple-bright)' }}>active</span>
                )}
              </label>
              <div className="p-3 rounded-lg space-y-2" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Tell the reviewer what NOT to check. Absent items on this list won&apos;t be flagged as issues and won&apos;t appear in rewrite suggestions.
                </p>
                <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={!!constraints.skipHook} onChange={e => setConstraints(c => ({ ...c, skipHook: e.target.checked }))} />
                  Don&apos;t judge the hook / opening grab
                </label>
                <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={!!constraints.skipSubscribeCTA} onChange={e => setConstraints(c => ({ ...c, skipSubscribeCTA: e.target.checked }))} />
                  Don&apos;t expect subscribe / like / bell CTAs
                </label>
                <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={!!constraints.skipClickableLinks} onChange={e => setConstraints(c => ({ ...c, skipClickableLinks: e.target.checked }))} />
                  Don&apos;t expect &quot;link in description&quot; / promo links
                </label>
                <div className="pt-1">
                  <label className="text-[11px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Custom exclusions (one per line — e.g. &quot;don&apos;t flag casual profanity&quot;, &quot;don&apos;t suggest adding humor&quot;)
                  </label>
                  <textarea
                    value={(constraints.custom || []).join('\n')}
                    // Don't trim/filter on every keystroke — that strips spaces
                    // and breaks typing. Server-side cleans the array before use.
                    onChange={e => setConstraints(c => ({ ...c, custom: e.target.value.split('\n') }))}
                    // Stop ALL keystrokes from bubbling so global shortcuts
                    // (Cmd/Ctrl+K palette, etc.) don't swallow characters.
                    onKeyDown={e => e.stopPropagation()}
                    onKeyUp={e => e.stopPropagation()}
                    placeholder={'don\'t flag casual profanity\ndon\'t suggest adding humor'}
                    className="input-field w-full"
                    style={{ fontSize: 12, minHeight: 80, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}
                    spellCheck
                    wrap="soft"
                  />
                  <div className="text-[10px] mt-1 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    <span>
                      Saved automatically — applied to the next QA pass.
                      {(constraints.custom?.filter(s => s.trim()).length ?? 0) > 0 && (
                        <span style={{ color: '#22c55e', marginLeft: 6 }}>
                          {constraints.custom!.filter(s => s.trim()).length} rule{constraints.custom!.filter(s => s.trim()).length === 1 ? '' : 's'} active
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Saved reviewer template + per-call extra context. Picks
                from /api/templates filtered by field_type=qa. The default
                QA template (if any) is auto-selected on mount. */}
            <div>
              <TemplateContextPicker
                fieldType="qa"
                templateId={qaTemplateId}
                onTemplateChange={setQaTemplateId}
                context={qaContext}
                onContextChange={setQaContext}
                label="Reviewer template"
                compact
              />
            </div>

            {/* Aggressiveness selector */}
            <div>
              <label className="block text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>QA Aggressiveness</label>
              <div className="space-y-2">
                {([
                  { id: 'standard' as const, label: 'Standard', emoji: '📋', desc: 'Thorough & constructive' },
                  { id: 'brutal' as const, label: 'Brutal', emoji: '🔥', desc: 'No sugar-coating, all weaknesses exposed' },
                  { id: 'nuclear' as const, label: 'Nuclear', emoji: '☢️', desc: 'Zero tolerance — maximum harshness' },
                ] as const).map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAggressiveness(opt.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-all"
                    style={{
                      background: aggressiveness === opt.id ? 'rgba(236,72,153,0.15)' : 'var(--bg-secondary)',
                      border: `1px solid ${aggressiveness === opt.id ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                    }}
                  >
                    <span className="text-lg">{opt.emoji}</span>
                    <div>
                      <div className="text-sm font-semibold" style={{ color: aggressiveness === opt.id ? '#ec4899' : 'var(--text-primary)' }}>
                        {opt.label}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{opt.desc}</div>
                    </div>
                    {aggressiveness === opt.id && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="2.5" className="ml-auto">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Script input */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Script to Analyze
                {script && <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>({script.split(/\s+/).filter(Boolean).length} words)</span>}
              </label>
              <textarea
                value={script}
                onChange={e => setScript(e.target.value)}
                placeholder="Paste your script here..."
                className="input-field"
                style={{ minHeight: 200 }}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={runQA}
                disabled={running || !script.trim()}
                className="btn-primary flex-1 justify-center"
                style={{ justifyContent: 'center' }}
              >
                {running ? (
                  <>
                    <div className="spinner" style={{ width: 16, height: 16 }} />
                    Analyzing Pass {passNumber}...
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                    </svg>
                    Run QA Pass {passNumber}
                  </>
                )}
              </button>
              {results.length > 0 && (
                <button onClick={resetQA} className="btn-secondary px-3">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Pass history */}
          {results.length > 0 && (
            <div className="glass rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
                QA History ({results.length} passes)
              </h3>
              <div className="space-y-2">
                {results.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => { setActiveResult(i); setApprovedFixes(new Set()); setFixedScript(''); }}
                    className="w-full flex items-center gap-3 p-3 rounded-lg text-left transition-all"
                    style={{
                      background: activeResult === i ? 'rgba(124,58,237,0.1)' : 'var(--bg-secondary)',
                      border: `1px solid ${activeResult === i ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`,
                    }}
                  >
                    <div className="text-center" style={{ minWidth: 40 }}>
                      <div className="text-lg font-bold" style={{
                        color: r.overall_score >= 75 ? '#10b981' : r.overall_score >= 50 ? '#f59e0b' : '#ef4444'
                      }}>
                        {r.overall_score}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Pass {i + 1}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{scoreLabel(r.overall_score)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT PANEL - Results */}
        <div>
          {/* Smart empty state: if no QA has been run but there is a script in the textarea
              (either typed by the user or restored from a metadata-only history entry),
              surface the same handoff + EL-format affordances so the script is still useful
              — you can ship it to Voiceover / Production Doc / Script Generator, or format
              it for ElevenLabs, without being forced to run a QA pass first. */}
          {!currentResult && !running && script.trim().length >= 50 && (
            <div className="glass rounded-xl p-6 space-y-4">
              <div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  📋 Script loaded — {script.trim().split(/\s+/).length} words
                </h3>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Run QA for detailed critique, or use this script directly in the rest of the workflow.
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                <button
                  onClick={() => handoffWithBestScript('/voiceover?from=qa', 'voiceover_prefill', { script, niche })}
                  className="btn-primary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                >
                  🎙️ Voiceover
                </button>
                <button
                  onClick={() => {
                    const topicLine = script.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                    handoffWithBestScript('/production-doc?from=qa', 'prodoc_prefill', { script, niche, topic: topicLine });
                  }}
                  className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                >
                  🎬 Production Doc
                </button>
                <button
                  onClick={() => {
                    const titleLine = script.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                    handoffWithBestScript('/thumbnails?from=qa', 'thumbnails_prefill', { title: titleLine, niche, description: script.slice(0, 500) });
                  }}
                  className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                >
                  🎨 Thumbnails
                </button>
                <button
                  onClick={() => {
                    const topicLine = script.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                    handoffWithBestScript('/seo?from=qa', 'seo_prefill', { topic: topicLine, niche, script });
                  }}
                  className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                >
                  🔍 SEO
                </button>
                <button
                  onClick={() => handoffWithBestScript('/generator?from=qa')}
                  className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                  title="Saves this script to your active draft and opens Script Generator resumed on it."
                >
                  📝 Script Generator
                </button>
                <button
                  onClick={() => saveAsProjectQuick()}
                  disabled={savingProject}
                  className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                >
                  {savingProject ? '💾 Saving…' : '💾 Save as Project'}
                </button>
              </div>

              <div className="pt-3 flex items-center gap-2 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Export for TTS:</span>
                <CopyForElevenLabs script={script} version="v2" />
                <CopyForElevenLabs script={script} version="v3" voiceContext={niche} />
                <button
                  onClick={() => { navigator.clipboard.writeText(script); toast.success('Script copied!'); }}
                  className="btn-secondary text-xs px-3 py-1.5 ml-auto"
                >
                  Copy script
                </button>
              </div>
            </div>
          )}

          {!currentResult && !running && script.trim().length < 50 && (
            <div className="glass rounded-xl h-full min-h-96 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
              <div className="text-center">
                <div className="text-5xl mb-4">🔬</div>
                <p className="text-sm">Run a QA pass to see detailed analysis</p>
                <p className="text-xs mt-2 opacity-60">The more passes, the more refined the critique</p>
              </div>
            </div>
          )}

          {running && (
            <div className="glass rounded-xl h-full min-h-96 flex items-center justify-center">
              <div className="text-center">
                <div className="spinner mx-auto mb-4" style={{ width: 32, height: 32 }} />
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {aggressiveness === 'nuclear' ? '☢️ Nuclear critique in progress...' :
                   aggressiveness === 'brutal' ? '🔥 Brutally analyzing your script...' :
                   '📋 Analyzing your script...'}
                </p>
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>This may take 15-30 seconds</p>
              </div>
            </div>
          )}

          {currentResult && !running && (
            <motion.div
              key={activeResult}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-4"
            >
              {/* Score overview */}
              <div className="glass rounded-xl p-6">
                <div className="flex items-start gap-6">
                  <ScoreRing score={currentResult.overall_score} size={100} strokeWidth={8} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                        Pass {activeResult + 1} · {aggressiveness.toUpperCase()} Mode
                      </span>
                    </div>
                    <p className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                      {currentResult.verdict}
                    </p>
                    {currentResult.will_it_perform && (
                      <p className="text-sm" style={{ color: currentResult.will_it_perform.toLowerCase().startsWith('yes') ? '#10b981' : currentResult.will_it_perform.toLowerCase().startsWith('maybe') ? '#f59e0b' : '#ef4444' }}>
                        Performance Outlook: {currentResult.will_it_perform}
                      </p>
                    )}
                  </div>
                </div>

                {/* Next pass focus */}
                {currentResult.next_pass_focus && (
                  <div className="mt-4 px-4 py-3 rounded-lg" style={{ background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)' }}>
                    <span className="text-xs font-semibold" style={{ color: 'var(--accent-purple-bright)' }}>
                      Next Pass Focus:
                    </span>
                    <span className="text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>{currentResult.next_pass_focus}</span>
                  </div>
                )}
              </div>

              {/* Persistent Next-Steps CTA — visible from every tab so the "what now?" is always answered.
                  Uses the fixed script if one has been generated, otherwise the original (for high-scoring scripts
                  that don't need Apply Fixes). */}
              <div className="glass rounded-xl p-5" style={{
                background: currentResult.overall_score >= 85
                  ? 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(124,58,237,0.08))'
                  : undefined,
                border: currentResult.overall_score >= 85 ? '1px solid rgba(16,185,129,0.3)' : undefined,
              }}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {fixedScript ? '✨ Continue with your QA-improved script' : currentResult.overall_score >= 85 ? '✅ Your script is ready — what\'s next?' : '🚀 Next Steps'}
                    </h3>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      {fixedScript
                        ? 'The fixed script is auto-saved to your draft. Pick where to go next:'
                        : currentResult.overall_score >= 85
                          ? 'Use the current script as-is, or refine further via Apply Fixes.'
                          : 'Apply fixes first, or continue with the current script if you\'re happy with it.'}
                    </p>
                  </div>
                  {projectId && (
                    <span className="text-xs px-2 py-1 rounded-full shrink-0" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                      🔗 Linked to project
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  <button
                    onClick={() => handoffWithBestScript('/voiceover?from=qa', 'voiceover_prefill', { script: fixedScript || script, niche })}
                    className="btn-primary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                  >
                    🎙️ Voiceover
                  </button>
                  <button
                    onClick={() => {
                      const best = fixedScript || script;
                      const topicLine = best.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                      handoffWithBestScript('/production-doc?from=qa', 'prodoc_prefill', { script: best, niche, topic: topicLine });
                    }}
                    className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                  >
                    🎬 Production Doc
                  </button>
                  <button
                    onClick={() => {
                      const best = fixedScript || script;
                      const titleLine = best.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                      handoffWithBestScript('/thumbnails?from=qa', 'thumbnails_prefill', { title: titleLine, niche, description: best.slice(0, 500) });
                    }}
                    className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                  >
                    🎨 Thumbnails
                  </button>
                  <button
                    onClick={() => {
                      const best = fixedScript || script;
                      const topicLine = best.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                      handoffWithBestScript('/seo?from=qa', 'seo_prefill', { topic: topicLine, niche, script: best });
                    }}
                    className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                  >
                    🔍 SEO
                  </button>
                  <button
                    onClick={() => handoffWithBestScript('/generator?from=qa')}
                    className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                    title="Updates your active draft with the QA-improved script, then opens Script Generator so you can resume there."
                  >
                    📝 Script Generator
                  </button>
                  {!projectId ? (
                    <button
                      onClick={() => saveAsProjectQuick()}
                      disabled={savingProject}
                      className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center' }}
                    >
                      {savingProject ? '💾 Saving…' : '💾 Save as Project'}
                    </button>
                  ) : (
                    <a
                      href={`/projects/${projectId}`}
                      className="btn-secondary text-xs px-3 py-2 justify-center" style={{ justifyContent: 'center', textDecoration: 'none' }}
                    >
                      📁 Open Project
                    </a>
                  )}
                </div>

                {/* ElevenLabs formats — the user wants these wherever the new script is surfaced. */}
                <div className="mt-3 pt-3 flex items-center gap-2 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Export for TTS:</span>
                  <CopyForElevenLabs script={fixedScript || script} version="v2" />
                  <CopyForElevenLabs script={fixedScript || script} version="v3" voiceContext={niche} />
                  <button
                    onClick={() => { navigator.clipboard.writeText(fixedScript || script); toast.success('Script copied!'); }}
                    className="btn-secondary text-xs px-3 py-1.5 ml-auto"
                  >
                    Copy script
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-2 flex-wrap">
                {([
                  { id: 'scores' as const, label: 'Category Scores' },
                  { id: 'issues' as const, label: `☑ Issues (${currentResult.critical_issues?.length || 0})` },
                  { id: 'rewrites' as const, label: `☑ Rewrites (${currentResult.rewrite_suggestions?.length || 0})` },
                  { id: 'suggestions' as const, label: 'Titles & Thumbnails' },
                  { id: 'apply' as const, label: approvedFixes.size > 0 ? `✨ Apply ${approvedFixes.size} Fix${approvedFixes.size > 1 ? 'es' : ''}` : '✨ Apply Fixes' },
                ] as const).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                    style={{
                      background: activeTab === tab.id ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${activeTab === tab.id ? 'var(--accent-purple)' : 'var(--border)'}`,
                      color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                {/* Scores tab */}
                {activeTab === 'scores' && (
                  <motion.div key="scores" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
                    {/* Category score rings */}
                    <div className="glass rounded-xl p-6">
                      <div className="grid grid-cols-5 md:grid-cols-10 gap-3 mb-6">
                        {Object.entries(currentResult.categories).map(([key, cat]) => (
                          <ScoreRing key={key} score={cat.score} size={60} strokeWidth={5} label={`${CATEGORY_LABELS[key]?.emoji || ''} ${CATEGORY_LABELS[key]?.label || key}`} />
                        ))}
                      </div>

                      {/* Detailed category assessments */}
                      <div className="space-y-4">
                        {Object.entries(currentResult.categories).map(([key, cat]) => (
                          <div key={key} className="p-4 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {CATEGORY_LABELS[key]?.emoji} {CATEGORY_LABELS[key]?.label || key}
                              </h4>
                              <span className="text-sm font-bold" style={{
                                color: cat.score >= 75 ? '#10b981' : cat.score >= 50 ? '#f59e0b' : '#ef4444'
                              }}>
                                {cat.score}/100
                              </span>
                            </div>
                            <div className="progress-bar mb-3">
                              <div className="progress-fill" style={{ width: `${cat.score}%` }} />
                            </div>
                            <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>{cat.assessment}</p>
                            <div className="p-3 rounded-lg mt-2" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)' }}>
                              <span className="text-xs font-semibold" style={{ color: '#10b981' }}>Fix: </span>
                              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{cat.fix}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Strengths */}
                    {currentResult.strengths?.length > 0 && (
                      <div className="glass rounded-xl p-5">
                        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--accent-green)' }}>✅ Strengths</h3>
                        <ul className="space-y-2">
                          {currentResult.strengths.map((s, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                              <span style={{ color: 'var(--accent-green)', flexShrink: 0 }}>•</span> {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </motion.div>
                )}

                {/* Issues tab */}
                {activeTab === 'issues' && (
                  <motion.div key="issues" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass rounded-xl p-5 space-y-3">
                    {currentResult.critical_issues?.length > 0 && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Check fixes to approve for rewriting</span>
                        <button onClick={selectAllFixes} className="text-xs" style={{ color: 'var(--accent-purple-bright)' }}>Select All</button>
                      </div>
                    )}
                    {currentResult.critical_issues?.length === 0 && (
                      <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No critical issues found in this pass</p>
                    )}
                    {currentResult.critical_issues?.map((issue, i) => {
                      const colors = SEVERITY_COLORS[issue.severity];
                      const fixKey = `issue-${i}`;
                      const isApproved = approvedFixes.has(fixKey);
                      return (
                        <div key={i} className="p-4 rounded-lg transition-all" style={{
                          background: colors.bg, border: `1px solid ${isApproved ? '#10b981' : colors.border}`,
                        }}>
                          <div className="flex items-center gap-2 mb-2">
                            <input type="checkbox" checked={isApproved} onChange={() => toggleFix(fixKey)}
                              className="w-4 h-4 cursor-pointer" style={{ accentColor: 'var(--accent-purple)' }} />
                            <span className="text-xs font-bold" style={{ color: colors.text }}>{colors.label}</span>
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>— {issue.location}</span>
                          </div>
                          <p className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>{issue.issue}</p>
                          <div className="p-2 rounded" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)' }}>
                            <span className="text-xs font-semibold" style={{ color: '#10b981' }}>Fix: </span>
                            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{issue.fix}</span>
                          </div>
                        </div>
                      );
                    })}
                    {approvedFixes.size > 0 && (
                      <button onClick={applyFixes} className="btn-primary w-full justify-center mt-3" style={{ justifyContent: 'center' }}>
                        ✨ Apply {approvedFixes.size} Selected Fix{approvedFixes.size > 1 ? 'es' : ''} → Get Fixed Script
                      </button>
                    )}
                  </motion.div>
                )}

                {/* Rewrites tab */}
                {activeTab === 'rewrites' && (
                  <motion.div key="rewrites" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass rounded-xl p-5 space-y-4">
                    {currentResult.rewrite_suggestions?.length > 0 && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Check rewrites to approve</span>
                        <button onClick={selectAllFixes} className="text-xs" style={{ color: 'var(--accent-purple-bright)' }}>Select All</button>
                      </div>
                    )}
                    {currentResult.rewrite_suggestions?.length === 0 && (
                      <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No rewrite suggestions this pass</p>
                    )}
                    {currentResult.rewrite_suggestions?.map((rw, i) => {
                      const fixKey = `rewrite-${i}`;
                      const isApproved = approvedFixes.has(fixKey);
                      return (
                        <div key={i} className="rounded-lg overflow-hidden transition-all" style={{
                          border: `1px solid ${isApproved ? '#10b981' : 'var(--border)'}`,
                        }}>
                          <div className="flex items-center gap-2 px-3 pt-3">
                            <input type="checkbox" checked={isApproved} onChange={() => toggleFix(fixKey)}
                              className="w-4 h-4 cursor-pointer" style={{ accentColor: 'var(--accent-purple)' }} />
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Approve this rewrite</span>
                          </div>
                          <div className="p-3" style={{ background: 'rgba(239,68,68,0.07)' }}>
                            <div className="text-xs font-semibold mb-1" style={{ color: '#ef4444' }}>❌ Original</div>
                            <p className="text-sm italic" style={{ color: 'var(--text-secondary)' }}>"{rw.original}"</p>
                          </div>
                          <div className="p-3" style={{ background: 'rgba(16,185,129,0.07)' }}>
                            <div className="text-xs font-semibold mb-1" style={{ color: '#10b981' }}>✅ Improved</div>
                            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>"{rw.improved}"</p>
                            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{rw.reason}</p>
                          </div>
                        </div>
                      );
                    })}
                    {approvedFixes.size > 0 && (
                      <button onClick={applyFixes} className="btn-primary w-full justify-center mt-3" style={{ justifyContent: 'center' }}>
                        ✨ Apply {approvedFixes.size} Selected Fix{approvedFixes.size > 1 ? 'es' : ''} → Get Fixed Script
                      </button>
                    )}
                  </motion.div>
                )}

                {/* Suggestions tab */}
                {activeTab === 'suggestions' && (
                  <motion.div key="suggestions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                    <div className="glass rounded-xl p-5">
                      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>🎯 Title Suggestions</h3>
                      <div className="space-y-2">
                        {currentResult.title_suggestions?.map((t, i) => (
                          <div key={i} className="flex items-center gap-3 p-3 rounded-lg"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                            <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>#{i + 1}</span>
                            <span className="text-sm flex-1" style={{ color: 'var(--text-primary)' }}>{t}</span>
                            <button
                              onClick={() => { navigator.clipboard.writeText(t); toast.success('Copied!'); }}
                              className="text-xs" style={{ color: 'var(--text-muted)' }}
                            >
                              Copy
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="glass rounded-xl p-5">
                      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>🖼️ Thumbnail Ideas</h3>
                      <div className="space-y-2">
                        {currentResult.thumbnail_ideas?.map((t, i) => (
                          <div key={i} className="p-3 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                            {i + 1}. {t}
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* Apply Fixes tab */}
                {activeTab === 'apply' && (
                  <motion.div key="apply" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                    {!fixedScript && !applyingFixes && approvedFixes.size === 0 && (
                      <div className="glass rounded-xl p-8 text-center">
                        <div className="text-5xl mb-4">✨</div>
                        <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>How to fix your script</p>
                        <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                          Go to the <strong>Issues</strong> or <strong>Rewrites</strong> tabs, check the fixes you want to apply, then come back here.
                        </p>
                        <div className="flex gap-3 justify-center">
                          <button onClick={() => setActiveTab('issues')} className="btn-primary text-sm">
                            Go to Issues ({currentResult?.critical_issues?.length || 0})
                          </button>
                          <button onClick={() => setActiveTab('rewrites')} className="btn-secondary text-sm">
                            Go to Rewrites ({currentResult?.rewrite_suggestions?.length || 0})
                          </button>
                        </div>
                      </div>
                    )}
                    {!fixedScript && !applyingFixes && approvedFixes.size > 0 && (
                      <div className="glass rounded-xl p-8 text-center">
                        <div className="text-5xl mb-4">✅</div>
                        <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                          {approvedFixes.size} fix{approvedFixes.size > 1 ? 'es' : ''} selected
                        </p>
                        <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                          The AI will rewrite your script applying only these approved changes.
                        </p>
                        <button onClick={applyFixes} className="btn-primary mx-auto text-base px-8 py-3">
                          ✨ Apply {approvedFixes.size} Fix{approvedFixes.size > 1 ? 'es' : ''} and Rewrite Script
                        </button>
                      </div>
                    )}
                    {applyingFixes && (
                      <div className="glass rounded-xl p-8 text-center">
                        <div className="spinner mx-auto mb-4" style={{ width: 28, height: 28 }} />
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Applying fixes and rewriting script...</p>
                        {fixedScript && (
                          <pre className="mt-4 text-left whitespace-pre-wrap text-xs leading-relaxed" style={{ color: 'var(--text-secondary)', maxHeight: 400, overflow: 'auto' }}>
                            {fixedScript}
                          </pre>
                        )}
                      </div>
                    )}
                    {fixedScript && !applyingFixes && (
                      <div className="glass rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-5 py-3 flex-wrap gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
                          <span className="text-sm font-semibold" style={{ color: 'var(--accent-green)' }}>✅ Fixed Script</span>
                          <div className="flex gap-2 items-center flex-wrap">
                            <CopyForElevenLabs script={fixedScript} version="v2" />
                            <CopyForElevenLabs script={fixedScript} version="v3" voiceContext={niche} />
                            <button onClick={() => { navigator.clipboard.writeText(fixedScript); toast.success('Copied!'); }}
                              className="btn-secondary text-xs px-3 py-1.5">Copy</button>
                            <button onClick={() => {
                              setScript(fixedScript);
                              setFixedScript('');
                              setApprovedFixes(new Set());
                              setActiveTab('scores');
                              toast.success('Script updated — run another QA pass to see the improvement!');
                            }}
                              className="btn-primary text-xs px-3 py-1.5">Use as New Script</button>
                          </div>
                        </div>
                        <div ref={fixedScriptRef} className="p-5 overflow-auto" style={{ maxHeight: 600 }}>
                          <pre className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {fixedScript}
                          </pre>
                        </div>
                        <div className="px-5 py-3 flex gap-2" style={{ borderTop: '1px solid var(--border)' }}>
                          <button
                            onClick={() => handoffWithBestScript('/voiceover?from=qa', 'voiceover_prefill', { script: fixedScript, niche })}
                            className="btn-primary text-sm flex-1 justify-center" style={{ justifyContent: 'center' }}>
                            🎙️ Generate Voiceover
                          </button>
                          <button
                            onClick={() => handoffWithBestScript('/generator?from=qa')}
                            className="btn-secondary text-sm flex-1 justify-center" style={{ justifyContent: 'center' }}
                            title="Updates your active draft with this fixed script and opens the Script Generator resumed on it.">
                            📝 Back to Script Generator
                          </button>
                        </div>
                        <div className="px-5 py-3 flex gap-2" style={{ borderTop: '1px solid var(--border)' }}>
                          <button
                            onClick={() => {
                              const s = fixedScript || script;
                              const topicLine = s.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                              handoffWithBestScript('/seo?from=qa', 'seo_prefill', { topic: topicLine, niche, script: s });
                            }}
                            className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                          >
                            🔍 Optimize SEO
                          </button>
                          <button
                            onClick={() => {
                              const s2 = fixedScript || script;
                              const titleLine = s2.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                              handoffWithBestScript('/thumbnails?from=qa', 'thumbnails_prefill', { title: titleLine, niche, description: s2.slice(0, 500) });
                            }}
                            className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                          >
                            🎨 Generate Thumbnail
                          </button>
                          <button
                            onClick={() => {
                              const s3 = fixedScript || script;
                              const topicLine3 = s3.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 100) || niche;
                              handoffWithBestScript('/production-doc?from=qa', 'prodoc_prefill', { script: s3, niche, topic: topicLine3 });
                            }}
                            className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                          >
                            🎬 Production Doc
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <SaveAsProject
                            script={fixedScript}
                            niche={niche}
                            topic=""
                            variant="secondary"
                            className="flex-1"
                            onSaved={id => {
                              setProjectId(id);
                              // Also persist the linkage onto the active draft so that
                              // closing the tab here (without hitting another handoff) doesn't leave
                              // the draft row unlinked locally.
                              try {
                                const active = getActiveDraft();
                                if (active) {
                                  saveDraft({
                                    ...active,
                                    projectId: id,
                                    fixedScript,
                                    script: fixedScript || active.script,
                                  });
                                }
                              } catch {}
                            }}
                          />
                          <ExportScript title={niche} script={fixedScript} niche={niche} />
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      </div>

      {/* QA History panel */}
      <HistoryPanel
        title="QA History"
        icon="📋"
        accentColor="#ec4899"
        items={qaHistory.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: `Score ${e.overallScore}/100 · ${e.aggressiveness.charAt(0).toUpperCase() + e.aggressiveness.slice(1)}`,
          sublabel: `${e.niche} · Pass ${e.passCount}`,
          preview: e.verdict,
        }))}
        onRestore={id => {
          const entry = qaHistory.find(e => e.id === id);
          if (!entry) return;

          // Protect in-progress work: if the user has unsaved results in memory,
          // confirm before replacing. Backup is still in localStorage either way,
          // but this avoids silent surprise.
          if (results.length > 0 && typeof window !== 'undefined' &&
              !confirm(`Replace your current ${results.length}-pass session with "${entry.niche}" (${entry.passCount} pass${entry.passCount === 1 ? '' : 'es'}, score ${entry.overallScore}/100)?`)) {
            return;
          }

          // Basic config.
          setNiche(entry.niche);
          const validAgg: Aggressiveness[] = ['standard', 'brutal', 'nuclear'];
          if (validAgg.includes(entry.aggressiveness as Aggressiveness)) {
            setAggressiveness(entry.aggressiveness as Aggressiveness);
          }
          if (entry.modelId) setModelId(entry.modelId);

          // Script: newer entries carry the full text; older entries only have
          // the 300-char preview — still useful as a starting point for EL
          // formatting or a voiceover handoff, but flag it clearly.
          const hasFullScript = Boolean(entry.script);
          if (entry.script) {
            setScript(entry.script);
          } else if (entry.scriptPreview) {
            setScript(entry.scriptPreview);
          }

          // Results can be stored in two shapes:
          //   - `results: QAResult[]`  — full multi-pass history (current format).
          //   - `result: QAResult`     — single latest pass (earlier format, fc6762a).
          // Normalize both to an array so restore works either way.
          const resultsArr: QAResult[] | null =
            Array.isArray(entry.results) && entry.results.length > 0
              ? (entry.results as QAResult[])
              : entry.result
                ? [entry.result as QAResult]
                : null;

          if (resultsArr && resultsArr.length > 0) {
            setResults(resultsArr);
            setActiveResult(resultsArr.length - 1);
            setPassNumber(resultsArr.length + 1);
          } else {
            // Legacy metadata-only entry — clear any stale results view. The
            // smart empty-state (below) will let the user still format/copy/
            // hand off whatever script text we did recover.
            setResults([]);
            setActiveResult(0);
            setPassNumber(Math.max(entry.passCount + 1, 1));
          }
          const hasFullResults = Boolean(resultsArr && resultsArr.length > 0);
          setApprovedFixes(new Set());
          setFixedScript('');
          setActiveTab('scores');

          if (hasFullResults && resultsArr) {
            const n = resultsArr.length;
            toast.success(`Session restored — ${n} pass${n === 1 ? '' : 'es'}, score ${entry.overallScore}/100`);
          } else if (hasFullScript) {
            toast.info('Script restored — QA details were not saved on this entry. Re-run QA to regenerate them.');
          } else {
            toast.info('Older entry — only a 300-char preview was saved. Use it as a starting point, or paste the full script to re-run QA.');
          }
        }}
        onDelete={id => {
          deleteQAEntry(id);
          setQaHistory(getQAHistory());
        }}
        onClearAll={() => {
          clearQAHistory();
          setQaHistory([]);
        }}
      />
    </div>
    </ScheduleLinkProvider>
  );
}
