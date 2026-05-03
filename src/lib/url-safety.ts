/**
 * SSRF-safe URL validation.
 *
 * Anything the server `fetch()`-es on behalf of an authenticated
 * user (publishing source MP4s, generic webhook URLs, future
 * thumbnail uploads from arbitrary URLs, etc.) MUST go through
 * `assertSafePublicUrl()` first. Without it, an authenticated user
 * can pivot the server into making requests to:
 *
 *   - localhost / 127.0.0.1   → other internal services on the box
 *   - 10.0.0.0/8 + 192.168/16 + 172.16-31/12 → corporate intranet
 *   - 169.254.169.254          → AWS / Azure / GCP cloud metadata
 *                                (steals IAM credentials)
 *   - 100.64.0.0/10            → CGNAT
 *   - fc00::/7 + fe80::/10     → IPv6 private + link-local
 *   - .internal / .local       → DNS-rewritten internal services
 *
 * Pure helper — no DB, no network deps. The IPv4/IPv6 range checks
 * are unit-tested.
 *
 * NOTE: This validates the URL string. A determined attacker can
 * still defeat host-based checks via DNS rebinding (the hostname
 * resolves to a public IP at validation time, then mutates to a
 * private IP at fetch time). For higher-stakes use, also pin to
 * the resolved IP between validation and fetch — out of scope here.
 */

export type UrlSafetyResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

/** Hosts that should never receive a server-initiated fetch. */
const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '169.254.169.254',  // AWS / Azure / GCP IMDS
  'metadata.google.internal',
  'metadata.azure.com',
]);

const BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost'];

interface CheckOptions {
  /** When set, only allow URLs whose hostname is in this allowlist
   *  (after the SSRF block list). Used by webhook validation to
   *  pin Slack/Discord URLs to their respective hosts. */
  allowedHosts?: ReadonlySet<string>;
  /** Defaults to ['http:', 'https:']. The publishing source-video
   *  fetch may want to enforce 'https:' only. */
  allowedProtocols?: ReadonlyArray<string>;
}

export function checkSafePublicUrl(raw: string, opts: CheckOptions = {}): UrlSafetyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'Not a valid URL.' };
  }

  const protocols = opts.allowedProtocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) {
    return { ok: false, error: `URL protocol must be one of: ${protocols.join(', ')}.` };
  }

  // Strip surrounding brackets that URL.hostname leaves on IPv6.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, error: 'URL has no hostname.' };

  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, error: 'URL points to a blocked host.' };
  }
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, error: 'URL points to a private/internal hostname.' };
  }

  // IPv4 literal check.
  const ipv4 = parseIpv4(host);
  if (ipv4 && isPrivateOrSpecialIpv4(ipv4)) {
    return { ok: false, error: 'URL resolves to a private/internal IPv4 address.' };
  }

  // IPv6 literal check.
  if (host.includes(':')) {
    if (isPrivateOrSpecialIpv6(host)) {
      return { ok: false, error: 'URL resolves to a private/internal IPv6 address.' };
    }
  }

  if (opts.allowedHosts && !opts.allowedHosts.has(host)) {
    return { ok: false, error: `URL host must be one of: ${[...opts.allowedHosts].join(', ')}.` };
  }

  return { ok: true, url };
}

/** Throwing variant — convenient for `await fetch()` paths. */
export function assertSafePublicUrl(raw: string, opts: CheckOptions = {}): URL {
  const r = checkSafePublicUrl(raw, opts);
  if (!r.ok) throw new Error(r.error);
  return r.url;
}

// ─── Pure IP-range helpers (exported for tests) ────────────────────────

/** Parse an IPv4 literal like "192.168.0.1" → [192,168,0,1] or null. */
export function parseIpv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

/** True for any IPv4 address that should never receive a
 *  server-initiated fetch. Covers loopback, private (RFC1918),
 *  link-local, CGNAT, multicast, broadcast, this-network, IMDS. */
export function isPrivateOrSpecialIpv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  if (a === 0) return true;                                  // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                 // 10.0.0.0/8 RFC1918
  if (a === 127) return true;                                // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;                   // 169.254.0.0/16 link-local + IMDS
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true;                   // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64.0.0/10 CGNAT
  if (a >= 224 && a <= 239) return true;                     // 224.0.0.0/4 multicast
  if (a >= 240) return true;                                 // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/** True for any IPv6 address that should never receive a
 *  server-initiated fetch. Pure-string matching — fast enough and
 *  keeps the helper dependency-free. Covers loopback, link-local,
 *  unique-local, IPv4-mapped/translated.
 *
 *  Note: Node's URL parser normalises `::ffff:127.0.0.1` to the
 *  compressed hex form `::ffff:7f00:1`, so we have to handle both
 *  the dotted-quad and the hex-pair representations. */
export function isPrivateOrSpecialIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;                // unspecified + loopback
  if (h.startsWith('fe80:') || h.startsWith('fe80::')) return true;  // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;             // unique-local fc00::/7

  // IPv4-mapped IPv6 in dotted-quad form: ::ffff:a.b.c.d
  const mappedDotted = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    const ip = parseIpv4(mappedDotted[1]);
    return !ip || isPrivateOrSpecialIpv4(ip);
  }

  // IPv4-mapped IPv6 in compressed hex-pair form: ::ffff:HHHH:HHHH
  // The last two 16-bit groups encode the four IPv4 octets.
  const mappedHex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      const ip: [number, number, number, number] = [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
      ];
      return isPrivateOrSpecialIpv4(ip);
    }
  }

  return false;
}
