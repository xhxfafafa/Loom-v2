import { describe, expect, it } from "vitest";

import {
  TEAM_ATTACHMENT_TRANSFER_TTL_MS,
  filterExpiredTeamAttachmentRecords,
  generateTeamAttachmentTransferId,
  isExpiredTeamAttachmentRecord,
  isPendingTeamAttachmentRecord,
  readTeamAttachmentTransfer,
  saveTeamAttachmentTransfer,
} from "../utils/team-attachment-transfer";

describe("isPendingTeamAttachmentRecord", () => {
  it("accepts a record with an id, timestamp, and Blob attachments", () => {
    const record = {
      transferId: "transfer-1",
      createdAt: 123,
      attachments: [new File(["text"], "notes.txt", { type: "text/plain" })],
    };
    expect(isPendingTeamAttachmentRecord(record)).toBe(true);
    // An empty attachment list is structurally valid (the launcher stores the
    // record before the first prompt; content validation happens elsewhere).
    expect(isPendingTeamAttachmentRecord({ ...record, attachments: [] })).toBe(true);
  });

  it("rejects records with missing, empty, or wrong-typed fields", () => {
    expect(isPendingTeamAttachmentRecord(null)).toBe(false);
    expect(isPendingTeamAttachmentRecord("transfer")).toBe(false);
    expect(isPendingTeamAttachmentRecord({})).toBe(false);
    expect(isPendingTeamAttachmentRecord({ transferId: "", createdAt: 1, attachments: [] })).toBe(false);
    expect(isPendingTeamAttachmentRecord({ transferId: "t", createdAt: "now", attachments: [] })).toBe(false);
    expect(isPendingTeamAttachmentRecord({ transferId: "t", createdAt: Number.NaN, attachments: [] })).toBe(false);
    expect(isPendingTeamAttachmentRecord({ transferId: "t", createdAt: 1, attachments: "files" })).toBe(false);
    expect(isPendingTeamAttachmentRecord({ transferId: "t", createdAt: 1, attachments: [{ name: "a.txt" }] })).toBe(false);
  });
});

describe("expiry", () => {
  it("expires records strictly older than the 30 minute TTL", () => {
    const createdAt = 1_000_000;
    expect(isExpiredTeamAttachmentRecord({ createdAt }, createdAt + TEAM_ATTACHMENT_TRANSFER_TTL_MS)).toBe(false);
    expect(isExpiredTeamAttachmentRecord({ createdAt }, createdAt + TEAM_ATTACHMENT_TRANSFER_TTL_MS + 1)).toBe(true);
    expect(isExpiredTeamAttachmentRecord({ createdAt }, createdAt)).toBe(false);
  });

  it("supports a custom TTL", () => {
    expect(isExpiredTeamAttachmentRecord({ createdAt: 0 }, 11, 10)).toBe(true);
    expect(isExpiredTeamAttachmentRecord({ createdAt: 0 }, 10, 10)).toBe(false);
  });

  it("filters expired records while keeping fresh ones", () => {
    const now = 5_000_000;
    const fresh = { transferId: "fresh", createdAt: now - 1_000 };
    const expired = { transferId: "expired", createdAt: now - TEAM_ATTACHMENT_TRANSFER_TTL_MS - 5 };
    expect(filterExpiredTeamAttachmentRecords([fresh, expired], now)).toEqual([fresh]);
  });
});

describe("generateTeamAttachmentTransferId", () => {
  it("returns non-empty, unique, URL-safe identifiers", () => {
    const first = generateTeamAttachmentTransferId();
    const second = generateTeamAttachmentTransferId();
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
    expect(/^[A-Za-z0-9-]+$/.test(first)).toBe(true);
  });
});

describe("IndexedDB-backed handoff", () => {
  // jsdom does not implement IndexedDB; the helpers must fail loudly instead
  // of pretending the handoff happened.
  it("rejects saves when IndexedDB is unavailable", async () => {
    await expect(
      saveTeamAttachmentTransfer([new File(["text"], "notes.txt", { type: "text/plain" })]),
    ).rejects.toThrow(/IndexedDB/);
  });

  it("reads with an empty transfer id resolve to null without touching storage", async () => {
    await expect(readTeamAttachmentTransfer("")).resolves.toBeNull();
  });
});
