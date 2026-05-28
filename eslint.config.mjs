import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Two react-hooks rules that were added in eslint-config-next 16 (React 19
 * era) flag real anti-patterns but require careful per-component refactor
 * to fix correctly. We downgrade them to warnings so CI can gate on errors
 * without forcing a sweeping React-19 migration onto every Phase 2/3 PR:
 *
 *   - react-hooks/set-state-in-effect: setState synchronously inside an
 *     effect can cascade renders. The pattern is widespread in legacy
 *     screens (sync server state into local state on mount). Real fix is
 *     useEffectEvent / derived state / useSyncExternalStore — needs
 *     thinking, not a one-liner.
 *
 *   - react-hooks/purity: pseudo-impure calls in render bodies (Date.now,
 *     Math.random, Date constructors). Often intentional (current-time
 *     formatting); real fix is to memoise or move into useEffect.
 *
 * Both stay visible in IDE / `npm run lint` output. Address opportunistically
 * when touching the affected component. Re-promote to errors when the
 * codebase is clean.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // React-19 strict-mode rules that flag legitimate-but-careful-refactor
      // patterns in legacy components (sync server state into local state in
      // an effect; current-time formatting in render bodies). Real fixes are
      // useEffectEvent / useMemo / useSyncExternalStore — opportunistic
      // cleanup, not a one-line change. Stays visible as warnings.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",

      // Cosmetic / typing nits that pre-date Phase 1 and would need ~50 line
      // touches across legacy components. Downgraded so CI can gate on
      // genuine errors. Each is fixable mechanically when touching the file.
      "react/no-unescaped-entities": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  // ─── Persistence chokepoint enforcement (Phase 2.1) ─────────────────
  // Ban raw `fetch()` in client-side code that sends server mutations.
  // Every server mutation MUST route through `mutate()` in src/lib/mutate.ts
  // so the request lands in the durable IDB outbox and gets retry +
  // server-side dedup via mutation_ids. Bypassing this re-introduces
  // the bug class that lost doc d244130f-bdfe's 181 image attaches —
  // see _plans/2026-05-29-persistence-rebuild.md.
  //
  // Scope: client-side files only. `src/app/api/**` is exempted because
  // server routes legitimately call providers (Replicate, Atlas, OpenAI)
  // and aren't subject to the browser tab-close failure mode.
  //
  // Severity: WARN (not error) initially. The codebase has ~40 existing
  // call sites that need gradual migration; gating CI on errors today
  // would block every PR. Each migration drops a warning; once the
  // baseline is zero we promote to ERROR.
  //
  // Exemptions besides server routes:
  //   - src/lib/mutate.ts             — the chokepoint itself
  //   - src/proxy.ts                  — edge proxy auth, runs server-side
  //   - tests/**                      — fetch mocks
  //   - src/remotion/**               — Remotion renderer (different runtime)
  //   - GET requests are still warned (visibility); legitimate GETs can
  //     be exempted per-line with `// eslint-disable-next-line no-restricted-syntax`
  //     and a comment naming the reason.
  {
    // Scoped to .tsx files (React components, where browser-side fetch
    // is sent from a tab that may close mid-flight). Plain .ts files
    // under src/lib are mostly server-only helpers that call third-
    // party APIs legitimately — out of scope for this rule.
    files: [
      "src/app/(app)/**/*.tsx",
      "src/components/**/*.tsx",
      "src/hooks/**/*.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",
          message:
            "Use mutate() from @/lib/mutate for server mutations (POST/PUT/PATCH/DELETE) so the request survives refresh/tab-close. Read-only GETs that should bypass the queue can disable this rule per-line with `// eslint-disable-next-line no-restricted-syntax` and a comment naming the reason. See _plans/2026-05-29-persistence-rebuild.md.",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
