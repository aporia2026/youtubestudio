/**
 * Field configs for the four feature-preset tables (script_presets,
 * qa_presets, narration_presets, idea_presets — migration 0097).
 *
 * Lives in its own file so the configs can be imported from React
 * components without dragging in the server-side CRUD helpers
 * (apiRoute, sql, NextRequest, etc.) that live in
 * `feature-preset-crud.ts`. Pure data only — no runtime side effects.
 *
 * The server-side validator + UI form generator share these configs,
 * so adding/removing a field here automatically updates both the
 * accepted input shape AND the rendered form.
 */

// ─── Field-config shape ─────────────────────────────────────────────

export type FeaturePresetFieldType = 'text' | 'int' | 'numeric' | 'uuid' | 'jsonb' | 'enum';

export interface FeaturePresetField {
  /** Postgres column name. The validator + UPDATE keep the same name. */
  column: string;
  type: FeaturePresetFieldType;
  required?: boolean;
  /** For `int`/`numeric` types: inclusive bounds. */
  min?: number;
  max?: number;
  /** For `text` type: max characters. */
  maxLength?: number;
  /** For `enum` type: allowed string values. */
  enumValues?: readonly string[];
  // ─── UI hints (consumed by the admin page generator) ─────────────
  /** Human-readable label. Falls back to the column name. */
  label?: string;
  /** Tooltip / help text shown beneath the input. */
  hint?: string;
  /** Force a widget choice. Defaults inferred from type + maxLength. */
  widget?: 'input' | 'textarea';
  /** Number of rows for textarea widgets. */
  rows?: number;
  /** Placeholder. */
  placeholder?: string;
}

export interface FeaturePresetConfig {
  /** Postgres table name. */
  table: string;
  /** Lowercase human-readable label used in error messages — e.g. "script preset". */
  label: string;
  fields: readonly FeaturePresetField[];
}

// ─── Per-feature configs ────────────────────────────────────────────

export const SCRIPT_PRESET_CONFIG: FeaturePresetConfig = {
  table: 'script_presets',
  label: 'script preset',
  fields: [
    { column: 'name', type: 'text', required: true, maxLength: 200, label: 'Name',
      placeholder: 'e.g. Cyber Explainer voice' },
    { column: 'description', type: 'text', maxLength: 500, label: 'Description',
      hint: 'Optional. What is this script preset for?' },
    { column: 'tone', type: 'text', maxLength: 200, label: 'Tone',
      placeholder: 'e.g. urgent and direct',
      hint: 'One or two words describing the voice.' },
    { column: 'style_note', type: 'text', maxLength: 400, label: 'Style note',
      placeholder: 'e.g. short sentences, no rhetorical questions' },
    { column: 'audience', type: 'text', maxLength: 400, label: 'Target audience',
      placeholder: 'e.g. small-business IT decision makers' },
    { column: 'target_duration_minutes', type: 'int', min: 1, max: 120,
      label: 'Target duration (minutes)',
      hint: 'Optional. Overrides the pipeline preset target-spoken-words derivation.' },
    { column: 'additional_context', type: 'text', maxLength: 4000,
      label: 'Custom script instructions',
      widget: 'textarea', rows: 5,
      hint: "Free-form text spliced into the script prompt as 'additional context'." },
    { column: 'reference_context', type: 'text', maxLength: 4000,
      label: 'Reference context / videos',
      widget: 'textarea', rows: 3,
      hint: 'Optional. Transcripts, URLs, or notes the writer should treat as reference.' },
  ],
};

export const QA_PRESET_CONFIG: FeaturePresetConfig = {
  table: 'qa_presets',
  label: 'QA preset',
  fields: [
    { column: 'name', type: 'text', required: true, maxLength: 200, label: 'Name',
      placeholder: 'e.g. Strict QA · 85+ threshold' },
    { column: 'description', type: 'text', maxLength: 500, label: 'Description' },
    { column: 'min_score', type: 'numeric', min: 0, max: 100,
      label: 'Minimum passing score',
      hint: 'Critic-panel score threshold. Scripts below this trigger a retry.' },
    { column: 'max_iterations', type: 'int', min: 0, max: 10,
      label: 'Max retry iterations',
      hint: '0 = single attempt, no retries. The pipeline gives up after this many.' },
    { column: 'pre_check_enabled', type: 'enum',
      enumValues: ['on', 'off', 'inherit'] as const,
      label: 'Pre-QA self-check',
      hint: 'Have the generator self-criticize before the critic panel. Defaults to inherit.' },
    { column: 'generator_v2_enabled', type: 'enum',
      enumValues: ['on', 'off', 'inherit'] as const,
      label: 'Generator v2 (rubric-aware)',
      hint: 'Inject a rubric digest into the generator system prompt. Defaults to inherit.' },
  ],
};

export const NARRATION_PRESET_CONFIG: FeaturePresetConfig = {
  table: 'narration_presets',
  label: 'narration preset',
  fields: [
    { column: 'name', type: 'text', required: true, maxLength: 200, label: 'Name',
      placeholder: 'e.g. 7-day human narrator' },
    { column: 'description', type: 'text', maxLength: 500, label: 'Description' },
    { column: 'deadline_days', type: 'int', min: 1, max: 90, label: 'Deadline (days)',
      hint: 'How long the narrator has from assignment before the pipeline flags it overdue.' },
  ],
};

export const IDEA_PRESET_CONFIG: FeaturePresetConfig = {
  table: 'idea_presets',
  label: 'idea preset',
  fields: [
    { column: 'name', type: 'text', required: true, maxLength: 200, label: 'Name',
      placeholder: 'e.g. Cybersec trending · 5 ideas' },
    { column: 'description', type: 'text', maxLength: 500, label: 'Description' },
    { column: 'niche_default', type: 'text', maxLength: 200, label: 'Default niche',
      placeholder: 'e.g. cybersecurity' },
    { column: 'ideas_count_default', type: 'int', min: 1, max: 50,
      label: 'Default ideas per batch' },
    { column: 'focus', type: 'enum',
      enumValues: ['trending', 'evergreen', 'controversial', 'beginner', 'mixed'] as const,
      label: 'Focus',
      hint: 'Bias the brainstorm toward a category. Mixed = balance.' },
    { column: 'audience', type: 'text', maxLength: 400, label: 'Target audience' },
    { column: 'video_type', type: 'text', maxLength: 200, label: 'Video type',
      placeholder: 'e.g. 10-minute explainer' },
    { column: 'reference_context', type: 'text', maxLength: 4000,
      label: 'Reference context',
      widget: 'textarea', rows: 3 },
    { column: 'reddit_context', type: 'text', maxLength: 4000,
      label: 'Reddit context',
      widget: 'textarea', rows: 3,
      hint: 'Optional. Paste subreddit names or threads to seed the brainstorm.' },
  ],
};
