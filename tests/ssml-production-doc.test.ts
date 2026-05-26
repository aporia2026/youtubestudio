import { describe, expect, it } from 'vitest';
import { isSsml, preprocessSsmlForProductionDoc } from '@/lib/ssml-production-doc';

describe('isSsml — detector', () => {
  it('detects <speak> at the start', () => {
    expect(isSsml('<speak>Hello</speak>')).toBe(true);
    expect(isSsml('   <speak version="1.0">Hello</speak>')).toBe(true);
  });
  it('detects <break> tags without an outer <speak>', () => {
    expect(isSsml('Hello. <break time="1s"/> World.')).toBe(true);
  });
  it('does not flag plain text with stray angle brackets', () => {
    expect(isSsml('5 > 3 < 4 in plain prose')).toBe(false);
    expect(isSsml('Just regular narration text.')).toBe(false);
  });
});

describe('preprocessSsmlForProductionDoc — plain text pass-through', () => {
  it('returns the script unchanged when not SSML', () => {
    const r = preprocessSsmlForProductionDoc('Just plain narration. Two sentences.');
    expect(r.wasSsml).toBe(false);
    expect(r.cleanScript).toBe('Just plain narration. Two sentences.');
    expect(r.sections).toEqual([]);
  });
});

describe('preprocessSsmlForProductionDoc — section extraction', () => {
  it('splits on <break time="2s"/> as section boundary', () => {
    const input = `<speak>
First section content. More of it.
<break time="2s"/>
Second section content.
<break time="2s"/>
Third section.
</speak>`;
    const r = preprocessSsmlForProductionDoc(input);
    expect(r.wasSsml).toBe(true);
    expect(r.sections).toHaveLength(3);
    expect(r.sections[0]).toContain('First section content');
    expect(r.sections[1]).toContain('Second section content');
    expect(r.sections[2]).toContain('Third section');
  });

  it('treats <break time="1.5s"/> as a section boundary (≥1.5s default)', () => {
    const input = '<speak>A <break time="1.5s"/> B <break time="2s"/> C</speak>';
    const r = preprocessSsmlForProductionDoc(input);
    expect(r.sections).toEqual(['A', 'B', 'C']);
  });

  it('keeps sub-second breaks inside their section (not section boundaries)', () => {
    const input = `<speak>
First part with subtle pause <break time="500ms"/> and continuation.
<break time="2s"/>
Second section.
</speak>`;
    const r = preprocessSsmlForProductionDoc(input);
    expect(r.sections).toHaveLength(2);
    expect(r.sections[0]).toContain('First part with subtle pause');
    expect(r.sections[0]).toContain('and continuation');
    expect(r.sections[1]).toBe('Second section.');
  });

  it('also splits on time="1s" when threshold lowered (custom sectionBreakSeconds)', () => {
    const input = '<speak>A <break time="1s"/> B</speak>';
    const defaultResult = preprocessSsmlForProductionDoc(input);
    expect(defaultResult.sections).toEqual(['A B']);    // 1s < 1.5s default
    const explicit = preprocessSsmlForProductionDoc(input, { sectionBreakSeconds: 1 });
    expect(explicit.sections).toEqual(['A', 'B']);      // 1s ≥ 1s
  });
});

describe('preprocessSsmlForProductionDoc — tag stripping', () => {
  it('strips every SSML tag from the cleaned script', () => {
    const input = `<speak>
Hessdalen Lights.<break time="1s"/>
Hessdalen Valley, Norway. Lights consistently appear.
<break time="2s"/>
The Phoenix Lights.<break time="1s"/>
On March 13, 1997.
</speak>`;
    const r = preprocessSsmlForProductionDoc(input);
    expect(r.cleanScript).not.toContain('<speak>');
    expect(r.cleanScript).not.toContain('<break');
    expect(r.cleanScript).not.toContain('</speak>');
    expect(r.cleanScript).toContain('Hessdalen Lights');
    expect(r.cleanScript).toContain('Phoenix Lights');
  });

  it('builds cleanScript by joining sections with paragraph breaks', () => {
    const input = '<speak>A <break time="2s"/> B <break time="2s"/> C</speak>';
    const r = preprocessSsmlForProductionDoc(input);
    expect(r.cleanScript).toBe('A\n\nB\n\nC');
  });
});

describe('preprocessSsmlForProductionDoc — realistic 27-section narration', () => {
  it("handles the user's reported 27-section script structure", () => {
    const section = (title: string, body: string) =>
      `${title}.<break time="1s"/>\n${body}`;
    const sections = [
      section('Hessdalen Lights', 'Lights appear in Norway.'),
      section('The Phoenix Lights', 'Reported in 1997 across Arizona.'),
      section('Dyatlov Pass', 'Nine hikers died in 1959.'),
      section('Bermuda Triangle', 'Statistical exaggeration of losses.'),
      section('Foo Fighters', 'Pilots saw glowing objects in WWII.'),
    ];
    const input = `<speak>\n${sections.join('\n\n<break time="2s"/>\n\n')}\n</speak>`;
    const r = preprocessSsmlForProductionDoc(input);
    expect(r.wasSsml).toBe(true);
    expect(r.sections).toHaveLength(5);
    expect(r.sections[0]).toMatch(/^Hessdalen Lights/);
    expect(r.sections[4]).toMatch(/^Foo Fighters/);
    // Sub-second `<break time="1s"/>` AFTER each title stays inside
    // its section — the title's pause-before-body is preserved as
    // part of the section content for the LLM's row-text decision.
    for (const s of r.sections) {
      expect(s).not.toContain('<');
      expect(s).not.toContain('>');
    }
  });
});
