/**
 * GET /api/local-studio/logs?lines=N
 *
 * Tail of the ComfyUI stderr log file we use for the dev launch
 * (`D:\AI\ComfyUI\startup-err.log`). Surfaces what's happening
 * inside ComfyUI to the UI so the user has visibility into model
 * loads, sampling progress lines, and errors without digging
 * through their filesystem.
 *
 * If ComfyUI was started a different way (manual `run_nvidia_gpu.bat`
 * outside our orchestration) the file may not exist — the route
 * returns an empty array, not a 500.
 *
 * Gated by `LOCAL_STUDIO=1`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { apiRoute } from '@/lib/route-helpers';

// Hard-coded path tied to the orchestration in CLAUDE.md. If a user
// has a different ComfyUI install we'd add a `comfyui_log_path`
// setting later. For now this matches every install we've shipped.
const COMFY_LOG_PATH = 'D:\\AI\\ComfyUI\\startup-err.log';

export const GET = apiRoute.public(async (req: NextRequest) => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const linesParam = url.searchParams.get('lines');
  const lines = Math.max(1, Math.min(500, Number(linesParam) || 80));

  try {
    const stat = await fs.stat(COMFY_LOG_PATH);
    // Read the trailing window — for a typical ComfyUI log, the last
    // 80 lines is well under 64 KB so this is cheap.
    const fd = await fs.open(COMFY_LOG_PATH, 'r');
    try {
      const windowBytes = Math.min(stat.size, 64 * 1024);
      const buf = Buffer.alloc(windowBytes);
      await fd.read(buf, 0, windowBytes, Math.max(0, stat.size - windowBytes));
      const text = buf.toString('utf8');
      // Strip the leading partial line if we cut into the middle of
      // one. Easier than trying to do proper line-anchored reading.
      const firstNl = text.indexOf('\n');
      const clean = firstNl >= 0 ? text.slice(firstNl + 1) : text;
      const allLines = clean.split('\n');
      const tail = allLines.slice(-lines).filter(l => l.length > 0);
      return NextResponse.json({
        ok: true,
        lines: tail,
        path: COMFY_LOG_PATH,
        size_bytes: stat.size,
      });
    } finally {
      await fd.close();
    }
  } catch {
    return NextResponse.json({
      ok: false,
      lines: [],
      path: COMFY_LOG_PATH,
    });
  }
});
