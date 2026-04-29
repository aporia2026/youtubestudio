/**
 * Keeps two <video> elements in sync.
 * The "primary" video drives playback — the secondary follows.
 * RAF loop only runs while playing to avoid wasting CPU.
 */
export class VideoSyncManager {
  private primary: HTMLVideoElement;
  private secondary: HTMLVideoElement;
  private rafId: number | null = null;
  private listeners: (() => void)[] = [];

  constructor(primary: HTMLVideoElement, secondary: HTMLVideoElement) {
    this.primary = primary;
    this.secondary = secondary;
    this.setup();
  }

  private startSyncLoop() {
    if (this.rafId != null) return; // already running
    const step = () => {
      if (Math.abs(this.primary.currentTime - this.secondary.currentTime) > 0.05) {
        this.secondary.currentTime = this.primary.currentTime;
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  private stopSyncLoop() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private setup() {
    const onPlay = () => {
      this.secondary.play().catch(() => {});
      this.startSyncLoop();
    };
    const onPause = () => {
      this.secondary.pause();
      this.stopSyncLoop();
    };
    const onSeeked = () => { this.secondary.currentTime = this.primary.currentTime; };
    const onRateChange = () => { this.secondary.playbackRate = this.primary.playbackRate; };

    this.primary.addEventListener('play', onPlay);
    this.primary.addEventListener('pause', onPause);
    this.primary.addEventListener('seeked', onSeeked);
    this.primary.addEventListener('ratechange', onRateChange);

    this.listeners.push(
      () => this.primary.removeEventListener('play', onPlay),
      () => this.primary.removeEventListener('pause', onPause),
      () => this.primary.removeEventListener('seeked', onSeeked),
      () => this.primary.removeEventListener('ratechange', onRateChange),
    );

    // If already playing when sync manager is created
    if (!this.primary.paused) {
      this.secondary.play().catch(() => {});
      this.startSyncLoop();
    }
  }

  dispose() {
    for (const remove of this.listeners) remove();
    this.listeners = [];
    this.stopSyncLoop();
  }
}
