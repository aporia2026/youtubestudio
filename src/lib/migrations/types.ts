/**
 * Migration interface used by the runner in `./index.ts`.
 *
 * Each numbered file in this directory exports a default `Migration`. The id
 * MUST match the filename (without extension) so the runner can locate logs
 * and error messages by filename alone.
 *
 * `up` performs the migration. It receives a connected node-postgres client
 * that is already inside a transaction — DO NOT issue BEGIN/COMMIT/ROLLBACK
 * inside a migration; the runner manages the transaction boundary so a failed
 * migration is auto-rolled back.
 *
 * `down` is optional. If present, it should reverse `up` cleanly enough that
 * the runner can roll back a single applied migration. We don't have a
 * down-runner CLI yet — `down` is recorded for human use during incidents.
 */
export interface MigrationClient {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface Migration {
  id: string;
  description: string;
  up(client: MigrationClient): Promise<void>;
  down?(client: MigrationClient): Promise<void>;
}
