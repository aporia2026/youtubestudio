/**
 * "Ask Studio" — natural-language Q&A over the workspace's own data.
 *
 * The model runs an Anthropic native tool-use loop over a curated catalog
 * of read-only queries (channels, video_analytics, schedule_items, projects,
 * ab_tests, etc.). Every tool executor takes the workspaceId as an
 * implicit first argument that the model cannot override — so no matter
 * what the model tries, queries are always tenancy-scoped.
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

const ASK_STUDIO_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOOL_ITERATIONS = 6;
const ROW_LIMIT_PER_TOOL_CALL = 50;

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
// Agent loop
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

const SYSTEM_PROMPT = `You are "Ask Studio", an analyst that answers questions about a YouTube creator's own channels and projects. You have a small catalog of read-only tools that query their workspace database — every result is automatically scoped to their workspace, you cannot see other users' data even if you tried.

Strict rules for every answer:
1. ALWAYS use a tool when the question is about specific data ("which video", "how many", "what's scheduled"). NEVER make up numbers.
2. If a tool returns zero rows, say so plainly. Don't invent rows.
3. Cite the data: when you mention a video, include its title and the metric you're referencing. When you mention a channel, name it.
4. Keep answers tight. 2-4 short paragraphs OR a 5-7 row table in markdown. The user is operating multiple channels and doesn't want a wall of text.
5. When the user's question is genuinely answerable without a tool ("what's a good CTR?"), answer from general knowledge — but be explicit that you didn't query their data.
6. If you call multiple tools, synthesise across them — don't dump each result separately.

End every answer with a single one-line "next step?" suggestion that's a question they could ask next.`;

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Anthropic SDK types are loose enough that we work with `any` for the
// message blocks — the runtime contract is what matters and it's stable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageContentBlock = any;

export interface AskStudioRunArgs {
  workspaceId: string;
  collaboratorId: string | null;
  question: string;
  modelId?: string;
}

export async function askStudio(args: AskStudioRunArgs): Promise<{ id: string; answer: AskStudioAnswer }> {
  if (!args.question.trim()) {
    throw new Error('question is required');
  }
  const modelId = args.modelId || ASK_STUDIO_DEFAULT_MODEL;

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
  let inputTokens = 0;
  let outputTokens = 0;
  const trace: PersistedToolStep[] = [];

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const tools: AnthropicTool[] = TOOL_CATALOG;
    const messages: Array<{ role: 'user' | 'assistant'; content: MessageContentBlock }> = [
      { role: 'user', content: args.question.trim() },
    ];

    let finalAnswer = '';
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration += 1;

      const response = await client.messages.create({
        model: modelId,
        max_tokens: 2000,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      // Append the assistant's full response (text + tool_use blocks) to
      // the conversation so the model can continue reasoning over its
      // own tool calls in the next iteration.
      messages.push({ role: 'assistant', content: response.content });

      // Walk the content blocks. The Anthropic SDK types these as a
      // discriminated union ({ type: 'text', ... } | { type: 'tool_use',
      // id, name, input } | ...). We cast each block to the loose shape
      // we care about so the loop reads cleanly without a chain of
      // `block.type === 'tool_use'` narrowings every line.
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
          finalAnswer = 'No textual answer was produced. Try rephrasing the question.';
        }
        break;
      }

      // Execute each tool call and build tool_result blocks for the next turn.
      const toolResultBlocks: MessageContentBlock[] = [];
      for (const tu of toolUses) {
        const result = await runToolCall(
          { workspaceId: args.workspaceId },
          tu.name,
          tu.input,
        );
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

    if (!finalAnswer) {
      finalAnswer = 'I ran out of tool-call budget before producing an answer. Try a simpler question or break it into parts.';
    }

    const duration = Date.now() - startedAt;
    await sql`
      UPDATE ask_studio_questions
         SET answer = ${finalAnswer},
             tool_trace = ${JSON.stringify(trace)}::jsonb,
             tool_call_count = ${trace.length},
             input_tokens = ${inputTokens},
             output_tokens = ${outputTokens},
             duration_ms = ${duration},
             completed_at = NOW()
       WHERE id = ${id}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `;
    return {
      id,
      answer: { answer: finalAnswer, tool_trace: trace, input_tokens: inputTokens, output_tokens: outputTokens, duration_ms: duration },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('ask-studio: agent loop threw', { id, detail: msg });
    await sql`
      UPDATE ask_studio_questions
         SET error_message = ${msg.slice(0, 1000)},
             tool_trace = ${JSON.stringify(trace)}::jsonb,
             tool_call_count = ${trace.length},
             input_tokens = ${inputTokens},
             output_tokens = ${outputTokens},
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
