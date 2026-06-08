import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { sql } from '@/lib/db';
import { getUserSettings } from '@/lib/user-settings';
import { BatchClient } from './BatchClient';

/**
 * /shorts/batch — bulk shorts generation + YouTube upload workflow.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Server-side bootstrap: loads the user's active channel + workspace
 * defaults so the client component renders with sensible seed values
 * (voice, language, category, timezone, description template etc.)
 * without an extra round-trip. Everything from step 1 onward is
 * client-side.
 */
export default async function BatchPage() {
  const session = await requireUser();
  const settings = await getUserSettings(session.uid);

  // Pull every workspace-scoped channel so step 2 can render a
  // picker (single channel = no picker, just attached automatically).
  const { rows: channels } = await sql<{
    id: string;
    title: string | null;
    oauth_connected: boolean;
  }>`
    SELECT id, title, oauth_connected
      FROM channels
     WHERE workspace_id = ${session.ws}::uuid
     ORDER BY created_at ASC
  `;

  if (channels.length === 0) {
    // No channel = nothing to upload to. Redirect to settings with a
    // clear breadcrumb instead of rendering an unusable form.
    redirect('/settings/channels?need=upload-channel');
  }

  const activeChannelId = settings.active_channel_id ?? channels[0].id;

  return (
    <BatchClient
      channels={channels}
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
