/**
 * Local mail mirror sync engine (Outlook/SOGo-style).
 *
 * A background job pulls each mirrored folder over IMAP into the local
 * `email_mirror` table (see mirror.ts). Enumeration never uses IMAP SEARCH —
 * some providers serve SEARCH from a lagging index that omits recent mail —
 * so new messages are found by UID range, deletions by a UID-only `1:*`
 * fetch, and flag changes by a flags-only fetch over the recent window.
 *
 * Logs carry counts, folders, and UIDs only — never subjects or bodies.
 */
import type { Store } from "../../db.ts";
import type { MirrorStore } from "./mirror.ts";
import type {
  EmailService,
  FetchedMessage,
  ImapSyncConnection,
  ResolvedEmailAccount,
} from "./service.ts";

/**
 * Minimal factory surface the sync engine needs. EmailService checks
 * `factories.imapSync` exists before calling in, so the engine can treat it
 * as required.
 */
export interface SyncCapableFactories {
  imapSync(account: ResolvedEmailAccount): Promise<ImapSyncConnection>;
}

/** Folders kept in the local mirror. Extend to add more (Trash/Spam skipped). */
export const MIRROR_FOLDERS = ["INBOX", "Sent"] as const;

/** How often the background job syncs every account. */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Sync-state records live in the Store under this kind. */
export const SYNC_STATE_KIND = "email-sync-state";

/** Full-message fetch batch size (UID ranges). */
const FETCH_BATCH_SIZE = 500;

/** How many of the most recent UIDs get their flags refreshed each sync. */
const FLAG_REFRESH_WINDOW = 200;

/**
 * Per sync run, how many of the newest HTML-less mirrored messages get
 * their HTML backfilled (messages stored before HTML capture existed).
 */
const HTML_BACKFILL_BATCH = 25;

interface SyncState {
  id: string;
  uidValidity: number;
  maxUid: number;
  lastSyncAt: string;
  messageCount: number;
}

export interface MirrorSyncReport {
  owner: string;
  accountId: string;
  folder: string;
  added: number;
  deleted: number;
  flagsRefreshed: number;
  total: number;
  resynced: boolean;
  lastSyncAt: string;
}

/**
 * Sync one folder of one account into the mirror. Idempotent: safe to
 * re-run after a crash — maxUid only advances past messages actually stored.
 */
export async function syncFolderMirror(opts: {
  owner: string;
  accountId: string;
  folder: string;
  account: ResolvedEmailAccount;
  factories: SyncCapableFactories;
  store: Store;
  mirror: MirrorStore;
  log?: (message: string) => void;
}): Promise<MirrorSyncReport> {
  const { owner, accountId, folder, account, factories, store, mirror, log } = opts;
  const stateId = `${accountId}:${folder}`;
  let state = await store.get<SyncState>(owner, SYNC_STATE_KIND, stateId);
  let added = 0;
  let deleted = 0;
  let flagsRefreshed = 0;
  let resynced = false;

  const conn = await factories.imapSync(account);
  try {
    const session = await conn.openFolder(folder);
    try {
      if (state && state.uidValidity !== session.uidValidity) {
        // Mailbox was recreated server-side; UIDs are meaningless now.
        await mirror.deleteFolder(owner, accountId, folder);
        state = null;
        resynced = true;
      }
      const maxUid = state?.maxUid ?? 0;

      // 1) New messages: everything above the stored max UID.
      let newMax = maxUid;
      const rangeEnd = session.uidNext - 1;
      for (let start = maxUid + 1; start <= rangeEnd; start += FETCH_BATCH_SIZE) {
        const end = Math.min(start + FETCH_BATCH_SIZE - 1, rangeEnd);
        const messages: FetchedMessage[] = await session.fetchRange(start, end);
        for (const message of messages) {
          await mirror.upsert(owner, accountId, folder, session.uidValidity, message);
          added += 1;
          if (message.uid > newMax) newMax = message.uid;
        }
      }

      // 2) Deletions: local UIDs no longer present on the server.
      const serverUids = await session.listUids();
      const serverSet = new Set(serverUids);
      const gone = (await mirror.uids(owner, accountId, folder)).filter(
        (uid) => !serverSet.has(uid),
      );
      if (gone.length > 0) {
        await mirror.deleteUids(owner, accountId, folder, gone);
        deleted = gone.length;
      }

      // 3) Flag refresh over the most recent window (seen/unseen etc.).
      const recent = serverUids.slice(-FLAG_REFRESH_WINDOW);
      if (recent.length > 0) {
        const flagRows = await session.fetchFlags(recent[0], recent[recent.length - 1]);
        for (const row of flagRows) {
          await mirror.updateFlags(owner, accountId, folder, row.uid, row.flags);
          flagsRefreshed += 1;
        }
      }

      // 4) HTML backfill: newest mirrored messages that predate HTML
      // capture get their HTML filled in, newest first, a batch per run.
      let htmlBackfilled = 0;
      const missingHtml = await mirror.uidsMissingHtml(
        owner,
        accountId,
        folder,
        HTML_BACKFILL_BATCH,
      );
      for (const uid of missingHtml) {
        try {
          const fetched = await session.fetchRange(uid, uid);
          const html = fetched[0]?.html;
          if (html) {
            await mirror.setHtml(owner, accountId, folder, uid, html);
            htmlBackfilled += 1;
          }
        } catch {
          // A single message failing must not fail the whole sync.
        }
      }

      const lastSyncAt = new Date().toISOString();
      await store.put<SyncState>(owner, SYNC_STATE_KIND, {
        id: stateId,
        uidValidity: session.uidValidity,
        maxUid: newMax,
        lastSyncAt,
        messageCount: session.exists,
      });
      log?.(
        `synced ${folder}: +${added} -${deleted} flags=${flagsRefreshed} total=${session.exists}` +
          (htmlBackfilled ? ` html+${htmlBackfilled}` : "") +
          (resynced ? " (uidvalidity resync)" : ""),
      );
      return {
        owner,
        accountId,
        folder,
        added,
        deleted,
        flagsRefreshed,
        total: session.exists,
        resynced,
        lastSyncAt,
      };
    } finally {
      await session.release();
    }
  } finally {
    await conn.close();
  }
}

/**
 * Start the background mirror job. Syncs every account of every owner that
 * has email accounts, every `intervalMs`. Never throws out of the tick and
 * never overlaps runs. The timer is unref'd so it can't hold the process
 * open on its own. Returns a stop function.
 */
export function startMirrorScheduler(opts: {
  store: Store;
  getService: () => EmailService | undefined;
  intervalMs?: number;
  initialDelayMs?: number;
  log?: (message: string) => void;
}): () => void {
  const intervalMs = opts.intervalMs ?? SYNC_INTERVAL_MS;
  const log = opts.log ?? ((message: string) => console.log(`[email-mirror] ${message}`));
  let timer: ReturnType<typeof setInterval> | undefined;
  let initial: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const service = opts.getService();
      if (!service) return;
      const owners = await service.listOwnersWithAccounts();
      for (const owner of owners) {
        try {
          await service.syncMirrors(owner);
        } catch (error) {
          log(`owner sync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  initial = setTimeout(() => void tick(), opts.initialDelayMs ?? 10_000);
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  if (typeof initial.unref === "function") initial.unref();
  log(`scheduler started (every ${Math.round(intervalMs / 1000)}s)`);
  return () => {
    if (initial) clearTimeout(initial);
    if (timer) clearInterval(timer);
  };
}
