'use client';

/**
 * Inspector → Shot Type panel. Surfaces the row's `visual_type` as a
 * dropdown the user can change, plus the two title-card workflows
 * that previously only existed in the production-doc grid view:
 *
 *   - "Make this a title card" — promotes the active row to
 *     visual_type === 'Title Card' and runs the production-doc
 *     promotion side-effects (clears ai_image_prompt + visual_description,
 *     lifts script_text into on_screen_text, backs prior prompt into
 *     notes). Wired through the SET_ROW_VISUAL_TYPE command with
 *     promoteFields: true.
 *
 *   - "Split as title card" — extracts a leading `## heading` from
 *     `script_text` into a fresh Title Card row inserted above the
 *     active row. Wired through SPLIT_AS_TITLE_CARD.
 *
 *   - "Apply as section title →" (Title Card rows only) — propagates
 *     the card's text as `section_title` to every downstream row until
 *     the next Title Card. Wired through APPLY_TITLE_CARD_AS_SECTION_TITLE.
 *
 * Visual type options match the set the production-doc generator emits
 * (Animation / Title Card / Statistics / B-Roll / blank). Other values
 * are accepted but displayed as-is.
 */

import { useMemo } from 'react';
import { Type, Scissors, ChevronsRight } from 'lucide-react';
import type { ProductionDoc } from '@/remotion/utils';

type Row = ProductionDoc['rows'][number];

/** Canonical visual_type values the production-doc generator emits.
 *  Listed here as the dropdown options so a user can promote any row.
 *  Unknown values from older docs are preserved by being injected as
 *  the current option. */
const KNOWN_VISUAL_TYPES = [
  'Animation',
  'Title Card',
  'Statistics',
  'B-Roll',
  'blank',
] as const;

interface Props {
  row: Row;
  /** Detects a leading markdown heading in `script_text` so the
   *  "Split as title card" button can show/hide and label itself with
   *  the actual heading text. Empty string ⇒ no heading available. */
  detectedHeading: string;
  /** True when this Title Card has at least one downstream row up to
   *  (not including) the next Title Card. Drives the
   *  "Apply as section title" button visibility — hides when the
   *  apply would be a no-op. */
  applySectionTitleAffectedCount: number;

  onSetVisualType: (visualType: string, options?: { promoteFields?: boolean }) => void;
  onSplitAsTitleCard: (heading: string) => void;
  onApplyTitleCardAsSectionTitle: () => void;
}

export function InspectorShotTypePanel({
  row,
  detectedHeading,
  applySectionTitleAffectedCount,
  onSetVisualType,
  onSplitAsTitleCard,
  onApplyTitleCardAsSectionTitle,
}: Props): React.ReactElement {
  const currentType = row.visual_type || 'Animation';
  const isTitleCard = currentType === 'Title Card';

  // Build the option list: known types + the current value if it's not
  // already in the canonical list. Keeps old-doc values selectable
  // without losing them when the user opens the dropdown.
  const options = useMemo(() => {
    const set = new Set<string>(KNOWN_VISUAL_TYPES);
    set.add(currentType);
    return [...set];
  }, [currentType]);

  return (
    <div
      className="p-3 border-b space-y-2"
      style={{ borderColor: 'var(--card-border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
          Shot type
        </div>
        {isTitleCard && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1"
            style={{
              color: '#fff',
              background: 'var(--accent-blue, #3b82f6)',
            }}
            title="This row renders as a typography-only title card (no image)."
          >
            <Type size={10} /> Title Card
          </span>
        )}
      </div>
      <select
        value={currentType}
        onChange={(e) => {
          const next = e.target.value;
          // When promoting TO a Title Card, run the production-doc
          // promotion side-effects (clear prompt, lift script into
          // on-screen text, etc.). Other type changes are field-only.
          const isPromoteToTitle = next === 'Title Card' && currentType !== 'Title Card';
          onSetVisualType(next, { promoteFields: isPromoteToTitle });
        }}
        className="w-full text-[11px] px-2 py-1.5 rounded border bg-transparent"
        style={{
          borderColor: 'var(--card-border)',
          color: 'var(--fg)',
        }}
      >
        {options.map((t) => (
          <option key={t} value={t} style={{ background: 'var(--card-bg, #1f2937)' }}>
            {t}
          </option>
        ))}
      </select>
      <p
        className="text-[10px] leading-snug"
        style={{ color: 'var(--fg-muted)' }}
      >
        Title Cards render as typography only — no image generation, no
        animation. Use them as section dividers in a long video.
      </p>

      {/* Split-as-title-card surfaces a button only when the row's
          script_text actually starts with a heading the regex can
          match. No-op buttons are worse than hidden ones. */}
      {detectedHeading && !isTitleCard && (
        <button
          type="button"
          onClick={() => onSplitAsTitleCard(detectedHeading)}
          className="w-full text-[11px] px-2 py-1.5 rounded border transition-colors flex items-center justify-center gap-1.5 hover:bg-white/5"
          style={{
            borderColor: 'var(--card-border)',
            color: 'var(--fg)',
          }}
          title={`Extract "${detectedHeading}" from the script as a new Title Card row above this one.`}
        >
          <Scissors size={12} /> Split &quot;{truncate(detectedHeading, 28)}&quot; as title card
        </button>
      )}

      {/* Section-title propagation is Title-Card-only. The affected
          count is computed by the parent (walks downstream until the
          next Title Card); a 0 count hides the button so the inspector
          never offers a zero-op action. */}
      {isTitleCard && applySectionTitleAffectedCount > 0 && (
        <button
          type="button"
          onClick={onApplyTitleCardAsSectionTitle}
          className="w-full text-[11px] px-2 py-1.5 rounded border transition-colors flex items-center justify-center gap-1.5 hover:bg-white/5"
          style={{
            borderColor: 'var(--card-border)',
            color: 'var(--fg)',
          }}
          title={`Stamp this card's text as the section title on the next ${applySectionTitleAffectedCount} row${applySectionTitleAffectedCount === 1 ? '' : 's'} (until the next Title Card).`}
        >
          <ChevronsRight size={12} /> Apply as section title for next {applySectionTitleAffectedCount} row{applySectionTitleAffectedCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Detect a leading markdown heading in `script_text` the way the
 * production-doc grid does. Returns the heading text (trimmed) or
 * empty string when the script doesn't start with one.
 *
 * Matches:  `## Heading`  or  `## Heading: trailing body...`
 *           `Heading`  (bare, when followed by `:` or `\n`)
 *
 * Mirrors the regex shape the production-doc page uses so detection
 * is consistent across surfaces.
 */
export function detectLeadingHeading(scriptText: string): string {
  const trimmed = scriptText.trim();
  if (!trimmed) return '';
  // Prefer the markdown-style `## Heading` form when present.
  const md = /^##\s+(.+?)(?:[\n:.,]|$)/.exec(trimmed);
  if (md && md[1]) return md[1].trim();
  // Fallback: the first line, when it's short enough to read as a
  // heading (≤ 60 chars) and is followed by a paragraph break.
  const firstLine = trimmed.split('\n')[0];
  if (firstLine && firstLine.length <= 60 && trimmed.length > firstLine.length + 1) {
    const next = trimmed[firstLine.length];
    if (next === '\n' || next === ':') return firstLine.trim();
  }
  return '';
}
