/**
 * Skill loader — reads critic definitions from Markdown files at module init.
 *
 * Non-devs can edit hook-coach.md / substance-auditor.md / flow-critic.md
 * to tweak persona, mission, rubric, or ownership without touching TS code.
 * Format (inspired by agentskills.io):
 *
 *   ---
 *   id: hook-coach
 *   persona: ...
 *   mission: ...
 *   owned: a, b, c
 *   ---
 *   <rubric markdown, verbatim>
 *
 * Body is passed through to the LLM prompt unchanged — preserve any numbering
 * or formatting you write.
 *
 * Next.js traces `new URL('./path', import.meta.url)` and bundles the
 * referenced .md files into the server build output. No config changes
 * required in next.config.ts.
 */

import { readFileSync } from 'node:fs';
import type { ScriptCategoryKey, ScriptCriticId } from '../types';

export interface SkillSpec {
  id: ScriptCriticId;
  persona: string;
  mission: string;
  owned: ScriptCategoryKey[];
  rubric: string;
}

const VALID_CRITIC_IDS: ReadonlySet<ScriptCriticId> = new Set(['hook-coach', 'substance-auditor', 'flow-critic']);
const VALID_CATEGORY_KEYS: ReadonlySet<ScriptCategoryKey> = new Set([
  'hook_strength', 'retention_potential', 'content_quality', 'audience_targeting',
  'cta_effectiveness', 'seo_optimization', 'pacing_flow', 'human_authenticity',
  'natural_speech', 'logic_coherence',
]);

/** Minimal frontmatter parser — avoids adding gray-matter as a dep since we
 *  only need string scalars and one comma-separated list. Throws with a
 *  clear error so a malformed skill file fails fast at boot (bad deploy),
 *  not silently at first request. */
function parseSkill(source: string, filename: string): SkillSpec {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: missing or malformed frontmatter (expected "---\\n...\\n---\\n<body>")`);

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) throw new Error(`${filename}: invalid frontmatter line "${line}" (missing ':')`);
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }

  const required = ['id', 'persona', 'mission', 'owned'] as const;
  for (const k of required) {
    if (!frontmatter[k]) throw new Error(`${filename}: frontmatter missing required key "${k}"`);
  }

  const id = frontmatter.id as ScriptCriticId;
  if (!VALID_CRITIC_IDS.has(id)) {
    throw new Error(`${filename}: unknown critic id "${id}" (expected one of: ${[...VALID_CRITIC_IDS].join(', ')})`);
  }

  const owned = frontmatter.owned.split(',').map(s => s.trim()).filter(Boolean) as ScriptCategoryKey[];
  if (owned.length === 0) throw new Error(`${filename}: "owned" must list at least one category`);
  for (const key of owned) {
    if (!VALID_CATEGORY_KEYS.has(key)) {
      throw new Error(`${filename}: unknown category "${key}" in owned (expected one of: ${[...VALID_CATEGORY_KEYS].join(', ')})`);
    }
  }

  const rubric = match[2].trim();
  if (!rubric) throw new Error(`${filename}: body (rubric) must not be empty`);

  return { id, persona: frontmatter.persona, mission: frontmatter.mission, owned, rubric };
}

function loadSkillFile(filename: string): SkillSpec {
  const url = new URL(`./${filename}`, import.meta.url);
  const text = readFileSync(url, 'utf8');
  return parseSkill(text, filename);
}

/**
 * V2 rubric switch (Lever A of the QA hardening plan). When
 * QA_RUBRIC_V2_ENABLED=true, load the rebuilt rubrics with anchor
 * examples, per-category deduction lists, and a self-criticism step.
 * V1 stays in the repo as the rollback path. The flag is resolved
 * here at module init (file reads are synchronous), so a redeploy is
 * needed to flip it — the right granularity for a load-bearing change.
 *
 * Importing the flag inline (not at top of file) so this module's
 * runtime side-effect (file reads) survives even if the flag module
 * has its own initialisation order. The flag is read once; cached
 * naturally by module evaluation.
 */
const v2Enabled = process.env.QA_RUBRIC_V2_ENABLED === 'true';
const HOOK_FILE = v2Enabled ? 'hook-coach.v2.md' : 'hook-coach.md';
const SUBSTANCE_FILE = v2Enabled ? 'substance-auditor.v2.md' : 'substance-auditor.md';
const FLOW_FILE = v2Enabled ? 'flow-critic.v2.md' : 'flow-critic.md';

export const HOOK_COACH = loadSkillFile(HOOK_FILE);
export const SUBSTANCE_AUDITOR = loadSkillFile(SUBSTANCE_FILE);
export const FLOW_CRITIC = loadSkillFile(FLOW_FILE);
export const SCRIPT_CRITICS: SkillSpec[] = [HOOK_COACH, SUBSTANCE_AUDITOR, FLOW_CRITIC];
