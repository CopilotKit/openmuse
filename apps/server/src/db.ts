import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { TaskStatus } from "../../../packages/domain/src/agent.ts";
import {
  DEFAULT_FORM_FACTOR,
  type DeviceProfile,
  formFactorOf,
  normalizeCapabilities,
  normalizeFormFactor,
} from "../../../packages/domain/src/capabilities.ts";
import {
  type PairingState,
  pairingStateSchema,
  unpaired,
} from "../../../packages/domain/src/pairing.ts";
import type { Prerequisite } from "../../../packages/domain/src/scheduler.ts";
import type { SyncChange } from "../../../packages/domain/src/sync.ts";
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
    await this.appendChange(owner, {
      kind,
      recordId: value.id,
      op: "put",
      data: value as Record<string, unknown>,
    });
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
    // Logged so a device's projection drops the record rather than keeping a
    // tombstone forever. Omitting this is how "deleted on the server" turns into
    // "reappears on the phone every time it re-syncs".
    await this.appendChange(owner, { kind, recordId: id, op: "delete" });
  }
  /**
   * Empty every table. Only for test fixtures and destructive maintenance —
   * this is the only method here that discards other owners' data, so it must
   * never sit on a request path.
   */
  async clearAll(): Promise<void> {
    await this.db.query("DELETE FROM records");
    await this.db.query("DELETE FROM task_dependencies");
    // The log is reset too, deliberately: this is a destructive wipe used by test
    // fixtures, so replaying it would resurrect deleted rows on any device. The
    // cursor table is cleared rather than advanced so a device rebuilds from 0.
    await this.db.query("DELETE FROM changes");
    await this.db.query("DELETE FROM change_seq");
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
    const inserted = (result.rows[0]?.data as T | undefined) ?? null;
    // Only log an actual insert. Logging the `DO NOTHING` path would announce a
    // change for a row that did not change, making devices re-fetch state that
    // never moved.
    if (inserted)
      await this.appendChange(owner, {
        kind,
        recordId: value.id,
        op: "put",
        data: inserted as Record<string, unknown>,
      });
    return inserted;
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

  /**
   * Register or refresh a device in the per-device execution plane.
   *
   * Capabilities are normalized on the way in: a client claiming a capability we
   * do not know about is filtered out rather than stored, so a task can never be
   * dispatched against a capability this build cannot honour.
   */
  async registerDevice(
    owner: string,
    id: string,
    name: string,
    capabilities: readonly string[],
    formFactor?: string | undefined,
  ): Promise<DeviceProfile> {
    const normalized = normalizeCapabilities(capabilities);
    // Unrecognised form factors are DROPPED, not stored verbatim, so a client
    // cannot invent a third class and escape the destructive-work restriction.
    // A device that sends nonsense here reads as `handheld` downstream.
    const factor = normalizeFormFactor(formFactor);
    const result = await this.db.query<DeviceProfile>(
      `INSERT INTO devices(owner,id,name,capabilities,form_factor,last_seen_at)
       VALUES($1,$2,$3,$4::jsonb,$5,now())
       ON CONFLICT(owner,id) DO UPDATE
         SET name=EXCLUDED.name, capabilities=EXCLUDED.capabilities,
             form_factor=EXCLUDED.form_factor, last_seen_at=now()
       RETURNING id, name, capabilities, form_factor AS "formFactor",
         to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt"`,
      [owner, id, name, JSON.stringify(normalized), factor ?? DEFAULT_FORM_FACTOR],
    );
    const row = result.rows[0];
    if (!row) throw new Error("device registration returned no row");
    return {
      ...row,
      capabilities: normalizeCapabilities(row.capabilities ?? []),
      formFactor: formFactorOf(row),
    };
  }

  /** Heartbeat only. Does not change declared capabilities. */
  async touchDevice(owner: string, id: string): Promise<void> {
    await this.db.query("UPDATE devices SET last_seen_at=now() WHERE owner=$1 AND id=$2", [
      owner,
      id,
    ]);
  }

  /** Most-recently-seen first, so callers can stop once they have enough. */
  async listDevices(owner: string): Promise<DeviceProfile[]> {
    const result = await this.db.query<DeviceProfile>(
      `SELECT id, name, capabilities, form_factor AS "formFactor",
         to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt"
       FROM devices WHERE owner=$1 ORDER BY last_seen_at DESC`,
      [owner],
    );
    return result.rows.map((row) => ({
      ...row,
      capabilities: normalizeCapabilities(row.capabilities ?? []),
      // Normalised on read as well as on write: a row written before the
      // column existed has no form factor, and must read as the fail-closed
      // default rather than as an untyped hole in the contract.
      formFactor: formFactorOf(row),
    }));
  }

  async removeDevice(owner: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM devices WHERE owner=$1 AND id=$2", [owner, id]);
  }

  /**
   * Pairing state for one device, or `unpaired` when the device is unknown.
   *
   * An unknown device reads as unpaired rather than throwing: pairing is a
   * gate, and a gate must fail CLOSED for a caller it has never heard of. The
   * caller's session is already authenticated by this point, so an unknown id
   * here means "this session's device was removed", not "this is an attacker" —
   * but either way it must not be executable.
   */
  async pairingState(owner: string, id: string): Promise<PairingState> {
    const result = await this.db.query<{ pairing: PairingState | null }>(
      "SELECT pairing FROM devices WHERE owner=$1 AND id=$2",
      [owner, id],
    );
    const row = result.rows[0];
    if (!row?.pairing) return unpaired;
    // Validate what came back: the column is jsonb and a hand-edited or
    // future-shaped row must not be trusted into the state machine.
    const parsed = pairingStateSchema.safeParse(row.pairing);
    return parsed.success ? parsed.data : unpaired;
  }

  /**
   * Persist pairing state.
   *
   * The row is updated unconditionally rather than compare-and-swapped on the
   * prior value: pairing is a single-device state machine whose transitions are
   * already guarded by the challenge being consumed on use, so a lost update
   * here can only ever move a device further from paired, never into a forged
   * pairing. `mintChallenge` is the transition that must not race, and it is
   * reached from an already-trusted surface.
   */
  async savePairingState(owner: string, id: string, state: PairingState): Promise<void> {
    await this.db.query("UPDATE devices SET pairing=$3::jsonb WHERE owner=$1 AND id=$2", [
      owner,
      id,
      JSON.stringify(state),
    ]);
  }

  /**
   * Append to the sync log and return the assigned sequence number.
   *
   * The counter is bumped with `RETURNING` inside a single statement rather than
   * a read-then-write, so two concurrent writers cannot be handed the same seq.
   * That collision would silently drop one of them from a device's cursor.
   */
  async appendChange(
    owner: string,
    change: {
      kind: string;
      recordId: string;
      op: "put" | "delete";
      data?: Record<string, unknown> | undefined;
      deviceId?: string | undefined;
    },
  ): Promise<number> {
    const bumped = await this.db.query<{ next_seq: string }>(
      `INSERT INTO change_seq(owner,next_seq) VALUES($1,2)
       ON CONFLICT(owner) DO UPDATE SET next_seq=change_seq.next_seq+1
       RETURNING next_seq-1 AS next_seq`,
      [owner],
    );
    const seq = Number(bumped.rows[0]?.next_seq ?? "0");
    await this.db.query(
      "INSERT INTO changes(owner,seq,kind,record_id,op,data,device_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
      [
        owner,
        seq,
        change.kind,
        change.recordId,
        change.op,
        change.data === undefined ? null : JSON.stringify(change.data),
        change.deviceId ?? null,
      ],
    );
    return seq;
  }

  /**
   * Everything after the caller's cursor, oldest first, capped at `limit`.
   *
   * The returned `cursor` is the highest seq actually delivered — not the
   * newest in the table — so a device that falls behind pages forward instead of
   * skipping the batch it never received.
   */
  async changesSince(
    owner: string,
    since: number,
    limit = 500,
  ): Promise<{ changes: SyncChange[]; cursor: number; hasMore: boolean }> {
    const result = await this.db.query<{
      seq: string;
      kind: string;
      record_id: string;
      op: string;
      data?: Record<string, unknown> | null;
      device_id?: string | null;
      at: string;
    }>(
      `SELECT seq, kind, record_id, op, data, device_id,
         to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
       FROM changes WHERE owner=$1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [owner, since, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const changes = rows.map((row) => ({
      seq: Number(row.seq),
      kind: row.kind,
      recordId: row.record_id,
      op: row.op as "put" | "delete",
      data: row.data ?? undefined,
      deviceId: row.device_id ?? undefined,
      at: row.at,
    }));
    return {
      changes,
      cursor: changes.at(-1)?.seq ?? since,
      hasMore: result.rows.length > limit,
    };
  }

  /** The newest seq for an owner, or 0 when the log is empty. */
  async latestSeq(owner: string): Promise<number> {
    const result = await this.db.query<{ seq: string | null }>(
      "SELECT max(seq) AS seq FROM changes WHERE owner=$1",
      [owner],
    );
    return Number(result.rows[0]?.seq ?? "0");
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
  // Devices for the per-device execution plane. A table rather than jsonb rows
  // because the scheduler's hot path is "which devices are live right now",
  // which needs a query across owners' devices ordered by heartbeat.
  await database.query(
    `CREATE TABLE IF NOT EXISTS devices(
       owner text NOT NULL,
       id text NOT NULL,
       name text NOT NULL,
       capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
       last_seen_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY(owner,id))`,
  );
  // Form factor, added forward-only. A phone and a desktop differ on more than
  // capabilities: only a handheld is excluded from destructive work, and that
  // exclusion must not be inferred from the capability list (a phone that
  // declares `screen` would otherwise slip through). Defaults to 'handheld',
  // the FAIL-CLOSED choice -- a device that never declared a form factor is
  // treated as the more restricted kind, so rows written before this column
  // existed cannot claim destructive work by omission.
  await database.query(
    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS form_factor text NOT NULL DEFAULT 'handheld'",
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS devices_recent ON devices(owner,last_seen_at DESC)",
  );
  // Pairing state, added after `devices` shipped. Forward-only, `IF NOT EXISTS`,
  // per this repo's schema policy — there are still no migration files.
  //
  // `pairing` holds the whole serializable state as jsonb (pairedAt + the
  // outstanding challenge) rather than nullable columns, because the state
  // machine in packages/domain/src/pairing.ts produces and consumes it as one
  // value and splitting it across columns would put a second, divergent
  // representation on the table. `NULL` means "never paired", which is the
  // fail-closed default: a row predating this migration cannot execute.
  await database.query("ALTER TABLE devices ADD COLUMN IF NOT EXISTS pairing jsonb");
  // The sync log. Append-only, ordered by a monotonic per-owner seq; a device
  // stores the highest seq it has seen and pulls everything after it. This is
  // Telegram's model: the server owns an ordered log, device state is a
  // rebuildable projection of it.
  //
  // `seq` comes from a per-owner counter rather than a global sequence so two
  // owners cannot interleave into each other's cursors, and so a cursor stays
  // meaningful if rows are ever pruned per owner.
  await database.query(
    `CREATE TABLE IF NOT EXISTS change_seq(
       owner text PRIMARY KEY,
       next_seq bigint NOT NULL DEFAULT 1)`,
  );
  await database.query(
    `CREATE TABLE IF NOT EXISTS changes(
       owner text NOT NULL,
       seq bigint NOT NULL,
       kind text NOT NULL,
       record_id text NOT NULL,
       op text NOT NULL,
       data jsonb,
       device_id text,
       at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY(owner,seq))`,
  );
}
