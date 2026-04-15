/**
 * Google Sheets API utility — creates and formats production documents as spreadsheets.
 * Uses the REST API directly (no client library).
 */

export interface SheetsRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  on_screen_text: string;
  notes: string;
  imageUrl?: string;
  searchUrl?: string;
}

export interface SheetsExportInput {
  title: string;
  niche: string;
  totalDuration: string;
  totalWords: number;
  speakingPaceWpm: number;
  rows: SheetsRow[];
}

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// Visual type color palette — light background, matching text
const VT_COLORS: Record<string, { bg: Color; text: Color }> = {
  'Title Card':       { bg: rgb(237, 233, 254), text: rgb(109, 40, 217) },
  'B-Roll':           { bg: rgb(207, 250, 254), text: rgb(14, 116, 144) },
  'Talking Head':     { bg: rgb(209, 250, 229), text: rgb(4, 120, 87) },
  'Screen Recording': { bg: rgb(254, 243, 199), text: rgb(180, 83, 9) },
  'Animation':        { bg: rgb(252, 231, 243), text: rgb(157, 23, 77) },
  'Lower Third':      { bg: rgb(219, 234, 254), text: rgb(29, 78, 216) },
  'Statistics':       { bg: rgb(254, 226, 226), text: rgb(185, 28, 28) },
  'Cutaway':          { bg: rgb(243, 244, 246), text: rgb(55, 65, 81) },
};

// Color helpers
interface Color { red: number; green: number; blue: number }
function rgb(r: number, g: number, b: number): Color {
  return { red: r / 255, green: g / 255, blue: b / 255 };
}
const WHITE  = rgb(255, 255, 255);
const NEAR_WHITE = rgb(250, 250, 252);
const LIGHT_GRAY = rgb(241, 241, 247);
const HEADER_BG  = rgb(49, 28, 98);    // deep purple
const HEADER_FG  = rgb(237, 224, 255); // lavender white
const TITLE_BG   = rgb(30, 14, 66);    // very dark purple
const TITLE_FG   = rgb(196, 167, 255); // soft purple
const META_BG    = rgb(245, 243, 255);
const META_FG    = rgb(100, 80, 140);
const BORDER_CLR = rgb(220, 210, 240);
const TIMECODE_FG = rgb(14, 116, 144); // teal

// --- Sheets API helpers ---

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
  // Detect missing scope
  if (res.status === 403) {
    const isScope = body.includes('insufficient') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    if (isScope) {
      throw new Error(
        'NEEDS_REAUTH: Your connected Google account does not have Google Sheets access. ' +
        'Please re-authorize your channel to add Sheets permissions.',
      );
    }
  }
  throw new Error(`${context} failed (${res.status}): ${body.slice(0, 300)}`);
}

// --- Main export function ---

export async function createProductionDocSheet(
  accessToken: string,
  data: SheetsExportInput,
): Promise<{ spreadsheetId: string; sheetUrl: string }> {
  const sheetId = 0;
  const HEADER_ROW = 3; // 0-indexed (row 4 in Sheets = col headers)
  const DATA_START = 4; // 0-indexed (row 5+ in Sheets = data)
  const numDataRows = data.rows.length;
  const COLS = 10;

  // ── 1. Create spreadsheet ──────────────────────────────────────────────────
  const createRes = await sheetsPost(SHEETS_BASE, accessToken, {
    properties: { title: `Production Doc: ${data.title}` },
    sheets: [{
      properties: {
        sheetId,
        title: 'Production Document',
        gridProperties: {
          rowCount: numDataRows + DATA_START + 5,
          columnCount: COLS,
          frozenRowCount: DATA_START, // freeze title + meta + header
        },
      },
    }],
  });
  await assertOk(createRes, 'Create spreadsheet');
  const { spreadsheetId } = await createRes.json() as { spreadsheetId: string };

  // ── 2. Write values ────────────────────────────────────────────────────────
  const HEADERS = [
    '#', 'Timecode', 'Script Text', 'Visual Type', 'Visual Description',
    'Stock Search Terms', 'Image', 'AI Image Prompt', 'On-Screen Text', 'Notes',
  ];

  const valueRows: (string | number)[][] = [
    // Row 1: Title (A1)
    [`Production Document: ${data.title}`],
    // Row 2: Metadata
    [
      `Niche: ${data.niche}`, '',
      `Duration: ${data.totalDuration}`, '',
      `${data.totalWords.toLocaleString()} words @ ${data.speakingPaceWpm} wpm`,
    ],
    // Row 3: Empty separator
    [],
    // Row 4: Column headers
    HEADERS,
    // Rows 5+: Data — image column left empty, filled with formulas below
    ...data.rows.map((r, i) => [
      i + 1,
      r.timecode,
      r.script_text,
      r.visual_type,
      r.visual_description,
      r.stock_search_terms,
      '', // image placeholder — overwritten with HYPERLINK formula
      r.ai_image_prompt,
      r.on_screen_text,
      r.notes,
    ]),
  ];

  const range = `A1:J${DATA_START + numDataRows}`;
  const valRes = await sheetsPut(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    accessToken,
    { range, majorDimension: 'ROWS', values: valueRows },
  );
  await assertOk(valRes, 'Write values');

  // ── 3. Write image/search hyperlinks via batchUpdate values ───────────────
  const hyperlinkUpdates: { range: string; values: string[][] }[] = [];
  data.rows.forEach((row, i) => {
    const sheetRow = DATA_START + i + 1; // 1-indexed for A1 notation
    const safeImageUrl = row.imageUrl ? safeHyperlinkUrl(row.imageUrl) : null;
    const safeSearchUrl = row.searchUrl ? safeHyperlinkUrl(row.searchUrl) : null;
    if (safeImageUrl) {
      hyperlinkUpdates.push({
        range: `G${sheetRow}`,
        values: [[`=HYPERLINK("${safeImageUrl}","View Image")`]],
      });
    } else if (safeSearchUrl) {
      hyperlinkUpdates.push({
        range: `G${sheetRow}`,
        values: [[`=HYPERLINK("${safeSearchUrl}","Search Images")`]],
      });
    }
  });

  if (hyperlinkUpdates.length > 0) {
    const hlRes = await sheetsPost(
      `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`,
      accessToken,
      { valueInputOption: 'USER_ENTERED', data: hyperlinkUpdates },
    );
    await assertOk(hlRes, 'Write hyperlinks');
  }

  // ── 4. Apply formatting ────────────────────────────────────────────────────
  const requests = buildFormatRequests(sheetId, HEADER_ROW, DATA_START, data.rows, COLS);
  const fmtRes = await sheetsPost(
    `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`,
    accessToken,
    { requests },
  );
  // Non-fatal: data is already written, formatting failure just means no styling
  if (!fmtRes.ok) {
    console.warn('Sheet formatting partially failed:', (await fmtRes.text()).slice(0, 200));
  }

  return {
    spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

// ── Format request builders ──────────────────────────────────────────────────

/** Validate and escape a URL for use inside a HYPERLINK formula string.
 *  Only http/https URLs are allowed. Returns null if the URL is unsafe. */
function safeHyperlinkUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null; // not a valid URL
  }
  // Escape double quotes so they cannot break out of the HYPERLINK("...") argument
  return url.replace(/"/g, '""');
}

function cellFmt(
  sheetId: number,
  r1: number, r2: number, c1: number, c2: number,
  fmt: Record<string, unknown>,
): unknown {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
      cell: { userEnteredFormat: fmt },
      fields: 'userEnteredFormat',
    },
  };
}

function rowHeight(sheetId: number, r1: number, r2: number, px: number): unknown {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: r1, endIndex: r2 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function colWidth(sheetId: number, c1: number, c2: number, px: number): unknown {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: c1, endIndex: c2 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function merge(sheetId: number, r1: number, r2: number, c1: number, c2: number): unknown {
  return {
    mergeCells: {
      range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
      mergeType: 'MERGE_ALL',
    },
  };
}

function border(sheetId: number, r1: number, r2: number, c1: number, c2: number, color: Color, width = 1): unknown {
  const s = { style: 'SOLID', color, width };
  return {
    updateBorders: {
      range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
      top: s, bottom: s, left: s, right: s,
      innerHorizontal: { style: 'SOLID', color: { ...color, red: color.red * 0.6 + 0.4, green: color.green * 0.6 + 0.4, blue: color.blue * 0.6 + 0.4 }, width: 1 },
      innerVertical: { style: 'SOLID', color: { ...color, red: color.red * 0.6 + 0.4, green: color.green * 0.6 + 0.4, blue: color.blue * 0.6 + 0.4 }, width: 1 },
    },
  };
}

function buildFormatRequests(
  sheetId: number,
  HEADER_ROW: number,
  DATA_START: number,
  rows: SheetsRow[],
  COLS: number,
): unknown[] {
  const reqs: unknown[] = [];
  const numRows = rows.length;

  // — Merge title row across all columns
  reqs.push(merge(sheetId, 0, 1, 0, COLS));

  // — Title row style
  reqs.push(cellFmt(sheetId, 0, 1, 0, COLS, {
    backgroundColor: TITLE_BG,
    textFormat: { foregroundColor: TITLE_FG, fontSize: 15, bold: true, fontFamily: 'Google Sans' },
    horizontalAlignment: 'CENTER',
    verticalAlignment: 'MIDDLE',
    padding: { top: 14, bottom: 14, left: 16, right: 16 },
  }));
  reqs.push(rowHeight(sheetId, 0, 1, 56));

  // — Metadata row style
  reqs.push(cellFmt(sheetId, 1, 2, 0, COLS, {
    backgroundColor: META_BG,
    textFormat: { foregroundColor: META_FG, fontSize: 9, fontFamily: 'Google Sans' },
    verticalAlignment: 'MIDDLE',
    padding: { top: 6, bottom: 6, left: 12, right: 12 },
  }));
  reqs.push(rowHeight(sheetId, 1, 2, 28));

  // — Empty separator row
  reqs.push(cellFmt(sheetId, 2, 3, 0, COLS, { backgroundColor: rgb(240, 236, 255) }));
  reqs.push(rowHeight(sheetId, 2, 3, 8));

  // — Header row style
  reqs.push(cellFmt(sheetId, HEADER_ROW, HEADER_ROW + 1, 0, COLS, {
    backgroundColor: HEADER_BG,
    textFormat: { foregroundColor: HEADER_FG, fontSize: 9, bold: true, fontFamily: 'Google Sans' },
    horizontalAlignment: 'CENTER',
    verticalAlignment: 'MIDDLE',
    wrapStrategy: 'WRAP',
    padding: { top: 8, bottom: 8, left: 8, right: 8 },
  }));
  reqs.push(rowHeight(sheetId, HEADER_ROW, HEADER_ROW + 1, 36));

  // — Column widths: #, Time, Script, VisType, VisDesc, Stock, Image, AIPrompt, OnScreen, Notes
  const widths = [36, 68, 230, 130, 190, 155, 110, 270, 135, 135];
  widths.forEach((px, c) => reqs.push(colWidth(sheetId, c, c + 1, px)));

  // — Data rows
  rows.forEach((row, i) => {
    const r = DATA_START + i;
    const isEven = i % 2 === 0;
    const rowBg = isEven ? WHITE : NEAR_WHITE;

    // Base row formatting — all columns
    reqs.push(cellFmt(sheetId, r, r + 1, 0, COLS, {
      backgroundColor: rowBg,
      textFormat: { foregroundColor: rgb(30, 30, 40), fontSize: 9, fontFamily: 'Google Sans' },
      verticalAlignment: 'TOP',
      wrapStrategy: 'WRAP',
      padding: { top: 5, bottom: 5, left: 7, right: 7 },
    }));

    // # column — right-aligned, muted
    reqs.push(cellFmt(sheetId, r, r + 1, 0, 1, {
      backgroundColor: isEven ? LIGHT_GRAY : rgb(234, 234, 240),
      textFormat: { foregroundColor: rgb(120, 120, 140), fontSize: 9, bold: true },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
    }));

    // Timecode — teal monospace, centered
    reqs.push(cellFmt(sheetId, r, r + 1, 1, 2, {
      textFormat: { foregroundColor: TIMECODE_FG, fontSize: 10, bold: true, fontFamily: 'Roboto Mono' },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
    }));

    // Visual type — color-coded badge
    const vt = VT_COLORS[row.visual_type];
    if (vt) {
      reqs.push(cellFmt(sheetId, r, r + 1, 3, 4, {
        backgroundColor: vt.bg,
        textFormat: { foregroundColor: vt.text, fontSize: 9, bold: true },
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'MIDDLE',
      }));
    }

    // Image column — center, blue link style
    reqs.push(cellFmt(sheetId, r, r + 1, 6, 7, {
      textFormat: { foregroundColor: rgb(59, 130, 246), fontSize: 9, underline: true },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
    }));

    // Row height — taller for script rows (wrapped text)
    const scriptLen = row.script_text.length;
    const estimatedHeight = Math.max(28, Math.min(120, Math.ceil(scriptLen / 40) * 16));
    reqs.push(rowHeight(sheetId, r, r + 1, estimatedHeight));
  });

  // — Outer border around the whole table (header + data)
  reqs.push(border(sheetId, HEADER_ROW, DATA_START + numRows, 0, COLS, BORDER_CLR, 2));

  // — Freeze rows (title + meta + separator + header = 4 rows)
  reqs.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: DATA_START },
      },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // — Tab color
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId, tabColorStyle: { rgbColor: rgb(124, 58, 237) } },
      fields: 'tabColorStyle',
    },
  });

  return reqs;
}
