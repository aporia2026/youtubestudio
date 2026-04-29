import type { ScheduleItem, ScheduleStatus } from './schedule';

function sanitize(name: string): string {
  return (name || 'schedule').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '-').slice(0, 60).toLowerCase();
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function download(content: BlobPart, filename: string, mimeType: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** CSV export — every field including flattened custom_fields keys. */
export function exportScheduleCSV(items: ScheduleItem[], scopeLabel: string) {
  const customKeys = Array.from(
    new Set(items.flatMap(i => Object.keys(i.custom_fields ?? {}))),
  ).sort();

  const headers = [
    'Title', 'Scheduled for', 'Status', 'Channels', 'Tags', 'Notes',
    'Idea ID', 'Project ID', 'Script ID',
    ...customKeys.map(k => `custom_${k}`),
  ];

  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = items.map(it => [
    it.title,
    it.scheduled_for ?? '',
    it.status,
    (it.channels ?? []).map(c => c.name).join('; '),
    (it.tags ?? []).join('; '),
    it.notes ?? '',
    it.idea_id ?? '',
    it.project_id ?? '',
    it.script_id ?? '',
    ...customKeys.map(k => {
      const v = it.custom_fields?.[k];
      return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
    }),
  ].map(escape).join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  download(csv, `${sanitize(scopeLabel)}-schedule-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
}

/** PDF export — one page per item OR compact list. Defaults to list. */
export async function exportScheduleListPDF(
  items: ScheduleItem[],
  statuses: ScheduleStatus[],
  scopeLabel: string,
) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // Header
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(`Schedule — ${scopeLabel}`, margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120, 120, 120);
  doc.text(
    `${items.length} item${items.length === 1 ? '' : 's'} · generated ${new Date().toLocaleString()}`,
    margin, y,
  );
  y += 6;
  doc.setDrawColor(220, 220, 220);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  const statusMap = new Map(statuses.map(s => [s.key, s]));

  for (const item of items) {
    // Each entry ~ 24mm. Page break check.
    if (y > pageHeight - 30) {
      doc.addPage();
      y = margin;
    }

    const st = statusMap.get(item.status);
    const hex = (st?.color || '#64748b').replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // Status pill (colored rect + label)
    doc.setFillColor(r, g, b);
    doc.roundedRect(margin, y - 3.5, 22, 4.5, 1, 1, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.text((st?.label ?? item.status).toUpperCase().slice(0, 12), margin + 1, y);

    // Date (right-aligned)
    doc.setTextColor(120, 120, 120);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(fmtWhen(item.scheduled_for), pageWidth - margin, y, { align: 'right' });

    y += 5;

    // Title
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);
    const titleLines = doc.splitTextToSize(item.title || 'Untitled', contentWidth - 25);
    doc.text(titleLines[0], margin, y);
    y += 5;

    // Channels + tags
    const meta: string[] = [];
    const channelNames = (item.channels ?? []).map(c => c.name).join(', ');
    if (channelNames) meta.push(`Channels: ${channelNames}`);
    if (item.tags?.length) meta.push(`Tags: ${item.tags.join(', ')}`);
    if (item.recurrence) meta.push('Recurring');
    if (meta.length) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(130, 130, 130);
      const ml = doc.splitTextToSize(meta.join(' · '), contentWidth);
      doc.text(ml[0], margin, y);
      y += 4;
    }

    // Notes (truncated)
    if (item.notes) {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(80, 80, 80);
      const notesLines = doc.splitTextToSize(item.notes, contentWidth);
      const shown = notesLines.slice(0, 3);
      for (const line of shown) {
        doc.text(line, margin, y);
        y += 4;
      }
      if (notesLines.length > 3) {
        doc.setTextColor(160, 160, 160);
        doc.text('…', margin, y);
        y += 4;
      }
    }

    // Separator
    y += 2;
    doc.setDrawColor(235, 235, 240);
    doc.line(margin, y, pageWidth - margin, y);
    y += 4;
  }

  doc.save(`${sanitize(scopeLabel)}-schedule-${new Date().toISOString().slice(0, 10)}.pdf`);
}

/** Printable calendar PDF — one landscape page per month within the data range. */
export async function exportScheduleCalendarPDF(
  items: ScheduleItem[],
  scopeLabel: string,
) {
  const { jsPDF } = await import('jspdf');
  const scheduled = items.filter(i => i.scheduled_for);
  if (scheduled.length === 0) {
    throw new Error('No scheduled items to render into a calendar.');
  }

  // Determine the range of months covered.
  const dates = scheduled.map(i => new Date(i.scheduled_for!));
  const minD = new Date(Math.min(...dates.map(d => d.getTime())));
  const maxD = new Date(Math.max(...dates.map(d => d.getTime())));
  const start = new Date(minD.getFullYear(), minD.getMonth(), 1);
  const end = new Date(maxD.getFullYear(), maxD.getMonth(), 1);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const margin = 10;

  const byDay = new Map<string, ScheduleItem[]>();
  for (const it of scheduled) {
    const d = new Date(it.scheduled_for!);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(it);
  }

  const cursor = new Date(start);
  let firstPage = true;
  while (cursor <= end) {
    if (!firstPage) doc.addPage();
    firstPage = false;

    // Title
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);
    doc.text(`${cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} — ${scopeLabel}`, margin, margin + 5);

    const gridTop = margin + 12;
    const gridHeight = ph - gridTop - margin;
    const cellW = (pw - margin * 2) / 7;
    const weekdayH = 6;
    const rowH = (gridHeight - weekdayH) / 6;

    // Weekday headers
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(100, 100, 100);
    const wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      doc.text(wk[i], margin + i * cellW + 1.5, gridTop + 4);
    }

    // 42 cells
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = new Date(first);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    doc.setDrawColor(220, 220, 220);
    for (let i = 0; i < 42; i++) {
      const col = i % 7;
      const row = Math.floor(i / 7);
      const d = new Date(gridStart);
      d.setDate(d.getDate() + i);
      const x = margin + col * cellW;
      const y = gridTop + weekdayH + row * rowH;

      doc.rect(x, y, cellW, rowH);
      const inMonth = d.getMonth() === cursor.getMonth();

      // Day number
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(inMonth ? 60 : 180, inMonth ? 60 : 180, inMonth ? 60 : 180);
      doc.text(String(d.getDate()), x + 1.5, y + 4);

      if (!inMonth) continue;

      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const cellItems = byDay.get(k) ?? [];
      const maxShow = Math.max(1, Math.floor((rowH - 8) / 4));
      doc.setFontSize(7);
      doc.setTextColor(40, 40, 40);
      let ly = y + 8;
      for (const it of cellItems.slice(0, maxShow)) {
        const title = doc.splitTextToSize(it.title || 'Untitled', cellW - 3)[0];
        doc.text(`• ${title}`, x + 1.5, ly);
        ly += 3.5;
      }
      if (cellItems.length > maxShow) {
        doc.setTextColor(150, 150, 150);
        doc.text(`+${cellItems.length - maxShow} more`, x + 1.5, ly);
      }
    }

    cursor.setMonth(cursor.getMonth() + 1);
  }

  doc.save(`${sanitize(scopeLabel)}-schedule-calendar-${new Date().toISOString().slice(0, 10)}.pdf`);
}
