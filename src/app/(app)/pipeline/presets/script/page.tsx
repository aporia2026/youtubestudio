'use client';

import { FeaturePresetManager } from '@/components/feature-presets/FeaturePresetManager';
import { SCRIPT_PRESET_CONFIG } from '@/lib/auto-pipeline/feature-preset-configs';

export default function ScriptPresetsPage() {
  return (
    <FeaturePresetManager
      apiBase="/api/auto-pipeline/script-presets"
      title="Script presets"
      subtitle="Reusable scripts-stage configs: tone, audience, target duration, custom instructions, reference context. Pipeline presets bundle one of these."
      fields={SCRIPT_PRESET_CONFIG.fields}
    />
  );
}
