import {
  listHandler,
  createHandler,
  IDEA_PRESET_CONFIG,
} from '@/lib/auto-pipeline/feature-preset-crud';

export const GET = listHandler(IDEA_PRESET_CONFIG);
export const POST = createHandler(IDEA_PRESET_CONFIG);
