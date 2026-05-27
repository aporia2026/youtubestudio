'use client';

import { FeaturePresetManager } from '@/components/feature-presets/FeaturePresetManager';
import { NARRATION_PRESET_CONFIG } from '@/lib/auto-pipeline/feature-preset-configs';

export default function NarrationPresetsPage() {
  return (
    <FeaturePresetManager
      apiBase="/api/auto-pipeline/narration-presets"
      title="Narration presets"
      subtitle="Reusable narration configs: deadline days, preferred narrator (coming soon), AI-voice settings (coming soon). Pipeline presets bundle one of these."
      fields={NARRATION_PRESET_CONFIG.fields}
    />
  );
}
