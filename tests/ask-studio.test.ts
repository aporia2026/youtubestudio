import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '@/lib/ask-studio';

describe('TOOL_CATALOG', () => {
  it('contains the load-bearing tools', () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(names).toContain('list_channels');
    expect(names).toContain('list_recent_videos');
    expect(names).toContain('list_underperforming_videos');
    expect(names).toContain('list_top_performers');
    expect(names).toContain('list_scheduled_items');
    expect(names).toContain('list_projects');
    expect(names).toContain('list_ab_tests');
    expect(names).toContain('count_uploads_by_channel');
    expect(names).toContain('get_video_analytics');
  });

  it('every tool has a non-empty description', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('every tool has a valid input_schema (object root)', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.input_schema.type).toBe('object');
      expect(typeof t.input_schema.properties).toBe('object');
    }
  });

  it('list_top_performers requires the metric arg', () => {
    const t = TOOL_CATALOG.find((x) => x.name === 'list_top_performers')!;
    expect(t.input_schema.required).toEqual(['metric']);
    const metric = t.input_schema.properties.metric as { enum?: string[] };
    expect(metric.enum).toEqual(['views', 'ctr_percentage', 'average_view_percentage', 'subscribers_gained']);
  });

  it('get_video_analytics requires youtube_video_id', () => {
    const t = TOOL_CATALOG.find((x) => x.name === 'get_video_analytics')!;
    expect(t.input_schema.required).toEqual(['youtube_video_id']);
  });

  it('tool names are kebab-or-snake-case-friendly (no spaces, lowercase, alphanumerics + underscore)', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('tool names are unique', () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
