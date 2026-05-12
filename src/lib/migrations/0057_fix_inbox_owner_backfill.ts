import type { Migration } from './types';

/**
 * Follow-up to 0056. Two corrections shipped together because they share
 * an investigation and both surface the same way in the inbox: historical
 * owner-authored review comments bucketing under "Reviewers" instead of
 * "Owners".
 *
 * 1. Re-backfill `author_role='owner'` for rows where `author_name='Owner'`.
 *    The 0056 backfill relied on `posted_by_owner = true`, but the legacy
 *    owner-side POST route never set that flag — so every historical
 *    comment from the owner UI fell through to the 'reviewer' default. The
 *    OwnerName sentinel is fixed at 'Owner' in src/components/review/ReviewPage.tsx
 *    (see AuthorSetup default), so matching on it is safe.
 *
 * 2. Drop the NOT NULL constraint on `author_role`. A NOT NULL column with
 *    no DEFAULT is a footgun: any code path that forgets to set the
 *    field silently fails the INSERT and the user sees a phantom "posted"
 *    toast with no row in the DB. The inbox UI already maps NULL/unknown
 *    roles into the 'reviewer' bucket, so this is purely defensive.
 *
 * Idempotent. Safe to re-run.
 */
const migration: Migration = {
  id: '0057_fix_inbox_owner_backfill',
  description: 'Re-backfill owner-authored review_comments and relax author_role NOT NULL',

  async up(client) {
    // 1. Fix mis-bucketed owner rows. We only touch rows that are currently
    //    'reviewer' so we don't clobber later corrections an admin might
    //    have made by hand.
    await client.query(`
      UPDATE review_comments
         SET author_role = 'owner'
       WHERE LOWER(author_name) = 'owner'
         AND author_role = 'reviewer'
    `);

    // 2. Drop the NOT NULL — see header comment.
    await client.query(`
      ALTER TABLE review_comments
        ALTER COLUMN author_role DROP NOT NULL
    `);
  },

  async down(client) {
    // Best-effort: re-tighten the constraint. We don't try to undo the
    // backfill — there's no signal to reliably identify which rows were
    // flipped by this migration vs. by 0056.
    await client.query(`
      UPDATE review_comments
         SET author_role = COALESCE(author_role, 'reviewer')
    `);
    await client.query(`
      ALTER TABLE review_comments
        ALTER COLUMN author_role SET NOT NULL
    `);
  },
};

export default migration;
