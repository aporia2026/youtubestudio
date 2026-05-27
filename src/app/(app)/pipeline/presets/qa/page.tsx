'use client';

import { FeaturePresetManager } from '@/components/feature-presets/FeaturePresetManager';
import { QA_PRESET_CONFIG } from '@/lib/auto-pipeline/feature-preset-configs';

export default function QaPresetsPage() {
  return (
    <FeaturePresetManager
      apiBase="/api/auto-pipeline/qa-presets"
      title="QA presets"
      subtitle="Reusable QA configs: minimum critic-panel score, max retry iterations, pre-check / generator-v2 toggles. Pipeline presets bundle one of these."
      fields={QA_PRESET_CONFIG.fields}
    />
  );
}
