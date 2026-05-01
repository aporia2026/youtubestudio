/**
 * User CRUD + auth helpers built on top of the existing `collaborators` table.
 *
 * "User" and "collaborator" are the same row in this schema (see
 * PHASE1_PLAN.md — we deliberately did not rename to avoid touching 60+
 * call sites). New auth code uses the language of users; existing workflow
 * code keeps saying collaborators. They are interchangeable.
 *
 * Conventions:
 *   - bcrypt cost 11 (~250ms on hobby; tune to 10 if cold-start dominates).
 *   - Passwords are minimum 12 chars; enforced at the helper boundary so
 *     every code path that sets a password gets the same rule.
 *   - One-shot tokens (invite, password reset) are stored as their sha-256
 *     hex digest. The plaintext is only ever in the email link sent to the
 *     user — a DB dump leaks no usable tokens.
 *   - The legacy `personal_token` and `unsubscribe_token` columns are
 *     intentionally still plaintext: they appear in long-lived URLs that
 *     real humans bookmark, and rotating them silently breaks portal
 *     access. They have a different threat model.
 */
import { hash, compare } from 'bcryptjs';
import { sql } from '@vercel/postgres';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const BCRYPT_COST = 11;
const PASSWORD_MIN_LENGTH = 12;
const INVITE_TTL_DAYS = 7;
const PASSWORD_RESET_TTL_HOURS = 1;

export type SystemRole = 'admin' | 'user';
export type UserStatus = 'active' | 'suspended' | 'invited';

export interface User {
  id: string;
  email: string | null;
  name: string;
  password_hash: string | null;
  google_sub: string | null;
  system_role: SystemRole;
  status: UserStatus;
  last_login_at: Date | null;
  encrypted_settings: string | null;
  invite_token: string | null;
  invite_expires_at: Date | null;
  password_reset_token: string | null;
  password_reset_expires_at: Date | null;
  // Legacy columns retained for back-compat with the rest of the app:
  role: string;
  color: string;
  personal_token: string | null;
  unsubscribe_token: string | null;
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export class PasswordTooShortError extends Error {
  constructor() {
    super(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    this.name = 'PasswordTooShortError';
  }
}

/** Hash a password. Throws PasswordTooShortError if the input is too short. */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordTooShortError();
  }
  return hash(plain, BCRYPT_COST);
}

/** Constant-time compare via bcrypt. Returns false if either side is empty. */
export async function verifyPassword(plain: string, hashed: string | null): Promise<boolean> {
  if (!plain || !hashed) return false;
  try {
    return await compare(plain, hashed);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// One-shot token generation + storage hashing
// ---------------------------------------------------------------------------

/** A 64-char hex token. Used in URLs sent via email — high enough entropy
 *  that brute force is infeasible and the token is short enough to fit in
 *  one line of an email link. */
export function generateOneShotToken(): string {
  return randomBytes(32).toString('hex');
}

/** sha-256 hex digest of an one-shot token. Used as the at-rest form so DB
 *  dumps don't leak usable tokens. Stable across calls (no salt) — that's
 *  intentional because we need to look the token up by exact match. */
export function hashOneShotToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time string compare for one-shot tokens. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  return timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// User lookup
// ---------------------------------------------------------------------------

export async function findUserById(id: string): Promise<User | null> {
  if (!id) return null;
  const { rows } = await sql<User>`
    SELECT * FROM collaborators WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  if (!email) return null;
  const { rows } = await sql<User>`
    SELECT * FROM collaborators
    WHERE email IS NOT NULL AND LOWER(email) = LOWER(${email.trim()})
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findUserByGoogleSub(sub: string): Promise<User | null> {
  if (!sub) return null;
  const { rows } = await sql<User>`
    SELECT * FROM collaborators WHERE google_sub = ${sub} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Look up a user by an UNHASHED invite token (i.e. the value from the URL).
 *  Returns null if the token is unknown OR expired. The expiry check happens
 *  at the SQL layer so we don't accept just-expired tokens by race. */
export async function findUserByInviteToken(token: string): Promise<User | null> {
  if (!token) return null;
  const tokenHash = hashOneShotToken(token);
  const { rows } = await sql<User>`
    SELECT * FROM collaborators
    WHERE invite_token = ${tokenHash}
      AND invite_expires_at IS NOT NULL
      AND invite_expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Look up a user by an UNHASHED password reset token. Same expiry semantics. */
export async function findUserByPasswordResetToken(token: string): Promise<User | null> {
  if (!token) return null;
  const tokenHash = hashOneShotToken(token);
  const { rows } = await sql<User>`
    SELECT * FROM collaborators
    WHERE password_reset_token = ${tokenHash}
      AND password_reset_expires_at IS NOT NULL
      AND password_reset_expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** Set a user's password (hashes + updates + clears any reset token). */
export async function setUserPassword(userId: string, plain: string): Promise<void> {
  const hashed = await hashPassword(plain);
  await sql`
    UPDATE collaborators
    SET password_hash = ${hashed},
        password_reset_token = NULL,
        password_reset_expires_at = NULL,
        status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
    WHERE id = ${userId}
  `;
}

/** Clear a user's password (e.g. when admin disables password login). */
export async function clearUserPassword(userId: string): Promise<void> {
  await sql`
    UPDATE collaborators SET password_hash = NULL WHERE id = ${userId}
  `;
}

/** Issue a fresh invite token; stores its HASH. Returns the plaintext —
 *  the caller emails this to the user. The plaintext is never persisted. */
export async function issueInviteToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateOneShotToken();
  const tokenHash = hashOneShotToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await sql`
    UPDATE collaborators
    SET invite_token = ${tokenHash},
        invite_expires_at = ${expiresAt.toISOString()}::timestamptz,
        status = 'invited'
    WHERE id = ${userId}
  `;
  return { token, expiresAt };
}

/** Consume an invite token (mark used, set initial password, mark active).
 *  Atomic at the DB level so the same token cannot be redeemed twice. */
export async function consumeInviteToken(token: string, newPassword: string): Promise<User | null> {
  const user = await findUserByInviteToken(token);
  if (!user) return null;
  const hashed = await hashPassword(newPassword);
  const { rows } = await sql<User>`
    UPDATE collaborators
    SET password_hash = ${hashed},
        invite_token = NULL,
        invite_expires_at = NULL,
        status = 'active'
    WHERE id = ${user.id}
      AND invite_token = ${hashOneShotToken(token)}
      AND invite_expires_at > NOW()
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** Issue a password-reset token, returning the plaintext for the email. */
export async function issuePasswordResetToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateOneShotToken();
  const tokenHash = hashOneShotToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 60 * 60 * 1000);
  await sql`
    UPDATE collaborators
    SET password_reset_token = ${tokenHash},
        password_reset_expires_at = ${expiresAt.toISOString()}::timestamptz
    WHERE id = ${userId}
  `;
  return { token, expiresAt };
}

/** Atomically consume a password reset token + set the new password. */
export async function consumePasswordResetToken(token: string, newPassword: string): Promise<User | null> {
  const user = await findUserByPasswordResetToken(token);
  if (!user) return null;
  const hashed = await hashPassword(newPassword);
  const { rows } = await sql<User>`
    UPDATE collaborators
    SET password_hash = ${hashed},
        password_reset_token = NULL,
        password_reset_expires_at = NULL,
        status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
    WHERE id = ${user.id}
      AND password_reset_token = ${hashOneShotToken(token)}
      AND password_reset_expires_at > NOW()
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** Stamp last_login_at = NOW(). Best-effort; never throws. */
export async function markLoginSuccess(userId: string): Promise<void> {
  try {
    await sql`UPDATE collaborators SET last_login_at = NOW() WHERE id = ${userId}`;
  } catch {
    /* logging side effect; not load-bearing */
  }
}

export async function suspendUser(userId: string): Promise<void> {
  await sql`UPDATE collaborators SET status = 'suspended' WHERE id = ${userId}`;
}

export async function unsuspendUser(userId: string): Promise<void> {
  await sql`UPDATE collaborators SET status = 'active' WHERE id = ${userId} AND status = 'suspended'`;
}

/** Link a Google `sub` to an existing user. Used by the OAuth login flow on
 *  first sign-in for a user who was created with email+password only. */
export async function linkGoogleSub(userId: string, sub: string): Promise<void> {
  await sql`UPDATE collaborators SET google_sub = ${sub} WHERE id = ${userId}`;
}
