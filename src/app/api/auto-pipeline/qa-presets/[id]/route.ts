import {
  getOneHandler,
  patchHandler,
  deleteHandler,
  QA_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = getOneHandler(QA_PRESET_CONFIG);
export const PATCH = patchHandler(QA_PRESET_CONFIG);
export const DELETE = deleteHandler(QA_PRESET_CONFIG);
