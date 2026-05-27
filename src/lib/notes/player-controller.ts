/**
 * Minimal control surface the notes UI needs from a Remotion player.
 * Decoupled from `PlayerRef` so the notes components don't depend on
 * Remotion directly — both `<VideoPlayer>` (production-doc grid) and
 * `<Stage>` (editor) expose a controller via `useImperativeHandle` to
 * keep this contract narrow.
 *
 * Why an interface instead of just passing the PlayerRef:
 *   - PlayerRef carries dozens of methods that aren't relevant to
 *     the notes feature; narrowing the surface makes future test
 *     mocks trivial.
 *   - The two host components have different wrapping patterns; this
 *     lets each adapt to its own internal state (e.g. Stage already
 *     manages a seek effect — the controller delegates to it instead
 *     of bypassing it).
 */
export interface PlayerController {
  /** Synchronously read the current playhead position in frames. Returns
   *  0 if the player hasn't mounted yet. */
  getCurrentFrame(): number;
  /** Pause playback if currently playing. No-op when already paused. */
  pause(): void;
  /** Resume playback from the current playhead. No-op when already playing. */
  play(): void;
  /** Seek to an absolute frame. Implementations may clamp to the
   *  composition's duration. */
  seekToFrame(frame: number): void;
  /** Whether playback is currently active. Lets the notes hotkey
   *  remember the previous state across a pause-to-take-a-note interaction
   *  so it can resume seamlessly on save. */
  isPlaying(): boolean;
}
