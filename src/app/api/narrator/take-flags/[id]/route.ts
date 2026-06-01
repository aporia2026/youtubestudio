import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { createTakeComment } from '@/lib/narrator-db';
import {
  getPronunciationFlag,
  setPronunciationFlagCommentId,
  updatePronunciationFlag,
  type FlagUserStatus,
} from '@/lib/pronunciation-review/db';

export const runtime = 'nodejs';

/**
 * Reviewer-side mutations on a single pronunciation_flag.
 *
 * Three actions are expressed via one PATCH body so the UI can flip
 * any combination of (status, comment text, send-to-narrator) in a
 * single round trip:
 *
 *   • `user_status: 'accepted' | 'dismissed' | 'pending'`
 *     Reviewer's verdict on whether the flag is a real issue worth
 *     addressing. 'pending' is the default the orchestrator inserts
 *     with; reviewer transitions to 'accepted' or 'dismissed'. The
 *     reviewer can also unwind a decision back to 'pending'.
 *
 *   • `user_comment: string | null`
 *     Reviewer's editable version of the AI-suggested comment text.
 *     Null clears it back to "use the AI suggestion." Empty string
 *     ("") is treated as an explicit blank comment.
 *
 *   • `send_to_narrator: true`
 *     One-shot side effect. When `user_status` is also 'accepted'
 *     (or already-accepted), the server creates a `narration_take_comments`
 *     row at the flag's timestamp, links `pronunciation_flags.comment_id`
 *     to it, and notifies the narrator. The route returns both the
 *     updated flag and the created comment. Subsequent send-to-narrator
 *     calls on the same flag are no-ops (we don't overwrite an
 *     existing comment_id).
 *
 * Author identity (`author_name`, `author_color`) is optional — the
 * UI passes them so optimistic rendering matches the server insert.
 * Server enforces `author_role='owner'` since this is the owner-side
 * route.
 *
 * Not authenticated explicitly — owner-side routes rely on the
 * higher-layer auth check (same pattern as the take-comments route at
 * src/app/api/narrator/takes/[takeId]/comments/route.ts).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const flag = await getPronunciationFlag(id);
    if (!flag) return NextResponse.json({ error: 'Flag not found' }, { status: 404 });

    const body = (await req.json()) as {
      user_status?: string;
      user_comment?: string | null;
      send_to_narrator?: boolean;
      author_name?: string;
      author_color?: string;
    };

    const validStatuses: ReadonlyArray<FlagUserStatus> = ['pending', 'accepted', 'dismissed'];
    if (body.user_status !== undefined && !validStatuses.includes(body.user_status as FlagUserStatus)) {
      return NextResponse.json(
        { error: `user_status must be one of: ${validStatuses.join(', ')}` },
        { status: 400 },
      );
    }
    if (body.user_comment !== undefined && body.user_comment !== null && typeof body.user_comment !== 'string') {
      return NextResponse.json(
        { error: 'user_comment must be a string or null' },
        { status: 400 },
      );
    }
    if (body.send_to_narrator === true && !body.author_name?.trim()) {
      return NextResponse.json(
        { error: 'author_name is required when send_to_narrator is true' },
        { status: 400 },
      );
    }

    // Apply the status / comment update first. Skip the SQL round-trip
    // entirely when the caller only sent send_to_narrator with no
    // other fields — the existing flag row is already what we'll send
    // the narrator.
    const wantsFieldUpdate =
      body.user_status !== undefined || body.user_comment !== undefined;
    const updatedFlag = wantsFieldUpdate
      ? await updatePronunciationFlag({
          flagId: id,
          userStatus: body.user_status as FlagUserStatus | undefined,
          userComment: body.user_comment ?? undefined,
        })
      : flag;
    if (!updatedFlag) {
      // Race: flag was deleted between getPronunciationFlag and update.
      return NextResponse.json({ error: 'Flag not found' }, { status: 404 });
    }

    // Send-to-narrator side effect. Gated by user_status='accepted'
    // (either set in this same request or previously) and a missing
    // comment_id (re-sends are no-ops).
    let createdComment: { id: string; text: string; timestamp_ms: number } | null = null;
    if (body.send_to_narrator === true && updatedFlag.user_status === 'accepted' && !updatedFlag.comment_id) {
      // The text the narrator sees: the reviewer's edit if present,
      // else the AI suggestion verbatim. We never send an empty
      // comment — fall back to the AI suggestion when the reviewer
      // cleared the text but still hit Send.
      const text =
        (updatedFlag.user_comment && updatedFlag.user_comment.trim()) ||
        updatedFlag.suggested_comment;
      if (!text.trim()) {
        return NextResponse.json(
          { error: 'No comment text to send (AI suggestion was empty).' },
          { status: 400 },
        );
      }

      const timestampMs = Math.round(updatedFlag.start_sec * 1000);
      try {
        const comment = await createTakeComment({
          take_id: updatedFlag.take_id,
          timestamp_ms: timestampMs,
          end_timestamp_ms: null,
          text: text.trim(),
          author_name: (body.author_name ?? 'Reviewer').trim(),
          author_color: body.author_color || '#06b6d4',
          author_role: 'owner',
        });
        await setPronunciationFlagCommentId(id, comment.id);
        createdComment = {
          id: comment.id,
          text: comment.text,
          timestamp_ms: comment.timestamp_ms,
        };
      } catch (err) {
        // Comment creation failed — leave the flag in its updated state
        // (accepted, with the reviewer's text) so they can retry the
        // Send action without redoing the accept.
        logger.error('pronunciation-flag send-to-narrator failed', {
          flagId: id,
          detail: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json(
          {
            error: 'Comment send failed. The flag is still accepted — retry "Send to narrator" to try again.',
          },
          { status: 502 },
        );
      }
    }

    // Re-read the flag if we linked a comment, so the response carries
    // the latest comment_id. Two extra DB hops in the send path; one
    // in the field-update-only path.
    const finalFlag = createdComment ? await getPronunciationFlag(id) : updatedFlag;

    return NextResponse.json({
      flag: finalFlag,
      comment: createdComment,
    });
  } catch (err) {
    logger.error('PATCH pronunciation-flag error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Failed to update flag' }, { status: 500 });
  }
}
