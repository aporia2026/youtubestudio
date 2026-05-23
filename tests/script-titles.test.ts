import { describe, expect, it } from 'vitest';
import { extractScriptTitles, TITLE_SENTINEL_LEAK_RE } from '@/lib/script-titles';

describe('extractScriptTitles', () => {
  it('detects a single `##Title` (no space)', () => {
    const r = extractScriptTitles('Some intro.\n##TrickBot\nAfter the title.');
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0].text).toBe('TrickBot');
    expect(r.titles[0].sentinel).toBe('<<TITLE_0>>');
    expect(r.stripped).toBe('Some intro.\n<<TITLE_0>>\nAfter the title.');
    expect(r.warnings).toEqual([]);
  });

  it('detects `## Title` (with space)', () => {
    const r = extractScriptTitles('Intro.\n## With Space\nBody.');
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0].text).toBe('With Space');
  });

  it('detects titles with internal whitespace and numerics', () => {
    const r = extractScriptTitles('Intro.\n##Wana Decrypt0r 2.0\nBody.');
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0].text).toBe('Wana Decrypt0r 2.0');
  });

  it('rejects `### Subheading` (h3, not h2)', () => {
    const r = extractScriptTitles('Intro.\n### NotATitle\nBody.');
    expect(r.titles).toHaveLength(0);
    expect(r.stripped).toContain('### NotATitle');
  });

  it('rejects `#### h4` and deeper', () => {
    const r = extractScriptTitles('#### NotATitle\nBody.');
    expect(r.titles).toHaveLength(0);
  });

  it('rejects `## ` followed by nothing (empty heading)', () => {
    const r = extractScriptTitles('Intro.\n## \nBody.');
    expect(r.titles).toHaveLength(0);
  });

  it('strips trailing whitespace from the heading text', () => {
    const r = extractScriptTitles('##Padded   \nBody.');
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0].text).toBe('Padded');
  });

  it('treats `##Title` at the very start of the script as a title', () => {
    const r = extractScriptTitles('##First\nBody.');
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0].text).toBe('First');
    expect(r.stripped.startsWith('<<TITLE_0>>')).toBe(true);
  });

  it('does NOT detect `##` mid-line', () => {
    const r = extractScriptTitles('A sentence with ##NotATitle inside it.');
    expect(r.titles).toHaveLength(0);
  });

  it('skips `##` inside a fenced code block', () => {
    const script = [
      'Intro.',
      '```',
      '##InsideCode',
      '```',
      '##OutsideCode',
      'Body.',
    ].join('\n');
    const r = extractScriptTitles(script);
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0].text).toBe('OutsideCode');
  });

  it('caps at 50 titles and warns when exceeded', () => {
    const lines: string[] = [];
    for (let i = 0; i < 55; i++) lines.push(`##H${i}`, `body ${i}`);
    const r = extractScriptTitles(lines.join('\n'));
    expect(r.titles).toHaveLength(50);
    expect(r.warnings.some(w => w.includes('more than 50'))).toBe(true);
    // Headings beyond the cap survive in the stripped text as plain `##`.
    expect(r.stripped).toContain('##H50');
  });

  it('truncates titles longer than 200 chars and warns', () => {
    const long = 'X'.repeat(250);
    const r = extractScriptTitles(`##${long}\nBody.`);
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0].text).toHaveLength(200);
    expect(r.warnings.some(w => w.includes('truncated'))).toBe(true);
  });

  it('scrubs pre-existing <<TITLE_N>> markers from input', () => {
    const r = extractScriptTitles('Foo <<TITLE_0>> bar.');
    expect(r.titles).toHaveLength(0);
    expect(r.stripped).not.toMatch(TITLE_SENTINEL_LEAK_RE);
    expect(r.warnings.some(w => w.includes('pre-existing'))).toBe(true);
  });

  it('numbers sentinels sequentially across multiple titles', () => {
    const r = extractScriptTitles('##A\nbody A\n##B\nbody B\n##C\nbody C');
    expect(r.titles.map(t => t.sentinel)).toEqual([
      '<<TITLE_0>>',
      '<<TITLE_1>>',
      '<<TITLE_2>>',
    ]);
    expect(r.titles.map(t => t.text)).toEqual(['A', 'B', 'C']);
  });

  // ─── Regression fixture ────────────────────────────────────────────────────
  // The user's exact 6-title script that exposed the bug.
  // Before this fix: production-doc generator detected #1 but silently dropped
  // #3 (TrickBot) and likely others. After: all six must be extracted.
  it('regression: extracts all six titles from the WannaCry/NotPetya/TrickBot/Ryuk/Conti/REvil script', () => {
    const script = FIXTURE_SIX_TITLE_SCRIPT;
    const r = extractScriptTitles(script);
    expect(r.titles.map(t => t.text)).toEqual([
      'Wana Decrypt0r 2.0',
      'NotPetya',
      'TrickBot',
      'Ryuk',
      'Conti',
      'REvil',
    ]);
    // Each heading line is replaced by its sentinel; original `##` lines gone.
    expect(r.stripped).not.toMatch(/^##/m);
    // Every sentinel appears exactly once in the stripped output.
    for (const t of r.titles) {
      const count = r.stripped.split(t.sentinel).length - 1;
      expect(count).toBe(1);
    }
    expect(r.warnings).toEqual([]);
  });
});

// Trimmed-down version of the user's actual failing script. Keeps every
// `##Heading` line and one paragraph of context per section so the fixture
// stays scoped to title-detection behavior, not narrative content.
const FIXTURE_SIX_TITLE_SCRIPT = `[VISUAL CUE: Authentic screen recording of Wana Decrypt0r 2.0 window popping up.]

##Wana Decrypt0r 2.0
May 12, 2017. British hospitals lose access to patient scans. Manufacturing plants stall out. Screens lock across 150 countries.

A month earlier, the Shadow Brokers had dumped a classified NSA cyberweapon onto the public internet.

[PAUSE] [VISUAL CUE: Transition to Ukrainian flag glitching into black screens.]

##NotPetya
June 27, 2017. Ukrainian accountants open M.E.Doc, the country's standard tax software, and install a routine update.

The update is a weapon.

[PAUSE] [SFX: Digital lock clicking shut] [VISUAL CUE: Banking trojans spreading like a neural network.]

##TrickBot
TrickBot appeared in 2016 as a banking trojan. At first, it injected malicious scripts into web browsers and stole financial credentials from ordinary users.

What began as banking malware turned into a modular access platform.

[PAUSE] [VISUAL CUE: Phishing email open, Ryuk skull icon spreading.]

##Ryuk
Ryuk surfaced in 2018. It was not a worm. It did not spray itself blindly across the internet.

TrickBot opened the door. Cobalt Strike kept it open. Ryuk came in last.

[PAUSE] [SFX: Alarm siren fading into hospital monitors] [VISUAL CUE: Conti logo morphing from TrickBot code.]

##Conti
By 2020, Ryuk was fading. Wizard Spider was not. The syndicate retired one brand and built another: Conti.

Conti inherited the access, the tooling, and the operators.

[PAUSE] [SFX: Chain reaction explosion sound] [VISUAL CUE: Kaseya logo cracking, MSP icons cascading like dominoes.]

##REvil
July 2, 2021. The attackers skip individual companies and go straight for the companies that manage them.

The target is Kaseya VSA, a remote monitoring and management platform used by managed service providers around the world.`;
