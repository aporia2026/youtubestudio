import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { sql } from '@/lib/db';
import { getUserSettings, type UserSettings } from '@/lib/user-settings';
import { logger } from '@/lib/logger';
import { BatchClient } from './BatchClient';

/**
 * /shorts/batch — bulk shorts generation + YouTube upload workflow.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Server-side bootstrap: loads the user's settings + workspace
 * channels so the client renders with sensible seed values without
 * an extra round-trip. Every load step is wrapped in a try/catch
 * with a sensible fallback so a single bad row or missing column
 * shows a useful inline state instead of throwing a generic
 * "Server Components render" error.
 */
export default async function BatchPage() {
  const session = await requireUser();

  // Settings — fall back to an empty record on read failure (the
  // user just loses their saved batch defaults; they can re-pick
  // them inside the form). Logs the underlying detail for
  // diagnostics.
  let settings: UserSettings = { v: 1 };
  try {
    settings = await getUserSettings(session.uid);
  } catch (err) {
    logger.error('[shorts-batch page] getUserSettings failed', {
      detail: err instanceof Error ? err.message : String(err),
      user_id: session.uid,
    });
  }

  // Channels — fall back to empty list on read failure; the
  // empty-state UI below explains what's missing instead of
  // throwing.
  // Channels table calls the display column `name`, not `title` (per
  // db.ts:270 — `name TEXT NOT NULL`). We alias to `title` here so
  // the client component's prop shape stays semantic ("title" reads
  // better in UI code than "name").
  type ChannelRow = { id: string; title: string | null; oauth_connected: boolean };
  let channels: ChannelRow[] = [];
  try {
    const { rows } = await sql<ChannelRow>`
      SELECT id,
             COALESCE(account_label, name) AS title,
             COALESCE(oauth_connected, false) AS oauth_connected
        FROM channels
       WHERE workspace_id = ${session.ws}::uuid
       ORDER BY created_at ASC
    `;
    channels = rows;
  } catch (err) {
    logger.error('[shorts-batch page] channels query failed', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
    });
  }

  if (channels.length === 0) {
    return <NoChannelsState />;
  }

  const connectedChannels = channels.filter((c) => c.oauth_connected);
  if (connectedChannels.length === 0) {
    return <NoConnectedChannelsState channelCount={channels.length} />;
  }

  const activeChannelId = settings.active_channel_id ?? connectedChannels[0].id;

  return (
    <BatchClient
      channels={connectedChannels}
      activeChannelId={activeChannelId}
      defaultVoiceId={settings.shorts_batch_default_voice_id ?? null}
      defaultLanguage={settings.shorts_batch_default_youtube_language ?? 'en'}
      defaultCategoryId={settings.shorts_batch_default_youtube_category_id ?? null}
      defaultMadeForKids={settings.shorts_batch_default_made_for_kids ?? null}
      defaultTimezone={settings.shorts_batch_default_timezone ?? null}
      defaultDescriptionTemplate={settings.shorts_batch_default_description_template ?? ''}
      defaultAgeRestricted={settings.shorts_batch_default_age_restricted ?? false}
      defaultPaidPromotion={settings.shorts_batch_default_paid_promotion ?? false}
      defaultAiContentDisclosure={settings.shorts_batch_default_ai_content_disclosure ?? true}
    />
  );
}

/** Inline empty state — workspace has no channels at all. */
function NoChannelsState() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
        Bulk batch needs a YouTube channel
      </h1>
      <p className="mt-3 text-sm text-[var(--text-secondary)]">
        Add a channel in Settings first — the batch flow uploads every short
        in the batch to a specific channel.
      </p>
      <Link
        href="/settings"
        className="mt-6 inline-block rounded-md bg-[var(--accent-purple)] px-5 py-2 text-sm font-medium text-white shadow-[0_0_30px_rgba(124,58,237,0.35)] hover:bg-[var(--accent-purple-bright)]"
      >
        Go to Settings →
      </Link>
    </div>
  );
}

/** Inline state — channels exist but none are OAuth-connected. */
function NoConnectedChannelsState({ channelCount }: { channelCount: number }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
        Connect a channel before batching
      </h1>
      <p className="mt-3 text-sm text-[var(--text-secondary)]">
        Your workspace has {channelCount} channel{channelCount === 1 ? '' : 's'},
        but none are connected to YouTube yet. Connect one in Settings so the
        batch flow can upload on its behalf.
      </p>
      <Link
        href="/settings"
        className="mt-6 inline-block rounded-md bg-[var(--accent-purple)] px-5 py-2 text-sm font-medium text-white shadow-[0_0_30px_rgba(124,58,237,0.35)] hover:bg-[var(--accent-purple-bright)]"
      >
        Open Settings →
      </Link>
    </div>
  );
}
