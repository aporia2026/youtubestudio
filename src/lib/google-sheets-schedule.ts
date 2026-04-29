/**
 * Google Sheets export for the schedule feature.
 * Creates a new spreadsheet with one row per schedule item, status-colored,
 * with frozen header + basic formatting. Custom fields are flattened into columns.
 */

import type { ScheduleItem, ScheduleStatus } from './schedule';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Convert a 1-indexed column count to A1-notation column letters (1→A, 26→Z, 27→AA). */
function colToA1(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

interface Color { red: number; green: number; blue: number }
function rgb(r: number, g: number, b: number): Color {
  return { red: r / 255, green: g / 255, blue: b / 255 };
}
function hexToColor(hex: string): Color {
  const h = hex.replace('#', '');
  return rgb(
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  );
}

export interface ScheduleSheetInput {
  scopeLabel: string;               // e.g. "All channels" or "Main Channel"
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
}

async function sheetsPost(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sheetsPut(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function assertOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  if (res.status === 403 && (body.includes('insufficient') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))) {
    throw new Error('NEEDS_REAUTH: Your connected Google account does not have Google Sheets access. Please reconnect.');
  }
  throw new Error(`${context} failed (${res.status}): ${body.slice(0, 300)}`);
}

export async function createScheduleSheet(
  accessToken: string,
  data: ScheduleSheetInput,
): Promise<{ spreadsheetId: string; sheetUrl: string }> {
  const { scopeLabel, items, statuses } = data;

  // Flatten custom field keys
  const customKeys = Array.from(
    new Set(items.flatMap(i => Object.keys(i.custom_fields ?? {}))),
  ).sort();

  const HEADERS = [
    'Title', 'Scheduled for', 'Status', 'Channels', 'Tags', 'Notes',
    'Recurring', 'Has Script', 'From Idea',
    ...customKeys.map(k => `custom_${k}`),
  ];
  const COLS = HEADERS.length;
  const HEADER_ROW = 2; // 0-indexed: row 3 in Sheets
  const DATA_START = 3; // 0-indexed: row 4+ in Sheets
  const numRows = items.length;

  // 1. Create spreadsheet
  const createRes = await sheetsPost(SHEETS_BASE, accessToken, {
    properties: { title: `Schedule — ${scopeLabel}` },
    sheets: [{
      properties: {
        sheetId: 0,
        title: 'Schedule',
        gridProperties: {
          rowCount: numRows + DATA_START + 5,
          columnCount: COLS,
          frozenRowCount: DATA_START,
        },
      },
    }],
  });
  await assertOk(createRes, 'Create spreadsheet');
  const { spreadsheetId } = await createRes.json() as { spreadsheetId: string };

  // 2. Write values
  const fmtWhen = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '';
  const statusLabel = (k: string) => statuses.find(s => s.key === k)?.label ?? k;

  const valueRows: (string | number)[][] = [
    [`Schedule — ${scopeLabel}`],
    [`${numRows} item${numRows === 1 ? '' : 's'}`, '', `Generated: ${new Date().toLocaleString()}`],
    HEADERS,
    ...items.map(it => [
      it.title || '',
      fmtWhen(it.scheduled_for),
      statusLabel(it.status),
      (it.channels ?? []).map(c => c.name).join(', '),
      (it.tags ?? []).join(', '),
      it.notes ?? '',
      it.recurrence ? 'Yes' : '',
      it.script_id ? 'Yes' : '',
      it.idea_id ? 'Yes' : '',
      ...customKeys.map(k => {
        const v = it.custom_fields?.[k];
        return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
      }),
    ]),
  ];

  const lastCol = colToA1(COLS); // handles >26 columns
  const range = `A1:${lastCol}${DATA_START + numRows}`;
  const valRes = await sheetsPut(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    accessToken,
    { range, majorDimension: 'ROWS', values: valueRows },
  );
  await assertOk(valRes, 'Write values');

  // 3. Formatting — title, header, status-colored status cells, borders, col widths
  const requests: unknown[] = [
    // Title row (A1 merged across all columns)
    {
      mergeCells: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: COLS },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(30, 14, 66),
            textFormat: { foregroundColor: rgb(196, 167, 255), bold: true, fontSize: 14 },
            horizontalAlignment: 'LEFT',
            verticalAlignment: 'MIDDLE',
            padding: { top: 6, right: 8, bottom: 6, left: 8 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,padding)',
      },
    },
    // Meta row (row 2)
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(245, 243, 255),
            textFormat: { foregroundColor: rgb(100, 80, 140), fontSize: 9 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    // Header row (row 3, 0-indexed 2)
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: HEADER_ROW, endRowIndex: HEADER_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(49, 28, 98),
            textFormat: { foregroundColor: rgb(237, 224, 255), bold: true, fontSize: 10 },
            horizontalAlignment: 'LEFT',
            verticalAlignment: 'MIDDLE',
            padding: { top: 4, right: 6, bottom: 4, left: 6 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,padding)',
      },
    },
    // Data rows — wrap text, zebra background handled per-row below
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: DATA_START, endRowIndex: DATA_START + numRows, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            wrapStrategy: 'WRAP',
            verticalAlignment: 'TOP',
            textFormat: { fontSize: 10 },
            padding: { top: 4, right: 6, bottom: 4, left: 6 },
          },
        },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,textFormat,padding)',
      },
    },
  ];

  // Color-code the Status column (column C = index 2) per row
  items.forEach((it, i) => {
    const st = statuses.find(s => s.key === it.status);
    const color = st ? hexToColor(st.color) : rgb(100, 116, 139);
    // Light background derived from the status color
    const bg = { red: color.red * 0.15 + 0.85, green: color.green * 0.15 + 0.85, blue: color.blue * 0.15 + 0.85 };
    requests.push({
      repeatCell: {
        range: {
          sheetId: 0,
          startRowIndex: DATA_START + i,
          endRowIndex: DATA_START + i + 1,
          startColumnIndex: 2,
          endColumnIndex: 3,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: bg,
            textFormat: { foregroundColor: color, bold: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });
  });

  // Column widths
  const widths = [
    260, // Title
    150, // Scheduled for
    100, // Status
    200, // Channels
    150, // Tags
    360, // Notes
    80,  // Recurring
    80,  // Has Script
    80,  // From Idea
  ];
  widths.forEach((w, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: 0, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  });
  // Custom columns default to 140px
  for (let i = 9; i < COLS; i++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: 0, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: 140 },
        fields: 'pixelSize',
      },
    });
  }

  // Enable basic filter over header + data
  requests.push({
    setBasicFilter: {
      filter: {
        range: {
          sheetId: 0,
          startRowIndex: HEADER_ROW,
          endRowIndex: DATA_START + numRows,
          startColumnIndex: 0,
          endColumnIndex: COLS,
        },
      },
    },
  });

  const fmtRes = await sheetsPost(
    `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`,
    accessToken,
    { requests },
  );
  if (!fmtRes.ok) {
    console.warn('Schedule sheet formatting partially failed:', (await fmtRes.text()).slice(0, 200));
  }

  return {
    spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}
