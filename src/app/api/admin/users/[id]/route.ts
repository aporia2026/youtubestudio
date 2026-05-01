import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { findUserById } from '@/lib/users';
import { extractIp, writeAudit } from '@/lib/audit';

export const GET = apiRoute.admin(async (_session, _req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const user = await findUserById(id);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { rows: memberships } = await sql<{ workspace_id: string; workspace_name: string; role: string }>`
    SELECT m.workspace_id, w.name AS workspace_name, m.role
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ${id}
     ORDER BY w.created_at ASC, m.role ASC
  `;

  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      system_role: user.system_role,
      status: user.status,
      role: user.role,
      color: user.color,
      has_password: user.password_hash !== null,
      has_google: user.google_sub !== null,
      last_login_at: user.last_login_at,
      personal_token: user.personal_token,
      unsubscribe_token: user.unsubscribe_token,
    },
    memberships,
  });
});

export const PATCH = apiRoute.admin(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const target = await findUserById(id);
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const b = (body ?? {}) as Record<string, unknown>;

    const updates: { name?: string; email?: string | null; system_role?: 'admin' | 'user' } = {};
    if (typeof b.name === 'string' && b.name.trim()) updates.name = b.name.trim();
    if (typeof b.email === 'string') {
      const e = b.email.trim().toLowerCase();
      if (e && !e.includes('@')) {
        return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
      }
      updates.email = e || null;
    }
    if (b.system_role === 'admin' || b.system_role === 'user') {
      updates.system_role = b.system_role;
    }

    if (!Object.keys(updates).length) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    // Defend against the admin demoting themselves to the last user — leaves
    // the system without an admin which would lock /admin out for everyone.
    if (updates.system_role === 'user' && id === session.uid) {
      const { rows } = await sql<{ count: number }>`
        SELECT COUNT(*)::int AS count FROM collaborators WHERE system_role = 'admin'
      `;
      if ((rows[0]?.count ?? 0) <= 1) {
        return NextResponse.json(
          { error: 'Cannot remove your own admin role — you are the only admin.' },
          { status: 400 },
        );
      }
    }

    await sql`
      UPDATE collaborators
         SET name = COALESCE(${updates.name ?? null}, name),
             email = CASE WHEN ${'email' in updates} THEN ${updates.email ?? null} ELSE email END,
             system_role = COALESCE(${updates.system_role ?? null}, system_role)
       WHERE id = ${id}
    `;

    await writeAudit({
      actorUserId: session.uid,
      action: 'user.update',
      targetUserId: id,
      metadata: { changes: updates },
      ipAddress: extractIp(req),
    });

    const updated = await findUserById(id);
    return NextResponse.json({ ok: true, user: updated && { id: updated.id, name: updated.name, email: updated.email, system_role: updated.system_role } });
  },
);

export const DELETE = apiRoute.admin(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (id === session.uid) {
      return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 });
    }
    const target = await findUserById(id);
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Cascade: workspace_members ON DELETE CASCADE; review_share_links sets
    // collaborator_id to NULL on delete via legacy code path — for safety,
    // null those refs here too rather than rely on schema state.
    try {
      await sql`UPDATE review_share_links SET collaborator_id = NULL WHERE collaborator_id = ${id}`;
    } catch {
      /* table may not exist on a fresh DB */
    }
    await sql`DELETE FROM collaborators WHERE id = ${id}`;

    await writeAudit({
      actorUserId: session.uid,
      action: 'user.delete',
      targetUserId: id,
      metadata: { name: target.name, email: target.email },
      ipAddress: extractIp(req),
    });

    return NextResponse.json({ ok: true });
  },
);
