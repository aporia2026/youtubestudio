import {
  getOneHandler,
  patchHandler,
  deleteHandler,
  IDEA_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = getOneHandler(IDEA_PRESET_CONFIG);
export const PATCH = patchHandler(IDEA_PRESET_CONFIG);
export const DELETE = deleteHandler(IDEA_PRESET_CONFIG);
