import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/ai';
import { productionDocPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { apiRoute } from '@/lib/route-helpers';
import { resolveStyle } from '@/lib/production-doc-styles';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import {
  attachStyleSuffixToRows,
  detectEmptyVariantGroupBases,
  validateAndSplitOverlongRows,
  type ProductionDocRowLike,
} from '@/lib/production-doc-postprocess';
import {
  getEffectiveAiImageSuffix,
  getEffectiveMixingRules,
  useRefinedVariantPrompt,
} from '@/lib/production-doc-flags';
import { refineVariantPromptsInDoc } from '@/lib/variant-prompt-refiner';
import { autoGroupVariants } from '@/lib/auto-group-variants';
import { dedupVariantIndexCollisions } from '@/lib/production-doc-postprocess';
import { extractScriptTitles, TITLE_SENTINEL_LEAK_RE } from '@/lib/script-titles';
import { preprocessSsmlForProductionDoc } from '@/lib/ssml-production-doc';

export const maxDuration = 300;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited, resetIn } = checkRateLimit(`prodoc:${getClientIP(req)}`, 5, 60_000);
  if (limited) {
    return NextResponse.json({ error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const {
    modelId,
    script,
    niche,
    topic,
    speakingPaceWpm,
    stylePreset,
    creativeBrief,
    startTimecodeSeconds,
    isChunk,
    overlaysDisabled,
    motionCollageSettings,
  } = body as {
    modelId?: string; script?: string; niche?: string; topic?: string;
    speakingPaceWpm?: number;
    /** Either a built-in style slug ('cinematic', 'doodle_explainer', …)
     *  or a UUID pointing at a workspace-saved style row. */
    stylePreset?: string;
    creativeBrief?: string;
    startTimecodeSeconds?: number; isChunk?: boolean;
    /** Forwarded from the production-doc page's `overlays_disabled`
     *  toggle. When true, the prompt instructs the LLM to leave
     *  `overlay_stock_terms` empty on every row and bake brand
     *  identity into ai_image_prompt instead. */
    overlaysDisabled?: boolean;
    /** doodle_explainer_2 motion-collage settings forwarded from the
     *  page's pre-generation panel. When the user has tuned them BEFORE
     *  generation, the values flow into `productionDocPrompt` so the
     *  LLM emits motion_collage rows that match the constraints
     *  (max_grid_panels, per-frame duration window, kill switch).
     *  Undefined ⇒ the prompt uses canonical defaults from
     *  DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS. See
     *  `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` (B). */
    motionCollageSettings?: {
      allow_motion_collage?: boolean;
      max_grid_panels?: number;
      min_per_frame_ms?: number;
      max_per_frame_ms?: number;
    };
  };

  if (!script || !niche) {
    return NextResponse.json({ error: 'script and niche are required' }, { status: 400 });
  }
  if (script.trim().split(/\s+/).length < 20) {
    return NextResponse.json({ error: 'Script is too short — need at least 20 words' }, { status: 400 });
  }

  // Resolve the style id (built-in slug or saved-row UUID) into the full
  // payload the prompt builder needs. Unknown ids resolve to null — the
  // builder treats null as "no style" rather than failing the generation.
  // Stage 1 — pipe both `ai_image_suffix` and `mixing_rules` through the
  // trim-flag helpers. When `USE_TRIMMED_SUFFIX=1` AND the style has a
  // trimmed entry registered (currently doodle_explainer_2), the LLM
  // receives the condensed versions and `attachStyleSuffixToRows` later
  // appends the condensed suffix. Flag off ⇒ helpers return originals
  // unchanged. See `_plans/2026-05-27-doodle-explainer-2-foundation.md`.
  const resolved = await resolveStyle(stylePreset, session.ws);
  const style = resolved
    ? {
        id: resolved.id,
        label: resolved.label,
        ai_image_suffix: getEffectiveAiImageSuffix(resolved),
        mixing_rules: getEffectiveMixingRules(resolved),
        allow_overlay_stock: resolved.allow_overlay_stock,
      }
    : null;

  // SSML preprocessor. Auto-detects scripts pasted as SSML (e.g.
  // <speak>...<break time="2s"/>...) and converts them into clean
  // plain text plus an ordered list of section bodies. The sections
  // become authoritative row-boundary hints for the LLM — no more
  // guessing where one beat ends and the next begins when the user
  // has already marked it. Plain-text input passes through unchanged.
  const ssmlPre = preprocessSsmlForProductionDoc(script);
  if (ssmlPre.wasSsml) {
    logger.info('[production-doc ssml-detected]', {
      inputBytes: Buffer.byteLength(script, 'utf8'),
      cleanScriptChars: ssmlPre.cleanScript.length,
      sectionCount: ssmlPre.sections.length,
    });
  }
  const scriptForPipelinePreStrip = ssmlPre.wasSsml ? ssmlPre.cleanScript : script;

  // Strip production-note lines BEFORE the LLM sees them. Lines that
  // are entirely a bracket-wrapped production note (`[SFX: ...]`,
  // `[VISUAL CUE: ...]`, `[ON-SCREEN TEXT - ...]`, etc.) are stage
  // directions for the editor, not narration — and yet across multiple
  // production runs the LLM kept emitting Title Card rows for them
  // even with explicit mixing_rules saying "ignore these". The LLM is
  // unreliable here, so we just remove the lines server-side. The
  // narrative prose between them carries the meaning fine.
  //
  // What gets stripped: lines whose TRIMMED content starts with `[`
  // and ends with `]`. We don't strip lines that contain brackets
  // mid-sentence ("the value '[1]' was zero") — only whole-line
  // bracket-notes.
  const productionNoteLineRegex = /^\s*\[[^\]]*\]\s*$/;
  const beforeLines = scriptForPipelinePreStrip.split('\n');
  const strippedLines = beforeLines.filter((line) => !productionNoteLineRegex.test(line));
  const stripCount = beforeLines.length - strippedLines.length;
  const scriptForPipeline = strippedLines.join('\n');
  if (stripCount > 0) {
    logger.info('[production-doc production-notes-stripped]', {
      stripped_lines: stripCount,
      before_chars: scriptForPipelinePreStrip.length,
      after_chars: scriptForPipeline.length,
    });
  }

  // Deterministic title pre-pass. The LLM used to detect `##Heading` markers
  // itself, which was unreliable: a 6-title script could come back missing
  // titles silently. Now we extract them server-side per chunk and replace
  // each heading line with a `<<TITLE_N>>` sentinel before the LLM sees it.
  // The prompt then instructs the model to emit one Title Card row per
  // sentinel. Per-chunk scoping is automatic because the chunk's own text
  // is what gets parsed — no risk of titles from other chunks leaking in.
  const extracted = extractScriptTitles(scriptForPipeline);
  logger.info('[production-doc title-extract]', {
    inputScriptChars: scriptForPipeline.length,
    strippedScriptChars: extracted.stripped.length,
    titleCount: extracted.titles.length,
    titles: extracted.titles.map(t => t.text),
    isChunk: isChunk === true,
    warnings: extracted.warnings,
  });

  const { system, user } = productionDocPrompt({
    script: extracted.stripped,
    titles: extracted.titles,
    ssmlSections: ssmlPre.wasSsml ? ssmlPre.sections : undefined,
    niche, topic, speakingPaceWpm, style, creativeBrief,
    startTimecodeSeconds: typeof startTimecodeSeconds === 'number' ? startTimecodeSeconds : 0,
    overlaysDisabled: overlaysDisabled === true,
    motionCollageSettings,
  });

  const effectiveModelId = modelId || (await getEffectiveModelId(session.ws, 'production-doc'));

  // Catch the AI call here rather than letting it propagate to the route
  // wrapper's generic 500. Errors from generateText are domain-safe
  // explanations of upstream failure modes (Kie gateway down, model returned
  // empty, rate limited, timeout) — the user can act on them. The wrapper's
  // "Internal server error" mask is for DB / internal exceptions where the
  // text might leak schema details, not for AI provider responses.
  let raw: string;
  try {
    raw = await generateText({
      modelId: effectiveModelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 16000,
      temperature: 0.4,
      spend: {
        workspaceId: session.ws,
        featureArea: 'production_doc',
        metadata: { niche, is_chunk: isChunk === true },
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'AI generation failed';
    logger.error('production-doc generation failed', {
      detail,
      modelId: effectiveModelId,
      isChunk: isChunk === true,
      promptChars: (system?.length ?? 0) + user.length,
    });
    // 502 because the failure is upstream of us, not an internal bug.
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  if (!raw || raw.trim().length === 0) {
    logger.error('production-doc model returned empty output', {
      modelId: effectiveModelId,
      isChunk: isChunk === true,
    });
    return NextResponse.json(
      { error: `${effectiveModelId} returned an empty response — try the same model again, or switch models.` },
      { status: 502 },
    );
  }

  let result: {
    rows?: ProductionDocRowLike[];
    speaking_pace_wpm?: number;
    [k: string]: unknown;
  };
  try {
    result = parseLlmJson(raw) as typeof result;
  } catch (parseErr) {
    // Surface the real cause so the client can distinguish truncation from
    // malformed JSON — generic "try again" hides a multi-minute failure.
    const detail = parseErr instanceof Error ? parseErr.message : 'unknown parser error';
    const tail = raw.slice(-120).replace(/\s+/g, ' ').trim();
    const looksTruncated = !raw.trimEnd().endsWith('}') && !raw.trimEnd().endsWith('```');
    const hint = looksTruncated ? ' (output appears truncated — model hit token cap)' : '';
    return NextResponse.json(
      { error: `Failed to parse production document${hint} — ${detail}. Tail: …${tail}` },
      { status: 500 },
    );
  }

  // Post-pass: enforce the 7s per-row narration ceiling. The prompt asks
  // the model to keep rows in the 4–6s range, but LLMs are unreliable at
  // length constraints — this deterministic pass catches any overruns and
  // splits them on sentence boundaries before the doc reaches the editor.
  // Title Card rows are exempt (they're 1–2s by design).
  let generation_warnings: string[] = [];
  if (Array.isArray(result.rows) && result.rows.length > 0) {
    const wpm =
      typeof result.speaking_pace_wpm === 'number'
        ? result.speaking_pace_wpm
        : typeof speakingPaceWpm === 'number'
          ? speakingPaceWpm
          : 135;
    const split = validateAndSplitOverlongRows(result.rows, wpm);
    if (split.overlongRowCount > 0) {
      logger.info('[production-doc post-validate]', {
        modelId: effectiveModelId,
        inputRowCount: result.rows.length,
        outputRowCount: split.rows.length,
        overlongRowCount: split.overlongRowCount,
        splitCount: split.splitCount,
        warningCount: split.warnings.length,
      });
      result.rows = split.rows;
      generation_warnings = split.warnings;
    }
  }

  // Title-card emission validator: confirm every extracted sentinel produced
  // exactly one Title Card row whose script_text matches the title text.
  // Surfaces missing/extra/leaked-sentinel cases as warnings so the user can
  // recover with the Promote / Split row actions instead of having to
  // re-generate the whole doc.
  if (Array.isArray(result.rows)) {
    const titleCardRows = result.rows.filter(
      r => r.visual_type === 'Title Card',
    );
    const emittedTexts = titleCardRows.map(r =>
      typeof r.script_text === 'string' ? r.script_text.trim() : '',
    );
    const expectedTexts = extracted.titles.map(t => t.text);

    const emittedCounts = new Map<string, number>();
    for (const t of emittedTexts) emittedCounts.set(t, (emittedCounts.get(t) ?? 0) + 1);

    const missing: string[] = [];
    for (const expected of expectedTexts) {
      const c = emittedCounts.get(expected) ?? 0;
      if (c === 0) missing.push(expected);
      else emittedCounts.set(expected, c - 1);
    }
    const extra: string[] = [];
    for (const [text, count] of emittedCounts) {
      for (let i = 0; i < count; i++) if (text) extra.push(text);
    }

    const leaked = result.rows
      .filter(r =>
        typeof r.script_text === 'string'
          ? TITLE_SENTINEL_LEAK_RE.test(r.script_text)
          : false,
      )
      .map(r => (typeof r.script_text === 'string' ? r.script_text : ''));

    logger.info('[production-doc title-emit]', {
      modelId: effectiveModelId,
      expected: expectedTexts.length,
      emitted: titleCardRows.length,
      missingCount: missing.length,
      missing,
      extraCount: extra.length,
      extra,
      leakedSentinelCount: leaked.length,
    });

    if (missing.length > 0) {
      generation_warnings.push(
        `Missing title card(s) — the model didn't emit a Title Card row for: ${missing
          .map(t => `"${t}"`)
          .join(', ')}. Use the "Make this a title card" row action to add them where they belong.`,
      );
    }
    if (extra.length > 0) {
      generation_warnings.push(
        `Unexpected title card(s) — the model emitted Title Cards we didn't request: ${extra
          .map(t => `"${t}"`)
          .join(', ')}. Review and delete if not wanted.`,
      );
    }
    if (leaked.length > 0) {
      generation_warnings.push(
        `Title sentinel leaked into row text on ${leaked.length} row(s). Edit the affected rows to remove the <<TITLE_N>> marker.`,
      );
    }
    if (extracted.warnings.length > 0) {
      generation_warnings.push(...extracted.warnings);
    }
  }

  // Post-pass: attach the chosen style's `ai_image_suffix` to every row's
  // `ai_image_prompt`. The LLM is instructed (see productionDocPrompt) to
  // emit only the 35–55 word scene body and leave the style attachment to
  // the server — this keeps each row's output under ~150 tokens and avoids
  // the verbose-suffix-per-row truncation that GPT-mini-class models hit on
  // long scripts. See plan `_plans/2026-05-26-production-doc-suffix-server-side.md`.
  if (Array.isArray(result.rows) && style?.ai_image_suffix) {
    const attach = attachStyleSuffixToRows(result.rows, style.ai_image_suffix);
    logger.info('[production-doc suffix-attach]', {
      modelId: effectiveModelId,
      rowCount: result.rows.length,
      attachedCount: attach.attachedCount,
      skippedAlreadyPresent: attach.skippedAlreadyPresent,
      skippedNonString: attach.skippedNonString,
      suffixChars: style.ai_image_suffix.length,
      suffixWords: style.ai_image_suffix.trim().split(/\s+/).length,
    });
  }

  // Pin the doc-level OST default from the chosen style when the style
  // has an opinion. doodle_explainer_2 sets `'overlay'` so the chunky
  // yellow-bubble LowerThird variant is what gets composited at render
  // time, instead of the diffusion prompt baking small black text into
  // the corner of every image. The LLM is told the same rule via the
  // style's mixing_rules, but its compliance is unreliable — server-
  // pinning the doc default removes the failure mode entirely. Only
  // overwrite when the LLM didn't already set a value (it shouldn't,
  // but guard so a future schema change doesn't get clobbered here).
  if (resolved?.default_on_screen_text_mode && result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.on_screen_text_mode_default === undefined) {
      r.on_screen_text_mode_default = resolved.default_on_screen_text_mode;
      logger.info('[production-doc ost-mode-default]', {
        styleId: resolved.id,
        mode: resolved.default_on_screen_text_mode,
      });
    }
  }

  // Auto-group consecutive similar rows into variant groups for styles
  // whose mixing_rules describe the additive frame-by-frame pattern. The
  // LLM is instructed to emit variant groups directly but its compliance
  // is unreliable — this post-pass detects "consecutive rows with very
  // similar ai_image_prompts" and rewrites them in place to use
  // group_id / variant_index / variant_edit_prompt so the existing Atlas
  // Edit dispatcher (composeVariantEditRequest → /image/edit) generates
  // the derivative frames from a shared base image instead of from
  // scratch with different seeds. Gated on doodle_explainer_2 for now
  // because it's the only style that has variant_groups in its
  // mixing_rules. See `_plans/2026-05-25-near-static-variants.md`.
  if (Array.isArray(result.rows) && resolved?.id === 'doodle_explainer_2') {
    // Local alias preserves the narrowing inside nested callbacks below
    // (TypeScript drops the `result.rows` narrowing once we enter a
    // .filter / .map arrow function).
    let rows = result.rows;
    const grouped = autoGroupVariants(rows);
    if (grouped.groupCount > 0) {
      logger.info('[production-doc auto-group-variants]', {
        styleId: resolved.id,
        rowCount: rows.length,
        groupCount: grouped.groupCount,
        mergedRowCount: grouped.mergedRowCount,
        // Phase 1.5 (Bug B): subset of mergedRowCount whose promotion
        // used the synthesized DEFAULT_SUBTLE_MOTION_DELTA. A non-zero
        // value means the LLM emitted byte-for-byte duplicate prompts
        // on consecutive rows and the auto-grouper recovered them as
        // Atlas-Edit siblings rather than letting them fall through to
        // two independent fresh i2i calls (the Phase 1 QA failure
        // mode). Spec: _plans/2026-05-28-doodle-2-phase-1-5-completion.md.
        identicalPromptMerges: grouped.identicalPromptMerges,
      });
    }
    // Phase 1.6 (Bug 3) — variant-index collision dedup.
    //
    // Resolves the malformed group structure observed on Sodder doc
    // b30b8d1e (rows 5+6 both claimed sodder-fire-1 / variant_index=1
    // with identical content). Drops byte-for-byte duplicates, renumbers
    // different-content collisions, and recovers missing bases when a
    // fresh preceding row can be promoted. Runs AFTER autoGroupVariants
    // so both LLM-emitted and auto-grouper-derived groups are checked
    // by the same pass. Spec:
    // _plans/2026-05-28-doodle-2-phase-1-6-completion.md (R-3).
    const dedup = dedupVariantIndexCollisions(rows);
    if (
      dedup.collisionsResolved > 0
      || dedup.basesRecovered > 0
      || dedup.orphanVariantsPromoted > 0
      || dedup.warnings.length > 0
    ) {
      logger.info('[production-doc variant-index-dedup]', {
        styleId: resolved.id,
        collisionsResolved: dedup.collisionsResolved,
        duplicatesDropped: dedup.duplicatesDropped,
        renumbered: dedup.renumbered,
        basesRecovered: dedup.basesRecovered,
        // Phase 1.6 (post-QA fix-up): orphan variant rows in groups
        // whose base couldn't be recovered get promoted to standalone
        // Animation rows instead of staying permanently un-renderable.
        orphanVariantsPromoted: dedup.orphanVariantsPromoted,
        warningCount: dedup.warnings.length,
        warningSample: dedup.warnings.slice(0, 3),
      });
    }
    // The dedup pass may have removed rows. Reassign both `result.rows`
    // and the local `rows` alias so every downstream consumer sees the
    // cleaned-up array.
    if (dedup.duplicatesDropped > 0) {
      result.rows = dedup.rows as typeof result.rows;
      rows = result.rows;
    }
    // Always log the final variant-group ratio after both LLM-emitted
    // groups and the auto-grouper pass have run. Target is ~40% of rows
    // in variant groups per the doodle_explainer_2 mixing_rules. This
    // log is the primary verification surface for the 40% target — open
    // the console after generating a doc and check the ratio. Counts
    // any row carrying a `group_id` (whether emitted by the LLM or
    // patched by autoGroupVariants).
    const totalRows = rows.length;
    const groupRows = rows.filter((r) => {
      const gid = (r as unknown as { group_id?: unknown }).group_id;
      return typeof gid === 'string' && gid.length > 0;
    }).length;
    const ratio = totalRows > 0 ? groupRows / totalRows : 0;
    logger.info('[production-doc variants]', {
      styleId: resolved.id,
      totalRows,
      groupRows,
      freshRows: totalRows - groupRows,
      ratio: Number(ratio.toFixed(3)),
      targetRatio: 0.4,
      withinTarget: ratio >= 0.25 && ratio <= 0.55,
    });

    // Log overlay_stock_terms coverage so we can verify the REALISM
    // pillar is firing: the mixing_rules now demand a real-photo
    // composition on every named person / place / brand / event with
    // a cadence floor of ~1 per 8-12 rows (4-6 for factual scripts).
    // This log shows what the LLM actually emitted; pair with the
    // /api/overlay/fetch logs to see what got resolved at render time.
    const overlayRows = rows.filter((r) => {
      const terms = (r as unknown as { overlay_stock_terms?: unknown }).overlay_stock_terms;
      return typeof terms === 'string' && terms.trim().length > 0;
    });
    const overlayRatio = totalRows > 0 ? overlayRows.length / totalRows : 0;
    // Sample the first 8 terms so the log is grep-friendly without
    // dumping the entire script — full terms are visible per-row in
    // the saved doc.
    const sampleTerms = overlayRows.slice(0, 8).map((r) => {
      const idx = rows.indexOf(r);
      const term = (r as unknown as { overlay_stock_terms?: string }).overlay_stock_terms ?? '';
      return { rowIndex: idx, term };
    });
    logger.info('[production-doc overlay-stock terms]', {
      styleId: resolved.id,
      totalRows,
      overlayRows: overlayRows.length,
      overlayRatio: Number(overlayRatio.toFixed(3)),
      // Cadence floor: 1 real-photo beat per 8-12 rows = ratio of
      // ~0.083 - 0.125 at minimum. Factual scripts can sit at ~0.17 -
      // 0.25. Below the floor means the LLM is skipping named entities.
      meetsFloor: overlayRatio >= 0.08,
      sampleTerms,
    });

    // Log character_id emission so we can verify the LLM is actually
    // tagging recurring characters per the new CHARACTERS section in
    // the mixing_rules. The Atlas Edit cache hits happen later (image-
    // gen time, visible in the stage handler's tick summary); this
    // log captures what the LLM emitted before that.
    const charIdCounts = new Map<string, number>();
    for (const r of rows) {
      const cid = (r as unknown as { character_id?: unknown }).character_id;
      if (typeof cid === 'string' && cid.trim().length > 0) {
        charIdCounts.set(cid, (charIdCounts.get(cid) ?? 0) + 1);
      }
    }
    const rowsWithCharId = Array.from(charIdCounts.values()).reduce((a, b) => a + b, 0);
    // A character_id only earns its keep when at least 2 rows share it
    // (otherwise the cache never gets used). Count unique slugs that
    // appear on 2+ rows for the "actually-useful" metric.
    const reusableCharIds = Array.from(charIdCounts.entries()).filter(([, n]) => n >= 2);
    logger.info('[production-doc character-ids]', {
      styleId: resolved.id,
      totalRows,
      rowsWithCharId,
      uniqueCharIds: charIdCounts.size,
      reusableCharIds: reusableCharIds.length,
      // Sample the first 6 character_ids and their row counts so the
      // log is human-readable without dumping the entire doc.
      sampleSlugs: Array.from(charIdCounts.entries()).slice(0, 6).map(([slug, count]) => ({ slug, count })),
      // Heuristic: a script with named recurring characters (most
      // real-life story scripts) should emit at least one reusable
      // character_id. Zero means the LLM either ignored the
      // mixing_rules or the script genuinely has no recurring
      // characters (rare).
      hasAnyReusable: reusableCharIds.length > 0,
    });

    // Phase 2 (Character Bible) — telemetry for doc-level
    // character_descriptions emission. Logs the count + sample
    // entries so the post-gen QA can confirm the LLM honored the
    // mixing_rules update without dumping the whole map.
    const descriptions =
      (result as unknown as { doodle_explainer_2_character_descriptions?: Record<string, string> })
        .doodle_explainer_2_character_descriptions;
    if (descriptions && typeof descriptions === 'object') {
      const entries = Object.entries(descriptions).filter(
        ([slug, desc]) =>
          typeof slug === 'string' && slug.length > 0
          && typeof desc === 'string' && desc.trim().length > 0,
      );
      logger.info('[production-doc character-descriptions]', {
        styleId: resolved.id,
        emittedCount: entries.length,
        sample: entries.slice(0, 3).map(([slug, desc]) => ({
          slug,
          desc: desc.slice(0, 80) + (desc.length > 80 ? '…' : ''),
        })),
        totalChars: entries.reduce((sum, [, d]) => sum + d.length, 0),
      });
    } else {
      logger.info('[production-doc character-descriptions]', {
        styleId: resolved.id,
        emittedCount: 0,
        sample: [],
        totalChars: 0,
      });
    }

    // Phase 3 — same telemetry shape for scene_id emission.
    const sceneIdCounts = new Map<string, number>();
    for (const r of rows) {
      const sid = (r as unknown as { scene_id?: unknown }).scene_id;
      if (typeof sid === 'string' && sid.trim().length > 0) {
        sceneIdCounts.set(sid, (sceneIdCounts.get(sid) ?? 0) + 1);
      }
    }
    const rowsWithSceneId = Array.from(sceneIdCounts.values()).reduce((a, b) => a + b, 0);
    const reusableSceneIds = Array.from(sceneIdCounts.entries()).filter(([, n]) => n >= 2);
    logger.info('[production-doc scene-ids]', {
      styleId: resolved.id,
      totalRows,
      rowsWithSceneId,
      uniqueSceneIds: sceneIdCounts.size,
      reusableSceneIds: reusableSceneIds.length,
      sampleSlugs: Array.from(sceneIdCounts.entries()).slice(0, 6).map(([slug, count]) => ({ slug, count })),
      hasAnyReusable: reusableSceneIds.length > 0,
    });
  }

  // Option A (variant prompt refinement) — rewrites each variant's
  // vague `variant_edit_prompt` (extracted by autoGroupVariants) into
  // a specific, visually-concrete instruction the GPT Image 2 Edit
  // model can actually execute. Runs AFTER auto-grouping so it sees
  // both LLM-emitted and post-process-derived variant groups.
  // Parallelised internally; one LLM call per variant. Fail-soft per
  // variant — a single refinement failure preserves that variant's
  // original prompt without aborting the pass.
  //
  // Gated behind `USE_REFINED_VARIANT_PROMPT=1` so default behavior
  // is unchanged until validated. See
  // `_plans/2026-05-27-doodle-explainer-2-foundation.md` (Option A).
  if (Array.isArray(result.rows) && useRefinedVariantPrompt()) {
    const refinement = await refineVariantPromptsInDoc({
      rows: result.rows,
      styleLabel: resolved?.label ?? null,
      modelId: effectiveModelId,
      spend: {
        workspaceId: session.ws,
        featureArea: 'variant_prompt_refinement',
      },
    });
    if (
      refinement.refinedCount > 0 ||
      refinement.failedCount > 0 ||
      refinement.skippedCount > 0
    ) {
      logger.info('[production-doc variant-prompt-refinement]', {
        styleId: resolved?.id ?? null,
        refined: refinement.refinedCount,
        skipped: refinement.skippedCount,
        failed: refinement.failedCount,
      });
    }
  }

  // Stage 3.0 — detection-only pass that surfaces variant groups whose
  // base row (`variant_index === 0`) has an empty `ai_image_prompt`.
  // The base is generated by the regular i2i path and its prompt is
  // mandatory; an empty base blocks the entire group's image
  // generation (variants depend on the base's image URL). This pass
  // logs + warns instead of repairing so we can measure the bug's
  // real-world frequency before committing to an LLM re-prompt repair
  // path (Stage 3.1). See `_plans/2026-05-27-doodle-explainer-2-foundation.md`.
  if (Array.isArray(result.rows)) {
    const detection = detectEmptyVariantGroupBases(result.rows);
    if (detection.emptyBaseGroupIds.length > 0) {
      logger.warn('[production-doc empty-variant-bases]', {
        styleId: resolved?.id ?? null,
        totalGroupsChecked: detection.totalGroupsChecked,
        emptyBaseGroupCount: detection.emptyBaseGroupIds.length,
        emptyBaseGroupIds: detection.emptyBaseGroupIds,
      });
      generation_warnings.push(
        `${detection.emptyBaseGroupIds.length} variant group(s) have an empty base scene prompt. Affected variants won't generate images until the base prompt is filled — open the doc in the editor and add a scene description to the base row of each flagged group.`,
      );
    }
  }

  return NextResponse.json({ result, generation_warnings });
});
