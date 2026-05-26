/**
 * Ambient type declarations for `soundtouchjs` (v0.3.0).
 *
 * The upstream package ships no `.d.ts` files and no `@types/soundtouchjs`
 * exists on npm. We declare only what `src/lib/voiceover/time-stretch.ts`
 * actually uses; the rest are opaque so future callers still get a typed
 * import surface without having to reverse-engineer the whole API.
 *
 * Upstream exports (verified against `node_modules/soundtouchjs/dist/soundtouch.js`):
 *   AbstractFifoSamplePipe, PitchShifter, RateTransposer, SimpleFilter,
 *   SoundTouch, Stretch, WebAudioBufferSource, getWebAudioNode
 */
declare module 'soundtouchjs' {
  /**
   * Wraps an `AudioBuffer` so the SoundTouch pipeline can read PCM frames
   * from it. SoundTouch internally treats the source as stereo; mono
   * inputs are upmixed silently to the right channel.
   */
  export class WebAudioBufferSource {
    constructor(buffer: AudioBuffer);
  }

  /**
   * Time-stretch / pitch-shift processor. Setting `tempo > 1` plays faster,
   * `< 1` plays slower; pitch is preserved.
   */
  export class SoundTouch {
    constructor();
    tempo: number;
    pitch: number;
    rate: number;
  }

  /**
   * Pulls processed frames from a SoundTouch chain into a Float32Array.
   * Output is stereo-interleaved (L, R, L, R, ...) even for mono input.
   * Returns the number of frame pairs actually written.
   */
  export class SimpleFilter {
    constructor(source: WebAudioBufferSource, pipe: SoundTouch);
    extract(target: Float32Array, numFrames: number): number;
  }

  export class AbstractFifoSamplePipe {}
  export class PitchShifter {}
  export class RateTransposer {}
  export class Stretch {}

  export function getWebAudioNode(
    context: BaseAudioContext,
    filter: SimpleFilter,
    sourcePositionCallback?: (sourcePosition: number) => void,
    bufferSize?: number,
  ): ScriptProcessorNode;
}
