/**
 * MouthSwap — paint_explainer_v1 procedural mouth animation.
 *
 * Renders the mouth-removed character base + an overlay PNG of the
 * current mouth state (closed / mid / open) at a known anchor on the
 * face. Per-frame state selection is driven by a `MouthState[]`
 * sequence (one entry per frame) — produced upstream by
 * `viseme-from-alignment.ts` when alignment data exists, or by
 * `constantRateVisemeSequence` as the fallback.
 *
 * Architectural detail: this component is intentionally STATELESS in
 * terms of mouth-state semantics — it just indexes into the sequence
 * the caller computed. That keeps phoneme-vs-word-vs-fallback timing
 * decisions in one place (the helper) and lets the Remotion render
 * stay deterministic across previews and Lambda renders.
 *
 * The mouth PNGs are 200×100 transparent assets shipped in
 * `public/paint-explainer-v1-motion/`. The component composites them
 * over the mouth-removed base at the supplied anchor coordinates
 * (percent of the canvas, calibrated to where the character's mouth
 * sits on the AI-generated base). PR 1 uses a hardcoded anchor; PR 5
 * adds the vision-pass resolver for non-centered character poses.
 *
 * See `_plans/2026-05-28-paint-explainer-v1-architecture.md` §4 (L1).
 */
import React from 'react';
import { AbsoluteFill, Img, useCurrentFrame } from 'remotion';
import type { MouthState } from '../../lib/viseme-from-alignment';

/** Hardcoded mouth-state PNG URLs. Shipped as static assets so Lambda
 *  renders can fetch them without going through a presigned R2 URL.
 *  The renderer reads these via the public path which Remotion
 *  rewrites against the bundled output. */
const MOUTH_PNGS: Record<MouthState, string> = {
  closed: '/paint-explainer-v1-motion/mouth-closed.png',
  mid: '/paint-explainer-v1-motion/mouth-mid.png',
  open: '/paint-explainer-v1-motion/mouth-open.png',
};

/** Default mouth anchor on a centered close-up character base —
 *  calibrated during the 2026-05-28 viability test on
 *  `14-close-up-character-face.jpg`. Expressed as a percentage of the
 *  canvas so it survives composition scaling. Range 0–100. */
const DEFAULT_MOUTH_ANCHOR_PCT = { xPct: 41.7, yPct: 52.2 };

/** Mouth PNG natural dimensions (build-mouth-states.py emits 200×100).
 *  The renderer scales them as a percent of the canvas width — the
 *  default ~12% landed cleanly on the test character. */
const DEFAULT_MOUTH_WIDTH_PCT = 12;
const MOUTH_ASPECT_RATIO = 200 / 100; // width : height

export interface MouthSwapProps {
  /** R2 URL of the mouth-removed character base. Bottom layer. */
  baseUrl: string;
  /** Per-frame mouth state sequence. Index = frame number relative to
   *  the shot's start (Remotion's `useCurrentFrame()` value). Values
   *  past `sequence.length - 1` clamp to the last entry. */
  sequence: MouthState[];
  /** Anchor for the mouth-state PNG center, % of canvas. When
   *  undefined, the component falls back to the centered-close-up
   *  default. Set by the PR-5 vision-pass for non-centered character
   *  poses. */
  anchor?: { xPct: number; yPct: number };
  /** Width of the mouth PNG as % of canvas width. Defaults to 12%
   *  which matches the calibrated default character size. */
  widthPct?: number;
  /** When true, log the resolved state on frame 0 for grep-able
   *  debugging. Same shape as BRollScene's `[broll mounted]` line. */
  diagnose?: boolean;
}

export const MouthSwap: React.FC<MouthSwapProps> = ({
  baseUrl,
  sequence,
  anchor = DEFAULT_MOUTH_ANCHOR_PCT,
  widthPct = DEFAULT_MOUTH_WIDTH_PCT,
  diagnose = false,
}) => {
  const frame = useCurrentFrame();

  // Defensive: an empty sequence should render the base only (a held
  // closed-mouth would be misleading). The caller is responsible for
  // ensuring the sequence has at least one entry; we don't fabricate.
  const stateIdx = sequence.length > 0
    ? Math.min(frame, sequence.length - 1)
    : -1;
  const state: MouthState | null = stateIdx >= 0 ? sequence[stateIdx] : null;

  if (diagnose && frame === 0) {
    console.info('[paint-explainer-v1 mouth-swap mounted]', {
      base_url_head: baseUrl.slice(0, 80),
      sequence_len: sequence.length,
      first_state: sequence[0] ?? null,
      anchor,
      width_pct: widthPct,
    });
  }

  const mouthWidthPct = widthPct;
  const mouthHeightPct = mouthWidthPct / MOUTH_ASPECT_RATIO;
  // Center the mouth PNG on the anchor coords by subtracting half its
  // size from each axis. All values are percent so they survive the
  // composition's outer width:height scaling.
  const mouthLeftPct = anchor.xPct - mouthWidthPct / 2;
  const mouthTopPct = anchor.yPct - mouthHeightPct / 2;

  return (
    <AbsoluteFill>
      <Img
        src={baseUrl}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {state !== null && (
        <Img
          src={MOUTH_PNGS[state]}
          style={{
            position: 'absolute',
            left: `${mouthLeftPct}%`,
            top: `${mouthTopPct}%`,
            width: `${mouthWidthPct}%`,
            height: `${mouthHeightPct}%`,
            pointerEvents: 'none',
          }}
        />
      )}
    </AbsoluteFill>
  );
};
