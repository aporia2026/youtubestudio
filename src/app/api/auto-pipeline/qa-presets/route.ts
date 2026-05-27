import {
  listHandler,
  createHandler,
  QA_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = listHandler(QA_PRESET_CONFIG);
export const POST = createHandler(QA_PRESET_CONFIG);
