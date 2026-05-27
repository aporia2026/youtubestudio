'use client';

import { FeaturePresetManager } from '@/components/feature-presets/FeaturePresetManager';
import { IDEA_PRESET_CONFIG } from '@/lib/auto-pipeline/feature-preset-configs';

export default function IdeaPresetsPage() {
  return (
    <FeaturePresetManager
      apiBase="/api/auto-pipeline/idea-presets"
      title="Idea-gen presets"
      subtitle="Reusable idea-generation configs: default niche, ideas per batch, focus, audience, reference / Reddit context. Pipeline presets bundle one of these."
      fields={IDEA_PRESET_CONFIG.fields}
    />
  );
}
