/**
 * Google Sheets export for niche favorites.
 *
 * Builds a 2- or 3-sheet workbook (Summary + Briefs, optionally a flat
 * Proof Videos sheet) modeled on the schedule export pattern at
 * `google-sheets-schedule.ts`:
 *   - Title bar merged across columns, dark purple bg.
 *   - Meta row below with model + monthly spend context.
 *   - Inline "Read me first" glossary so a non-technical viewer
 *     understands Niche / Outlier / Promise score / Confidence labels
 *     without a tour (council Outsider fix).
 *   - Frozen header, basic filter, per-status background tinting,
 *     promise-score heat band (red → amber → green).
 *   - Inline YouTube thumbnails via `=IMAGE("https://i.ytimg.com/…",1)`
 *     in the Top proof video column.
 *
 * Three call modes:
 *   - 'all'      — entire workspace's favorites in one workbook
 *                  (includes the Proof Videos sheet).
 *   - 'single'   — one favorite + its proof videos in a compact workbook.
 *   - 'compare'  — 2–3 favorites side by side; Proof Videos sheet omitted.
 *
 * Public function: `createFavoritesSheet(accessToken, data)` returns
 * `{ spreadsheetId, sheetUrl }`. Routes wrap it with auth + rate limit.
 */
import type { NicheFavoriteWithVideos } from './niche-finder/favorites';
import type { BriefRow } from './niche-finder/brief-db';
import { isPlaceholderScores } from './niche-finder/favorites';
import { getModelById } from './ai-models';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

interface Color {
  red: number;
  green: number;
  blue: number;
}
function rgb(r: number, g: number, b: number): Color {
  return { red: r / 255, green: g / 255, blue: b / 255 };
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

export type FavoritesSheetMode = 'all' | 'single' | 'compare';

export interface FavoritesSheetInput {
  /** Display label for the workspace (used in the title bar). */
  workspaceLabel: string;
  favorites: NicheFavoriteWithVideos[];
  /** Most-recent 'ready' brief per niche slug. Null when the niche has
   *  no brief yet — the Briefs sheet renders a stub row. */
  briefsByNicheSlug: Record<string, BriefRow | null>;
  /** Workspace's current-month brief spend in USD. Surfaced on the
   *  meta row + the glossary so a sharer understands the cost basis. */
  monthlySpendUsd: number;
  mode: FavoritesSheetMode;
}

export async function createFavoritesSheet(
  accessToken: string,
  data: FavoritesSheetInput,
): Promise<{ spreadsheetId: string; sheetUrl: string }> {
  const { favorites, briefsByNicheSlug, mode, workspaceLabel, monthlySpendUsd } = data;

  // ── 1. Create the spreadsheet with two (or three) sheets. ──────────────
  const includeVideosSheet = mode === 'all' && favorites.some((f) => f.videos.length > 0);

  const summarySheetId = 0;
  const briefsSheetId = 1;
  const videosSheetId = 2;

  const sheets: SheetSpec[] = [
    {
      properties: {
        sheetId: summarySheetId,
        title: 'Summary',
        gridProperties: {
          rowCount: Math.max(60, favorites.length + GLOSSARY_ROW_COUNT + 8),
          columnCount: SUMMARY_HEADERS.length,
          frozenRowCount: SUMMARY_HEADER_ROW + 1,
        },
      },
    },
    {
      properties: {
        sheetId: briefsSheetId,
        title: 'Briefs',
        gridProperties: {
          rowCount: Math.max(80, favorites.length * BRIEF_BLOCK_HEIGHT + 8),
          columnCount: BRIEF_COL_COUNT,
        },
      },
    },
  ];
  if (includeVideosSheet) {
    const totalVideos = favorites.reduce((sum, f) => sum + f.videos.length, 0);
    sheets.push({
      properties: {
        sheetId: videosSheetId,
        title: 'Proof videos',
        gridProperties: {
          rowCount: Math.max(40, totalVideos + 4),
          columnCount: VIDEOS_HEADERS.length,
          frozenRowCount: 2,
        },
      },
    });
  }

  const title = buildWorkbookTitle(mode, workspaceLabel, favorites);

  const createRes = await sheetsPost(SHEETS_BASE, accessToken, {
    properties: { title },
    sheets,
  });
  await assertOk(createRes, 'Create spreadsheet');
  const { spreadsheetId } = (await createRes.json()) as { spreadsheetId: string };

  // ── 2. Write values into each sheet. ───────────────────────────────────
  await writeSummary(spreadsheetId, accessToken, favorites, briefsByNicheSlug, monthlySpendUsd, workspaceLabel, mode);
  await writeBriefs(spreadsheetId, accessToken, favorites, briefsByNicheSlug);
  if (includeVideosSheet) {
    await writeProofVideos(spreadsheetId, accessToken, favorites);
  }

  // ── 3. Formatting. ─────────────────────────────────────────────────────
  const formatRequests: unknown[] = [];
  formatRequests.push(...summaryFormatRequests(favorites, briefsByNicheSlug));
  formatRequests.push(...briefsFormatRequests(favorites, briefsByNicheSlug, briefsSheetId));
  if (includeVideosSheet) {
    formatRequests.push(...videosFormatRequests(favorites, videosSheetId));
  }

  const fmtRes = await sheetsPost(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, accessToken, {
    requests: formatRequests,
  });
  if (!fmtRes.ok) {
    const detail = (await fmtRes.text()).slice(0, 300);
    // Formatting failures are non-fatal — values already wrote. Surface
    // a warning header so the caller can log it.
    console.warn('niche-favorites sheet: formatting partially failed —', detail);
  }

  // ── 4. Write IMAGE() formulas for thumbnails AFTER core write. ─────────
  // We use a separate values:batchUpdate with USER_ENTERED so the formula
  // is evaluated by Sheets rather than stored as literal text. This
  // mirrors the production-doc IMAGE() pattern.
  await writeThumbnailFormulas(
    spreadsheetId,
    accessToken,
    favorites,
    includeVideosSheet,
  );

  return {
    spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

// ---------------------------------------------------------------------------
// Layout constants.
// ---------------------------------------------------------------------------

const SUMMARY_HEADERS = [
  'Niche',
  'Status',
  'Promise',
  'Verdict',
  'Outcome',
  'Headline',
  'Demand',
  'Crowdedness',
  'Monetization $/1k',
  'Fit',
  'Brief confidence',
  'Videos saved',
  'Top proof video',
  'Recommended angle',
  'Notes',
  'Brief updated',
] as const;

/** Glossary block lives between the meta row and the data header. */
const GLOSSARY_ENTRIES: ReadonlyArray<[string, string]> = [
  [
    'Niche',
    'A topic + audience cluster on YouTube where the same kind of viewer watches the same kind of video.',
  ],
  [
    'Outlier video',
    "A video that punches above its channel's size — views ÷ subscribers far above 1. Signals demand the operator's channel could capture.",
  ],
  [
    'Niche Brief',
    "An AI-written promise memo explaining whether this operator can win this niche, with confidence labels per section. Generated on demand; the model is configurable per workspace.",
  ],
  [
    'Promise score',
    '0–100. Red <40 = weak. Amber 40–69 = marginal/solid. Green ≥70 = strong.',
  ],
  [
    'Confidence labels',
    'low / medium / high — the AI flags each section by how solid its sources were. "low" appears more than feels comfortable; that is by design (the operator should not trust over-claiming).',
  ],
  [
    'Source quality',
    'high = primary or authoritative source. medium = community signal (Reddit, HN). low = likely SEO blogspam / listicle.',
  ],
];

const TITLE_ROW = 0; // row 1 in A1 notation
const META_ROW = 1; // row 2
const GLOSSARY_TITLE_ROW = 2; // row 3 — "Read me first" header
const GLOSSARY_FIRST_ENTRY_ROW = 3; // rows 4 to 4 + len-1
const GLOSSARY_ROW_COUNT = 1 + GLOSSARY_ENTRIES.length; // title + entries
const SEPARATOR_ROW_AFTER_GLOSSARY = GLOSSARY_TITLE_ROW + GLOSSARY_ROW_COUNT; // blank row
const SUMMARY_HEADER_ROW = SEPARATOR_ROW_AFTER_GLOSSARY + 1; // row index
const SUMMARY_DATA_START_ROW = SUMMARY_HEADER_ROW + 1;

const BRIEF_COL_COUNT = 4; // Label | Value | (spacer) | confidence
const BRIEF_BLOCK_HEIGHT = 14; // header + 8 sections + citation lead + buffer

const VIDEOS_HEADERS = [
  'Niche',
  'Video title',
  'Channel',
  'Subs',
  'Views',
  'Outlier ×',
  'Class',
  'Thumbnail',
  'Link',
  'Published',
  'Status',
] as const;

// ---------------------------------------------------------------------------
// Cell shapes.
// ---------------------------------------------------------------------------

interface SheetSpec {
  properties: {
    sheetId: number;
    title: string;
    gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number };
  };
}

// ---------------------------------------------------------------------------
// Helpers — copied / adapted from google-sheets-schedule.ts.
// ---------------------------------------------------------------------------

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
  if (
    res.status === 403 &&
    (body.includes('insufficient') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))
  ) {
    throw new Error(
      'NEEDS_REAUTH: Your connected Google account does not have Google Sheets access. Please reconnect.',
    );
  }
  throw new Error(`${context} failed (${res.status}): ${body.slice(0, 300)}`);
}

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

function buildWorkbookTitle(
  mode: FavoritesSheetMode,
  workspaceLabel: string,
  favorites: NicheFavoriteWithVideos[],
): string {
  const date = new Date().toISOString().slice(0, 10);
  if (mode === 'single' && favorites.length === 1) {
    return `Niche favorite — ${favorites[0].niche_name} (${date})`;
  }
  if (mode === 'compare') {
    return `Niche favorites — compare ${favorites.length} (${date})`;
  }
  return `Niche favorites — ${workspaceLabel} (${date})`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function monetizationText(f: NicheFavoriteWithVideos): string {
  if (isPlaceholderScores(f.scores)) return '';
  const lo = f.scores.monetization.lowUsdPerMille;
  const hi = f.scores.monetization.highUsdPerMille;
  if (lo === 0 && hi === 0) return '';
  return `$${lo.toFixed(0)}–$${hi.toFixed(0)}`;
}

function topProofVideo(f: NicheFavoriteWithVideos) {
  return f.videos.find((v) => !v.is_removed_upstream) ?? null;
}

function avgConfidenceLabel(brief: BriefRow | null): string {
  if (!brief) return '';
  const c = brief.section_confidences;
  const order: ('low' | 'medium' | 'high')[] = ['low', 'medium', 'high'];
  const counts = { low: 0, medium: 0, high: 0 };
  for (const k of Object.keys(c) as (keyof typeof c)[]) {
    const v = c[k];
    if (v === 'low' || v === 'medium' || v === 'high') counts[v]++;
  }
  // Pick the most-common bucket; ties resolve downward (more honest).
  let best: 'low' | 'medium' | 'high' = 'low';
  let bestCount = -1;
  for (const k of order) {
    if (counts[k] > bestCount) {
      bestCount = counts[k];
      best = k;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Summary sheet — write values + formatting.
// ---------------------------------------------------------------------------

async function writeSummary(
  spreadsheetId: string,
  accessToken: string,
  favorites: NicheFavoriteWithVideos[],
  briefsBySlug: Record<string, BriefRow | null>,
  monthlySpendUsd: number,
  workspaceLabel: string,
  mode: FavoritesSheetMode,
): Promise<void> {
  const titleText = buildSummaryTitleText(mode, workspaceLabel, favorites);
  const metaText = `${favorites.length} niche${favorites.length === 1 ? '' : 's'} · Generated ${new Date().toLocaleString()} · Workspace brief spend this month: $${monthlySpendUsd.toFixed(2)}`;

  const rows: (string | number)[][] = [];

  // Row 1: title (merged); only the first cell holds text.
  rows.push([titleText]);
  // Row 2: meta
  rows.push([metaText]);
  // Row 3: glossary title (merged)
  rows.push(['Read me first']);
  // Rows 4..: glossary entries
  for (const [k, v] of GLOSSARY_ENTRIES) {
    rows.push([k, v]);
  }
  // Separator row
  rows.push(['']);
  // Header row
  rows.push([...SUMMARY_HEADERS]);
  // Data rows
  for (const f of favorites) {
    const brief = briefsBySlug[f.niche_slug] ?? null;
    const proof = topProofVideo(f);
    const placeholder = isPlaceholderScores(f.scores);
    rows.push([
      f.niche_name,
      f.status,
      brief ? `${brief.promise_score}/100 (${brief.promise_label})` : '',
      f.verdict ?? '',
      f.outcome ?? '',
      brief?.sections.headline ?? (placeholder ? 'Scores pending — run a deep-dive to populate.' : ''),
      placeholder ? '' : f.scores.demand.label,
      placeholder ? '' : f.scores.supply.label,
      monetizationText(f),
      placeholder ? '' : f.scores.fit.label,
      avgConfidenceLabel(brief),
      f.videos.filter((v) => !v.is_removed_upstream).length,
      proof ? `${proof.title}` : '', // overwritten by IMAGE() formula in step 4
      brief?.sections.recommended_angle ?? '',
      f.notes ?? '',
      brief ? fmtDate(brief.generated_at) : '',
    ]);
  }

  const lastCol = colToA1(SUMMARY_HEADERS.length);
  const range = `Summary!A1:${lastCol}${rows.length}`;
  const res = await sheetsPut(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    accessToken,
    { range, majorDimension: 'ROWS', values: rows },
  );
  await assertOk(res, 'Write Summary values');
}

function buildSummaryTitleText(
  mode: FavoritesSheetMode,
  workspaceLabel: string,
  favorites: NicheFavoriteWithVideos[],
): string {
  if (mode === 'single' && favorites.length === 1) {
    return `Niche favorite — ${favorites[0].niche_name}`;
  }
  if (mode === 'compare') {
    const names = favorites.map((f) => f.niche_name).join(' vs ');
    return `Compare: ${names}`;
  }
  return `Niche favorites — ${workspaceLabel}`;
}

function summaryFormatRequests(
  favorites: NicheFavoriteWithVideos[],
  briefsBySlug: Record<string, BriefRow | null>,
): unknown[] {
  const COLS = SUMMARY_HEADERS.length;
  const NUM = favorites.length;
  const out: unknown[] = [];

  // Title row: merged + dark purple bg.
  out.push(
    {
      mergeCells: {
        range: { sheetId: 0, startRowIndex: TITLE_ROW, endRowIndex: TITLE_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: TITLE_ROW, endRowIndex: TITLE_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
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
    // Meta row (also merged for readability).
    {
      mergeCells: {
        range: { sheetId: 0, startRowIndex: META_ROW, endRowIndex: META_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: META_ROW, endRowIndex: META_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(245, 243, 255),
            textFormat: { foregroundColor: rgb(100, 80, 140), fontSize: 10 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
  );

  // Glossary title row (merged).
  out.push(
    {
      mergeCells: {
        range: { sheetId: 0, startRowIndex: GLOSSARY_TITLE_ROW, endRowIndex: GLOSSARY_TITLE_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: GLOSSARY_TITLE_ROW, endRowIndex: GLOSSARY_TITLE_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(252, 232, 191), // amber tint
            textFormat: { foregroundColor: rgb(110, 60, 20), bold: true, fontSize: 11 },
            padding: { top: 4, right: 8, bottom: 4, left: 8 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,padding)',
      },
    },
    // Glossary body rows — light bg, label cell bold.
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: GLOSSARY_FIRST_ENTRY_ROW, endRowIndex: GLOSSARY_FIRST_ENTRY_ROW + GLOSSARY_ENTRIES.length, startColumnIndex: 0, endColumnIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(255, 250, 235),
            textFormat: { foregroundColor: rgb(80, 60, 30), bold: true, fontSize: 10 },
            padding: { top: 2, right: 6, bottom: 2, left: 8 },
            verticalAlignment: 'TOP',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,padding,verticalAlignment)',
      },
    },
    {
      // Merge label column 0 alone to width 1; value spans 1..COLS-1.
      mergeCells: {
        range: { sheetId: 0, startRowIndex: GLOSSARY_FIRST_ENTRY_ROW, endRowIndex: GLOSSARY_FIRST_ENTRY_ROW + GLOSSARY_ENTRIES.length, startColumnIndex: 1, endColumnIndex: COLS },
        mergeType: 'MERGE_ROWS',
      },
    },
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: GLOSSARY_FIRST_ENTRY_ROW, endRowIndex: GLOSSARY_FIRST_ENTRY_ROW + GLOSSARY_ENTRIES.length, startColumnIndex: 1, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(255, 250, 235),
            textFormat: { foregroundColor: rgb(80, 60, 30), fontSize: 10 },
            wrapStrategy: 'WRAP',
            verticalAlignment: 'TOP',
            padding: { top: 2, right: 8, bottom: 2, left: 6 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment,padding)',
      },
    },
  );

  // Header row.
  out.push({
    repeatCell: {
      range: { sheetId: 0, startRowIndex: SUMMARY_HEADER_ROW, endRowIndex: SUMMARY_HEADER_ROW + 1, startColumnIndex: 0, endColumnIndex: COLS },
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
  });

  // Data rows: WRAP + top-align.
  if (NUM > 0) {
    out.push({
      repeatCell: {
        range: { sheetId: 0, startRowIndex: SUMMARY_DATA_START_ROW, endRowIndex: SUMMARY_DATA_START_ROW + NUM, startColumnIndex: 0, endColumnIndex: COLS },
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
    });
  }

  // Per-row status colored cell + promise heat band.
  favorites.forEach((f, i) => {
    const sheetRow = SUMMARY_DATA_START_ROW + i;
    const statusColor = STATUS_HEX[f.status] ?? '#64748b';
    const lightStatus = hexToLightBg(statusColor);
    out.push({
      repeatCell: {
        range: { sheetId: 0, startRowIndex: sheetRow, endRowIndex: sheetRow + 1, startColumnIndex: 1, endColumnIndex: 2 },
        cell: {
          userEnteredFormat: {
            backgroundColor: lightStatus,
            textFormat: { foregroundColor: hexToColor(statusColor), bold: true },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    });

    const brief = briefsBySlug[f.niche_slug] ?? null;
    if (brief) {
      const band = promiseHeatBg(brief.promise_score);
      out.push({
        repeatCell: {
          range: { sheetId: 0, startRowIndex: sheetRow, endRowIndex: sheetRow + 1, startColumnIndex: 2, endColumnIndex: 3 },
          cell: {
            userEnteredFormat: {
              backgroundColor: band.bg,
              textFormat: { foregroundColor: band.fg, bold: true },
              horizontalAlignment: 'CENTER',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
        },
      });
    }

    // Confidence column tint.
    const conf = avgConfidenceLabel(brief);
    if (conf) {
      const ct = confidenceTint(conf as 'low' | 'medium' | 'high');
      out.push({
        repeatCell: {
          range: { sheetId: 0, startRowIndex: sheetRow, endRowIndex: sheetRow + 1, startColumnIndex: 10, endColumnIndex: 11 },
          cell: {
            userEnteredFormat: {
              backgroundColor: ct.bg,
              textFormat: { foregroundColor: ct.fg, bold: true },
              horizontalAlignment: 'CENTER',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
        },
      });
    }
  });

  // Column widths.
  const widths = [220, 100, 110, 90, 110, 320, 100, 110, 130, 90, 110, 90, 180, 320, 280, 110];
  widths.forEach((w, i) => {
    out.push({
      updateDimensionProperties: {
        range: { sheetId: 0, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  });

  // Row height tweak: data rows get taller so the thumbnail IMAGE() has room.
  if (NUM > 0) {
    out.push({
      updateDimensionProperties: {
        range: { sheetId: 0, dimension: 'ROWS', startIndex: SUMMARY_DATA_START_ROW, endIndex: SUMMARY_DATA_START_ROW + NUM },
        properties: { pixelSize: 80 },
        fields: 'pixelSize',
      },
    });
  }

  // Basic filter over header + data.
  if (NUM > 0) {
    out.push({
      setBasicFilter: {
        filter: {
          range: { sheetId: 0, startRowIndex: SUMMARY_HEADER_ROW, endRowIndex: SUMMARY_DATA_START_ROW + NUM, startColumnIndex: 0, endColumnIndex: COLS },
        },
      },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Briefs sheet — one block per niche.
// ---------------------------------------------------------------------------

interface BriefBlockRange {
  /** 0-indexed start row of this niche's block. */
  start: number;
  /** Promise score for the header band color. */
  promiseScore: number;
  /** True if the niche has a 'ready' brief; affects rendering. */
  hasReady: boolean;
}

async function writeBriefs(
  spreadsheetId: string,
  accessToken: string,
  favorites: NicheFavoriteWithVideos[],
  briefsBySlug: Record<string, BriefRow | null>,
): Promise<void> {
  const rows: (string | number)[][] = [];
  // Sheet preamble.
  rows.push(['Niche Briefs']);
  rows.push(['Per-niche promise memos. Each section carries a confidence label (low/medium/high). "Low" is honest, not a defect.']);
  rows.push(['']);

  for (const f of favorites) {
    const brief = briefsBySlug[f.niche_slug] ?? null;
    rows.push([`${f.niche_name}`, brief ? `Promise ${brief.promise_score}/100 (${brief.promise_label})` : 'No brief yet', '', '']);
    if (brief) {
      rows.push(['Headline', brief.sections.headline, '', '']);
      rows.push(['Market demand', brief.sections.market_demand, '', brief.section_confidences.market_demand]);
      rows.push(['Competition', brief.sections.competition, '', brief.section_confidences.competition]);
      rows.push(['Monetization', brief.sections.monetization, '', brief.section_confidences.monetization]);
      rows.push(['Operator fit', brief.sections.operator_fit, '', brief.section_confidences.operator_fit]);
      rows.push(['Risks', brief.sections.risks, '', brief.section_confidences.risks]);
      rows.push(['Recommended angle', brief.sections.recommended_angle, '', brief.section_confidences.recommended_angle]);
      rows.push(['Next steps', (brief.sections.next_steps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n'), '', '']);
      const cites = (brief.citations ?? []).map((c) => {
        const q = c.domain_quality === 'high' ? '●' : c.domain_quality === 'medium' ? '◐' : '○';
        const safeUrl = c.url.replace(/"/g, '%22');
        const label = (c.title ?? c.domain).replace(/"/g, "'");
        return `${q} =HYPERLINK("${safeUrl}","${label}")`;
      });
      if (cites.length > 0) {
        // Each citation row carries the formula in column B (Value).
        rows.push(['Sources', '', '', '']);
        for (const cite of cites) {
          rows.push(['', cite, '', '']);
        }
      }
      const model = getModelById(brief.model_id);
      rows.push([
        'Generated',
        `${fmtDate(brief.generated_at)} · ${model?.name ?? brief.model_id}${brief.cost_usd != null ? ` · $${brief.cost_usd.toFixed(3)}` : ''}`,
        '',
        '',
      ]);
    } else {
      rows.push([
        'No brief yet',
        isPlaceholderScores(f.scores)
          ? 'Run a deep-dive on this niche so demand/competition/monetization signals are real, then generate a brief.'
          : 'Click "Generate brief" in the Favorites tab to write one.',
        '',
        '',
      ]);
    }
    rows.push(['']);
    rows.push(['']);
  }

  const lastCol = colToA1(BRIEF_COL_COUNT);
  const range = `Briefs!A1:${lastCol}${rows.length}`;
  const res = await sheetsPut(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    accessToken,
    { range, majorDimension: 'ROWS', values: rows },
  );
  await assertOk(res, 'Write Briefs values');
}

function briefsFormatRequests(
  favorites: NicheFavoriteWithVideos[],
  briefsBySlug: Record<string, BriefRow | null>,
  sheetId: number,
): unknown[] {
  const out: unknown[] = [];
  // Title row.
  out.push(
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: BRIEF_COL_COUNT },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: BRIEF_COL_COUNT },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(30, 14, 66),
            textFormat: { foregroundColor: rgb(196, 167, 255), bold: true, fontSize: 14 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: BRIEF_COL_COUNT },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: BRIEF_COL_COUNT },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(245, 243, 255),
            textFormat: { foregroundColor: rgb(100, 80, 140), fontSize: 10, italic: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
  );

  // Track each block's row range so we can color its header band.
  const blocks: BriefBlockRange[] = [];
  let cursor = 3; // After title + meta + spacer.
  for (const f of favorites) {
    const brief = briefsBySlug[f.niche_slug] ?? null;
    blocks.push({ start: cursor, promiseScore: brief?.promise_score ?? 0, hasReady: !!brief });
    // Compute block height (must mirror writeBriefs() exactly).
    let height = 1; // header
    if (brief) {
      height += 8; // headline + 6 sections + next steps
      if (brief.citations && brief.citations.length > 0) {
        height += 1 + brief.citations.length; // Sources header + items
      }
      height += 1; // Generated stamp
    } else {
      height += 1; // No brief yet row
    }
    height += 2; // spacers
    cursor += height;
  }

  for (const b of blocks) {
    const band = b.hasReady ? promiseHeatBg(b.promiseScore) : { bg: rgb(40, 40, 50), fg: rgb(180, 180, 200) };
    out.push(
      // Block header row — niche name + promise band.
      {
        repeatCell: {
          range: { sheetId, startRowIndex: b.start, endRowIndex: b.start + 1, startColumnIndex: 0, endColumnIndex: BRIEF_COL_COUNT },
          cell: {
            userEnteredFormat: {
              backgroundColor: band.bg,
              textFormat: { foregroundColor: band.fg, bold: true, fontSize: 12 },
              padding: { top: 6, right: 8, bottom: 6, left: 8 },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,padding)',
        },
      },
      // Label column — bold, narrow.
      {
        repeatCell: {
          range: { sheetId, startRowIndex: b.start + 1, endRowIndex: b.start + 12, startColumnIndex: 0, endColumnIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { foregroundColor: rgb(80, 60, 30), bold: true, fontSize: 10 },
              verticalAlignment: 'TOP',
              padding: { top: 4, right: 6, bottom: 4, left: 8 },
            },
          },
          fields: 'userEnteredFormat(textFormat,verticalAlignment,padding)',
        },
      },
      // Value column wraps.
      {
        repeatCell: {
          range: { sheetId, startRowIndex: b.start + 1, endRowIndex: b.start + 14, startColumnIndex: 1, endColumnIndex: 2 },
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
      // Confidence column (col 3) — colored pill per row.
      {
        repeatCell: {
          range: { sheetId, startRowIndex: b.start + 1, endRowIndex: b.start + 12, startColumnIndex: 3, endColumnIndex: 4 },
          cell: {
            userEnteredFormat: {
              wrapStrategy: 'WRAP',
              verticalAlignment: 'TOP',
              textFormat: { fontSize: 9, bold: true },
              horizontalAlignment: 'CENTER',
              padding: { top: 4, right: 6, bottom: 4, left: 6 },
            },
          },
          fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,textFormat,horizontalAlignment,padding)',
        },
      },
    );
  }

  // Column widths.
  const widths = [180, 480, 12, 110];
  widths.forEach((w, i) => {
    out.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Proof Videos sheet (mode='all' only).
// ---------------------------------------------------------------------------

async function writeProofVideos(
  spreadsheetId: string,
  accessToken: string,
  favorites: NicheFavoriteWithVideos[],
): Promise<void> {
  const rows: (string | number)[][] = [];
  rows.push(['Proof videos']);
  rows.push([...VIDEOS_HEADERS]);
  for (const f of favorites) {
    for (const v of f.videos) {
      rows.push([
        f.niche_name,
        v.title,
        v.channel_title ?? '',
        v.subscriber_count ?? '',
        v.view_count ?? '',
        v.outlier_score == null ? '' : Number(v.outlier_score.toFixed(2)),
        v.classification ?? '',
        '', // overwritten by IMAGE() in step 4
        `=HYPERLINK("https://www.youtube.com/watch?v=${v.video_id}","watch")`,
        fmtDate(v.published_at),
        v.is_removed_upstream ? 'removed' : 'live',
      ]);
    }
  }

  const lastCol = colToA1(VIDEOS_HEADERS.length);
  const range = `'Proof videos'!A1:${lastCol}${rows.length}`;
  const res = await sheetsPut(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    accessToken,
    { range, majorDimension: 'ROWS', values: rows },
  );
  await assertOk(res, 'Write Proof videos values');
}

function videosFormatRequests(
  favorites: NicheFavoriteWithVideos[],
  sheetId: number,
): unknown[] {
  const COLS = VIDEOS_HEADERS.length;
  const out: unknown[] = [];

  // Title row merged.
  out.push(
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: COLS },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(30, 14, 66),
            textFormat: { foregroundColor: rgb(196, 167, 255), bold: true, fontSize: 14 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    // Header row.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: COLS },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(49, 28, 98),
            textFormat: { foregroundColor: rgb(237, 224, 255), bold: true, fontSize: 10 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
  );

  const totalRows = favorites.reduce((sum, f) => sum + f.videos.length, 0);
  if (totalRows > 0) {
    out.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 2 + totalRows, startColumnIndex: 0, endColumnIndex: COLS },
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
    });
    out.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 2 + totalRows },
        properties: { pixelSize: 70 },
        fields: 'pixelSize',
      },
    });
  }

  const widths = [200, 360, 180, 80, 100, 90, 100, 130, 110, 110, 80];
  widths.forEach((w, i) => {
    out.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// IMAGE() formulas — written via a second values:batchUpdate so the
// formula is evaluated rather than literal.
// ---------------------------------------------------------------------------

async function writeThumbnailFormulas(
  spreadsheetId: string,
  accessToken: string,
  favorites: NicheFavoriteWithVideos[],
  includeVideosSheet: boolean,
): Promise<void> {
  const updates: { range: string; values: string[][] }[] = [];

  // Summary sheet — column M (index 12) holds Top proof video thumbnail.
  const topProofCol = colToA1(13); // 1-indexed col M
  favorites.forEach((f, i) => {
    const proof = topProofVideo(f);
    if (!proof) return;
    const url = thumbnailUrlForVideo(proof.video_id, proof.thumbnail_url);
    if (!url) return;
    const sheetRow = SUMMARY_DATA_START_ROW + i + 1; // A1 1-indexed
    const safe = url.replace(/"/g, '%22');
    updates.push({
      range: `Summary!${topProofCol}${sheetRow}`,
      values: [[`=IMAGE("${safe}",1)`]],
    });
  });

  // Proof videos sheet — column H (index 7) holds thumbnail.
  if (includeVideosSheet) {
    const thumbCol = colToA1(8); // 1-indexed col H
    let r = 3; // header is row 2, first data row is 3 (1-indexed)
    for (const f of favorites) {
      for (const v of f.videos) {
        const url = thumbnailUrlForVideo(v.video_id, v.thumbnail_url);
        if (url) {
          const safe = url.replace(/"/g, '%22');
          updates.push({
            range: `'Proof videos'!${thumbCol}${r}`,
            values: [[`=IMAGE("${safe}",1)`]],
          });
        }
        r++;
      }
    }
  }

  if (updates.length === 0) return;

  const res = await sheetsPost(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, accessToken, {
    valueInputOption: 'USER_ENTERED',
    data: updates,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.warn('niche-favorites sheet: thumbnail formula write failed —', detail);
  }
}

/** Build a thumbnail URL we can pass to IMAGE(). YouTube's
 *  `i.ytimg.com/vi/<id>/mqdefault.jpg` is the universally-available
 *  thumbnail; the cached `thumbnail_url` we stored may be the same or
 *  may be a different size — prefer the canonical mqdefault for
 *  predictable IMAGE() rendering. */
function thumbnailUrlForVideo(videoId: string, fallback: string | null): string | null {
  if (videoId && /^[A-Za-z0-9_-]{6,15}$/.test(videoId)) {
    return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
  }
  if (fallback && fallback.startsWith('https://')) return fallback;
  return null;
}

// ---------------------------------------------------------------------------
// Color helpers — mirror the schedule export's style.
// ---------------------------------------------------------------------------

const STATUS_HEX: Record<string, string> = {
  considering: '#f59e0b',
  committed: '#22c55e',
  parked: '#94a3b8',
  passed: '#64748b',
};

function hexToColor(hex: string): Color {
  const h = hex.replace('#', '');
  return rgb(parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16));
}

function hexToLightBg(hex: string): Color {
  const c = hexToColor(hex);
  return { red: c.red * 0.15 + 0.85, green: c.green * 0.15 + 0.85, blue: c.blue * 0.15 + 0.85 };
}

function promiseHeatBg(score: number): { bg: Color; fg: Color } {
  if (score >= 70) return { bg: rgb(220, 252, 231), fg: rgb(22, 101, 52) }; // green
  if (score >= 40) return { bg: rgb(254, 243, 199), fg: rgb(120, 53, 15) }; // amber
  return { bg: rgb(254, 226, 226), fg: rgb(127, 29, 29) }; // red
}

function confidenceTint(level: 'low' | 'medium' | 'high'): { bg: Color; fg: Color } {
  if (level === 'high') return { bg: rgb(220, 252, 231), fg: rgb(22, 101, 52) };
  if (level === 'medium') return { bg: rgb(254, 243, 199), fg: rgb(120, 53, 15) };
  return { bg: rgb(254, 226, 226), fg: rgb(127, 29, 29) };
}
