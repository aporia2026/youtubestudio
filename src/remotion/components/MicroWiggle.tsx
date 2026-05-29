/**
 * MicroWiggle — paint_explainer_v1 ambient character-body sway.
 *
 * Wraps children with a per-frame CSS transform that produces a
 * subtle ±1° rotation / ±2px elliptical translation, frame-
 * deterministic (preview === Lambda render). Mounted by MotionScene
 * inside a Remotion `<Sequence>` so the wiggle is bounded to the
 * beat's window — caller controls when it starts and stops.
 *
 * Math lives in `../micro-wiggle-math.ts` for testability — this
 * component is the thinnest possible React wrapper around it.
 *
 * Plan: §4 (Layer 1 — MicroWiggle) of
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  microWiggleCssTransform,
  microWiggleTransform,
  type MicroWiggleOpts,
} from '../micro-wiggle-math';

export interface MicroWiggleProps extends MicroWiggleOpts {
  children: React.ReactNode;
  /** When true, log the resolved transform on frame 0 so a debug-
   *  from-symptoms session can verify intensity / frequency landed
   *  the way the caller intended. */
  diagnose?: boolean;
}

export const MicroWiggle: React.FC<MicroWiggleProps> = ({
  children,
  diagnose = false,
  ...opts
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const transform = microWiggleTransform(frame, fps, opts);
  const cssTransform = microWiggleCssTransform(transform);

  if (diagnose && frame === 0) {
    console.info('[paint-explainer-v1 micro-wiggle mounted]', {
      rotation_deg: opts.rotationDeg,
      translate_px: opts.translatePx,
      rotation_freq_hz: opts.rotationFreqHz,
      translate_freq_hz: opts.translateFreqHz,
      first_transform: {
        rotation: Number(transform.rotation.toFixed(3)),
        translateX: Number(transform.translateX.toFixed(3)),
        translateY: Number(transform.translateY.toFixed(3)),
      },
    });
  }

  return (
    <AbsoluteFill
      style={{
        transform: cssTransform,
        transformOrigin: 'center center',
        pointerEvents: 'none',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
