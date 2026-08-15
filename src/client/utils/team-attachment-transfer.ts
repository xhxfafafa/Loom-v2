/**
 * Temporary IndexedDB handoff for Team Run launch attachments.
 *
 * Team creation navigates before the first prompt is sent, and the attachment
 * payload can exceed sessionStorage quotas, so `File` objects live here in
 * IndexedDB until the Team Run page consumes them. Only the opaque
 * `transferId` crosses through the pending-prompt payload — never file
 * content or Base64.
 *
 * Lifecycle: the launcher saves a record before creating the session, the
 * Team Run page reads it for the first prompt, delivery success deletes it,
 * and a delivery failure keeps it for retry until the 30-minute TTL expires.
 */

export interface PendingTeamAttachmentRecord {
  transferId: string;
  createdAt: number;
  attachments: File[];
}

export const TEAM_ATTACHMENT_TRANSFER_TTL_MS = 30 * 60 * 1000;

const DB_NAME = "routa-team-attachment-transfers";
const DB_VERSION = 1;
const STORE_NAME = "transfers";

/**
 * Random, URL-safe identifier. It is only ever used as an IndexedDB key and
 * must never be interpreted as a filesystem path.
 */
export function generateTeamAttachmentTransferId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  let fallback = "";
  for (let index = 0; index < 32; index += 1) {
    fallback += Math.floor(Math.random() * 16).toString(16);
  }
  return fallback;
}

/** Strict shape check: records come from storage and are untrusted input. */
export function isPendingTeamAttachmentRecord(value: unknown): value is PendingTeamAttachmentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.transferId !== "string" || record.transferId.length === 0) return false;
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return false;
  if (!Array.isArray(record.attachments)) return false;
  return record.attachments.every((entry) => typeof Blob !== "undefined" && entry instanceof Blob);
}

export function isExpiredTeamAttachmentRecord(
  record: Pick<PendingTeamAttachmentRecord, "createdAt">,
  nowMs: number,
  ttlMs: number = TEAM_ATTACHMENT_TRANSFER_TTL_MS,
): boolean {
  return nowMs - record.createdAt > ttlMs;
}

export function filterExpiredTeamAttachmentRecords<T extends Pick<PendingTeamAttachmentRecord, "createdAt">>(
  records: T[],
  nowMs: number,
  ttlMs: number = TEAM_ATTACHMENT_TRANSFER_TTL_MS,
): T[] {
  return records.filter((record) => !isExpiredTeamAttachmentRecord(record, nowMs, ttlMs));
}

let sharedDb: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || typeof window.indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  if (!sharedDb) {
    sharedDb = new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "transferId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to open attachment transfer store"));
      request.onblocked = () => reject(new Error("Attachment transfer store is blocked"));
    });
  }
  return sharedDb;
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = run(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Attachment transfer operation failed"));
      }),
  );
}

/** Remove records older than the TTL. Runs every time the helper opens. */
async function cleanupExpiredTransfers(): Promise<void> {
  const nowMs = Date.now();
  const records = await withStore<unknown[]>("readonly", (store) => store.getAll());
  const expired = records.filter(
    (record) => isPendingTeamAttachmentRecord(record) && isExpiredTeamAttachmentRecord(record, nowMs),
  );
  await Promise.all(
    expired.map((record) =>
      withStore<undefined>("readwrite", (store) =>
        store.delete((record as PendingTeamAttachmentRecord).transferId))
        .then(() => undefined),
    ),
  );
}

/**
 * Persist the selected files and return the opaque transfer ID that the
 * pending-prompt payload may reference. File content never leaves IndexedDB.
 */
export async function saveTeamAttachmentTransfer(files: File[]): Promise<string> {
  const transferId = generateTeamAttachmentTransferId();
  const record: PendingTeamAttachmentRecord = {
    transferId,
    createdAt: Date.now(),
    attachments: files,
  };
  await cleanupExpiredTransfers();
  await withStore<IDBValidKey>("readwrite", (store) => store.put(record));
  return transferId;
}

/** Read a transfer without deleting it; delivery success deletes it. */
export async function readTeamAttachmentTransfer(
  transferId: string,
): Promise<PendingTeamAttachmentRecord | null> {
  if (!transferId) return null;
  await cleanupExpiredTransfers();
  const record = await withStore<unknown>("readonly", (store) => store.get(transferId));
  if (!isPendingTeamAttachmentRecord(record)) return null;
  return record;
}

/** Delete the temporary record after the first prompt was accepted. */
export async function deleteTeamAttachmentTransfer(transferId: string): Promise<void> {
  if (!transferId) return;
  await withStore<undefined>("readwrite", (store) => store.delete(transferId)).then(() => undefined);
}
