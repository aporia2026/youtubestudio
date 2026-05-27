import {
  getOneHandler,
  patchHandler,
  deleteHandler,
  SCRIPT_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = getOneHandler(SCRIPT_PRESET_CONFIG);
export const PATCH = patchHandler(SCRIPT_PRESET_CONFIG);
export const DELETE = deleteHandler(SCRIPT_PRESET_CONFIG);
