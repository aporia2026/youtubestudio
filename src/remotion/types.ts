// ─── Scene Types ───────────────────────────────────────────────────────────────

export type SceneType =
  | 'title-card'      // Bold title text, optional subtitle — for intros, section headers
  | 'b-roll'          // Image/illustration with Ken Burns animation
  | 'text-reveal'     // Text-only shot, words reveal one by one
  | 'icon-scene'      // Flat illustration style: white bg, icons/characters, bold title
  | 'screen-mockup'   // Shows a UI/app screenshot in a device frame
  | 'split-scene'     // Two items side by side (comparison, before/after)
  | 'outro';          // End card with CTA

// ─── Brand Kit ─────────────────────────────────────────────────────────────────

export interface BrandKit {
  primaryColor: string;    // Main accent color, e.g. "#FF4444"
  secondaryColor: string;  // Secondary accent, e.g. "#222222"
  backgroundColor: string; // Scene background, e.g. "#FFFFFF"
  textColor: string;       // Body text color, e.g. "#111111"
  titleColor: string;      // Title text color
  fontFamily: string;      // CSS font-family string
  titleFontFamily: string; // Separate font for bold titles
  logoUrl?: string;        // Optional logo URL for intros/outros
  channelName?: string;    // Channel name for outros
}

export const DEFAULT_BRAND_KIT: BrandKit = {
  primaryColor: '#FF0000',
  secondaryColor: '#222222',
  backgroundColor: '#FFFFFF',
  textColor: '#111111',
  titleColor: '#111111',
  fontFamily: 'Inter, system-ui, sans-serif',
  titleFontFamily: 'Inter, system-ui, sans-serif',
};

// ─── Video Shot ─────────────────────────────────────────────────────────────────

export interface VideoShot {
  /** Start time in milliseconds */
  startMs: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Scene type — determines which scene component renders this shot */
  sceneType: SceneType;
  /** Image URL for this shot (b-roll, icon-scene, screen-mockup) */
  imageUrl?: string;
  /** Bold title text shown at top of frame */
  title?: string;
  /** Subtitle or secondary text */
  subtitle?: string;
  /** On-screen overlay text (lower third style) */
  onScreenText?: string;
  /** The voiceover script text for this shot (used for captions) */
  scriptText?: string;
  /** Animation variant override — used to pick between multiple entrance styles */
  animationVariant?: 'slide-up' | 'slide-left' | 'slide-right' | 'zoom-in' | 'fade';
  /** Ken Burns direction override */
  kenBurnsDirection?: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down';
  /** Background color override for this shot */
  backgroundColor?: string;
  /** Whether to show floating/bobbing animation on the main image */
  floatImage?: boolean;
}

// ─── Video Config ──────────────────────────────────────────────────────────────

export interface VideoConfig {
  /** Frames per second — 30 for YouTube, 60 for gaming content */
  fps: number;
  /** Composition width in pixels */
  width: number;
  /** Composition height in pixels */
  height: number;
  /** All shots in order */
  shots: VideoShot[];
  /** Voiceover audio URL (Vercel Blob public URL) */
  voiceoverUrl?: string;
  /** Background music URL */
  musicUrl?: string;
  /** Music volume (0–1), defaults to 0.15 */
  musicVolume?: number;
  /** Brand kit for colors/fonts */
  brand: BrandKit;
  /** Whether to show burned-in captions */
  showCaptions?: boolean;
}

// ─── Render Job ───────────────────────────────────────────────────────────────

export type RenderStatus = 'pending' | 'rendering' | 'done' | 'error';

export interface RenderJob {
  id: string;
  status: RenderStatus;
  progress: number;    // 0–1
  outputUrl?: string;  // Vercel Blob URL when done
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

// ─── Production Doc → Shot Conversion ─────────────────────────────────────────

/** Maps visual_type strings from production doc to SceneType */
export function inferSceneType(visualType: string): SceneType {
  const v = visualType.toLowerCase();
  if (v.includes('title') || v.includes('intro') || v.includes('header')) return 'title-card';
  if (v.includes('outro') || v.includes('end') || v.includes('cta')) return 'outro';
  if (v.includes('screen') || v.includes('ui') || v.includes('app') || v.includes('demo')) return 'screen-mockup';
  if (v.includes('icon') || v.includes('diagram') || v.includes('illustration') || v.includes('infograph')) return 'icon-scene';
  if (v.includes('text') || v.includes('quote') || v.includes('stat') || v.includes('fact')) return 'text-reveal';
  if (v.includes('split') || v.includes('comparison') || v.includes('vs')) return 'split-scene';
  // Default: b-roll (most common)
  return 'b-roll';
}
