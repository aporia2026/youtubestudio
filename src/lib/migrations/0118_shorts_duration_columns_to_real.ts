import type { Migration } from './types';

/**
 * Plan: `_plans/2026-06-04-shorts-images-must-be-9-16.md`'s outcome
 * notes (and the chain of duration fixes that followed).
 *
 * The user wanted the Sync button to make the video exactly the
 * length of the voiceover. The browser measures the audio at
 * sub-second precision (e.g. 32.229297s), but `voiceover_duration_seconds`
 * was an INTEGER column from migration 0021 — Postgres rejects
 * fractional writes:
 *
 *   invalid input syntax for type integer: "32.229297"
 *
 * Rounding to the nearest second would still cut the voiceover off
 * mid-word in extreme cases. The right fix is to hold sub-second
 * precision in the column.
 *
 * Migration choices:
 *   - DOUBLE PRECISION (float8) over NUMERIC because @vercel/postgres
 *     returns DOUBLE PRECISION as a JS `number`, while NUMERIC comes
 *     back as a string (arbitrary-precision, must be parsed). The
 *     existing ShortRow shape declares these fields as `number | null`;
 *     keeping them numeric-compatible avoids a serialisation pass.
 *   - Both `voiceover_duration_seconds` and `estimated_duration_seconds`
 *     migrate together. They share a domain (audio length in seconds);
 *     splitting precision between them just creates future confusion.
 *   - The implicit INT → DOUBLE PRECISION cast is lossless; existing
 *     rows keep their values (39 → 39.0, etc.).
 *
 * Down migration converts back to INTEGER with a round-trip cast that
 * rounds fractional values. Lossy, but only used for rollbacks.
 */
const migration: Migration = {
  id: '0118_shorts_duration_columns_to_real',
  description: 'Convert shorts.voiceover_duration_seconds + estimated_duration_seconds to DOUBLE PRECISION so sub-second values store losslessly',

  async up(client) {
    await client.query(`
      ALTER TABLE shorts
        ALTER COLUMN voiceover_duration_seconds TYPE DOUBLE PRECISION
        USING voiceover_duration_seconds::double precision
    `);
    await client.query(`
      ALTER TABLE shorts
        ALTER COLUMN estimated_duration_seconds TYPE DOUBLE PRECISION
        USING estimated_duration_seconds::double precision
    `);
  },

  async down(client) {
    // Lossy: rounds fractional seconds back to integer. Acceptable for
    // a rollback, never expected on a forward path.
    await client.query(`
      ALTER TABLE shorts
        ALTER COLUMN voiceover_duration_seconds TYPE INTEGER
        USING ROUND(voiceover_duration_seconds)::integer
    `);
    await client.query(`
      ALTER TABLE shorts
        ALTER COLUMN estimated_duration_seconds TYPE INTEGER
        USING ROUND(estimated_duration_seconds)::integer
    `);
  },
};

export default migration;
