/**
 * Shared webpack override for Remotion's `bundle()`.
 *
 * Remotion runs its own standalone webpack — it does not inherit the
 * Next.js webpack config, so the `@/*` path alias declared in
 * tsconfig.json is invisible to it. Compositions that import via
 * `@/lib/...` (e.g. Root.tsx, ShortVideo.tsx) fail to resolve unless
 * we replay the alias here.
 *
 * Both /api/render/video and /api/render/short pass this into
 * `bundle({ webpackOverride })`.
 */
import path from 'path';
import type { WebpackOverrideFn } from '@remotion/bundler';

export const remotionWebpackOverride: WebpackOverrideFn = (cfg) => ({
  ...cfg,
  resolve: {
    ...cfg.resolve,
    alias: {
      ...(cfg.resolve?.alias ?? {}),
      '@': path.join(process.cwd(), 'src'),
    },
  },
});
