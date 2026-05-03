import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  checkSafePublicUrl,
  assertSafePublicUrl,
  parseIpv4,
  isPrivateOrSpecialIpv4,
  isPrivateOrSpecialIpv6,
  resolveAndPinSafeUrl,
} from '@/lib/url-safety';

// Hoisted mock of node:dns/promises so resolveAndPinSafeUrl's lazy
// `import('node:dns/promises')` call hits a stub instead of the real
// resolver. The mock has to be hoisted so vi.mock runs before the
// dynamic import inside the helper.
const dnsMock = vi.hoisted(() => ({
  lookup: vi.fn(),
}));
vi.mock('node:dns/promises', () => dnsMock);

describe('parseIpv4', () => {
  it('parses well-formed dotted-quad', () => {
    expect(parseIpv4('192.168.0.1')).toEqual([192, 168, 0, 1]);
    expect(parseIpv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
    expect(parseIpv4('255.255.255.255')).toEqual([255, 255, 255, 255]);
  });
  it('rejects out-of-range octets', () => {
    expect(parseIpv4('256.0.0.1')).toBeNull();
    expect(parseIpv4('-1.0.0.0')).toBeNull();
  });
  it('rejects malformed inputs', () => {
    expect(parseIpv4('')).toBeNull();
    expect(parseIpv4('not.an.ip.addr')).toBeNull();
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
  });
});

describe('isPrivateOrSpecialIpv4', () => {
  it.each([
    [[0, 0, 0, 0], true, 'this-network'],
    [[10, 1, 2, 3], true, 'RFC1918 10/8'],
    [[127, 0, 0, 1], true, 'loopback'],
    [[169, 254, 169, 254], true, 'AWS IMDS'],
    [[169, 254, 1, 2], true, 'link-local'],
    [[172, 15, 0, 1], false, '172.15 is public'],
    [[172, 16, 0, 1], true, 'RFC1918 172.16/12 lower bound'],
    [[172, 31, 255, 255], true, 'RFC1918 172.16/12 upper bound'],
    [[172, 32, 0, 1], false, '172.32 is public'],
    [[192, 168, 1, 1], true, 'RFC1918 192.168/16'],
    [[100, 64, 0, 1], true, 'CGNAT lower bound'],
    [[100, 127, 255, 255], true, 'CGNAT upper bound'],
    [[100, 128, 0, 1], false, '100.128 is public'],
    [[224, 0, 0, 1], true, 'multicast'],
    [[239, 255, 255, 255], true, 'multicast upper'],
    [[240, 0, 0, 1], true, 'reserved'],
    [[255, 255, 255, 255], true, 'broadcast'],
    [[1, 1, 1, 1], false, 'public CF DNS'],
    [[8, 8, 8, 8], false, 'public Google DNS'],
    [[203, 0, 113, 5], false, 'TEST-NET-3 documentation range — technically reserved but not private'],
  ] as const)('%p → %s (%s)', (ip, expected, _label) => {
    expect(isPrivateOrSpecialIpv4(ip as [number, number, number, number])).toBe(expected);
  });
});

describe('isPrivateOrSpecialIpv6', () => {
  it.each([
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fe80:0:0:0:0:0:0:1', true],
    ['fc00::1', true],
    ['fd12:3456:789a:1::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:192.168.1.1', true],
    ['::ffff:8.8.8.8', false],
    ['2001:4860:4860::8888', false],
    // Phase 8.6.1 — coverage gaps surfaced by the Phase 8 review.
    ['0:0:0:0:0:0:0:1', true],                           // fully expanded loopback
    ['0:0:0:0:0:0:0:0', true],                           // fully expanded unspecified
    ['0:0:0:0:0:ffff:127.0.0.1', true],                  // expanded IPv4-mapped, dotted
    ['0:0:0:0:0:ffff:7f00:1', true],                     // expanded IPv4-mapped, hex-pair (= 127.0.0.1)
    ['::1.2.3.4', false],                                // IPv4-compatible legacy form pointing at public IP
    ['::127.0.0.1', true],                               // IPv4-compatible legacy form pointing at loopback
    ['::169.254.169.254', true],                         // IPv4-compatible legacy form pointing at IMDS
    ['64:ff9b::8.8.8.8', true],                          // NAT64 well-known prefix
    ['64:ff9b:1::1', true],                              // NAT64 RFC8215 local prefix
    ['fe80::1%eth0', true],                              // zone-suffix variant
    ['FE80::1', true],                                   // uppercase link-local
    ['FC00::1', true],                                   // uppercase unique-local
  ])('%s → %s', (host, expected) => {
    expect(isPrivateOrSpecialIpv6(host)).toBe(expected);
  });
});

describe('checkSafePublicUrl', () => {
  it('accepts a normal https URL', () => {
    const r = checkSafePublicUrl('https://example.com/foo.mp4');
    expect(r.ok).toBe(true);
  });
  it('accepts a normal http URL by default', () => {
    expect(checkSafePublicUrl('http://example.com').ok).toBe(true);
  });
  it('rejects a non-URL string', () => {
    const r = checkSafePublicUrl('not a url');
    expect(r.ok).toBe(false);
  });
  it('rejects file: protocol', () => {
    const r = checkSafePublicUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
  });
  it('rejects data: URLs', () => {
    expect(checkSafePublicUrl('data:image/png;base64,xxx').ok).toBe(false);
  });
  it('rejects ftp:', () => {
    expect(checkSafePublicUrl('ftp://example.com').ok).toBe(false);
  });
  it('rejects loopback IPv4 literal', () => {
    expect(checkSafePublicUrl('http://127.0.0.1/admin').ok).toBe(false);
  });
  it('rejects AWS IMDS literal', () => {
    const r = checkSafePublicUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/blocked|private|internal/);
  });
  it('rejects RFC1918 ranges', () => {
    expect(checkSafePublicUrl('http://10.0.0.1').ok).toBe(false);
    expect(checkSafePublicUrl('http://192.168.1.1').ok).toBe(false);
    expect(checkSafePublicUrl('http://172.20.0.5').ok).toBe(false);
  });
  it('rejects "localhost" hostname literal', () => {
    expect(checkSafePublicUrl('http://localhost:3000/foo').ok).toBe(false);
  });
  it('rejects .internal / .local suffixes', () => {
    expect(checkSafePublicUrl('http://api.internal/foo').ok).toBe(false);
    expect(checkSafePublicUrl('http://printer.local').ok).toBe(false);
    expect(checkSafePublicUrl('http://something.localhost').ok).toBe(false);
  });
  it('rejects bare IPv6 loopback', () => {
    expect(checkSafePublicUrl('http://[::1]/foo').ok).toBe(false);
  });
  it('rejects IPv6 link-local', () => {
    expect(checkSafePublicUrl('http://[fe80::1]/foo').ok).toBe(false);
  });
  it('rejects IPv4-mapped IPv6 to a private IP', () => {
    expect(checkSafePublicUrl('http://[::ffff:127.0.0.1]').ok).toBe(false);
  });
  it('rejects cloud metadata DNS aliases', () => {
    expect(checkSafePublicUrl('http://metadata.google.internal/').ok).toBe(false);
  });
  it('honours allowedProtocols when provided', () => {
    const r = checkSafePublicUrl('http://example.com', { allowedProtocols: ['https:'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https:/);
  });
  it('honours allowedHosts when provided', () => {
    const r = checkSafePublicUrl('https://example.com', {
      allowedHosts: new Set(['hooks.slack.com']),
    });
    expect(r.ok).toBe(false);
    expect(checkSafePublicUrl('https://hooks.slack.com/services/x/y/z', {
      allowedHosts: new Set(['hooks.slack.com']),
    }).ok).toBe(true);
  });

  it('hostname-comparison is case-insensitive', () => {
    expect(checkSafePublicUrl('http://LocalHost').ok).toBe(false);
    expect(checkSafePublicUrl('http://API.Internal').ok).toBe(false);
  });
});

describe('assertSafePublicUrl', () => {
  it('returns the URL on success', () => {
    const u = assertSafePublicUrl('https://example.com/x');
    expect(u.hostname).toBe('example.com');
  });
  it('throws on failure', () => {
    expect(() => assertSafePublicUrl('http://127.0.0.1')).toThrow(/private|blocked/);
  });
});

describe('resolveAndPinSafeUrl', () => {
  beforeEach(() => {
    dnsMock.lookup.mockReset();
  });

  it('returns a dispatcher when every resolved address is public', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const result = await resolveAndPinSafeUrl('https://example.com/foo.mp4', {
      allowedProtocols: ['https:'],
    });
    expect(result.url.hostname).toBe('example.com');
    expect(result.dispatcher).toBeDefined();
    expect(dnsMock.lookup).toHaveBeenCalledWith('example.com', { all: true });
  });

  it('throws when DNS resolves to a private IPv4 (rebinding defence)', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(resolveAndPinSafeUrl('https://malicious.example/')).rejects.toThrow(
      /private\/internal IPv4 \(127\.0\.0\.1\)/,
    );
  });

  it('throws when DNS resolves to AWS IMDS (rebinding defence)', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(resolveAndPinSafeUrl('https://malicious.example/')).rejects.toThrow(
      /169\.254\.169\.254/,
    );
  });

  it('rejects when ANY resolved address is private (mixed A records)', async () => {
    // Public + private mix — must reject. An attacker who publishes
    // both records can have the resolver pick the private one at fetch.
    dnsMock.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(resolveAndPinSafeUrl('https://malicious.example/')).rejects.toThrow(
      /private\/internal IPv4 \(10\.0\.0\.1\)/,
    );
  });

  it('rejects when DNS resolves to a private IPv6', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: 'fe80::1', family: 6 }]);
    await expect(resolveAndPinSafeUrl('https://malicious.example/')).rejects.toThrow(
      /private\/internal IPv6/,
    );
  });

  it('skips DNS when the host is already a literal IPv4', async () => {
    const result = await resolveAndPinSafeUrl('https://1.1.1.1/foo');
    expect(result.url.hostname).toBe('1.1.1.1');
    expect(dnsMock.lookup).not.toHaveBeenCalled();
  });

  it('still rejects literal private IPs at the synchronous gate (no DNS attempted)', async () => {
    await expect(resolveAndPinSafeUrl('https://127.0.0.1/')).rejects.toThrow(
      /private\/internal/,
    );
    expect(dnsMock.lookup).not.toHaveBeenCalled();
  });

  it('wraps DNS errors so the caller can show a useful message', async () => {
    dnsMock.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(resolveAndPinSafeUrl('https://does-not-exist.example/')).rejects.toThrow(
      /DNS resolution failed.*ENOTFOUND/,
    );
  });

  it('rejects when DNS returns an empty address list', async () => {
    dnsMock.lookup.mockResolvedValue([]);
    await expect(resolveAndPinSafeUrl('https://example.com/')).rejects.toThrow(
      /no addresses/,
    );
  });
});
