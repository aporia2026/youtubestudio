import {
  getOneHandler,
  patchHandler,
  deleteHandler,
  NARRATION_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = getOneHandler(NARRATION_PRESET_CONFIG);
export const PATCH = patchHandler(NARRATION_PRESET_CONFIG);
export const DELETE = deleteHandler(NARRATION_PRESET_CONFIG);
