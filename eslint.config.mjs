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
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
