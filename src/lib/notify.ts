/**
 * Thin orchestration layer that decides whether to send notifications
 * for each event and dispatches the right template. All functions are
 * fire-and-forget — call them with .catch(...) at the call site so the
 * main API response is never blocked by email I/O.
 */
import { sql } from '@vercel/postgres';
import { ownerWantsEvent, getCollaboratorEmailIfWantsNotifications } from './notifications-db';
import { sendEmail, getAppUrl } from './email';
import * as tpl from './email-templates';

function buildUnsubscribeUrl(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return `${getAppUrl()}/unsubscribe?t=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Review events
// ---------------------------------------------------------------------------

export async function notifyReviewComment(args: {
  projectId: string;
  projectTitle: string;
  versionId: string;
  versionNumber: number;
  authorName: string;
  text: string;
  timestampMs: number;
  drawingThumbnailUrl?: string | null;
}) {
  const { email, should } = await ownerWantsEvent('on_review_comment');
  if (!should || !email) return;
  const t = tpl.reviewCommentTemplate({
    appUrl: getAppUrl(),
    authorName: args.authorName,
    projectTitle: args.projectTitle,
    versionNumber: args.versionNumber,
    timestampMs: args.timestampMs,
    text: args.text,
    drawingThumbnailUrl: args.drawingThumbnailUrl ?? null,
    reviewLinkPath: `/reviews/${args.projectId}/play?v=${args.versionId}`,
  });
  return sendEmail({ to: email, subject: t.subject, html: t.html });
}

export async function notifyCommentResolved(args: {
  projectId: string;
  projectTitle: string;
  collaboratorId: string | null;
  commentText: string;
  resolverName: string;
}) {
  if (!args.collaboratorId) return;
  const recipient = await getCollaboratorEmailIfWantsNotifications(args.collaboratorId);
  if (!recipient) return;
  const t = tpl.commentResolvedTemplate({
    appUrl: getAppUrl(),
    resolverName: args.resolverName,
    projectTitle: args.projectTitle,
    text: args.commentText,
    reviewLinkPath: `/reviews/${args.projectId}`,
    unsubscribeUrl: buildUnsubscribeUrl(recipient.unsubscribeToken),
  });
  return sendEmail({ to: recipient.email, subject: t.subject, html: t.html });
}

export async function notifyVersionUploaded(args: {
  projectId: string;
  projectTitle: string;
  versionId: string;
  versionNumber: number;
}) {
  // Send to every collaborator with an active link on this project
  const { rows } = await sql`
    SELECT DISTINCT s.token, c.id, c.email, c.notifications_enabled, c.unsubscribe_token
    FROM review_share_links s
    JOIN collaborators c ON c.id = s.collaborator_id
    WHERE s.project_id = ${args.projectId}
      AND c.email IS NOT NULL
      AND c.notifications_enabled = true
  `;
  for (const r of rows) {
    const t = tpl.versionUploadedTemplate({
      appUrl: getAppUrl(),
      projectTitle: args.projectTitle,
      versionNumber: args.versionNumber,
      reviewLinkPath: `/review/${r.token}`,
      unsubscribeUrl: buildUnsubscribeUrl(r.unsubscribe_token),
    });
    sendEmail({ to: r.email, subject: t.subject, html: t.html }).catch(() => {});
  }
}

export async function notifyStatusChanged(args: {
  projectId: string;
  projectTitle: string;
  oldStatus: string;
  newStatus: string;
}) {
  const { rows } = await sql`
    SELECT DISTINCT s.token, c.email, c.unsubscribe_token
    FROM review_share_links s
    JOIN collaborators c ON c.id = s.collaborator_id
    WHERE s.project_id = ${args.projectId}
      AND c.email IS NOT NULL
      AND c.notifications_enabled = true
  `;
  for (const r of rows) {
    const t = tpl.statusChangedTemplate({
      appUrl: getAppUrl(),
      projectTitle: args.projectTitle,
      oldStatus: args.oldStatus,
      newStatus: args.newStatus,
      reviewLinkPath: `/review/${r.token}`,
      unsubscribeUrl: buildUnsubscribeUrl(r.unsubscribe_token),
    });
    sendEmail({ to: r.email, subject: t.subject, html: t.html }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Narrator events
// ---------------------------------------------------------------------------

export async function notifyNarratorTake(args: {
  narratorName: string;
  projectId: string;
  projectTitle: string;
  sectionLabel: string;
  takeNumber: number;
}) {
  const { email, should } = await ownerWantsEvent('on_narrator_take');
  if (!should || !email) return;
  const t = tpl.narratorTakeTemplate({
    appUrl: getAppUrl(),
    narratorName: args.narratorName,
    projectTitle: args.projectTitle,
    sectionLabel: args.sectionLabel,
    takeNumber: args.takeNumber,
    manageUrl: `${getAppUrl()}/projects/${args.projectId}`,
  });
  return sendEmail({ to: email, subject: t.subject, html: t.html });
}

export async function notifyNarratorComment(args: {
  narratorName: string;
  projectId: string;
  projectTitle: string;
  text: string;
}) {
  const { email, should } = await ownerWantsEvent('on_narrator_comment');
  if (!should || !email) return;
  const t = tpl.narratorCommentTemplate({
    appUrl: getAppUrl(),
    narratorName: args.narratorName,
    projectTitle: args.projectTitle,
    text: args.text,
    manageUrl: `${getAppUrl()}/projects/${args.projectId}`,
  });
  return sendEmail({ to: email, subject: t.subject, html: t.html });
}

export async function notifyRetakeRequested(args: {
  narratorId: string;
  shareToken: string;
  sectionLabel: string;
  notes?: string;
}) {
  const recipient = await getCollaboratorEmailIfWantsNotifications(args.narratorId);
  if (!recipient) return;
  const t = tpl.retakeRequestedTemplate({
    appUrl: getAppUrl(),
    sectionLabel: args.sectionLabel,
    notes: args.notes,
    portalUrl: `${getAppUrl()}/narrate/${args.shareToken}`,
    unsubscribeUrl: buildUnsubscribeUrl(recipient.unsubscribeToken),
  });
  return sendEmail({ to: recipient.email, subject: t.subject, html: t.html });
}

export async function notifyAssignmentReceived(args: {
  narratorId: string;
  narratorName: string;
  projectTitle: string;
  shareToken: string;
  sectionCount: number;
  deadline?: string | null;
}) {
  const recipient = await getCollaboratorEmailIfWantsNotifications(args.narratorId);
  if (!recipient) return;
  const t = tpl.assignmentReceivedTemplate({
    appUrl: getAppUrl(),
    narratorName: args.narratorName,
    projectTitle: args.projectTitle,
    sectionCount: args.sectionCount,
    deadline: args.deadline,
    portalUrl: `${getAppUrl()}/narrate/${args.shareToken}`,
    unsubscribeUrl: buildUnsubscribeUrl(recipient.unsubscribeToken),
  });
  return sendEmail({ to: recipient.email, subject: t.subject, html: t.html });
}
