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
import { logActivity } from './activity-feed';

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
  // Log to bell for every collaborator linked to this project so the
  // editor / narrator see new viewer comments without an email.
  try {
    const { rows: collabs } = await sql`
      SELECT DISTINCT s.token, c.id
      FROM review_share_links s
      JOIN collaborators c ON c.id = s.collaborator_id
      WHERE s.project_id = ${args.projectId}
    `;
    for (const r of collabs) {
      logActivity({
        recipientCollaboratorId: r.id as string,
        type: 'review_comment',
        title: `${args.authorName} commented on "${args.projectTitle}"`,
        body: args.text.slice(0, 200),
        projectId: args.projectId,
        linkPath: `/review/${r.token}`,
        metadata: { versionId: args.versionId, versionNumber: args.versionNumber, timestampMs: args.timestampMs },
      }).catch(() => {});
    }
  } catch {}
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
  // In-app feed entry — independent of email opt-in / delivery success.
  logActivity({
    recipientCollaboratorId: args.collaboratorId,
    type: 'comment_resolved',
    title: `${args.resolverName} resolved your comment`,
    body: args.commentText.slice(0, 200),
    projectId: args.projectId,
    linkPath: `/reviews/${args.projectId}`,
    metadata: { resolver: args.resolverName },
  }).catch(() => {});
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

/**
 * Editor/narrator resolved a comment on the owner's review project — notify
 * the owner. Uses the same `on_comment_resolved` toggle as the existing
 * commenter-side notification (the toggle is symmetric: if the owner doesn't
 * want resolution emails, neither direction fires).
 */
export async function notifyCommentResolvedToOwner(args: {
  projectId: string;
  projectTitle: string;
  resolverName: string;
  commentText: string;
  versionNumber: number;
  versionId: string;
  timestampMs: number;
}) {
  const { email, should } = await ownerWantsEvent('on_comment_resolved');
  if (!should || !email) return;
  // Reuse the existing commentResolvedTemplate so we don't double-maintain
  // visual style; the framing reads naturally with the resolver's name.
  const t = tpl.commentResolvedTemplate({
    appUrl: getAppUrl(),
    resolverName: args.resolverName,
    projectTitle: args.projectTitle,
    text: args.commentText,
    reviewLinkPath: `/reviews/${args.projectId}/play?v=${args.versionId}`,
    audience: 'owner',
  });
  return sendEmail({ to: email, subject: t.subject, html: t.html });
}

export async function notifyVersionUploaded(args: {
  projectId: string;
  projectTitle: string;
  versionId: string;
  versionNumber: number;
}) {
  // Send to every collaborator with an active link on this project
  // Log to every collaborator with a link on this project — even those
  // who've disabled email; they should still see this in their bell.
  const { rows: allCollabs } = await sql`
    SELECT DISTINCT s.token, c.id, c.email, c.notifications_enabled, c.unsubscribe_token
    FROM review_share_links s
    JOIN collaborators c ON c.id = s.collaborator_id
    WHERE s.project_id = ${args.projectId}
  `;
  for (const r of allCollabs) {
    logActivity({
      recipientCollaboratorId: r.id as string,
      type: 'version_uploaded',
      title: `New version v${args.versionNumber} of "${args.projectTitle}" is ready to review`,
      projectId: args.projectId,
      linkPath: `/review/${r.token}`,
      metadata: { versionId: args.versionId, versionNumber: args.versionNumber },
    }).catch(() => {});
  }
  for (const r of allCollabs.filter(r => r.email && r.notifications_enabled)) {
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
  // Log to bell first (works regardless of email opt-in)
  const { rows: allCollabs } = await sql`
    SELECT DISTINCT s.token, c.id, c.email, c.notifications_enabled, c.unsubscribe_token
    FROM review_share_links s
    JOIN collaborators c ON c.id = s.collaborator_id
    WHERE s.project_id = ${args.projectId}
  `;
  for (const r of allCollabs) {
    logActivity({
      recipientCollaboratorId: r.id as string,
      type: 'status_changed',
      title: `"${args.projectTitle}" moved to ${args.newStatus}`,
      body: `Was: ${args.oldStatus}`,
      projectId: args.projectId,
      linkPath: `/review/${r.token}`,
      metadata: { oldStatus: args.oldStatus, newStatus: args.newStatus },
    }).catch(() => {});
  }
  for (const r of allCollabs.filter(r => r.email && r.notifications_enabled)) {
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
  logActivity({
    recipientCollaboratorId: args.narratorId,
    type: 'retake_requested',
    title: `Retake requested on ${args.sectionLabel}`,
    body: args.notes,
    linkPath: `/narrate/${args.shareToken}`,
    metadata: { sectionLabel: args.sectionLabel },
  }).catch(() => {});
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

export async function notifyEditorAssigned(args: {
  editorId: string;
  projectId?: string;
  projectTitle: string;
  editorNotes?: string | null;
  deadline?: string | null;
}) {
  logActivity({
    recipientCollaboratorId: args.editorId,
    type: 'editor_assigned',
    title: `New project assigned: "${args.projectTitle}"`,
    body: args.editorNotes ?? undefined,
    projectId: args.projectId,
    metadata: { deadline: args.deadline ?? null },
  }).catch(() => {});
  const recipient = await getCollaboratorEmailIfWantsNotifications(args.editorId);
  if (!recipient) return;
  // We need the editor's personal_token to build the dashboard URL
  const { rows } = await sql`SELECT name, personal_token FROM collaborators WHERE id = ${args.editorId}`;
  const row = rows[0];
  if (!row?.personal_token) return;
  const t = tpl.editorAssignmentTemplate({
    appUrl: getAppUrl(),
    editorName: row.name || 'Editor',
    projectTitle: args.projectTitle,
    editorNotes: args.editorNotes,
    deadline: args.deadline,
    dashboardUrl: `${getAppUrl()}/editor/${row.personal_token}`,
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
  logActivity({
    recipientCollaboratorId: args.narratorId,
    type: 'narrator_assigned',
    title: `New narration assigned: "${args.projectTitle}"`,
    body: `${args.sectionCount} sections to record`,
    linkPath: `/narrate/${args.shareToken}`,
    metadata: { sectionCount: args.sectionCount, deadline: args.deadline ?? null },
  }).catch(() => {});
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
