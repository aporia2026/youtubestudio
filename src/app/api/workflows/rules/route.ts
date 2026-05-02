import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { createWorkflowRule, listWorkflowRules } from '@/lib/workflows';

export const GET = apiRoute.authed(async (session) => {
  const rules = await listWorkflowRules(session.ws);
  return NextResponse.json({ rules });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name : '';
  const triggerEventType = typeof b.triggerEventType === 'string' ? b.triggerEventType : '';
  const actionType = typeof b.actionType === 'string' ? b.actionType : '';
  if (!triggerEventType || !actionType) {
    return NextResponse.json({ error: 'triggerEventType and actionType are required' }, { status: 400 });
  }
  try {
    const result = await createWorkflowRule({
      workspaceId: session.ws,
      collaboratorId: session.uid,
      name,
      triggerEventType,
      actionType,
      condition: (b.condition && typeof b.condition === 'object' ? b.condition : {}) as Record<string, never>,
      actionConfig: (b.actionConfig && typeof b.actionConfig === 'object' ? b.actionConfig : {}) as Record<string, never>,
      delaySeconds: typeof b.delaySeconds === 'number' ? b.delaySeconds : 0,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
});
