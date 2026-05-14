/**
 * Per-channel visual brand kit — the fonts, colors, and logo that the
 * Remotion video composition picks up when this channel is the active
 * one.
 *
 * Stored in `channels.visual_brand_kit` (JSONB, added in migration 0070).
 * Distinct from the existing `brand_kit` column (added in 0016) which
 * carries script-generation guidance (voice / tone / banned phrases).
 * The two are deliberately separated — reading one as the other would
 * be a category mistake, and the type system rules it out here.
 *
 * Versioned shape (`v: 1`) so future fields can be added without a
 * coordinated migration. `parseVisualBrandKit` is fault-tolerant: a
 * corrupt blob, version mismatch, or unknown font name returns a
 * conservative default rather than throwing — a malformed kit should
 * never break a render.
 */
import { sql } from '@vercel/postgres';
import {
  ALLOWED_FONT_FAMILIES,
  type FontFamilyName,
  resolveFontStack,
} from '@/remotion/fonts';
import { DEFAULT_BRAND_KIT, type BrandKit } from '@/remotion/types';

export const VISUAL_BRAND_KIT_VERSION = 1;

export interface ChannelVisualBrandKit {
  v: typeof VISUAL_BRAND_KIT_VERSION;
  /** Font-family registry key (one of ALLOWED_FONT_FAMILIES). Resolves
   *  to a CSS fallback stack at render time via resolveFontStack. */
  fontFamily?: FontFamilyName;
  /** Separate font for bold titles. Same allowlist as fontFamily. */
  titleFontFamily?: FontFamilyName;
  /** Hex color "#RRGGBB" (case-insensitive). Validated by HEX_RE. */
  primaryColor?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  titleColor?: string;
  /** R2-bucket-hosted URL of the channel logo (used by the outro scene). */
  logoUrl?: string;
  /** Channel name shown in the outro scene. */
  channelName?: string;
}

const DEFAULTS: ChannelVisualBrandKit = { v: VISUAL_BRAND_KIT_VERSION };

/** Six-digit hex color, case-insensitive. Three-digit `#abc` is rejected on
 *  purpose — the brand kit is operator-curated, not user-pasted, so we keep
 *  the canonical form. */
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

const ALLOWED_FONT_SET: ReadonlySet<string> = new Set(ALLOWED_FONT_FAMILIES);

// ─── Logo URL validation ──────────────────────────────────────────────────────
//
// The logo URL ends up in `<img src>` inside the rendered video — an attacker-
// supplied URL would let them hot-link an image into every render this kit
// powers, or worse, point at an SSRF target that the Remotion bundler then
// fetches at build time. Host allowlist is the only safe gate; mirrors the
// `/api/download-proxy` allowlist for R2-served URLs.

const STATIC_LOGO_HOST_SUFFIXES = ['r2.cloudflarestorage.com'] as const;
const ENV_LOGO_HOST_KEYS = ['R2_IMAGES_PUBLIC_URL'] as const;

/** Whether a string is an http(s) URL whose host belongs to one of the R2
 *  buckets we own. False for everything else (file://, javascript:, etc.). */
export function isAllowedLogoUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.host.toLowerCase();
  if (STATIC_LOGO_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))) return true;
  for (const key of ENV_LOGO_HOST_KEYS) {
    const v = process.env[key];
    if (!v) continue;
    try {
      if (new URL(v).host.toLowerCase() === host) return true;
    } catch {
      // Malformed env var — skip.
    }
  }
  return false;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Pure parser. Accepts any unknown blob (from JSONB or a typed PATCH body)
 * and returns a well-shaped ChannelVisualBrandKit. Anything that doesn't
 * match the schema is silently dropped — a future-shape kit, an attacker
 * sneaking in extra keys, and an honest-but-broken client all degrade the
 * same way: the offending field disappears.
 */
export function parseVisualBrandKit(raw: unknown): ChannelVisualBrandKit {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const obj = raw as Record<string, unknown>;
  // Tolerate missing v on legacy rows seeded with {} default — treat as v1.
  if (obj.v !== undefined && obj.v !== VISUAL_BRAND_KIT_VERSION) return { ...DEFAULTS };

  const out: ChannelVisualBrandKit = { v: VISUAL_BRAND_KIT_VERSION };

  const hex = (k: string): string | undefined => {
    const v = obj[k];
    if (typeof v !== 'string') return undefined;
    return HEX_RE.test(v) ? v : undefined;
  };
  const font = (k: string): FontFamilyName | undefined => {
    const v = obj[k];
    if (typeof v !== 'string') return undefined;
    return ALLOWED_FONT_SET.has(v) ? (v as FontFamilyName) : undefined;
  };
  const trimmedString = (k: string, max: number): string | undefined => {
    const v = obj[k];
    if (typeof v !== 'string') return undefined;
    const t = v.trim().slice(0, max);
    return t.length > 0 ? t : undefined;
  };

  const ff = font('fontFamily');
  if (ff) out.fontFamily = ff;
  const tff = font('titleFontFamily');
  if (tff) out.titleFontFamily = tff;

  const p = hex('primaryColor');
  if (p) out.primaryColor = p;
  const s = hex('secondaryColor');
  if (s) out.secondaryColor = s;
  const b = hex('backgroundColor');
  if (b) out.backgroundColor = b;
  const t = hex('textColor');
  if (t) out.textColor = t;
  const ti = hex('titleColor');
  if (ti) out.titleColor = ti;

  // Logo URL is host-allowlisted; any URL outside the R2-images bucket
  // family is dropped.
  if (typeof obj.logoUrl === 'string' && isAllowedLogoUrl(obj.logoUrl)) {
    out.logoUrl = obj.logoUrl;
  }

  const name = trimmedString('channelName', 80);
  if (name) out.channelName = name;

  return out;
}

/** True if the kit carries any user-set override. Useful for the UI to
 *  decide between "default" / "customized" labels without enumerating
 *  every field. */
export function isVisualBrandKitNonEmpty(kit: ChannelVisualBrandKit): boolean {
  return (
    Boolean(kit.fontFamily) ||
    Boolean(kit.titleFontFamily) ||
    Boolean(kit.primaryColor) ||
    Boolean(kit.secondaryColor) ||
    Boolean(kit.backgroundColor) ||
    Boolean(kit.textColor) ||
    Boolean(kit.titleColor) ||
    Boolean(kit.logoUrl) ||
    Boolean(kit.channelName)
  );
}

// ─── Resolver (merged render-time view) ───────────────────────────────────────

/**
 * Collapse the three-layer brand-kit stack into a single BrandKit ready to
 * hand to the Remotion composition.
 *
 * Layer order, left-to-right precedence (later overrides earlier):
 *   DEFAULT_BRAND_KIT  ◀  channel  ◀  productionDocOverride
 *
 * Each higher layer is a Partial — only the fields the layer set get
 * applied. Font keys are expanded from their registry name to the CSS
 * fallback stack so the renderer doesn't need to know about
 * ALLOWED_FONT_FAMILIES.
 */
export function resolveBrandKitForRender(
  channel: ChannelVisualBrandKit | null | undefined,
  override: ChannelVisualBrandKit | null | undefined,
): BrandKit {
  const merged: BrandKit = { ...DEFAULT_BRAND_KIT };

  const apply = (layer: ChannelVisualBrandKit | null | undefined): void => {
    if (!layer) return;
    if (layer.fontFamily) merged.fontFamily = resolveFontStack(layer.fontFamily);
    if (layer.titleFontFamily) merged.titleFontFamily = resolveFontStack(layer.titleFontFamily);
    if (layer.primaryColor) merged.primaryColor = layer.primaryColor;
    if (layer.secondaryColor) merged.secondaryColor = layer.secondaryColor;
    if (layer.backgroundColor) merged.backgroundColor = layer.backgroundColor;
    if (layer.textColor) merged.textColor = layer.textColor;
    if (layer.titleColor) merged.titleColor = layer.titleColor;
    if (layer.logoUrl) merged.logoUrl = layer.logoUrl;
    if (layer.channelName) merged.channelName = layer.channelName;
  };

  apply(channel);
  apply(override);
  return merged;
}

// ─── DB I/O ───────────────────────────────────────────────────────────────────

export class ChannelNotFoundError extends Error {
  constructor(channelId: string) {
    super(`Channel ${channelId} not found in this workspace.`);
    this.name = 'ChannelNotFoundError';
  }
}

/** Read a channel's visual brand kit. Workspace-scoped — returns null if the
 *  channel doesn't exist in the user's workspace (404, not 403, to avoid
 *  leaking channel existence across workspaces). */
export async function getChannelVisualBrandKit(
  channelId: string,
  workspaceId: string,
): Promise<ChannelVisualBrandKit | null> {
  if (!channelId) return null;
  const { rows } = await sql<{ visual_brand_kit: unknown }>`
    SELECT visual_brand_kit FROM channels
     WHERE id = ${channelId}::uuid AND workspace_id = ${workspaceId}::uuid
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  return parseVisualBrandKit(rows[0]!.visual_brand_kit);
}

/** Replace a channel's visual brand kit. Validates ownership before writing.
 *  The patch is re-sanitized through parseVisualBrandKit so an attacker
 *  cannot persist a font name outside ALLOWED_FONT_FAMILIES or a non-hex
 *  color even if they bypass the route-level validation. */
export async function updateChannelVisualBrandKit(
  channelId: string,
  workspaceId: string,
  patch: Partial<ChannelVisualBrandKit>,
): Promise<ChannelVisualBrandKit> {
  const sanitized = parseVisualBrandKit({ ...patch, v: VISUAL_BRAND_KIT_VERSION });
  const { rowCount } = await sql`
    UPDATE channels
       SET visual_brand_kit = ${JSON.stringify(sanitized)}::jsonb
     WHERE id = ${channelId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  if (rowCount === 0) throw new ChannelNotFoundError(channelId);
  return sanitized;
}
