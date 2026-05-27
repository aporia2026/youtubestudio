import {
  listHandler,
  createHandler,
  NARRATION_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = listHandler(NARRATION_PRESET_CONFIG);
export const POST = createHandler(NARRATION_PRESET_CONFIG);
