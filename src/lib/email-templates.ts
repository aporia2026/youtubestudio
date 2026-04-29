/**
 * Themed HTML email templates. Pure strings — no React/JSX, no dependencies.
 * Dark background to match the app, with a purple→cyan gradient header.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Layout {
  preheader: string;
  heading: string;
  body: string;        // HTML body fragments (already escaped)
  ctaLabel?: string;
  ctaHref?: string;
  footerNote?: string;
  unsubscribeUrl?: string;
}

function layout({ preheader, heading, body, ctaLabel, ctaHref, footerNote, unsubscribeUrl }: Layout): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#050508;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#f1f5f9;">
  <span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(preheader)}</span>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#050508;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#0d0d14;border:1px solid #1e1e35;border-radius:16px;overflow:hidden;">
          <!-- Gradient header -->
          <tr>
            <td style="background:linear-gradient(135deg,#7c3aed,#06b6d4);padding:20px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size:13px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">YT STUDIO</td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:28px 24px 12px 24px;">
              <h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.3;color:#f1f5f9;font-weight:700;">${escapeHtml(heading)}</h1>
              <div style="font-size:14px;line-height:1.6;color:#cbd5e1;">${body}</div>
            </td>
          </tr>
          ${ctaLabel && ctaHref ? `
          <tr>
            <td style="padding:8px 24px 24px 24px;">
              <a href="${escapeHtml(ctaHref)}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:10px;">${escapeHtml(ctaLabel)}</a>
            </td>
          </tr>` : ''}
          ${footerNote ? `
          <tr>
            <td style="padding:8px 24px 24px 24px;font-size:12px;color:#8888aa;line-height:1.5;">${footerNote}</td>
          </tr>` : ''}
          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #1e1e35;padding:16px 24px;font-size:11px;color:#555577;line-height:1.5;">
              You're receiving this because you have access to a YT Studio project.
              ${unsubscribeUrl ? `<br /><a href="${escapeHtml(unsubscribeUrl)}" style="color:#8888aa;text-decoration:underline;">Unsubscribe from these notifications</a>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Per-event templates
// ---------------------------------------------------------------------------

interface BaseCtx { appUrl: string; unsubscribeUrl?: string }

export function reviewCommentTemplate(ctx: BaseCtx & {
  authorName: string;
  projectTitle: string;
  versionNumber: number;
  timestampMs: number;
  text: string;
  drawingThumbnailUrl?: string | null;
  reviewLinkPath: string; // e.g. /reviews/<id>/play?v=<versionId>
}) {
  const ts = formatTimestamp(ctx.timestampMs);
  const url = `${ctx.appUrl}${ctx.reviewLinkPath}`;
  const subject = `${ctx.authorName} commented on ${ctx.projectTitle}`;
  const body = `
    <p style="margin:0 0 12px 0;"><strong>${escapeHtml(ctx.authorName)}</strong> left a comment on <strong>${escapeHtml(ctx.projectTitle)}</strong> v${ctx.versionNumber}, at <code style="background:#1a1a2e;padding:2px 6px;border-radius:4px;color:#a78bfa;">${ts}</code>:</p>
    <blockquote style="margin:12px 0;padding:12px 16px;background:#0a0a14;border-left:3px solid #7c3aed;border-radius:6px;color:#e2e8f0;font-style:italic;">${escapeHtml(ctx.text)}</blockquote>
    ${ctx.drawingThumbnailUrl ? `<img src="${escapeHtml(ctx.drawingThumbnailUrl)}" alt="Annotation" style="max-width:100%;border-radius:8px;margin-top:8px;border:1px solid #1e1e35;" />` : ''}
  `;
  return {
    subject,
    html: layout({
      preheader: `${ctx.authorName} on ${ctx.projectTitle} at ${ts}`,
      heading: subject,
      body,
      ctaLabel: 'Open review',
      ctaHref: url,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function commentResolvedTemplate(ctx: BaseCtx & {
  resolverName: string;
  projectTitle: string;
  text: string;
  reviewLinkPath: string;
}) {
  const url = `${ctx.appUrl}${ctx.reviewLinkPath}`;
  const subject = `Your comment was resolved on ${ctx.projectTitle}`;
  const body = `
    <p style="margin:0 0 12px 0;"><strong>${escapeHtml(ctx.resolverName)}</strong> resolved your comment on <strong>${escapeHtml(ctx.projectTitle)}</strong>:</p>
    <blockquote style="margin:12px 0;padding:12px 16px;background:#0a0a14;border-left:3px solid #22c55e;border-radius:6px;color:#94a3b8;font-style:italic;">${escapeHtml(ctx.text)}</blockquote>
  `;
  return {
    subject,
    html: layout({
      preheader: `${ctx.resolverName} resolved your comment`,
      heading: subject,
      body,
      ctaLabel: 'View project',
      ctaHref: url,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function versionUploadedTemplate(ctx: BaseCtx & {
  projectTitle: string;
  versionNumber: number;
  reviewLinkPath: string;
}) {
  const url = `${ctx.appUrl}${ctx.reviewLinkPath}`;
  const subject = `New version uploaded: ${ctx.projectTitle} v${ctx.versionNumber}`;
  const body = `
    <p style="margin:0;">A new version of <strong>${escapeHtml(ctx.projectTitle)}</strong> is ready to review.</p>
  `;
  return {
    subject,
    html: layout({
      preheader: `v${ctx.versionNumber} is ready to review`,
      heading: subject,
      body,
      ctaLabel: `Watch v${ctx.versionNumber}`,
      ctaHref: url,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function statusChangedTemplate(ctx: BaseCtx & {
  projectTitle: string;
  oldStatus: string;
  newStatus: string;
  reviewLinkPath: string;
}) {
  const url = `${ctx.appUrl}${ctx.reviewLinkPath}`;
  const subject = `${ctx.projectTitle} is now ${ctx.newStatus.replace('-', ' ')}`;
  const body = `
    <p style="margin:0;"><strong>${escapeHtml(ctx.projectTitle)}</strong> moved from <em>${escapeHtml(ctx.oldStatus)}</em> to <strong>${escapeHtml(ctx.newStatus)}</strong>.</p>
  `;
  return {
    subject,
    html: layout({
      preheader: `Status changed to ${ctx.newStatus}`,
      heading: subject,
      body,
      ctaLabel: 'View project',
      ctaHref: url,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function narratorTakeTemplate(ctx: BaseCtx & {
  narratorName: string;
  projectTitle: string;
  sectionLabel: string;
  takeNumber: number;
  manageUrl: string;
}) {
  const subject = `${ctx.narratorName} uploaded a take on ${ctx.projectTitle}`;
  const body = `
    <p style="margin:0;"><strong>${escapeHtml(ctx.narratorName)}</strong> uploaded take ${ctx.takeNumber} on section <strong>${escapeHtml(ctx.sectionLabel)}</strong>.</p>
  `;
  return {
    subject,
    html: layout({
      preheader: `Take ${ctx.takeNumber} on ${ctx.sectionLabel}`,
      heading: subject,
      body,
      ctaLabel: 'Review take',
      ctaHref: ctx.manageUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function narratorCommentTemplate(ctx: BaseCtx & {
  narratorName: string;
  projectTitle: string;
  text: string;
  manageUrl: string;
}) {
  const subject = `${ctx.narratorName} commented on ${ctx.projectTitle}`;
  const body = `
    <blockquote style="margin:0 0 12px 0;padding:12px 16px;background:#0a0a14;border-left:3px solid #7c3aed;border-radius:6px;color:#e2e8f0;font-style:italic;">${escapeHtml(ctx.text)}</blockquote>
  `;
  return {
    subject,
    html: layout({
      preheader: `${ctx.narratorName}: ${ctx.text.slice(0, 60)}`,
      heading: subject,
      body,
      ctaLabel: 'Open project',
      ctaHref: ctx.manageUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function retakeRequestedTemplate(ctx: BaseCtx & {
  sectionLabel: string;
  notes?: string;
  portalUrl: string;
}) {
  const subject = `Retake requested: ${ctx.sectionLabel}`;
  const body = `
    <p style="margin:0 0 12px 0;">A retake has been requested on section <strong>${escapeHtml(ctx.sectionLabel)}</strong>.</p>
    ${ctx.notes ? `<blockquote style="margin:12px 0;padding:12px 16px;background:#0a0a14;border-left:3px solid #f97316;border-radius:6px;color:#e2e8f0;">${escapeHtml(ctx.notes)}</blockquote>` : ''}
  `;
  return {
    subject,
    html: layout({
      preheader: `Retake on ${ctx.sectionLabel}`,
      heading: subject,
      body,
      ctaLabel: 'Open narrator portal',
      ctaHref: ctx.portalUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function assignmentReceivedTemplate(ctx: BaseCtx & {
  narratorName: string;
  projectTitle: string;
  sectionCount: number;
  deadline?: string | null;
  portalUrl: string;
}) {
  const subject = `New narration assignment: ${ctx.projectTitle}`;
  const body = `
    <p style="margin:0 0 12px 0;">Hi ${escapeHtml(ctx.narratorName)},</p>
    <p style="margin:0 0 12px 0;">You've been assigned to narrate <strong>${escapeHtml(ctx.projectTitle)}</strong>.</p>
    <ul style="margin:0 0 12px 0;padding-left:20px;color:#cbd5e1;">
      <li>${ctx.sectionCount} section${ctx.sectionCount === 1 ? '' : 's'} to record</li>
      ${ctx.deadline ? `<li>Deadline: <strong>${escapeHtml(new Date(ctx.deadline).toLocaleDateString())}</strong></li>` : ''}
    </ul>
    <p style="margin:0;">Open your portal to read the script with director's notes, record sections, and submit takes.</p>
  `;
  return {
    subject,
    html: layout({
      preheader: `${ctx.sectionCount} sections, ${ctx.deadline ? 'due ' + new Date(ctx.deadline).toLocaleDateString() : 'no deadline'}`,
      heading: subject,
      body,
      ctaLabel: 'Open narrator portal',
      ctaHref: ctx.portalUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function editorAssignmentTemplate(ctx: BaseCtx & {
  editorName: string;
  projectTitle: string;
  editorNotes?: string | null;
  deadline?: string | null;
  dashboardUrl: string;
}) {
  const subject = `New video editing assignment: ${ctx.projectTitle}`;
  const body = `
    <p style="margin:0 0 12px 0;">Hi ${escapeHtml(ctx.editorName)},</p>
    <p style="margin:0 0 12px 0;">You've been assigned to edit <strong>${escapeHtml(ctx.projectTitle)}</strong>.</p>
    ${ctx.editorNotes ? `<blockquote style="margin:12px 0;padding:12px 16px;background:#0a0a14;border-left:3px solid #06b6d4;border-radius:6px;color:#e2e8f0;">${escapeHtml(ctx.editorNotes)}</blockquote>` : ''}
    ${ctx.deadline ? `<p style="margin:0 0 12px 0;">Deadline: <strong>${escapeHtml(new Date(ctx.deadline).toLocaleDateString())}</strong></p>` : ''}
    <p style="margin:0;">Open your dashboard to see the script, image references, thumbnails, and upload your finished video for review.</p>
  `;
  return {
    subject,
    html: layout({
      preheader: ctx.editorNotes ? ctx.editorNotes.slice(0, 80) : `Open your editor dashboard`,
      heading: subject,
      body,
      ctaLabel: 'Open editor dashboard',
      ctaHref: ctx.dashboardUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
    }),
  };
}

export function testEmailTemplate(ctx: BaseCtx) {
  const subject = '✅ YT Studio email notifications are working';
  const body = `
    <p style="margin:0 0 12px 0;">If you're reading this, your email notifications are correctly wired up.</p>
    <p style="margin:0;color:#94a3b8;font-size:13px;">You'll get emails when collaborators comment, upload videos, narrators submit takes, project status changes, and similar activity.</p>
  `;
  return {
    subject,
    html: layout({
      preheader: 'Test email from YT Studio',
      heading: subject,
      body,
      ctaLabel: 'Open YT Studio',
      ctaHref: ctx.appUrl,
      footerNote: 'Configure which events trigger notifications in Settings → Notifications.',
    }),
  };
}
