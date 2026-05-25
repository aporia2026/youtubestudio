/**
 * "Ask Studio" — natural-language Q&A over the workspace's own data.
 *
 * The model runs a tool-use loop over a curated catalog of read-only
 * queries (channels, video_analytics, schedule_items, projects, ab_tests,
 * etc.). Every tool executor takes the workspaceId as an implicit first
 * argument that the model cannot override — so no matter what the model
 * tries, queries are always tenancy-scoped.
 *
 * Multi-provider: the loop dispatches to one of four runners based on the
 * model's provider + Kie endpoint type. The protocol detail lives in
 * `resolveAskStudioProtocol()`; the runners themselves are below
 * `runToolCall`. Adding a model to the registry without wiring its
 * protocol here will surface a clean 400 from the route validator instead
 * of a 502 from a mismatched SDK call.
 *
 * Hard limits:
 *   - MAX_TOOL_ITERATIONS caps the loop so a confused model can't burn
 *     unbounded tokens.
 *   - Each tool returns at most ROW_LIMIT_PER_TOOL_CALL rows of data.
 *   - The full conversation is persisted in `ask_studio_questions` for
 *     audit + future few-shot.
 *
 * Tools are listed bottom-up in `TOOL_CATALOG`. When you add a tool:
 *   1. Add the schema entry to TOOL_CATALOG with a precise input_schema.
 *   2. Add a case to runToolCall().
 *   3. Make sure the SQL is `WHERE workspace_id = $ws` — never trust the
 *      model to scope.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { getEffectiveModelId } from './model-defaults';
import {
  AI_MODELS,
  KIE_MODEL_MAP,
  getModelById,
  isAskStudioSupportedModel,
  type AIModel,
  type KieEndpointType,
} from './ai-models';

const MAX_TOOL_ITERATIONS = 6;
const ROW_LIMIT_PER_TOOL_CALL = 50;
const MAX_TOKENS_PER_ITERATION = 2000;
const TEMPERATURE = 0.2;
const KIE_BASE = 'https://api.kie.ai';

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_CATALOG: ToolSchema[] = [
  {
    name: 'list_channels',
    description: 'List every YouTube channel in this workspace with name, handle, subscriber count, and niche.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_recent_videos',
    description:
      'Recent published videos from video_analytics, newest first. Filter by channel and limit. Returns title, views, AVP, CTR, published_at.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: {
          type: 'number',
          description: 'Limit to videos published in the last N days. Default 90.',
        },
        channel_db_id: {
          type: 'string',
          description: 'UUID of a specific channel to filter by. Omit for all channels.',
        },
        limit: { type: 'number', description: '1-50, default 20' },
      },
    },
  },
  {
    name: 'list_underperforming_videos',
    description:
      'The bottom-performing videos by Average View Percentage (AVP), oldest first. Useful for "what underperformed last month?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Default 60' },
        max_avp_percentage: {
          type: 'number',
          description: 'Only include videos with AVP <= this %. Default 35.',
        },
        limit: { type: 'number', description: '1-50, default 10' },
      },
    },
  },
  {
    name: 'list_top_performers',
    description:
      'Best-performing videos by a chosen metric. Use for "what worked best?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['views', 'ctr_percentage', 'average_view_percentage', 'subscribers_gained'],
          description: 'Which metric to sort by, descending.',
        },
        days_back: { type: 'number', description: 'Default 90' },
        limit: { type: 'number', description: '1-25, default 10' },
      },
      required: ['metric'],
    },
  },
  {
    name: 'list_scheduled_items',
    description:
      'Videos scheduled for upload. Filter by status and date range. Returns title, scheduled_for, status, channel.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'e.g. "ready", "scripting", "recording"' },
        days_ahead: { type: 'number', description: 'Default 30' },
        days_back: { type: 'number', description: 'Default 14' },
        limit: { type: 'number', description: '1-50, default 25' },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'Projects in this workspace, optionally filtered by status. Returns title, niche, channel, created_at.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        limit: { type: 'number', description: '1-50, default 25' },
      },
    },
  },
  {
    name: 'list_ab_tests',
    description: 'Recent A/B title/thumbnail experiments. Returns variant titles + winner if concluded.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'running', 'concluded'] },
        limit: { type: 'number', description: '1-50, default 20' },
      },
    },
  },
  {
    name: 'count_uploads_by_channel',
    description:
      'Aggregate upload count per channel over the last N days. Useful for "which channel has been most active?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Default 90' },
      },
    },
  },
  {
    name: 'get_video_analytics',
    description:
      'Deep-dive on a single video: views, likes, comments, AVP, CTR, retention curve summary. Pass the YouTube video id.',
    input_schema: {
      type: 'object',
      properties: {
        youtube_video_id: { type: 'string' },
      },
      required: ['youtube_video_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executors — every one auto-scopes to workspaceId
// ---------------------------------------------------------------------------

interface ToolContext {
  workspaceId: string;
}

interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
}

export async function runToolCall(
  ctx: ToolContext,
  toolName: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  try {
    switch (toolName) {
      case 'list_channels': {
        const { rows } = await sql`
          SELECT id, name, handle, channel_id AS youtube_channel_id,
                 subscriber_count, video_count, niche, oauth_connected
            FROM channels
           WHERE workspace_id = ${ctx.workspaceId}::uuid
           ORDER BY name
           LIMIT ${ROW_LIMIT_PER_TOOL_CALL}
        `;
        return { ok: true, data: rows };
      }

      case 'list_recent_videos': {
        const daysBack = clampInt(input.days_back, 1, 365, 90);
        const limit = clampInt(input.limit, 1, ROW_LIMIT_PER_TOOL_CALL, 20);
        const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
        if (input.channel_db_id !== undefined) {
          if (!isUuid(input.channel_db_id)) {
            return { ok: false, error: 'channel_db_id must be a UUID' };
          }
          const { rows } = await sql`
            SELECT v.youtube_video_id, v.title, v.views, v.average_view_percentage,
                   v.ctr_percentage, v.published_at::text AS published_at,
                   c.name AS channel_name
              FROM video_analytics v
              LEFT JOIN channels c ON c.id = v.channel_id
             WHERE v.workspace_id = ${ctx.workspaceId}::uuid
               AND v.published_at >= ${since}::timestamptz
               AND v.channel_id = ${input.channel_db_id}::uuid
             ORDER BY v.published_at DESC NULLS LAST
             LIMIT ${limit}
          `;
          return { ok: true, data: rows };
        }
        const { rows } = await sql`
          SELECT v.youtube_video_id, v.title, v.views, v.average_view_percentage,
                 v.ctr_percentage, v.published_at::text AS published_at,
                 c.name AS channel_name
            FROM video_analytics v
            LEFT JOIN channels c ON c.id = v.channel_id
           WHERE v.workspace_id = ${ctx.workspaceId}::uuid
             AND v.published_at >= ${since}::timestamptz
           ORDER BY v.published_at DESC NULLS LAST
           LIMIT ${limit}
        `;
        return { ok: true, data: rows };
      }

      case 'list_underperforming_videos': {
        const daysBack = clampInt(input.days_back, 1, 365, 60);
        const maxAvp = typeof input.max_avp_percentage === 'number' ? input.max_avp_percentage : 35;
        const limit = clampInt(input.limit, 1, ROW_LIMIT_PER_TOOL_CALL, 10);
        const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
        const { rows } = await sql`
          SELECT v.youtube_video_id, v.title, v.views, v.average_view_percentage,
                 v.ctr_percentage, v.published_at::text AS published_at,
                 c.name AS channel_name
            FROM video_analytics v
            LEFT JOIN channels c ON c.id = v.channel_id
           WHERE v.workspace_id = ${ctx.workspaceId}::uuid
             AND v.published_at >= ${since}::timestamptz
             AND v.average_view_percentage IS NOT NULL
             AND v.average_view_percentage <= ${maxAvp}
           ORDER BY v.average_view_percentage ASC
           LIMIT ${limit}
        `;
        return { ok: true, data: rows };
      }

      case 'list_top_performers': {
        const metric = input.metric;
        const allowedMetrics = ['views', 'ctr_percentage', 'average_view_percentage', 'subscribers_gained'] as const;
        if (typeof metric !== 'string' || !(allowedMetrics as readonly string[]).includes(metric)) {
          return { ok: false, error: `metric must be one of: ${allowedMetrics.join(', ')}` };
        }
        const daysBack = clampInt(input.days_back, 1, 365, 90);
        const limit = clampInt(input.limit, 1, 25, 10);
        const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
        // Whitelisted column name interpolation — `metric` already
        // validated against allowedMetrics above.
        const { rows } = await sql.query(
          `SELECT v.youtube_video_id, v.title, v.views, v.average_view_percentage,
                  v.ctr_percentage, v.subscribers_gained, v.published_at::text AS published_at,
                  c.name AS channel_name
             FROM video_analytics v
             LEFT JOIN channels c ON c.id = v.channel_id
            WHERE v.workspace_id = $1::uuid
              AND v.published_at >= $2::timestamptz
              AND v.${metric} IS NOT NULL
            ORDER BY v.${metric} DESC NULLS LAST
            LIMIT $3`,
          [ctx.workspaceId, since, limit],
        );
        return { ok: true, data: rows };
      }

      case 'list_scheduled_items': {
        const daysAhead = clampInt(input.days_ahead, 0, 365, 30);
        const daysBack = clampInt(input.days_back, 0, 365, 14);
        const limit = clampInt(input.limit, 1, ROW_LIMIT_PER_TOOL_CALL, 25);
        const start = new Date(Date.now() - daysBack * 86_400_000).toISOString();
        const end = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
        if (typeof input.status === 'string' && input.status) {
          const { rows } = await sql`
            SELECT s.id, s.title, s.status, s.scheduled_for::text AS scheduled_for,
                   s.pillar, c.name AS channel_name
              FROM schedule_items s
              LEFT JOIN schedule_item_channels sic ON sic.item_id = s.id
              LEFT JOIN channels c ON c.id = sic.channel_id
             WHERE s.workspace_id = ${ctx.workspaceId}::uuid
               AND s.status = ${input.status}
               AND s.scheduled_for IS NOT NULL
               AND s.scheduled_for BETWEEN ${start}::timestamptz AND ${end}::timestamptz
             ORDER BY s.scheduled_for ASC
             LIMIT ${limit}
          `;
          return { ok: true, data: rows };
        }
        const { rows } = await sql`
          SELECT s.id, s.title, s.status, s.scheduled_for::text AS scheduled_for,
                 s.pillar, c.name AS channel_name
            FROM schedule_items s
            LEFT JOIN schedule_item_channels sic ON sic.item_id = s.id
            LEFT JOIN channels c ON c.id = sic.channel_id
           WHERE s.workspace_id = ${ctx.workspaceId}::uuid
             AND s.scheduled_for IS NOT NULL
             AND s.scheduled_for BETWEEN ${start}::timestamptz AND ${end}::timestamptz
           ORDER BY s.scheduled_for ASC
           LIMIT ${limit}
        `;
        return { ok: true, data: rows };
      }

      case 'list_projects': {
        const limit = clampInt(input.limit, 1, ROW_LIMIT_PER_TOOL_CALL, 25);
        if (typeof input.status === 'string' && input.status) {
          const { rows } = await sql`
            SELECT id, title, niche, status, created_at::text AS created_at
              FROM projects
             WHERE workspace_id = ${ctx.workspaceId}::uuid
               AND status = ${input.status}
             ORDER BY created_at DESC
             LIMIT ${limit}
          `;
          return { ok: true, data: rows };
        }
        const { rows } = await sql`
          SELECT id, title, niche, status, created_at::text AS created_at
            FROM projects
           WHERE workspace_id = ${ctx.workspaceId}::uuid
           ORDER BY created_at DESC
           LIMIT ${limit}
        `;
        return { ok: true, data: rows };
      }

      case 'list_ab_tests': {
        const limit = clampInt(input.limit, 1, ROW_LIMIT_PER_TOOL_CALL, 20);
        if (input.status === 'draft' || input.status === 'running' || input.status === 'concluded') {
          const { rows } = await sql`
            SELECT id, youtube_video_id, variant_a_title, variant_b_title,
                   live_variant, winner, status,
                   started_at::text AS started_at,
                   concluded_at::text AS concluded_at
              FROM ab_tests
             WHERE workspace_id = ${ctx.workspaceId}::uuid
               AND status = ${input.status}
             ORDER BY created_at DESC
             LIMIT ${limit}
          `;
          return { ok: true, data: rows };
        }
        const { rows } = await sql`
          SELECT id, youtube_video_id, variant_a_title, variant_b_title,
                 live_variant, winner, status,
                 started_at::text AS started_at,
                 concluded_at::text AS concluded_at
            FROM ab_tests
           WHERE workspace_id = ${ctx.workspaceId}::uuid
           ORDER BY created_at DESC
           LIMIT ${limit}
        `;
        return { ok: true, data: rows };
      }

      case 'count_uploads_by_channel': {
        const daysBack = clampInt(input.days_back, 1, 365, 90);
        const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
        const { rows } = await sql`
          SELECT c.name AS channel_name, c.id AS channel_db_id, COUNT(v.youtube_video_id) AS upload_count
            FROM channels c
            LEFT JOIN video_analytics v
              ON v.channel_id = c.id
             AND v.published_at >= ${since}::timestamptz
           WHERE c.workspace_id = ${ctx.workspaceId}::uuid
           GROUP BY c.id, c.name
           ORDER BY upload_count DESC, c.name
        `;
        return { ok: true, data: rows };
      }

      case 'get_video_analytics': {
        const id = input.youtube_video_id;
        if (typeof id !== 'string' || !id) {
          return { ok: false, error: 'youtube_video_id is required' };
        }
        const { rows } = await sql`
          SELECT v.youtube_video_id, v.title, v.views, v.likes, v.comments,
                 v.duration_seconds, v.average_view_percentage,
                 v.average_view_duration_seconds, v.ctr_percentage, v.impressions,
                 v.subscribers_gained, v.published_at::text AS published_at,
                 v.data_source, c.name AS channel_name,
                 jsonb_array_length(COALESCE(v.retention_curve, '[]'::jsonb)) AS retention_samples
            FROM video_analytics v
            LEFT JOIN channels c ON c.id = v.channel_id
           WHERE v.workspace_id = ${ctx.workspaceId}::uuid
             AND v.youtube_video_id = ${id}
           LIMIT 1
        `;
        if (rows.length === 0) return { ok: false, error: 'Video not found in this workspace' };
        return { ok: true, data: rows[0] };
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Tool schema converters — TOOL_CATALOG is the source of truth, each
// provider gets its own shape derived from it.
// ---------------------------------------------------------------------------

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function toOpenAITools(catalog: ToolSchema[]): OpenAITool[] {
  return catalog.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Record<string, unknown>,
    },
  }));
}

/**
 * Convert a JSON-Schema-style object (which is what TOOL_CATALOG uses,
 * matching Anthropic + OpenAI conventions) into Gemini's Schema form.
 *
 * The @google/generative-ai SDK accepts `type` as either an uppercase
 * string ('OBJECT', 'STRING', …) or the `SchemaType` enum. Lowercase
 * 'object' / 'string' silently fails on some SDK versions — the request
 * goes through but the model sees an empty parameter object and ignores
 * the call. Normalising up-front keeps the contract sturdy.
 */
function geminifyType(t: unknown): unknown {
  if (typeof t !== 'string') return t;
  return t.toUpperCase();
}

function geminifySchema(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(geminifySchema);
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'type') out[k] = geminifyType(v);
    else if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = geminifySchema(pv);
      }
      out[k] = props;
    } else if (k === 'items') {
      out[k] = geminifySchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toGeminiFunctionDeclarations(catalog: ToolSchema[]): GeminiFunctionDeclaration[] {
  return catalog.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: geminifySchema(t.input_schema) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------
//
// Five protocols cover the entire supported set. The dispatcher inspects
// the model registry to pick one; unsupported models are rejected by the
// route validator before they reach this code path.

export type AskStudioProtocol =
  | 'anthropic-native'   // direct Anthropic Messages API
  | 'kie-claude'         // Kie's /claude/v1/messages — same wire shape as Anthropic
  | 'openai-chat'        // direct OpenAI chat completions with tool_calls
  | 'kie-openai-chat'    // Kie's /{model}/v1/chat/completions — OpenAI-compatible
  | 'gemini-native';     // direct Google Gemini with functionDeclarations

export function resolveAskStudioProtocol(modelId: string): AskStudioProtocol | null {
  const m = getModelById(modelId);
  if (!m) return null;
  if (!isAskStudioSupportedModel(modelId)) return null;
  switch (m.provider) {
    case 'anthropic':
      return 'anthropic-native';
    case 'openai':
      return 'openai-chat';
    case 'google':
      return 'gemini-native';
    case 'kie': {
      const cfg = KIE_MODEL_MAP[m.id];
      if (!cfg) return null;
      if (cfg.endpointType === 'claude') return 'kie-claude';
      if (cfg.endpointType === 'gemini') return 'kie-openai-chat';
      return null;
    }
    case 'perplexity':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Agent loop — shared types
// ---------------------------------------------------------------------------

interface PersistedToolStep {
  iteration: number;
  tool_name: string;
  input: unknown;
  result: ToolResult;
}

export interface AskStudioAnswer {
  answer: string;
  tool_trace: PersistedToolStep[];
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

interface RunnerArgs {
  workspaceId: string;
  modelId: string;
  question: string;
}

interface RunnerResult {
  finalAnswer: string;
  trace: PersistedToolStep[];
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM_PROMPT = `You are "Ask Studio", an analyst that answers questions about a YouTube creator's own channels and projects. You have a small catalog of read-only tools that query their workspace database — every result is automatically scoped to their workspace, you cannot see other users' data even if you tried.

Strict rules for every answer:
1. ALWAYS use a tool when the question is about specific data ("which video", "how many", "what's scheduled"). NEVER make up numbers.
2. If a tool returns zero rows, say so plainly. Don't invent rows.
3. Cite the data: when you mention a video, include its title and the metric you're referencing. When you mention a channel, name it.
4. Keep answers tight. 2-4 short paragraphs OR a 5-7 row table in markdown. The user is operating multiple channels and doesn't want a wall of text.
5. When the user's question is genuinely answerable without a tool ("what's a good CTR?"), answer from general knowledge — but be explicit that you didn't query their data.
6. If you call multiple tools, synthesise across them — don't dump each result separately.

End every answer with a single one-line "next step?" suggestion that's a question they could ask next.`;

// Anthropic SDK content blocks are a discriminated union (text | tool_use |
// tool_result | …). The runtime contract is what we care about; the SDK
// type surface is loose enough that working through `any` for blocks keeps
// the loop readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageContentBlock = any;

// ---------------------------------------------------------------------------
// Runner: anthropic-native + kie-claude (shared wire format)
// ---------------------------------------------------------------------------
//
// Kie's /claude/v1/messages is a faithful Anthropic Messages API
// passthrough. The only differences are the base URL and auth header;
// everything inside the loop (tool_use blocks, tool_result blocks,
// stop_reason handling, usage shape) is bit-identical. We therefore route
// both through the Anthropic SDK with a custom `baseURL`, which gets us
// proper TypeScript types and exhaustive content-block handling for free.

async function runAnthropicCompatibleLoop(
  args: RunnerArgs,
  opts: { baseURL?: string; apiKey: string; modelOverride?: string },
): Promise<RunnerResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  const tools = TOOL_CATALOG.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const messages: Array<{ role: 'user' | 'assistant'; content: MessageContentBlock }> = [
    { role: 'user', content: args.question.trim() },
  ];

  const trace: PersistedToolStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  let iteration = 0;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration += 1;

    const response = await client.messages.create({
      model: opts.modelOverride ?? args.modelId,
      max_tokens: MAX_TOKENS_PER_ITERATION,
      temperature: TEMPERATURE,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    messages.push({ role: 'assistant', content: response.content });

    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    const textBlocks: string[] = [];
    for (const block of response.content as MessageContentBlock[]) {
      if (block.type === 'tool_use') {
        toolUses.push({ id: block.id as string, name: block.name as string, input: block.input });
      } else if (block.type === 'text') {
        textBlocks.push(block.text as string);
      }
    }

    if (toolUses.length === 0) {
      finalAnswer = textBlocks.join('\n').trim();
      if (!finalAnswer) {
        finalAnswer = 'The model returned no text and no tool calls. Try rephrasing the question.';
      }
      break;
    }

    const toolResultBlocks: MessageContentBlock[] = [];
    for (const tu of toolUses) {
      const result = await runToolCall({ workspaceId: args.workspaceId }, tu.name, tu.input);
      trace.push({ iteration, tool_name: tu.name, input: tu.input, result });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error }).slice(0, 60_000),
        is_error: !result.ok,
      });
    }
    messages.push({ role: 'user', content: toolResultBlocks });
  }

  return {
    finalAnswer: finalAnswer || 'I ran out of tool-call budget before producing an answer. Try a simpler question or break it into parts.',
    trace,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Runner: openai-chat + kie-openai-chat (shared wire format)
// ---------------------------------------------------------------------------
//
// OpenAI chat completions returns `message.tool_calls[]` when the model
// wants to invoke a tool. Each call carries an id, function name, and a
// JSON-encoded arguments string. We execute the tool, push the assistant
// message back as-is, then add one `role:'tool'` message per call carrying
// the JSON result. Repeat until the model returns a message with no
// tool_calls — that's the final answer in `message.content`.
//
// Kie's `/{model}/v1/chat/completions` is OpenAI-compatible; same loop,
// different base URL and auth. We use the OpenAI SDK with `baseURL` set
// for Kie variants — saves us hand-rolling SSE handling and gives us the
// SDK's type system for free.

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool_calls?: any[];
  tool_call_id?: string;
}

async function runOpenAIChatLoop(
  args: RunnerArgs,
  opts: { baseURL?: string; apiKey: string; modelOverride?: string },
): Promise<RunnerResult> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  const tools = toOpenAITools(TOOL_CATALOG);
  const messages: OpenAIChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: args.question.trim() },
  ];

  const trace: PersistedToolStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  let iteration = 0;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration += 1;

    // gpt-5 family and o-series want `max_completion_tokens` instead of
    // `max_tokens`. ai.ts has the same branching for non-tool calls;
    // mirroring it here keeps the picker working across every OpenAI tier.
    const modelForApi = opts.modelOverride ?? args.modelId;
    const useCompletionTokens = modelForApi.startsWith('gpt-5') || /^o[0-9]/.test(modelForApi);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      model: modelForApi,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: TEMPERATURE,
    };
    if (useCompletionTokens) params.max_completion_tokens = MAX_TOKENS_PER_ITERATION;
    else params.max_tokens = MAX_TOKENS_PER_ITERATION;

    const response = await client.chat.completions.create(params);
    const usage = response.usage as
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    inputTokens += usage?.prompt_tokens ?? 0;
    outputTokens += usage?.completion_tokens ?? 0;

    const msg = response.choices[0]?.message;
    if (!msg) {
      finalAnswer = 'Model returned an empty response. Try rephrasing the question.';
      break;
    }

    // Append the assistant turn verbatim (including tool_calls). The next
    // tool messages must reference these ids.
    messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalAnswer = (msg.content ?? '').trim();
      if (!finalAnswer) {
        finalAnswer = 'The model returned no text and no tool calls. Try rephrasing the question.';
      }
      break;
    }

    for (const tc of toolCalls) {
      // Defensive: OpenAI guarantees `function` on tool_calls; treat
      // missing fields as a tool error so the loop can recover instead of
      // crashing the request.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (tc as any).function;
      if (!fn || typeof fn.name !== 'string') {
        trace.push({
          iteration,
          tool_name: '<malformed>',
          input: tc,
          result: { ok: false, error: 'Model returned a tool_call without a function name' },
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: 'Malformed tool_call' }),
        });
        continue;
      }
      let parsedInput: unknown = {};
      try {
        parsedInput = fn.arguments ? JSON.parse(fn.arguments) : {};
      } catch {
        parsedInput = { _raw: fn.arguments };
      }
      const result = await runToolCall({ workspaceId: args.workspaceId }, fn.name, parsedInput);
      trace.push({ iteration, tool_name: fn.name, input: parsedInput, result });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error }).slice(0, 60_000),
      });
    }
  }

  return {
    finalAnswer: finalAnswer || 'I ran out of tool-call budget before producing an answer. Try a simpler question or break it into parts.',
    trace,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Runner: gemini-native (direct Google)
// ---------------------------------------------------------------------------
//
// The @google/generative-ai SDK exposes tool use via `tools:
// [{ functionDeclarations: [...] }]` on the model. Responses carry parts
// inside `response.candidates[].content.parts[]`, where a part is either a
// text block or `{ functionCall: { name, args } }`. We send results back
// as `{ functionResponse: { name, response: {…} } }` parts in the next
// turn's user message.
//
// Uses the chat session (`startChat`) so message history is managed by
// the SDK — saves us hand-stitching a content array across turns. Note
// the SDK is officially deprecated as of 2025-12-16 in favour of
// `@google/genai`; the migration is out of scope here and the legacy
// package still functions.

async function runGeminiLoop(args: RunnerArgs): Promise<RunnerResult> {
  if (!process.env.GOOGLE_AI_API_KEY) {
    throw new Error('GOOGLE_AI_API_KEY is not configured');
  }
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: args.modelId,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_TOKENS_PER_ITERATION },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [{ functionDeclarations: toGeminiFunctionDeclarations(TOOL_CATALOG) as any }],
  });

  const chat = model.startChat();
  const trace: PersistedToolStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  let iteration = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let nextMessage: any = args.question.trim();

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration += 1;

    const result = await chat.sendMessage(nextMessage);
    const usage = (result.response as unknown as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }).usageMetadata;
    inputTokens += usage?.promptTokenCount ?? 0;
    outputTokens += usage?.candidatesTokenCount ?? 0;

    // The SDK exposes functionCalls() but it sometimes returns undefined
    // even when text + a single function call coexist in the same
    // response. Walk parts directly to be safe.
    const candidate = result.response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolUses: Array<{ name: string; args: unknown }> = [];
    const textParts: string[] = [];
    for (const part of parts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = part as any;
      if (p.functionCall && typeof p.functionCall.name === 'string') {
        toolUses.push({ name: p.functionCall.name, args: p.functionCall.args ?? {} });
      } else if (typeof p.text === 'string') {
        textParts.push(p.text);
      }
    }

    if (toolUses.length === 0) {
      // Fall back to result.response.text() for cases where parts is empty
      // but the SDK still synthesises a string answer.
      const textJoined = textParts.join('').trim();
      finalAnswer = textJoined || (() => {
        try {
          return result.response.text().trim();
        } catch {
          return '';
        }
      })();
      if (!finalAnswer) {
        finalAnswer = 'The model returned no text and no tool calls. Try rephrasing the question.';
      }
      break;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const functionResponseParts: any[] = [];
    for (const tu of toolUses) {
      const toolResult = await runToolCall({ workspaceId: args.workspaceId }, tu.name, tu.args);
      trace.push({ iteration, tool_name: tu.name, input: tu.args, result: toolResult });
      functionResponseParts.push({
        functionResponse: {
          name: tu.name,
          response: toolResult.ok
            ? { result: toolResult.data }
            : { error: toolResult.error },
        },
      });
    }
    nextMessage = functionResponseParts;
  }

  return {
    finalAnswer: finalAnswer || 'I ran out of tool-call budget before producing an answer. Try a simpler question or break it into parts.',
    trace,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function runAgentLoop(args: RunnerArgs): Promise<RunnerResult> {
  const protocol = resolveAskStudioProtocol(args.modelId);
  if (!protocol) {
    throw new Error(
      `Model "${args.modelId}" isn't supported by Ask Studio. Pick another model from the dropdown.`,
    );
  }

  switch (protocol) {
    case 'anthropic-native': {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
      return runAnthropicCompatibleLoop(args, { apiKey: process.env.ANTHROPIC_API_KEY });
    }
    case 'kie-claude': {
      const apiKey = process.env.KIE_API_KEY;
      if (!apiKey) throw new Error('KIE_API_KEY is not configured');
      const cfg = KIE_MODEL_MAP[args.modelId];
      if (!cfg) throw new Error(`Kie model not registered: ${args.modelId}`);
      return runAnthropicCompatibleLoop(args, {
        apiKey,
        baseURL: `${KIE_BASE}/claude`,
        modelOverride: cfg.kieModelId,
      });
    }
    case 'openai-chat': {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
      return runOpenAIChatLoop(args, { apiKey: process.env.OPENAI_API_KEY });
    }
    case 'kie-openai-chat': {
      const apiKey = process.env.KIE_API_KEY;
      if (!apiKey) throw new Error('KIE_API_KEY is not configured');
      const cfg = KIE_MODEL_MAP[args.modelId];
      if (!cfg) throw new Error(`Kie model not registered: ${args.modelId}`);
      // Kie's chat-completions endpoint is per-model: /{model}/v1/chat/completions.
      // The OpenAI SDK appends `/chat/completions` to baseURL, so we end the
      // base at the model id.
      return runOpenAIChatLoop(args, {
        apiKey,
        baseURL: `${KIE_BASE}/${cfg.kieModelId}/v1`,
        modelOverride: cfg.kieModelId,
      });
    }
    case 'gemini-native': {
      return runGeminiLoop(args);
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry — askStudio() owns DB persistence and error wrapping
// ---------------------------------------------------------------------------

export interface AskStudioRunArgs {
  workspaceId: string;
  collaboratorId: string | null;
  question: string;
  modelId?: string;
}

/** Pre-flight validation surfaced by the POST route as a 400, before any
 *  DB row is inserted. Centralises the "unsupported model" check so the
 *  route catch block doesn't have to special-case it. */
export class AskStudioModelNotSupported extends Error {
  readonly modelId: string;
  constructor(modelId: string) {
    const m = getModelById(modelId);
    const name = m ? `${m.name} (${m.provider})` : modelId;
    super(
      `Ask Studio doesn't support ${name} yet. Pick a different model from the dropdown — Claude, GPT, and Gemini families are supported.`,
    );
    this.name = 'AskStudioModelNotSupported';
    this.modelId = modelId;
  }
}

export async function askStudio(args: AskStudioRunArgs): Promise<{ id: string; answer: AskStudioAnswer }> {
  if (!args.question.trim()) {
    throw new Error('question is required');
  }
  const modelId = args.modelId || (await getEffectiveModelId(args.workspaceId, 'ask-studio'));

  // Validate the model BEFORE inserting the placeholder row so an
  // unsupported-model 400 doesn't leave an orphan errored row in history.
  if (!isAskStudioSupportedModel(modelId)) {
    throw new AskStudioModelNotSupported(modelId);
  }

  // Insert a placeholder row immediately so the question is durable even
  // if the agent loop crashes mid-flight.
  const insert = await sql<{ id: string }>`
    INSERT INTO ask_studio_questions (
      workspace_id, asked_by_collaborator_id, question, ai_model
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.collaboratorId}::uuid,
      ${args.question.trim()},
      ${modelId}
    )
    RETURNING id
  `;
  const id = insert.rows[0]!.id;

  const startedAt = Date.now();

  try {
    const runner = await runAgentLoop({
      workspaceId: args.workspaceId,
      modelId,
      question: args.question.trim(),
    });

    const duration = Date.now() - startedAt;
    await sql`
      UPDATE ask_studio_questions
         SET answer = ${runner.finalAnswer},
             tool_trace = ${JSON.stringify(runner.trace)}::jsonb,
             tool_call_count = ${runner.trace.length},
             input_tokens = ${runner.inputTokens},
             output_tokens = ${runner.outputTokens},
             duration_ms = ${duration},
             completed_at = NOW()
       WHERE id = ${id}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `;
    return {
      id,
      answer: {
        answer: runner.finalAnswer,
        tool_trace: runner.trace,
        input_tokens: runner.inputTokens,
        output_tokens: runner.outputTokens,
        duration_ms: duration,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('ask-studio: agent loop threw', { id, model_id: modelId, detail: msg });
    await sql`
      UPDATE ask_studio_questions
         SET error_message = ${msg.slice(0, 1000)},
             completed_at = NOW()
       WHERE id = ${id}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `;
    throw new Error(`Ask Studio failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export interface AskStudioQuestionRow {
  id: string;
  workspace_id: string;
  asked_by_collaborator_id: string | null;
  question: string;
  answer: string | null;
  error_message: string | null;
  tool_trace: PersistedToolStep[];
  tool_call_count: number;
  ai_model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export async function getAskStudioQuestion(
  id: string,
  workspaceId: string,
): Promise<AskStudioQuestionRow | null> {
  const { rows } = await sql<AskStudioQuestionRow>`
    SELECT id, workspace_id, asked_by_collaborator_id,
           question, answer, error_message,
           tool_trace, tool_call_count, ai_model,
           input_tokens, output_tokens, duration_ms,
           created_at::text AS created_at,
           completed_at::text AS completed_at
      FROM ask_studio_questions
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listAskStudioQuestions(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<AskStudioQuestionRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const { rows } = await sql<AskStudioQuestionRow>`
    SELECT id, workspace_id, asked_by_collaborator_id,
           question, answer, error_message,
           tool_trace, tool_call_count, ai_model,
           input_tokens, output_tokens, duration_ms,
           created_at::text AS created_at,
           completed_at::text AS completed_at
      FROM ask_studio_questions
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows;
}

export async function deleteAskStudioQuestion(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM ask_studio_questions
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}

// Re-export catalog types referenced by the registry helpers above so
// downstream code can `import { type AIModel } from '@/lib/ask-studio'`
// without separately reaching into ai-models.
export type { AIModel, KieEndpointType };
export { AI_MODELS };
