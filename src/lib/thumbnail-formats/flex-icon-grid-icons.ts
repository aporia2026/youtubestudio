/**
 * Flex Icon Grid — icon registry.
 *
 * Curated subset of Lucide icons exposed to the editor's icon picker
 * and the server composer. Two reasons we curate rather than expose
 * the full ~1700-icon set:
 *  1. Picker UX (rule 10/16) — a finite, grouped set is easier to
 *     skim than a search-only mode. Users opening the panel see what
 *     they can choose without a long discovery phase.
 *  2. Wire format stability — every entry here is a name the server
 *     promises to render. The picker can't accidentally ship a slug
 *     the server has never heard of.
 *
 * Adding an icon means:
 *  1. Import it from `lucide-static` (PascalCase export).
 *  2. Append an entry to `ICON_REGISTRY` with a kebab-case slug, a
 *     human-readable label, and a category.
 *  3. The picker UI surfaces it automatically next render.
 *
 * Server vs client:
 *  - Server (composer): consume the raw SVG string via `getIconSvg`.
 *  - Client (picker): consume the lucide-react React component via
 *    the picker file, keyed by the same slug. We don't import
 *    lucide-react here to keep this module server-safe.
 *
 * Dependency: `lucide-static` (MIT, ~1700 icons, each exported as a
 * standalone SVG markup string with `viewBox="0 0 24 24"`). The
 * composer extracts the inner XML and re-wraps it with its own
 * width/height/stroke attributes so cell colour overrides flow
 * through cleanly.
 */

import {
  // ─── Tech ─────────────────────────────────────────────────────────────────
  Laptop,
  Smartphone,
  Monitor,
  Server,
  Cpu,
  HardDrive,
  Wifi,
  Plug,
  Battery,
  Database,
  // ─── Security ─────────────────────────────────────────────────────────────
  Shield,
  ShieldAlert,
  ShieldCheck,
  Lock,
  Key,
  Eye,
  EyeOff,
  Fingerprint,
  AlertTriangle,
  Bug,
  // ─── Communication ────────────────────────────────────────────────────────
  Mail,
  MessageCircle,
  MessageSquare,
  Send,
  Bell,
  Phone,
  Mic,
  Video,
  // ─── Money / business ─────────────────────────────────────────────────────
  DollarSign,
  CreditCard,
  Banknote,
  Wallet,
  PiggyBank,
  TrendingUp,
  TrendingDown,
  Briefcase,
  // ─── Media ────────────────────────────────────────────────────────────────
  Play,
  Pause,
  Film,
  Music,
  Image as ImageIcon,
  Camera,
  Headphones,
  // ─── People / faces ───────────────────────────────────────────────────────
  User,
  Users,
  Smile,
  Frown,
  Heart,
  Brain,
  Baby,
  // ─── Web / cloud / social ─────────────────────────────────────────────────
  Globe,
  Cloud,
  Link,
  // Brand icons (GitHub / Twitter/X / YouTube / Instagram / LinkedIn) were
  // removed from `lucide-static` for trademark reasons. To bring them back
  // we have to ship custom SVG strings inline in this file rather than
  // import from lucide-static. Out of scope for the 2026-05-28 build-fix
  // unblock.
  // ─── Common UI ────────────────────────────────────────────────────────────
  Home,
  Settings,
  Search,
  Star,
  Check,
  X,
  Plus,
  Minus,
  Info,
  Calendar,
  Clock,
  MapPin,
  // ─── Nature / energy ──────────────────────────────────────────────────────
  Zap,
  Flame,
  Droplet,
  Leaf,
  Sun,
  Moon,
  Snowflake,
  CloudRain,
  // ─── Misc punch ───────────────────────────────────────────────────────────
  Gift,
  Package,
  Box,
  Trash,
  Trash2,
  Rocket,
  Sparkles,
  Target,
  Trophy,
  Crown,
  Skull,
  Ghost,
} from 'lucide-static';

// ─── Registry types ─────────────────────────────────────────────────────────

export type IconCategory =
  | 'tech'
  | 'security'
  | 'communication'
  | 'money'
  | 'media'
  | 'people'
  | 'web'
  | 'common'
  | 'nature'
  | 'misc';

export interface IconEntry {
  /** Kebab-case identifier persisted in the config (the wire name). */
  slug: string;
  /** Human-readable display name for the picker. */
  label: string;
  category: IconCategory;
  /** Raw SVG markup string as exported by `lucide-static`. The composer
   *  extracts the inner content via `extractIconInner` before embedding
   *  it in the master SVG. */
  svg: string;
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * The canonical icon list. Order within each category roughly follows
 * "most likely to be picked first" — the picker UI uses this order
 * directly rather than alphabetising.
 *
 * Slugs match Lucide's documented kebab-case name where possible so
 * users familiar with Lucide can predict what's available.
 */
export const ICON_REGISTRY: readonly IconEntry[] = [
  // Tech
  { slug: 'laptop', label: 'Laptop', category: 'tech', svg: Laptop as unknown as string },
  { slug: 'smartphone', label: 'Phone', category: 'tech', svg: Smartphone as unknown as string },
  { slug: 'monitor', label: 'Monitor', category: 'tech', svg: Monitor as unknown as string },
  { slug: 'server', label: 'Server', category: 'tech', svg: Server as unknown as string },
  { slug: 'cpu', label: 'CPU', category: 'tech', svg: Cpu as unknown as string },
  { slug: 'hard-drive', label: 'Hard Drive', category: 'tech', svg: HardDrive as unknown as string },
  { slug: 'wifi', label: 'Wi-Fi', category: 'tech', svg: Wifi as unknown as string },
  { slug: 'plug', label: 'Plug', category: 'tech', svg: Plug as unknown as string },
  { slug: 'battery', label: 'Battery', category: 'tech', svg: Battery as unknown as string },
  { slug: 'database', label: 'Database', category: 'tech', svg: Database as unknown as string },

  // Security
  { slug: 'shield', label: 'Shield', category: 'security', svg: Shield as unknown as string },
  { slug: 'shield-alert', label: 'Shield Alert', category: 'security', svg: ShieldAlert as unknown as string },
  { slug: 'shield-check', label: 'Shield Check', category: 'security', svg: ShieldCheck as unknown as string },
  { slug: 'lock', label: 'Lock', category: 'security', svg: Lock as unknown as string },
  { slug: 'key', label: 'Key', category: 'security', svg: Key as unknown as string },
  { slug: 'eye', label: 'Eye', category: 'security', svg: Eye as unknown as string },
  { slug: 'eye-off', label: 'Eye Off', category: 'security', svg: EyeOff as unknown as string },
  { slug: 'fingerprint', label: 'Fingerprint', category: 'security', svg: Fingerprint as unknown as string },
  { slug: 'alert-triangle', label: 'Alert', category: 'security', svg: AlertTriangle as unknown as string },
  { slug: 'bug', label: 'Bug', category: 'security', svg: Bug as unknown as string },

  // Communication
  { slug: 'mail', label: 'Mail', category: 'communication', svg: Mail as unknown as string },
  { slug: 'message-circle', label: 'Chat Bubble', category: 'communication', svg: MessageCircle as unknown as string },
  { slug: 'message-square', label: 'Chat Square', category: 'communication', svg: MessageSquare as unknown as string },
  { slug: 'send', label: 'Send', category: 'communication', svg: Send as unknown as string },
  { slug: 'bell', label: 'Bell', category: 'communication', svg: Bell as unknown as string },
  { slug: 'phone', label: 'Call', category: 'communication', svg: Phone as unknown as string },
  { slug: 'mic', label: 'Microphone', category: 'communication', svg: Mic as unknown as string },
  { slug: 'video', label: 'Video', category: 'communication', svg: Video as unknown as string },

  // Money
  { slug: 'dollar-sign', label: 'Dollar', category: 'money', svg: DollarSign as unknown as string },
  { slug: 'credit-card', label: 'Credit Card', category: 'money', svg: CreditCard as unknown as string },
  { slug: 'banknote', label: 'Banknote', category: 'money', svg: Banknote as unknown as string },
  { slug: 'wallet', label: 'Wallet', category: 'money', svg: Wallet as unknown as string },
  { slug: 'piggy-bank', label: 'Piggy Bank', category: 'money', svg: PiggyBank as unknown as string },
  { slug: 'trending-up', label: 'Trending Up', category: 'money', svg: TrendingUp as unknown as string },
  { slug: 'trending-down', label: 'Trending Down', category: 'money', svg: TrendingDown as unknown as string },
  { slug: 'briefcase', label: 'Briefcase', category: 'money', svg: Briefcase as unknown as string },

  // Media
  { slug: 'play', label: 'Play', category: 'media', svg: Play as unknown as string },
  { slug: 'pause', label: 'Pause', category: 'media', svg: Pause as unknown as string },
  { slug: 'film', label: 'Film', category: 'media', svg: Film as unknown as string },
  { slug: 'music', label: 'Music', category: 'media', svg: Music as unknown as string },
  { slug: 'image', label: 'Image', category: 'media', svg: ImageIcon as unknown as string },
  { slug: 'camera', label: 'Camera', category: 'media', svg: Camera as unknown as string },
  { slug: 'headphones', label: 'Headphones', category: 'media', svg: Headphones as unknown as string },

  // People
  { slug: 'user', label: 'User', category: 'people', svg: User as unknown as string },
  { slug: 'users', label: 'Group', category: 'people', svg: Users as unknown as string },
  { slug: 'smile', label: 'Smile', category: 'people', svg: Smile as unknown as string },
  { slug: 'frown', label: 'Frown', category: 'people', svg: Frown as unknown as string },
  { slug: 'heart', label: 'Heart', category: 'people', svg: Heart as unknown as string },
  { slug: 'brain', label: 'Brain', category: 'people', svg: Brain as unknown as string },
  { slug: 'baby', label: 'Baby', category: 'people', svg: Baby as unknown as string },

  // Web / social
  { slug: 'globe', label: 'Globe', category: 'web', svg: Globe as unknown as string },
  { slug: 'cloud', label: 'Cloud', category: 'web', svg: Cloud as unknown as string },
  { slug: 'link', label: 'Link', category: 'web', svg: Link as unknown as string },
  // GitHub / Twitter / YouTube / Instagram / LinkedIn entries removed —
  // lucide-static dropped brand icons for trademark reasons. Re-add via
  // inline SVG strings (not lucide-static imports) when bringing them back.

  // Common UI
  { slug: 'home', label: 'Home', category: 'common', svg: Home as unknown as string },
  { slug: 'settings', label: 'Settings', category: 'common', svg: Settings as unknown as string },
  { slug: 'search', label: 'Search', category: 'common', svg: Search as unknown as string },
  { slug: 'star', label: 'Star', category: 'common', svg: Star as unknown as string },
  { slug: 'check', label: 'Check', category: 'common', svg: Check as unknown as string },
  { slug: 'x', label: 'X', category: 'common', svg: X as unknown as string },
  { slug: 'plus', label: 'Plus', category: 'common', svg: Plus as unknown as string },
  { slug: 'minus', label: 'Minus', category: 'common', svg: Minus as unknown as string },
  { slug: 'info', label: 'Info', category: 'common', svg: Info as unknown as string },
  { slug: 'calendar', label: 'Calendar', category: 'common', svg: Calendar as unknown as string },
  { slug: 'clock', label: 'Clock', category: 'common', svg: Clock as unknown as string },
  { slug: 'map-pin', label: 'Pin', category: 'common', svg: MapPin as unknown as string },

  // Nature
  { slug: 'zap', label: 'Lightning', category: 'nature', svg: Zap as unknown as string },
  { slug: 'flame', label: 'Flame', category: 'nature', svg: Flame as unknown as string },
  { slug: 'droplet', label: 'Drop', category: 'nature', svg: Droplet as unknown as string },
  { slug: 'leaf', label: 'Leaf', category: 'nature', svg: Leaf as unknown as string },
  { slug: 'sun', label: 'Sun', category: 'nature', svg: Sun as unknown as string },
  { slug: 'moon', label: 'Moon', category: 'nature', svg: Moon as unknown as string },
  { slug: 'snowflake', label: 'Snowflake', category: 'nature', svg: Snowflake as unknown as string },
  { slug: 'cloud-rain', label: 'Rain', category: 'nature', svg: CloudRain as unknown as string },

  // Misc punch
  { slug: 'gift', label: 'Gift', category: 'misc', svg: Gift as unknown as string },
  { slug: 'package', label: 'Package', category: 'misc', svg: Package as unknown as string },
  { slug: 'box', label: 'Box', category: 'misc', svg: Box as unknown as string },
  { slug: 'trash', label: 'Trash', category: 'misc', svg: Trash as unknown as string },
  { slug: 'trash-2', label: 'Trash Solid', category: 'misc', svg: Trash2 as unknown as string },
  { slug: 'rocket', label: 'Rocket', category: 'misc', svg: Rocket as unknown as string },
  { slug: 'sparkles', label: 'Sparkles', category: 'misc', svg: Sparkles as unknown as string },
  { slug: 'target', label: 'Target', category: 'misc', svg: Target as unknown as string },
  { slug: 'trophy', label: 'Trophy', category: 'misc', svg: Trophy as unknown as string },
  { slug: 'crown', label: 'Crown', category: 'misc', svg: Crown as unknown as string },
  { slug: 'skull', label: 'Skull', category: 'misc', svg: Skull as unknown as string },
  { slug: 'ghost', label: 'Ghost', category: 'misc', svg: Ghost as unknown as string },
];

/** Display labels for each category. The picker uses these as group
 *  headers so the user sees "Security" instead of the raw `security`
 *  slug. */
export const CATEGORY_LABELS: Record<IconCategory, string> = {
  tech: 'Tech',
  security: 'Security',
  communication: 'Communication',
  money: 'Money',
  media: 'Media',
  people: 'People',
  web: 'Web & Social',
  common: 'Common',
  nature: 'Nature',
  misc: 'Punch',
};

/** Display order for the picker — biased so the visually-punchy
 *  categories sit near the top (common UI icons last). Matches what
 *  the reference channels lean on most. */
export const CATEGORY_ORDER: readonly IconCategory[] = [
  'security',
  'tech',
  'misc',
  'money',
  'communication',
  'people',
  'web',
  'media',
  'nature',
  'common',
];

// ─── Registry lookups ───────────────────────────────────────────────────────

const REGISTRY_BY_SLUG = new Map<string, IconEntry>(
  ICON_REGISTRY.map((entry) => [entry.slug, entry]),
);

/** Resolve a slug to its full registry entry. Returns null for unknown
 *  slugs (composer + picker treat this as "fall back to text-only"). */
export function getIconEntry(slug: string): IconEntry | null {
  return REGISTRY_BY_SLUG.get(slug) ?? null;
}

/** Raw SVG string for a slug — the wrapped `<svg viewBox="0 0 24 24">…</svg>`
 *  exactly as lucide-static exports it. Composer calls
 *  `extractIconInner` to strip the wrapper before embedding. */
export function getIconSvg(slug: string): string | null {
  return REGISTRY_BY_SLUG.get(slug)?.svg ?? null;
}

// ─── SVG body extraction ────────────────────────────────────────────────────

/**
 * Lucide icons are exported as a full `<svg …>…</svg>` string. The
 * composer wants only the inner XML (paths, circles, lines) so it can
 * re-wrap with its own width/height/stroke colour for the target cell.
 *
 * Conservative tag-scan rather than a full XML parser: every Lucide
 * icon has the same shape (`<svg …>inner</svg>`), so the slice between
 * the closing `>` of the opening tag and the opening `<` of the
 * closing tag is exactly the inner content.
 *
 * Returns empty string on any malformed input — defensive so a bad
 * icon entry produces an empty shape rather than a SVG parse error
 * at composition time.
 */
export function extractIconInner(svg: string): string {
  if (typeof svg !== 'string') return '';
  const openClose = svg.indexOf('>');
  const closeOpen = svg.lastIndexOf('</svg>');
  if (openClose < 0 || closeOpen < 0 || closeOpen <= openClose) return '';
  return svg.slice(openClose + 1, closeOpen);
}

/**
 * Build the inline SVG markup for an icon, sized + coloured for a
 * specific cell. The composer calls this when emitting per-cell SVG
 * for both the server pipeline and any future client-side preview.
 *
 * Embeds the icon at the given pixel size centred at (cx, cy). The
 * Lucide default stroke colour is `currentColor`; we override with
 * an explicit colour so the icon matches the configured ring/label
 * colour scheme regardless of the parent SVG's `color` attribute.
 */
export function inlineIconSvg(
  slug: string,
  cx: number,
  cy: number,
  size: number,
  strokeColor: string,
  strokeWidth: number,
): string {
  const inner = extractIconInner(getIconSvg(slug) ?? '');
  if (!inner) return '';
  const half = size / 2;
  // Wrap the icon's inner XML in a transformed group so the
  // 24-unit viewBox scales to the requested pixel size and positions
  // at (cx, cy). Stroke colour + width are forced via attributes on
  // the group (Lucide's inner paths use `stroke="currentColor"` so
  // overriding via attribute on a parent group cascades correctly).
  const scale = size / 24;
  const tx = cx - half;
  const ty = cy - half;
  return `<g transform="translate(${tx} ${ty}) scale(${scale})" stroke="${strokeColor}" stroke-width="${strokeWidth / scale}" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
}
