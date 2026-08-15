import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPendingPrompt,
  consumePendingPromptPayload,
  peekPendingPromptPayload,
  storePendingPrompt,
} from "../utils/pending-prompt";

describe("pending-prompt payload handoff", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores and peeks a structured payload without deleting it", () => {
    const stored = storePendingPrompt("session-1", {
      text: "Deliver feature X",
      attachmentTransferId: "transfer-1",
      repositoryFiles: [{ path: "src/a.ts", label: "a.ts" }],
    });
    expect(stored).toBe(true);

    const first = peekPendingPromptPayload("session-1");
    expect(first).toMatchObject({
      text: "Deliver feature X",
      attachmentTransferId: "transfer-1",
      repositoryFiles: [{ path: "src/a.ts", label: "a.ts" }],
    });
    // Non-destructive: the payload must survive repeated peeks so a failed
    // first prompt can retry with the same transfer metadata.
    expect(peekPendingPromptPayload("session-1")).toMatchObject({ text: "Deliver feature X" });
  });

  it("keeps only transfer metadata in sessionStorage, never file content", () => {
    storePendingPrompt("session-2", {
      text: "request",
      attachmentTransferId: "transfer-9",
    });
    const raw = sessionStorage.getItem("routa_pending_prompt_session-2") ?? "";
    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["attachmentTransferId", "text", "timestamp"].sort(),
    );
    expect(raw).not.toContain("base64");
  });

  it("clears the payload on demand", () => {
    storePendingPrompt("session-3", "plain text");
    expect(peekPendingPromptPayload("session-3")).not.toBeNull();
    clearPendingPrompt("session-3");
    expect(peekPendingPromptPayload("session-3")).toBeNull();
  });

  it("consume reads once and then removes the payload", () => {
    storePendingPrompt("session-4", { text: "once", skillName: "skill", skillRepoPath: "/repo" });
    const consumed = consumePendingPromptPayload("session-4");
    expect(consumed).toMatchObject({ text: "once", skillName: "skill", skillRepoPath: "/repo" });
    expect(consumePendingPromptPayload("session-4")).toBeNull();
    expect(peekPendingPromptPayload("session-4")).toBeNull();
  });

  it("accepts plain string input as a text-only payload", () => {
    storePendingPrompt("session-5", "just text");
    const payload = peekPendingPromptPayload("session-5");
    expect(payload?.text).toBe("just text");
    expect(payload?.attachmentTransferId).toBeUndefined();
    expect(payload?.repositoryFiles).toBeUndefined();
  });

  it("discards payloads older than 30 seconds", () => {
    sessionStorage.setItem(
      "routa_pending_prompt_session-6",
      JSON.stringify({ text: "stale", timestamp: Date.now() - 31_000 }),
    );
    expect(peekPendingPromptPayload("session-6")).toBeNull();
  });
});
