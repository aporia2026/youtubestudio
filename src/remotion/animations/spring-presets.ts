import { SpringConfig } from 'remotion';

// ─── Spring Presets ────────────────────────────────────────────────────────────
// All presets are tuned for 30fps video. Increase damping for 60fps.

/** Snappy entrance — quick settle, slight overshoot. Good for text/icon pop-in. */
export const SPRING_SNAPPY: SpringConfig = {
  damping: 12,
  stiffness: 200,
  mass: 0.8,
  overshootClamping: false,
};

/** Bouncy — noticeable overshoot. Good for character/icon entrances. */
export const SPRING_BOUNCY: SpringConfig = {
  damping: 8,
  stiffness: 180,
  mass: 1,
  overshootClamping: false,
};

/** Smooth — gentle settle, no overshoot. Good for background slides, Ken Burns. */
export const SPRING_SMOOTH: SpringConfig = {
  damping: 20,
  stiffness: 120,
  mass: 1,
  overshootClamping: true,
};

/** Wobbly — heavy overshoot. Good for "impact" moments, sticker-style entrances. */
export const SPRING_WOBBLY: SpringConfig = {
  damping: 6,
  stiffness: 150,
  mass: 1.2,
  overshootClamping: false,
};

/** Slow gentle — long ease in. Good for background zooms, full-scene fades. */
export const SPRING_GENTLE: SpringConfig = {
  damping: 30,
  stiffness: 60,
  mass: 1,
  overshootClamping: true,
};

/** Hard stop — instant settle. Good for sharp cuts, mechanical animations. */
export const SPRING_HARD: SpringConfig = {
  damping: 100,
  stiffness: 300,
  mass: 1,
  overshootClamping: true,
};
