import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { deleteWorkflowRule, updateWorkflowRule } from '@/lib/workflows';

export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    try {
      const ok = await updateWorkflowRule({
        id,
        workspaceId: session.ws,
        name: typeof b.name === 'string' ? b.name : undefined,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
        condition: b.condition && typeof b.condition === 'object' ? (b.condition as Record<string, never>) : undefined,
        actionConfig: b.actionConfig && typeof b.actionConfig === 'object' ? (b.actionConfig as Record<string, never>) : undefined,
        delaySeconds: typeof b.delaySeconds === 'number' ? b.delaySeconds : undefined,
      });
      if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'workflows: update-rule',
        knownPatterns: [
          { match: /required|invalid|unsupported/i, status: 400 },
        ],
        fallbackMessage: 'Could not update the workflow rule.',
      });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteWorkflowRule(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
