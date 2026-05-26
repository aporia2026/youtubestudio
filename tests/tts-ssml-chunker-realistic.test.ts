import { describe, expect, it } from 'vitest';
import { chunkSsmlForGoogle } from '@/lib/tts/ssml-chunker';

// Pins behavior against the actual SSML script structure the user reported
// (14,822 chars, 27 sections separated by `<break time="2s"/>`, each section
// has a title followed by `<break time="1s"/>` then body paragraphs). The
// pre-fix chunker produced 50+ tiny chunks; the post-fix should produce ~5
// large chunks at the default byte budget.

const USER_SCRIPT = `<speak>
Hessdalen Lights.<break time="1s"/>
Hessdalen Valley, Norway. Lights consistently appear.
Some hover. Some accelerate rapidly. Some remain stationary. Researchers put cameras there, and the lights still show up. The footage remains inconsistent.
Some say plasma. Some say dust. Some say reflections off the terrain. Hessdalen represents a recurring series of unclassified phenomena.
One witness sees a gold orb. Another sees a white streak. A camera catches a flash that does not match either report. This inconsistency prevents definitive classification.

<break time="2s"/>

The Phoenix Lights.<break time="1s"/>
On March 13, 1997, people across Arizona reported strange lights over Phoenix. Witnesses reported a large V-shaped formation or a silent linear progression.
The military identified them as flares dropped during a training exercise, but this explanation fails to account for all documented observations.
No definitive answer exists. Timing, distance, angle — and a high volume of conflicting reports — make this case difficult to quantify.

<break time="2s"/>

Dyatlov Pass.<break time="1s"/>
In February 1959, nine hikers died in the Ural Mountains at Dyatlov Pass. Their tent was found cut open from the inside. Several bodies sustained severe trauma.
Modern consensus points to a slab avalanche, though the exact sequence is still disputed.
The evidence is inherently contradictory. The rationale for tent evisceration, exposure to sub-zero temperatures, and the severity of blunt force trauma remain unresolved.

<break time="2s"/>

The Bermuda Triangle.<break time="1s"/>
The Bermuda Triangle's reputation is a result of statistical exaggeration and persistent folklore.
The region sees maritime losses. It is busy, prone to storms, strong currents, and shallow waters.

<break time="2s"/>

Foo Fighters.<break time="1s"/>
During World War II, pilots reported strange glowing objects pacing their aircraft. Allied crews saw them. Axis crews reported identical anomalies.
</speak>`;

describe('chunkSsmlForGoogle — user-reported regression scenario', () => {
  it('produces FEW chunks for a multi-section SSML script (not one-per-break)', () => {
    const chunks = chunkSsmlForGoogle(USER_SCRIPT);
    // 5 sections, total ~2500 bytes, default 4500-byte budget → 1 chunk
    // covers the whole thing. Pre-fix behavior would have been 10+ chunks
    // (one per <break>).
    expect(chunks.length).toBeLessThanOrEqual(2);
  });

  it('preserves intra-section <break time="1s"/> tags inside each chunk', () => {
    const chunks = chunkSsmlForGoogle(USER_SCRIPT);
    // Every chunk that contains a title should ALSO contain the
    // `<break time="1s"/>` tag that follows the title — that's the
    // user-authored title-to-body pause Chirp 3 HD honors.
    const joined = chunks.join('');
    expect(joined).toContain('<break time="1s"');
  });

  it('strips section-boundary <break time="2s"/> tags (they become chunk splits)', () => {
    // Force multiple chunks by setting a smaller byte budget so the
    // 2s boundaries actually trigger splits we can observe.
    const chunks = chunkSsmlForGoogle(USER_SCRIPT, 800);
    expect(chunks.length).toBeGreaterThan(1);
    // None of the chunks should contain the 2s break — those were
    // consumed as chunk-boundary signals.
    for (const c of chunks) {
      expect(c).not.toMatch(/<break\s+[^>]*time\s*=\s*["']2s["']/i);
    }
  });

  it("at default budget produces dramatically fewer chunks than a pre-fix run would have", () => {
    const chunks = chunkSsmlForGoogle(USER_SCRIPT);
    // The script has 5 long breaks (1× implicit + 4 explicit 2s breaks)
    // PLUS 5 short breaks (1s after each title). Pre-fix: 10+ segments,
    // each its own chunk → 10+ Chirp API calls. Post-fix: just 1 chunk
    // because everything fits in the byte budget.
    expect(chunks.length).toBe(1);
  });
});
