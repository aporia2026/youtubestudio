/**
 * Remotion Studio + CLI config.
 *
 * This is read by the standalone tools (`remotion studio`,
 * `remotion compositions`, `remotion render`, etc.). It is NOT read by
 * the programmatic `bundle()` calls in /api/render/* — those pass
 * `webpackOverride` directly. Both paths share the same override via
 * src/lib/remotion-bundler.ts so Studio and the production render stay
 * in lockstep.
 */
import { Config } from '@remotion/cli/config';
import { remotionWebpackOverride } from './src/lib/remotion-bundler';

Config.overrideWebpackConfig(remotionWebpackOverride);
