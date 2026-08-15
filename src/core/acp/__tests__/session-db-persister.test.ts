/**
 * @vitest-environment node
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionUpdateNotification } from "../http-session-store";
import { getHttpSessionStore } from "../http-session-store";
import {
  acquireSessionLeaseInDb,
  appendSessionNotificationEvent,
  deleteSessionFromDb,
  hasUserMessageInHistory,
  isProviderSessionIdDurable,
  loadHistorySinceEventIdFromDb,
  loadSessionFromDb,
  loadSessionFromLocalStorage,
  normalizeSessionHistory,
  persistCapturedProviderSessionId,
  persistSessionToDb,
  updateSessionExecutionBindingInDb,
} from "../session-db-persister";
import { LocalSessionProvider } from "../../storage/local-session-provider";

let tmpDir: string;
let originalHome: string | undefined;
let originalDbPath: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-db-persister-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  // Point SQLite at a per-test file so full-suite runs do not share the
  // cwd-relative `routa.db` with unrelated test files; leftover lease rows
  // from other suites made fail-closed lease acquisition flaky.
  const { closeSqliteDatabase } = await import("../../db/sqlite");
  closeSqliteDatabase();
  originalDbPath = process.env.ROUTA_DB_PATH;
  process.env.ROUTA_DB_PATH = path.join(tmpDir, "routa.db");
});

afterEach(async () => {
  const store = getHttpSessionStore();
  for (const session of store.listSessions()) {
    store.deleteSession(session.sessionId);
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalDbPath === undefined) {
    delete process.env.ROUTA_DB_PATH;
  } else {
    process.env.ROUTA_DB_PATH = originalDbPath;
  }

  // Close SQLite database to release file locks on Windows
  try {
    const { closeSqliteDatabase } = await import("../../db/sqlite");
    closeSqliteDatabase();
  } catch {
    // Ignore if import fails
  }

  // On Windows, file locks may not be released immediately after close
  // Add a small delay and retry the cleanup
  if (process.platform === "win32") {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows may keep file locks; cleanup will happen on reboot
  }
});

describe("session-db-persister", () => {
  it("detects persisted user prompts in session history", () => {
    const history: SessionUpdateNotification[] = [
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "acp_status",
          status: "ready",
        },
      } as SessionUpdateNotification,
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message",
          content: { type: "text", text: "hello" },
        },
      } as SessionUpdateNotification,
    ];

    expect(hasUserMessageInHistory(history)).toBe(true);
  });

  it("returns false when no user prompt has been stored", () => {
    const history: SessionUpdateNotification[] = [
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "acp_status",
          status: "ready",
        },
      } as SessionUpdateNotification,
    ];

    expect(hasUserMessageInHistory(history)).toBe(false);
  });

  it("appends session notifications to the local JSONL event log", async () => {
    const projectPath = path.join(tmpDir, "project");
    const sessionId = "session-jsonl";
    const store = getHttpSessionStore();
    store.upsertSession({
      sessionId,
      cwd: projectPath,
      workspaceId: "ws-1",
      provider: "opencode",
      createdAt: new Date().toISOString(),
    });

    const notification: SessionUpdateNotification = {
      sessionId,
      update: {
        sessionUpdate: "agent_message",
        content: { type: "text", text: "hello from jsonl" },
      },
    };

    await appendSessionNotificationEvent(sessionId, notification);

    const history = await new LocalSessionProvider(projectPath).getHistory(sessionId);
    expect(history).toHaveLength(1);
    expect((history[0] as { message: SessionUpdateNotification }).message).toEqual(notification);
  });

  it("loads only notifications after a durable event id", async () => {
    const projectPath = path.join(tmpDir, "project-replay");
    const sessionId = "session-replay";
    const store = getHttpSessionStore();
    store.upsertSession({
      sessionId,
      cwd: projectPath,
      workspaceId: "ws-1",
      provider: "opencode",
      createdAt: new Date().toISOString(),
    });

    const first: SessionUpdateNotification = {
      sessionId,
      eventId: "evt-1",
      update: {
        sessionUpdate: "user_message",
        content: { type: "text", text: "first" },
      },
    };
    const second: SessionUpdateNotification = {
      sessionId,
      eventId: "evt-2",
      update: {
        sessionUpdate: "agent_message",
        content: { type: "text", text: "second" },
      },
    };

    await appendSessionNotificationEvent(sessionId, first);
    await appendSessionNotificationEvent(sessionId, second);

    const replay = await loadHistorySinceEventIdFromDb(sessionId, "evt-1", projectPath);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toEqual(second);
  });

  it("falls back to in-memory history when durable replay misses the event id", async () => {
    const sessionId = "session-memory-fallback";
    const store = getHttpSessionStore();
    store.upsertSession({
      sessionId,
      cwd: path.join(tmpDir, "memory-fallback"),
      workspaceId: "ws-1",
      provider: "opencode",
      createdAt: new Date().toISOString(),
    });

    store.pushNotification({
      sessionId,
      eventId: "evt-a",
      update: { sessionUpdate: "user_message", content: { type: "text", text: "a" } },
    });
    store.pushNotification({
      sessionId,
      eventId: "evt-b",
      update: { sessionUpdate: "agent_message", content: { type: "text", text: "b" } },
    });

    const replay = await loadHistorySinceEventIdFromDb(sessionId, "evt-a");
    expect(replay).toHaveLength(1);
    expect(replay[0].eventId).toBe("evt-b");
  });

  it("persists sessions to local JSONL storage alongside database writes", async () => {
    const projectPath = path.join(tmpDir, "persisted-session");

    await persistSessionToDb({
      id: "persisted-1",
      name: "Persisted Session",
      cwd: projectPath,
      workspaceId: "ws-1",
      routaAgentId: "agent-1",
      provider: "opencode",
      role: "CRAFTER",
      modeId: "plan",
      model: "glm-4.7",
      specialistId: "researcher",
    });

    const session = await loadSessionFromLocalStorage("persisted-1");
    expect(session).toMatchObject({
      id: "persisted-1",
      name: "Persisted Session",
      cwd: projectPath,
      workspaceId: "ws-1",
      provider: "opencode",
      role: "CRAFTER",
      modeId: "plan",
      model: "glm-4.7",
      specialistId: "researcher",
    });
  });

  it("round-trips teamChainId through the local JSONL session log", async () => {
    const projectPath = path.join(tmpDir, "team-chain-session");

    await persistSessionToDb({
      id: "team-chain-1",
      name: "Team Run",
      cwd: projectPath,
      workspaceId: "ws-1",
      routaAgentId: "agent-1",
      provider: "opencode",
      role: "ROUTA",
      specialistId: "team-agent-lead",
      teamChainId: "standard_delivery",
    });

    const session = await loadSessionFromLocalStorage("team-chain-1");
    expect(session?.specialistId).toBe("team-agent-lead");
    expect(session?.teamChainId).toBe("standard_delivery");
  });

  it("round-trips providerSessionId without deriving it from routaAgentId", async () => {
    const projectPath = path.join(tmpDir, "provider-session-id");

    await persistSessionToDb({
      id: "provider-id-1",
      name: "Provider ID Session",
      cwd: projectPath,
      workspaceId: "ws-1",
      routaAgentId: "routa-agent-logical",
      providerSessionId: "acp-native-session",
      provider: "codex",
      role: "CRAFTER",
    });

    const session = await loadSessionFromLocalStorage("provider-id-1");
    expect(session?.routaAgentId).toBe("routa-agent-logical");
    expect(session?.providerSessionId).toBe("acp-native-session");

    // Sessions persisted without a provider session ID must not inherit one
    // from routaAgentId — the two identifiers stay distinct.
    await persistSessionToDb({
      id: "provider-id-2",
      cwd: projectPath,
      workspaceId: "ws-1",
      routaAgentId: "routa-agent-only",
      provider: "claude",
      role: "CRAFTER",
    });
    const bare = await loadSessionFromLocalStorage("provider-id-2");
    expect(bare?.routaAgentId).toBe("routa-agent-only");
    expect(bare?.providerSessionId).toBeUndefined();
  });

  it("loads persisted sessions from local JSONL storage", async () => {
    const projectPath = path.join(tmpDir, "local-session");
    const provider = new LocalSessionProvider(projectPath);

    await provider.save({
      id: "local-1",
      cwd: projectPath,
      workspaceId: "ws-local",
      routaAgentId: "agent-local",
      provider: "claude",
      role: "CRAFTER",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const session = await loadSessionFromLocalStorage("local-1");
    expect(session).toMatchObject({
      id: "local-1",
      cwd: projectPath,
      workspaceId: "ws-local",
      routaAgentId: "agent-local",
      provider: "claude",
      role: "CRAFTER",
    });
  });

  it("treats execution binding updates for missing sessions as a safe no-op", async () => {
    await expect(updateSessionExecutionBindingInDb("missing-session", {
      executionMode: "runner",
      ownerInstanceId: "instance-7",
      leaseExpiresAt: "2026-04-16T00:00:00.000Z",
    })).resolves.toBeUndefined();
    expect(await loadSessionFromDb("missing-session")).toBeNull();
  });

  describe("persistCapturedProviderSessionId (P0 native ID provenance)", () => {
    it("never persists the Routa Session ID or an empty value as the native ID", async () => {
      const projectPath = path.join(tmpDir, "captured-guard");
      const sessionId = "captured-guard-session";
      const store = getHttpSessionStore();

      await persistSessionToDb({
        id: sessionId,
        cwd: projectPath,
        workspaceId: "ws-1",
        routaAgentId: "routa-agent-guard",
        provider: "claude",
        role: "CRAFTER",
      });
      store.upsertSession({
        sessionId,
        cwd: projectPath,
        workspaceId: "ws-1",
        routaAgentId: "routa-agent-guard",
        provider: "claude",
        role: "CRAFTER",
        createdAt: new Date().toISOString(),
      });

      // createClaudeSession returns the Routa Session ID itself as its runtime
      // handle; that value must never be written into provider_session_id.
      await persistCapturedProviderSessionId(sessionId, sessionId);
      await persistCapturedProviderSessionId(sessionId, "");

      expect(store.getSession(sessionId)?.providerSessionId).toBeUndefined();
      const fromDb = await loadSessionFromDb(sessionId);
      expect(fromDb?.providerSessionId).toBeUndefined();
      expect(fromDb?.routaAgentId).toBe("routa-agent-guard");
    });

    it("persists a real captured native ID to memory and DB without touching routaAgentId", async () => {
      const projectPath = path.join(tmpDir, "captured-native");
      const sessionId = "captured-native-session";
      const store = getHttpSessionStore();

      await persistSessionToDb({
        id: sessionId,
        cwd: projectPath,
        workspaceId: "ws-1",
        routaAgentId: "routa-agent-native",
        provider: "claude",
        role: "CRAFTER",
      });
      store.upsertSession({
        sessionId,
        cwd: projectPath,
        workspaceId: "ws-1",
        routaAgentId: "routa-agent-native",
        provider: "claude",
        role: "CRAFTER",
        createdAt: new Date().toISOString(),
      });

      await persistCapturedProviderSessionId(sessionId, "claude-native-init-id");

      expect(store.getSession(sessionId)?.providerSessionId).toBe("claude-native-init-id");
      const fromDb = await loadSessionFromDb(sessionId);
      expect(fromDb?.providerSessionId).toBe("claude-native-init-id");
      expect(fromDb?.routaAgentId).toBe("routa-agent-native");
      expect(store.getSession(sessionId)?.routaAgentId).toBe("routa-agent-native");
      await expect(
        isProviderSessionIdDurable(sessionId, "claude-native-init-id"),
      ).resolves.toBe(true);
      await expect(
        isProviderSessionIdDurable(sessionId, "different-native-id"),
      ).resolves.toBe(false);
    });
  });
});

describe("normalizeSessionHistory", () => {
  it("collapses repeated conversation blocks", () => {
    const firstBlock = [
      {
        sessionId: "s1",
        update: { sessionUpdate: "user_message", content: { type: "text", text: "hello" } },
      },
      {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message", content: { type: "text", text: "world" } },
      },
    ];

    expect(normalizeSessionHistory([...firstBlock, ...firstBlock])).toEqual(firstBlock);
  });

  it("keeps repeated non-conversation records intact", () => {
    const input = [
      { sessionId: "s1", update: { sessionUpdate: "acp_status", status: "ready" } },
      { sessionId: "s1", update: { sessionUpdate: "acp_status", status: "ready" } },
    ];

    expect(normalizeSessionHistory(input)).toEqual(input);
  });
});


// ─── P1-1: fail-closed lease acquisition (5-state result) ─────────────────
// The lease result must distinguish every outcome unambiguously:
// acquired / already_owned / conflict come from successful CAS queries,
// `missing` ONLY from a successful query that found no row (JSONL-only
// sessions), and `unavailable` from any DB failure — never conflated.

describe("acquireSessionLeaseInDb (P1 fail-closed 5-state result)", () => {
  const ACTIVE_LEASE = () => new Date(Date.now() + 600_000).toISOString();
  const EXPIRED_LEASE = () => new Date(Date.now() - 60_000).toISOString();

  // The project-local `routa.db` persists across runs, `save()` never clears
  // binding columns on conflict, and a leftover row with an active lease would
  // flip `acquired`/`missing` expectations. Delete any leftover row first so
  // each test starts from a known-absent state.
  async function resetLeaseRow(id: string) {
    await deleteSessionFromDb(id);
  }

  async function persistLeasedSession(
    id: string,
    binding: { ownerInstanceId?: string; leaseExpiresAt?: string } = {},
  ) {
    await resetLeaseRow(id);
    await persistSessionToDb({
      id,
      cwd: path.join(tmpDir, id),
      workspaceId: "ws-1",
      provider: "opencode",
      role: "CRAFTER",
      executionMode: "embedded",
      ownerInstanceId: binding.ownerInstanceId,
      leaseExpiresAt: binding.leaseExpiresAt,
    });
  }

  it("returns acquired for an unowned durable session row", async () => {
    await persistLeasedSession("lease-fresh");

    const result = await acquireSessionLeaseInDb("lease-fresh", {
      ownerInstanceId: "instance-a",
      leaseExpiresAt: ACTIVE_LEASE(),
      executionMode: "embedded",
    });

    expect(result.outcome).toBe("acquired");
    const row = await loadSessionFromDb("lease-fresh");
    expect(row?.ownerInstanceId).toBe("instance-a");
  });

  it("returns already_owned when this instance already holds the active lease", async () => {
    await persistLeasedSession("lease-mine", {
      ownerInstanceId: "instance-a",
      leaseExpiresAt: ACTIVE_LEASE(),
    });

    const result = await acquireSessionLeaseInDb("lease-mine", {
      ownerInstanceId: "instance-a",
      leaseExpiresAt: ACTIVE_LEASE(),
      executionMode: "embedded",
    });

    expect(result.outcome).toBe("already_owned");
  });

  it("returns conflict (with holder info) and never preempts an active foreign lease", async () => {
    const foreignLease = ACTIVE_LEASE();
    await persistLeasedSession("lease-other", {
      ownerInstanceId: "other-instance",
      leaseExpiresAt: foreignLease,
    });

    const result = await acquireSessionLeaseInDb("lease-other", {
      ownerInstanceId: "instance-a",
      leaseExpiresAt: ACTIVE_LEASE(),
      executionMode: "embedded",
    });

    expect(result.outcome).toBe("conflict");
    expect(result.ownerInstanceId).toBe("other-instance");
    expect(result.leaseExpiresAt).toBe(foreignLease);
    // The CAS must not have clobbered the foreign owner.
    const row = await loadSessionFromDb("lease-other");
    expect(row?.ownerInstanceId).toBe("other-instance");
    expect(row?.leaseExpiresAt).toBe(foreignLease);
  });

  it("takes over an expired foreign lease (acquired, not conflict)", async () => {
    await persistLeasedSession("lease-expired", {
      ownerInstanceId: "dead-instance",
      leaseExpiresAt: EXPIRED_LEASE(),
    });

    const result = await acquireSessionLeaseInDb("lease-expired", {
      ownerInstanceId: "instance-a",
      leaseExpiresAt: ACTIVE_LEASE(),
      executionMode: "embedded",
    });

    expect(result.outcome).toBe("acquired");
    const row = await loadSessionFromDb("lease-expired");
    expect(row?.ownerInstanceId).toBe("instance-a");
  });

  it("returns missing only when a successful query finds no durable row (JSONL-only)", async () => {
    await resetLeaseRow("lease-jsonl-only");

    const result = await acquireSessionLeaseInDb("lease-jsonl-only", {
      ownerInstanceId: "instance-a",
      leaseExpiresAt: ACTIVE_LEASE(),
      executionMode: "embedded",
    });

    expect(result.outcome).toBe("missing");
  });

  it("returns acquired on the memory driver (single-process)", async () => {
    const priorDriver = process.env.ROUTA_DB_DRIVER;
    process.env.ROUTA_DB_DRIVER = "memory";
    try {
      const result = await acquireSessionLeaseInDb("lease-memory", {
        ownerInstanceId: "instance-a",
        leaseExpiresAt: ACTIVE_LEASE(),
        executionMode: "embedded",
      });
      expect(result.outcome).toBe("acquired");
    } finally {
      if (priorDriver === undefined) delete process.env.ROUTA_DB_DRIVER;
      else process.env.ROUTA_DB_DRIVER = priorDriver;
    }
  });

  it("returns unavailable (never missing) when the database cannot be reached", async () => {
    const { closeSqliteDatabase } = await import("../../db/sqlite");
    const priorDbPath = process.env.ROUTA_DB_PATH;
    closeSqliteDatabase();
    process.env.ROUTA_DB_PATH = path.join(tmpDir, "no-such-dir", "routa.db");
    try {
      const result = await acquireSessionLeaseInDb("lease-db-down", {
        ownerInstanceId: "instance-a",
        leaseExpiresAt: ACTIVE_LEASE(),
        executionMode: "embedded",
      });
      // A DB failure must NEVER be reported as `missing` — conflating the two
      // is exactly the fail-open hole that let runtimes start during outages.
      expect(result.outcome).toBe("unavailable");
    } finally {
      if (priorDbPath === undefined) delete process.env.ROUTA_DB_PATH;
      else process.env.ROUTA_DB_PATH = priorDbPath;
    }
  });
});
