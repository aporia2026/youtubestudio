import {
  listHandler,
  createHandler,
  SCRIPT_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = listHandler(SCRIPT_PRESET_CONFIG);
export const POST = createHandler(SCRIPT_PRESET_CONFIG);
