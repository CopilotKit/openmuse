import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { TaskStatus } from "../../../packages/domain/src/agent.ts";
import type { Prerequisite } from "../../../packages/domain/src/scheduler.ts";
import { backgroundFailure } from "./log.ts";

/** `data` is the records table's payload; the index signature covers the real tables. */
type Row = { data: Record<string, unknown>; [column: string]: unknown };
interface Database {
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

export class Store {
  constructor(private readonly db: Database) {}
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
  }
  /**
   * Empty every table. Only for test fixtures and destructive maintenance —
   * this is the only method here that discards other owners' data, so it must
   * never sit on a request path.
   */
  async clearAll(): Promise<void> {
    await this.db.query("DELETE FROM records");
    await this.db.query("DELETE FROM task_dependencies");
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.db.query(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claim<T>(owner: string, id: string, status: string, now: string): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND (data->>'expiresAt')::timestamptz>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async recoverInterruptedActions(): Promise<void> {
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
      [owner, connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
  /** Tasks that `taskId` waits on. */
  async dependencies(owner: string, taskId: string): Promise<string[]> {
    const result = await this.db.query<{ depends_on_id: string }>(
      "SELECT depends_on_id FROM task_dependencies WHERE owner=$1 AND task_id=$2 ORDER BY depends_on_id",
      [owner, taskId],
    );
    return result.rows.map((row) => row.depends_on_id);
  }
  /** Tasks waiting on `taskId` — the reverse edge, for "what just unblocked?". */
  async dependents(owner: string, taskId: string): Promise<string[]> {
    const result = await this.db.query<{ task_id: string }>(
      "SELECT task_id FROM task_dependencies WHERE owner=$1 AND depends_on_id=$2 ORDER BY task_id",
      [owner, taskId],
    );
    return result.rows.map((row) => row.task_id);
  }
  /**
   * Declare that `taskId` depends on `dependsOnId`.
   *
   * Returns false rather than throwing for the three rejections a caller can
   * act on: a self-edge, a duplicate edge, and any edge that would close a
   * cycle. A cycle is unrecoverable once written — the scheduler would simply
   * never make progress — so it is refused at the only place that can see the
   * whole graph. Concurrency is safe because two edges that each look acyclic
   * alone cannot together close a cycle in opposite directions.
   */
  async addDependency(owner: string, taskId: string, dependsOnId: string): Promise<boolean> {
    if (taskId === dependsOnId) return false;
    const existing = await this.dependencies(owner, taskId);
    if (existing.includes(dependsOnId)) return false;
    // A cycle appears if dependsOnId already (transitively) depends on taskId.
    if (await this.reaches(owner, dependsOnId, taskId)) return false;
    const result = await this.db.query(
      "INSERT INTO task_dependencies(owner,task_id,depends_on_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING depends_on_id",
      [owner, taskId, dependsOnId],
    );
    return result.rows.length === 1;
  }
  async removeDependency(owner: string, taskId: string, dependsOnId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM task_dependencies WHERE owner=$1 AND task_id=$2 AND depends_on_id=$3",
      [owner, taskId, dependsOnId],
    );
  }
  /** Remove every edge into or out of a task; used when the task itself is deleted. */
  async removeDependenciesFor(owner: string, taskId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM task_dependencies WHERE owner=$1 AND (task_id=$2 OR depends_on_id=$2)",
      [owner, taskId],
    );
  }
  /** Does `from` transitively depend on `target`? Breadth-first over the edges. */
  private async reaches(owner: string, from: string, target: string): Promise<boolean> {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const next of await this.dependencies(owner, current)) {
        if (next === target) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  }
  /**
   * Every prerequisite edge for an owner, each paired with that prerequisite's
   * current status, or `undefined` when the prerequisite task no longer exists.
   *
   * One query rather than one per task: the scheduler calls this on every tick
   * and a per-task lookup would make dispatch scale with total task count.
   */
  async prerequisiteStatuses(owner: string): Promise<Map<string, Prerequisite[]>> {
    const result = await this.db.query<{
      task_id: string;
      depends_on_id: string;
      status?: TaskStatus;
    }>(
      `SELECT d.task_id, d.depends_on_id, t.data->>'status' AS status
       FROM task_dependencies d
       LEFT JOIN records t ON t.owner=d.owner AND t.kind='tasks' AND t.id=d.depends_on_id
       WHERE d.owner=$1`,
      [owner],
    );
    const edges = new Map<string, Prerequisite[]>();
    for (const row of result.rows) {
      const prerequisite: Prerequisite = { id: row.depends_on_id, status: row.status };
      const existing = edges.get(row.task_id);
      if (existing) existing.push(prerequisite);
      else edges.set(row.task_id, [prerequisite]);
    }
    return edges;
  }
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const pool = createPool(options.databaseUrl);
    database = {
      query: async <T>(sql: string, params?: unknown[]) =>
        (await pool.query(sql, params)) as unknown as { rows: T[] },
      close: () => pool.end(),
    };
  } else {
    if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    database = {
      query: async <T>(sql: string, params?: unknown[]) =>
        (await embedded.query(sql, params)) as { rows: T[] },
      close: () => embedded.close(),
    };
  }
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  await migrateSchema(database);
  return new Store(database);
}

/**
 * Real (non-KV) tables. `records` is a generic jsonb store and cannot express
 * a join, so anything relational — currently only the task dependency DAG —
 * gets a table here. Schema is applied idempotently on every open; there are no
 * migration files yet, so keep additions forward-only and idempotent.
 */
async function migrateSchema(database: Database): Promise<void> {
  await database.query(
    `CREATE TABLE IF NOT EXISTS task_dependencies(
       owner text NOT NULL,
       task_id text NOT NULL,
       depends_on_id text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY(owner,task_id,depends_on_id))`,
  );
  // Reverse lookups ("what unblocks this task?") are the scheduler's hot path.
  await database.query(
    "CREATE INDEX IF NOT EXISTS task_dependencies_dependant ON task_dependencies(owner,depends_on_id)",
  );
}
