/**
 * Local mail mirror storage (Outlook/SOGo-style).
 *
 * Messages synced from IMAP land in the `email_mirror` Postgres table with a
 * tsvector column for full-text search, so inbox listings and keyword search
 * are served from the local copy instead of depending on the provider's
 * (sometimes lagging) server-side SEARCH index.
 *
 * Sync state (uidValidity/maxUid per folder) lives in the regular Store
 * under SYNC_STATE_KIND; the message rows live here.
 */
import type { Store } from "../../db.ts";
import { addressOf, displayName } from "./addresses.ts";
import type { FetchedMessage } from "./service.ts";

/** One mirrored message, shaped for the service's summary/message views. */
export interface MirrorMessage {
  uid: number;
  messageId?: string;
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  date?: string;
  snippet: string;
  unread: boolean;
  body: string;
  bodyHtml?: string;
}

export interface MirrorListPage {
  total: number;
  items: MirrorMessage[];
  /** Max mirrored_at for the folder, ISO string, or null when empty. */
  syncedAt: string | null;
}

const LIST_COLUMNS = `uid, message_id, subject, from_addr, from_name, to_addrs, cc_addrs, sent_at, flags, snippet, body_text, body_html`;

export class MirrorStore {
  private schemaReady: Promise<void> | null = null;
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Idempotent DDL; runs once, lazily, before the first query. */
  private ready(): Promise<void> {
    if (!this.schemaReady) {
      const run = async () => {
        await this.store.raw(`
          CREATE TABLE IF NOT EXISTS email_mirror (
            owner text NOT NULL,
            account_id text NOT NULL,
            folder text NOT NULL,
            uid bigint NOT NULL,
            uid_validity bigint NOT NULL,
            message_id text,
            subject text NOT NULL DEFAULT '',
            from_addr text NOT NULL DEFAULT '',
            from_name text NOT NULL DEFAULT '',
            to_addrs text[] NOT NULL DEFAULT '{}',
            cc_addrs text[] NOT NULL DEFAULT '{}',
            sent_at timestamptz,
            flags text[] NOT NULL DEFAULT '{}',
            body_text text NOT NULL DEFAULT '',
            body_html text NOT NULL DEFAULT '',
            snippet text NOT NULL DEFAULT '',
            search_tsv tsvector,
            mirrored_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (owner, account_id, folder, uid)
          )`);
        await this.store.raw(
          `CREATE INDEX IF NOT EXISTS email_mirror_search_idx ON email_mirror USING GIN (search_tsv)`,
        );
        await this.store.raw(
          `ALTER TABLE email_mirror ADD COLUMN IF NOT EXISTS body_html text NOT NULL DEFAULT ''`,
        );
        await this.store.raw(
          `CREATE INDEX IF NOT EXISTS email_mirror_list_idx
             ON email_mirror (owner, account_id, folder, sent_at DESC NULLS LAST, uid DESC)`,
        );
      };
      this.schemaReady = run();
    }
    return this.schemaReady;
  }

  /** Insert or replace one message. The tsvector covers subject/from/to/body. */
  async upsert(
    owner: string,
    accountId: string,
    folder: string,
    uidValidity: number,
    msg: FetchedMessage,
  ): Promise<void> {
    await this.ready();
    const from = msg.from[0];
    const subject = msg.subject ?? "";
    const fromAddr = from ? addressOf(from) : "";
    const fromName = from ? displayName(from) : "";
    const toAddrs = msg.to.map(addressOf).filter(Boolean);
    const ccAddrs = msg.cc.map(addressOf).filter(Boolean);
    const snippet = msg.text.replace(/\s+/g, " ").trim().slice(0, 240);
    const bodyHtml = msg.html ? msg.html.slice(0, 200_000) : "";
    await this.store.raw(
      `INSERT INTO email_mirror
         (owner, account_id, folder, uid, uid_validity, message_id, subject,
          from_addr, from_name, to_addrs, cc_addrs, sent_at, flags,
          body_text, body_html, snippet, search_tsv, mirrored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               to_tsvector('english',
                 coalesce($7::text,'') || ' ' || coalesce($8::text,'') || ' ' ||
                 coalesce(array_to_string($10::text[],' '),'') || ' ' || coalesce($14::text,'')),
               now())
       ON CONFLICT (owner, account_id, folder, uid) DO UPDATE SET
         uid_validity = EXCLUDED.uid_validity,
         message_id = EXCLUDED.message_id,
         subject = EXCLUDED.subject,
         from_addr = EXCLUDED.from_addr,
         from_name = EXCLUDED.from_name,
         to_addrs = EXCLUDED.to_addrs,
         cc_addrs = EXCLUDED.cc_addrs,
         sent_at = EXCLUDED.sent_at,
         flags = EXCLUDED.flags,
         body_text = EXCLUDED.body_text,
         body_html = EXCLUDED.body_html,
         snippet = EXCLUDED.snippet,
         search_tsv = EXCLUDED.search_tsv,
         mirrored_at = now()`,
      [
        owner,
        accountId,
        folder,
        msg.uid,
        uidValidity,
        msg.messageId ?? null,
        subject,
        fromAddr,
        fromName,
        toAddrs,
        ccAddrs,
        msg.date ?? null,
        msg.flags,
        msg.text,
        bodyHtml,
        snippet,
      ],
    );
  }

  async updateFlags(
    owner: string,
    accountId: string,
    folder: string,
    uid: number,
    flags: string[],
  ): Promise<void> {
    await this.ready();
    await this.store.raw(
      `UPDATE email_mirror SET flags = $5::text[], mirrored_at = now()
        WHERE owner = $1 AND account_id = $2 AND folder = $3 AND uid = $4`,
      [owner, accountId, folder, uid, flags],
    );
  }

  async deleteUids(
    owner: string,
    accountId: string,
    folder: string,
    uids: number[],
  ): Promise<void> {
    await this.ready();
    if (uids.length === 0) return;
    await this.store.raw(
      `DELETE FROM email_mirror
        WHERE owner = $1 AND account_id = $2 AND folder = $3 AND uid = ANY($4::bigint[])`,
      [owner, accountId, folder, uids],
    );
  }

  /** Drop every mirrored row for a folder (UIDVALIDITY change → full resync). */
  async deleteFolder(owner: string, accountId: string, folder: string): Promise<void> {
    await this.ready();
    await this.store.raw(
      `DELETE FROM email_mirror WHERE owner = $1 AND account_id = $2 AND folder = $3`,
      [owner, accountId, folder],
    );
  }

  async uids(owner: string, accountId: string, folder: string): Promise<number[]> {
    await this.ready();
    const res = await this.store.raw<{ uid: string }>(
      `SELECT uid FROM email_mirror WHERE owner = $1 AND account_id = $2 AND folder = $3`,
      [owner, accountId, folder],
    );
    return res.rows.map((row) => Number(row.uid));
  }

  async count(owner: string, accountId: string, folder: string): Promise<number> {
    await this.ready();
    const res = await this.store.raw<{ total: number }>(
      `SELECT count(*)::int AS total FROM email_mirror
        WHERE owner = $1 AND account_id = $2 AND folder = $3`,
      [owner, accountId, folder],
    );
    return res.rows[0]?.total ?? 0;
  }

  /**
   * UIDs of mirrored messages that still lack an HTML body, newest first.
   * Used by the background sync to backfill HTML for messages stored
   * before HTML capture was added.
   */
  async uidsMissingHtml(
    owner: string,
    accountId: string,
    folder: string,
    limit: number,
  ): Promise<number[]> {
    await this.ready();
    const res = await this.store.raw<{ uid: number }>(
      `SELECT uid FROM email_mirror
        WHERE owner = $1 AND account_id = $2 AND folder = $3 AND body_html = ''
        ORDER BY sent_at DESC NULLS LAST, uid DESC
        LIMIT $4`,
      [owner, accountId, folder, limit],
    );
    return res.rows.map((row) => Number(row.uid));
  }

  /** Store the HTML body for one mirrored message (sync backfill). */
  async setHtml(
    owner: string,
    accountId: string,
    folder: string,
    uid: number,
    html: string,
  ): Promise<void> {
    await this.ready();
    await this.store.raw(
      `UPDATE email_mirror SET body_html = $5, mirrored_at = now()
        WHERE owner = $1 AND account_id = $2 AND folder = $3 AND uid = $4`,
      [owner, accountId, folder, uid, html.slice(0, 200_000)],
    );
  }

  async get(
    owner: string,
    accountId: string,
    folder: string,
    uid: number,
  ): Promise<MirrorMessage | null> {
    await this.ready();
    const res = await this.store.raw(
      `SELECT ${LIST_COLUMNS} FROM email_mirror
        WHERE owner = $1 AND account_id = $2 AND folder = $3 AND uid = $4`,
      [owner, accountId, folder, uid],
    );
    return res.rows.length ? this.toMessage(res.rows[0]) : null;
  }

  /**
   * Newest-first page. An empty query lists; a non-empty query runs a
   * full-text search over the local tsvector, newest matches first.
   */
  async listPage(
    owner: string,
    accountId: string,
    folder: string,
    opts: { query: string; page: number; pageSize: number },
  ): Promise<MirrorListPage> {
    await this.ready();
    const trimmed = opts.query.trim();
    const offset = (opts.page - 1) * opts.pageSize;
    const base = `FROM email_mirror WHERE owner = $1 AND account_id = $2 AND folder = $3`;
    const baseParams = [owner, accountId, folder];
    let totalSql: string;
    let listSql: string;
    let params: unknown[];
    let totalParams: unknown[];
    if (trimmed) {
      const match = `search_tsv @@ websearch_to_tsquery('english', $4)`;
      totalSql = `SELECT count(*)::int AS total ${base} AND ${match}`;
      listSql = `SELECT ${LIST_COLUMNS} ${base} AND ${match}
                   ORDER BY sent_at DESC NULLS LAST, uid DESC
                   LIMIT $5 OFFSET $6`;
      totalParams = [...baseParams, trimmed];
      params = [...baseParams, trimmed, opts.pageSize, offset];
    } else {
      totalSql = `SELECT count(*)::int AS total ${base}`;
      listSql = `SELECT ${LIST_COLUMNS} ${base}
                   ORDER BY sent_at DESC NULLS LAST, uid DESC
                   LIMIT $4 OFFSET $5`;
      totalParams = baseParams;
      params = [...baseParams, opts.pageSize, offset];
    }
    const [totalRes, listRes, syncRes] = await Promise.all([
      this.store.raw<{ total: number }>(totalSql, totalParams),
      this.store.raw(listSql, params),
      this.store.raw<{ synced_at: string | null }>(
        `SELECT max(mirrored_at) AS synced_at FROM email_mirror
          WHERE owner = $1 AND account_id = $2 AND folder = $3`,
        baseParams,
      ),
    ]);
    return {
      total: totalRes.rows[0]?.total ?? 0,
      items: listRes.rows.map((row) => this.toMessage(row)),
      syncedAt: syncRes.rows[0]?.synced_at
        ? new Date(syncRes.rows[0].synced_at as string).toISOString()
        : null,
    };
  }

  private toMessage(row: Record<string, unknown>): MirrorMessage {
    const flags = (row.flags as string[] | null) ?? [];
    return {
      uid: Number(row.uid),
      messageId: (row.message_id as string | null) ?? undefined,
      from: (row.from_addr as string) ?? "",
      fromName: ((row.from_name as string) || undefined) ?? undefined,
      to: ((row.to_addrs as string[] | null) ?? []).filter(Boolean),
      cc: ((row.cc_addrs as string[] | null) ?? []).filter(Boolean),
      subject: (row.subject as string) ?? "",
      date: row.sent_at ? new Date(row.sent_at as string).toISOString() : undefined,
      snippet: (row.snippet as string) ?? "",
      unread: !flags.includes("\\Seen"),
      body: (row.body_text as string) ?? "",
      bodyHtml: (row.body_html as string) || undefined,
    };
  }
}
