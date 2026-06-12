import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  BUILT_IN_STYLES,
  getBuiltInStyle,
} from '@/lib/production-doc-styles';
import { BUILT_IN_REF_DIR_MAP } from '@/lib/production-doc-styles-refs';

// ─── built-in ref dirMap ↔ filesystem contract ───────────────────────
//
// Background — 2026-06-12: zenn_v1 shipped with bundled built_in_refs
// but no entry in the dirMap inside production-doc-styles-refs.ts.
// The default-to-id fallback resolved `zenn_v1` → `public/style-refs/
// zenn_v1/...` while the actual folder is `Zenn-v1/`. Every i2i call
// then failed at the bundled-file-read step with "Failed to read
// built-in ref ... from deploy filesystem".
//
// These tests pin the contract so the same regression can't ship
// again: every built-in style with `built_in_refs` MUST have a
// dirMap entry, AND the entry MUST point at a real directory on
// disk, AND every declared ref filename MUST exist inside it.

describe('BUILT_IN_REF_DIR_MAP — every built-in with refs is mapped', () => {
  const stylesWithRefs = BUILT_IN_STYLES.filter(
    (s) => (s.built_in_refs ?? []).length > 0,
  );

  it('has at least one built-in style with refs (sanity)', () => {
    expect(stylesWithRefs.length).toBeGreaterThan(0);
  });

  for (const style of stylesWithRefs) {
    it(`has an entry for built-in '${style.id}'`, () => {
      // The default fallback (use style.id as folder name) is too
      // fragile to rely on — `zenn_v1` vs `Zenn-v1` proved that.
      // Every built-in with refs gets an explicit entry.
      expect(BUILT_IN_REF_DIR_MAP[style.id]).toBeDefined();
      expect(typeof BUILT_IN_REF_DIR_MAP[style.id]).toBe('string');
      expect(BUILT_IN_REF_DIR_MAP[style.id]).not.toBe('');
    });
  }
});

describe('BUILT_IN_REF_DIR_MAP — each mapped folder exists on disk with the declared refs', () => {
  for (const [styleId, dir] of Object.entries(BUILT_IN_REF_DIR_MAP)) {
    const builtIn = getBuiltInStyle(styleId);
    const refs = builtIn?.built_in_refs ?? [];
    if (refs.length === 0) {
      // Mapped but no refs declared — defensive entry, skip filesystem
      // checks (nothing to verify).
      continue;
    }

    it(`'${styleId}' → public/style-refs/${dir}/ exists`, async () => {
      const dirPath = path.join(process.cwd(), 'public', 'style-refs', dir);
      const stat = await fs.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);
    });

    for (const ref of refs) {
      it(`'${styleId}': ${dir}/${ref.filename} is readable`, async () => {
        const filePath = path.join(
          process.cwd(),
          'public',
          'style-refs',
          dir,
          ref.filename,
        );
        const stat = await fs.stat(filePath);
        expect(stat.isFile()).toBe(true);
        expect(stat.size).toBeGreaterThan(0);
      });
    }
  }
});
