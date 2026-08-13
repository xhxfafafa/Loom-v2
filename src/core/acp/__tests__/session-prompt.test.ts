import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcpError } from "../acp-process";

const managerMock = vi.hoisted(() => ({
  hasActiveSession: vi.fn(),
  isOpencodeAdapterSession: vi.fn(),
  isOpencodeSdkSessionAsync: vi.fn(),
  getOrRecreateOpencodeSdkAdapter: vi.fn(),
  isDockerAdapterSession: vi.fn(),
  getDockerAdapter: vi.fn(),
  isClaudeCodeSdkSessionAsync: vi.fn(),
  getOrRecreateClaudeCodeSdkAdapter: vi.fn(),
  isClaudeSession: vi.fn(),
  getClaudeProcess: vi.fn(),
  killSession: vi.fn(),
  createClaudeSession: vi.fn(),
  createSession: vi.fn(),
  loadSession: vi.fn(),
  getProcess: vi.fn(),
  getAcpSessionId: vi.fn(),
  getPresetId: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  getHistory: vi.fn(() => []),
  updateSessionAcpStatus: vi.fn(),
  pushUserMessage: vi.fn(),
  flushAgentBuffer: vi.fn(),
  enterStreamingMode: vi.fn(),
  exitStreamingMode: vi.fn(),
  markFirstPromptSent: vi.fn(),
  upsertSession: vi.fn(),
  pushNotification: vi.fn(),
  isSessionStreaming: vi.fn(() => false),
  listSessions: vi.fn((): Array<{ sessionId: string; parentSessionId?: string }> => []),
  markSessionRuntimeRelease: vi.fn(),
  releaseTransientRuntimeBuffers: vi.fn(),
  flushSessionTraces: vi.fn(),
  getConsolidatedHistory: vi.fn(() => []),
}));

const getPresetByIdMock = vi.hoisted(() => vi.fn());
const isServerlessEnvironmentMock = vi.hoisted(() => vi.fn(() => false));
const isOpencodeServerConfiguredMock = vi.hoisted(() => vi.fn(() => false));
const getDockerDetectorMock = vi.hoisted(() => vi.fn(() => ({
  checkAvailability: vi.fn(async () => ({ available: false, error: "docker unavailable" })),
})));
const isClaudeCodeSdkConfiguredMock = vi.hoisted(() => vi.fn(() => false));
const getRoutaOrchestratorMock = vi.hoisted(() => vi.fn(() => null));
const getRoutaSystemMock = vi.hoisted(() => vi.fn(() => ({
  agentStore: { get: vi.fn() },
})));
const ensureMcpForProviderMock = vi.hoisted(() => vi.fn(async () => ({ mcpConfigs: [] })));
const getDefaultRoutaMcpConfigMock = vi.hoisted(() => vi.fn());
const consumeAcpPromptResponseMock = vi.hoisted(() => vi.fn(async () => {}));
const buildCoordinatorPromptMock = vi.hoisted(() => vi.fn(() => "coordinator prompt"));
const recordTraceMock = vi.hoisted(() => vi.fn());
const createTraceRecordMock = vi.hoisted(() => vi.fn((sessionId: string, type: string, metadata: unknown) => ({
  sessionId,
  type,
  metadata,
})));
const withWorkspaceIdMock = vi.hoisted(() => vi.fn((record: Record<string, unknown>) => record));
const withMetadataMock = vi.hoisted(() => vi.fn((record: Record<string, unknown>) => record));
const loadSessionFromDbMock = vi.hoisted(() => vi.fn());
const loadSessionFromLocalStorageMock = vi.hoisted(() => vi.fn());
const persistSessionToDbMock = vi.hoisted(() => vi.fn(async () => {}));
const updateSessionExecutionBindingInDbMock = vi.hoisted(() => vi.fn(async () => {}));
const updateSessionRuntimeBindingInDbMock = vi.hoisted(() => vi.fn(async () => false));
const tryAcquireSessionLeaseInDbMock = vi.hoisted(() => vi.fn(async () => true));
// P1 fail-closed lease acquisition: prompt dispatch must branch on the
// structured 5-state result — a lost or unverifiable lease stops dispatch.
const acquireSessionLeaseInDbMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{
    outcome: "acquired" | "already_owned" | "conflict" | "missing" | "unavailable";
    ownerInstanceId?: string;
    leaseExpiresAt?: string;
  }> => ({ outcome: "acquired" })),
);
const resolveSkillContentMock = vi.hoisted(() => vi.fn(async () => undefined));
const buildExecutionBindingMock = vi.hoisted(() => vi.fn(() => ({ executionMode: "embedded" as const })));
const getEmbeddedOwnershipIssueMock = vi.hoisted(() => vi.fn(() => null));
const refreshExecutionBindingMock = vi.hoisted(() => vi.fn((record: Record<string, unknown>) => record));
const persistSessionHistorySnapshotMock = vi.hoisted(() => vi.fn(async () => {}));
const appendSessionNotificationEventOnceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<
    | { status: "appended" }
    | { status: "duplicate" }
    | { status: "session_not_found" }
    | { status: "unavailable"; error: string }
  > => ({ status: "appended" })));
const hasSessionHistoryEventInDbMock = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _eventId: string) => false));

vi.mock("@/core/acp/processer", () => ({
  getAcpProcessManager: () => managerMock,
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => storeMock,
}));

vi.mock("@/core/acp/acp-presets", () => ({
  getPresetById: getPresetByIdMock,
}));

vi.mock("@/core/acp/api-based-providers", () => ({
  isServerlessEnvironment: isServerlessEnvironmentMock,
}));

vi.mock("@/core/acp/opencode-sdk-adapter", () => ({
  isOpencodeServerConfigured: isOpencodeServerConfiguredMock,
}));

vi.mock("@/core/acp/docker/detector", () => ({
  getDockerDetector: getDockerDetectorMock,
}));

vi.mock("@/core/acp/docker/utils", () => ({
  DEFAULT_DOCKER_AGENT_IMAGE: "docker-image",
}));

vi.mock("@/core/acp/claude-code-sdk-adapter", () => ({
  isClaudeCodeSdkConfigured: isClaudeCodeSdkConfiguredMock,
}));

vi.mock("@/core/orchestration/orchestrator-singleton", () => ({
  getRoutaOrchestrator: getRoutaOrchestratorMock,
}));

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: getRoutaSystemMock,
}));

vi.mock("@/core/acp/mcp-setup", () => ({
  ensureMcpForProvider: ensureMcpForProviderMock,
}));

vi.mock("@/core/acp/mcp-config-generator", () => ({
  getDefaultRoutaMcpConfig: getDefaultRoutaMcpConfigMock,
}));

vi.mock("@/core/acp/prompt-response", () => ({
  consumeAcpPromptResponse: consumeAcpPromptResponseMock,
}));

vi.mock("@/core/orchestration/specialist-prompts", () => ({
  buildCoordinatorPrompt: buildCoordinatorPromptMock,
}));

vi.mock("@/core/trace", () => ({
  createTraceRecord: createTraceRecordMock,
  withWorkspaceId: withWorkspaceIdMock,
  withMetadata: withMetadataMock,
  recordTrace: recordTraceMock,
}));

vi.mock("@/core/acp/session-db-persister", () => ({
  loadSessionFromDb: loadSessionFromDbMock,
  loadSessionFromLocalStorage: loadSessionFromLocalStorageMock,
  persistSessionToDb: persistSessionToDbMock,
  updateSessionExecutionBindingInDb: updateSessionExecutionBindingInDbMock,
  updateSessionRuntimeBindingInDb: updateSessionRuntimeBindingInDbMock,
  tryAcquireSessionLeaseInDb: tryAcquireSessionLeaseInDbMock,
  acquireSessionLeaseInDb: acquireSessionLeaseInDbMock,
  appendSessionNotificationEventOnce: appendSessionNotificationEventOnceMock,
  hasSessionHistoryEventInDb: hasSessionHistoryEventInDbMock,
}));

vi.mock("@/core/skills/skill-resolver", () => ({
  resolveSkillContent: resolveSkillContentMock,
}));

vi.mock("@/core/acp/execution-backend", () => ({
  buildExecutionBinding: buildExecutionBindingMock,
  getEmbeddedOwnershipIssue: getEmbeddedOwnershipIssueMock,
  refreshExecutionBinding: refreshExecutionBindingMock,
  buildAcpLeaseExpiresAt: vi.fn(() => new Date(Date.now() + 300_000).toISOString()),
  getAcpInstanceId: vi.fn(() => "instance-under-test"),
  getSessionLeaseRefreshMs: vi.fn(() => 60_000),
  isExecutionLeaseActive: vi.fn(
    (leaseExpiresAt?: string) => !!leaseExpiresAt && Date.parse(leaseExpiresAt) > Date.now(),
  ),
}));

vi.mock("@/core/acp/pending-acp-creations", () => ({
  pendingAcpCreations: new Map<string, Promise<void>>(),
}));

vi.mock("@/core/acp/session-history", () => ({
  persistSessionHistorySnapshot: persistSessionHistorySnapshotMock,
}));

// Recovery envelope prefix channel: recovery queues a clearly-marked internal
// context block for providers without a system append channel; session/prompt
// consumes it exactly once and prepends it to the dispatched prompt only.
const consumePendingRecoveryContextMock = vi.hoisted(() => vi.fn((): string | undefined => undefined));

vi.mock("@/core/acp/recovery-context", () => ({
  RECOVERY_ENVELOPE_SCHEMA: "routa.recovery-envelope@1",
  collectRecoveryEnvelope: vi.fn(async () => undefined),
  renderRecoveryEnvelope: vi.fn((envelope: unknown) => String(envelope)),
  setPendingRecoveryContext: vi.fn(),
  consumePendingRecoveryContext: consumePendingRecoveryContextMock,
}));

const {
  buildAcpDispatchBlocks,
  dispatchSessionPrompt,
  handleSessionPrompt,
  isSessionPromptTimeoutError,
  resolveBinaryPromptRejection,
} = await import("../session-prompt");

type ProcessManagerUnderTest = Parameters<typeof resolveBinaryPromptRejection>[0];

const { resetInflightPromptDeliveriesForTest } = await import("../prompt-delivery");

async function readStreamText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("session-prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerMock.hasActiveSession.mockReturnValue(true);
    managerMock.isOpencodeAdapterSession.mockReturnValue(false);
    managerMock.isOpencodeSdkSessionAsync.mockResolvedValue(false);
    managerMock.getOrRecreateOpencodeSdkAdapter.mockResolvedValue(undefined);
    managerMock.isDockerAdapterSession.mockReturnValue(false);
    managerMock.getDockerAdapter.mockReturnValue(undefined);
    managerMock.isClaudeCodeSdkSessionAsync.mockResolvedValue(false);
    managerMock.getOrRecreateClaudeCodeSdkAdapter.mockResolvedValue(undefined);
    managerMock.isClaudeSession.mockReturnValue(false);
    managerMock.getClaudeProcess.mockReturnValue(undefined);
    managerMock.createSession.mockResolvedValue("acp-created");
    managerMock.loadSession.mockResolvedValue("acp-loaded");
    managerMock.getProcess.mockReturnValue(undefined);
    managerMock.getAcpSessionId.mockReturnValue(undefined);
    managerMock.getPresetId.mockReturnValue("opencode");
    storeMock.getHistory.mockReturnValue([]);

    storeMock.getSession.mockImplementation((sessionId: string) => ({
      sessionId,
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      createdAt: new Date().toISOString(),
    }));

    getPresetByIdMock.mockReturnValue(null);
    isServerlessEnvironmentMock.mockReturnValue(false);
    loadSessionFromDbMock.mockResolvedValue(undefined);
    loadSessionFromLocalStorageMock.mockResolvedValue(undefined);
    getEmbeddedOwnershipIssueMock.mockReturnValue(null);
    acquireSessionLeaseInDbMock.mockResolvedValue({ outcome: "acquired" });
    appendSessionNotificationEventOnceMock.mockResolvedValue({ status: "appended" });
    hasSessionHistoryEventInDbMock.mockResolvedValue(false);
    consumePendingRecoveryContextMock.mockReset();
    consumePendingRecoveryContextMock.mockReturnValue(undefined);
    resetInflightPromptDeliveriesForTest();
  });

  it("detects session/prompt timeout errors", () => {
    expect(isSessionPromptTimeoutError(new Error("Timeout waiting for session/prompt (id=3)"))).toBe(true);
  });

  it("ignores non-timeout prompt errors", () => {
    expect(isSessionPromptTimeoutError(new Error("Permission denied"))).toBe(false);
    expect(isSessionPromptTimeoutError("Timeout waiting for session/prompt (id=3)")).toBe(false);
  });

  it("returns a JSON-RPC error when sessionId is missing", async () => {
    const response = await handleSessionPrompt({
      id: 1,
      params: {},
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => null),
      encodeSsePayload: JSON.stringify,
    });

    const payload = await response.json() as { error: { code: number; message: string } };
    expect(payload.error).toEqual({
      code: -32602,
      message: "Missing sessionId",
    });
  });

  it("fails auto-create when workspaceId cannot be recovered", async () => {
    managerMock.hasActiveSession.mockReturnValue(false);
    storeMock.getSession.mockReturnValue(undefined);

    const response = await handleSessionPrompt({
      id: 2,
      params: {
        sessionId: "missing-session",
        prompt: "hello",
      },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => null),
      encodeSsePayload: JSON.stringify,
    });

    const payload = await response.json() as { error: { code: number; message: string; data?: { reason: string; retryable: boolean } } };
    expect(payload.error).toEqual({
      code: -32013,
      message: "workspaceId is required to recreate the session",
      data: {
        reason: "workspace_unavailable",
        retryable: false,
      },
    });
  });

  it("returns an error when the OpenCode SDK adapter exists but is disconnected", async () => {
    managerMock.isOpencodeAdapterSession.mockReturnValue(true);
    managerMock.getOrRecreateOpencodeSdkAdapter.mockResolvedValue({
      alive: false,
    });

    const response = await handleSessionPrompt({
      id: 3,
      params: {
        sessionId: "opc-1",
        prompt: "hello",
      },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    const payload = await response.json() as { error: { code: number; message: string } };
    expect(payload.error).toEqual({
      code: -32000,
      message: "OpenCode SDK adapter is not connected",
    });
    expect(storeMock.pushUserMessage).toHaveBeenCalledWith("opc-1", "hello");
  });

  it("returns a pending response when a Claude prompt times out", async () => {
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => {
        throw new Error("Timeout waiting for session/prompt (id=9)");
      }),
    });

    const response = await handleSessionPrompt({
      id: 4,
      params: {
        sessionId: "claude-1",
        prompt: "continue",
      },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    const payload = await response.json() as { result: { sessionId: string; pending: boolean } };
    expect(payload.result).toEqual({
      sessionId: "claude-1",
      pending: true,
    });
    expect(storeMock.flushAgentBuffer).toHaveBeenCalledWith("claude-1");
    expect(managerMock.killSession).not.toHaveBeenCalled();
  });

  it("releases a completed Claude process after persisting its history", async () => {
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });

    const response = await handleSessionPrompt({
      id: 7,
      params: { sessionId: "claude-complete", prompt: "finish the task" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(persistSessionHistorySnapshotMock).toHaveBeenCalledWith("claude-complete", storeMock);
    expect(managerMock.killSession).toHaveBeenCalledWith("claude-complete");
  });

  it("does not release a Claude turn that still requires the runtime (tool_use)", async () => {
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "tool_use" })),
    });

    const response = await handleSessionPrompt({
      id: 8,
      params: { sessionId: "claude-tool-use", prompt: "run the tools" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "tool_use" } });
    expect(managerMock.killSession).not.toHaveBeenCalled();
    expect(storeMock.releaseTransientRuntimeBuffers).not.toHaveBeenCalled();
  });

  it("keeps a completed Claude process alive when auto-release is disabled", async () => {
    vi.stubEnv("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE", "0");
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });

    const response = await handleSessionPrompt({
      id: 9,
      params: { sessionId: "claude-flagged", prompt: "finish the task" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(managerMock.killSession).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("does not release a completed Claude session with an active child session", async () => {
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });
    managerMock.hasActiveSession.mockImplementation(
      (sessionId: string) => sessionId === "child-1" || sessionId === "claude-parent",
    );
    storeMock.listSessions.mockReturnValue([
      { sessionId: "child-1", parentSessionId: "claude-parent" },
    ]);

    const response = await handleSessionPrompt({
      id: 10,
      params: { sessionId: "claude-parent", prompt: "finish the task" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(managerMock.killSession).not.toHaveBeenCalled();
  });

  it("recreates a released Claude session from durable metadata on the next prompt", async () => {
    managerMock.hasActiveSession.mockReturnValue(false);
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });
    managerMock.createClaudeSession.mockResolvedValue("claude-agent-2");
    storeMock.getSession.mockImplementation((sessionId: string) => ({
      sessionId,
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      createdAt: new Date().toISOString(),
    }));

    const response = await handleSessionPrompt({
      id: 11,
      params: { sessionId: "claude-recreated", prompt: "follow-up question" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(managerMock.createClaudeSession).toHaveBeenCalledTimes(1);
    expect(managerMock.createClaudeSession.mock.calls[0][0]).toBe("claude-recreated");
    expect(storeMock.pushUserMessage).toHaveBeenCalledWith("claude-recreated", "follow-up question");
  });

  it("preserves routaAgentId and keeps the persisted native provider session ID when recovering from the DB", async () => {
    managerMock.hasActiveSession.mockReturnValue(false);
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });
    managerMock.createClaudeSession.mockResolvedValue("claude-agent-new");
    storeMock.getSession.mockReturnValue(undefined);
    loadSessionFromDbMock.mockResolvedValue({
      sessionId: "claude-db-recover",
      name: "Durable session",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      routaAgentId: "routa-agent-durable",
      providerSessionId: "claude-agent-old",
      model: "claude-model",
      teamChainId: "chain-1",
      firstPromptSent: true,
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    updateSessionRuntimeBindingInDbMock.mockResolvedValueOnce(true);

    const response = await handleSessionPrompt({
      id: 20,
      params: { sessionId: "claude-db-recover", prompt: "follow-up" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });

    // Native resume is seeded with the persisted provider-native ID (arg 9),
    // never the Routa Session ID or the create-call return value.
    expect(managerMock.createClaudeSession).toHaveBeenCalledTimes(1);
    expect(managerMock.createClaudeSession.mock.calls[0][8]).toBe("claude-agent-old");

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    // The durable logical agent ID survives recovery. The prior native ID is
    // kept until a fresh system/init callback captures a new one; the
    // create-call return value must never be persisted as the native ID.
    expect(upserted.routaAgentId).toBe("routa-agent-durable");
    expect(upserted.providerSessionId).toBe("claude-agent-old");
    expect(upserted.teamChainId).toBe("chain-1");
    expect(upserted.model).toBe("claude-model");
    expect(upserted.firstPromptSent).toBe(true);
    expect(upserted.createdAt).toBe("2026-08-10T00:00:00.000Z");

    // A DB row exists, so the targeted runtime-binding update is used and the
    // full-record fallback is skipped (no erasure of durable fields). The
    // acquired lease (owner + expiry) is persisted alongside the binding.
    expect(updateSessionRuntimeBindingInDbMock).toHaveBeenCalledWith("claude-db-recover", expect.objectContaining({
      providerSessionId: "claude-agent-old",
      executionMode: "embedded",
      ownerInstanceId: "instance-under-test",
      leaseExpiresAt: expect.any(String),
    }));
    expect(persistSessionToDbMock).not.toHaveBeenCalled();
  });

  it("falls back to a complete persistent record when the targeted runtime binding update matches no row", async () => {
    managerMock.hasActiveSession.mockReturnValue(false);
    managerMock.isClaudeSession.mockReturnValue(true);
    managerMock.getClaudeProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });
    managerMock.createClaudeSession.mockResolvedValue("claude-agent-new");
    storeMock.getSession.mockReturnValue(undefined);
    loadSessionFromDbMock.mockResolvedValue({
      sessionId: "claude-db-recover-2",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      routaAgentId: "routa-agent-durable",
      providerSessionId: "claude-agent-old",
      model: "claude-model",
      teamChainId: "chain-1",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    // Default mock resolves false → no DB row matched the targeted update.

    const response = await handleSessionPrompt({
      id: 21,
      params: { sessionId: "claude-db-recover-2", prompt: "follow-up" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(persistSessionToDbMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "claude-db-recover-2",
      // The fallback record keeps the durable agent ID and the prior
      // provider-native ID; the create-call return value is never persisted.
      routaAgentId: "routa-agent-durable",
      providerSessionId: "claude-agent-old",
      model: "claude-model",
      teamChainId: "chain-1",
      executionMode: "embedded",
    }));
  });

  it("resumes Codex with the persisted provider session ID, never the routa agent ID", async () => {
    managerMock.hasActiveSession.mockReturnValue(false);
    managerMock.loadSession.mockResolvedValue("codex-native-77");
    managerMock.getProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });
    managerMock.getAcpSessionId.mockReturnValue("codex-native-77");
    storeMock.getSession.mockReturnValue(undefined);
    loadSessionFromDbMock.mockResolvedValue({
      sessionId: "codex-recover",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "codex",
      role: "CRAFTER",
      routaAgentId: "routa-agent-codex",
      providerSessionId: "codex-native-77",
      firstPromptSent: true,
    });

    const response = await handleSessionPrompt({
      id: 22,
      params: { sessionId: "codex-recover", prompt: "continue" },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(managerMock.loadSession).toHaveBeenCalledTimes(1);
    const nativeResumeSessionId = managerMock.loadSession.mock.calls[0][9];
    expect(nativeResumeSessionId).toBe("codex-native-77");
    expect(nativeResumeSessionId).not.toBe("routa-agent-codex");
    expect(managerMock.createSession).not.toHaveBeenCalled();
  });

  it("returns ACP-shaped error data for standard process failures", async () => {
    managerMock.getProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => {
        throw new AcpError(
          "Authentication required",
          401,
          [{ id: "oauth", name: "OAuth", description: "login" }],
          { name: "codex", version: "1.0.0" },
          { detail: "login first" },
        );
      }),
    });
    managerMock.getAcpSessionId.mockReturnValue("agent-123");

    const response = await handleSessionPrompt({
      id: 5,
      params: {
        sessionId: "proc-1",
        prompt: "fix it",
      },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    const payload = await response.json() as {
      error: {
        code: number;
        message: string;
        data: Record<string, unknown>;
      };
    };

    expect(payload.error.code).toBe(-32000);
    expect(payload.error.message).toBe("Authentication required");
    expect(payload.error.data).toMatchObject({
      source: "acp",
      code: 401,
      agentInfo: { name: "codex", version: "1.0.0" },
    });
    expect(storeMock.updateSessionAcpStatus).toHaveBeenCalledWith(
      "proc-1",
      "error",
      "Authentication required",
    );
  });

  it("dispatches prompt responses through consumeAcpPromptResponse", async () => {
    managerMock.getProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });
    managerMock.getAcpSessionId.mockReturnValue("agent-456");

    await dispatchSessionPrompt({
      sessionId: "dispatch-1",
      prompt: "ship it",
      workspaceId: "ws-1",
    });

    expect(consumeAcpPromptResponseMock).toHaveBeenCalledOnce();
    expect(storeMock.pushUserMessage).toHaveBeenCalledWith("dispatch-1", "ship it");
  });

  it("pushes a synthetic turn_complete notification when prompt returns only stopReason", async () => {
    managerMock.getProcess.mockReturnValue({
      alive: true,
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    });
    managerMock.getAcpSessionId.mockReturnValue("agent-789");

    await handleSessionPrompt({
      id: 6,
      params: {
        sessionId: "proc-2",
        prompt: "continue",
      },
      jsonrpcResponse: (id, result, error) => new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    });

    expect(storeMock.pushNotification).toHaveBeenCalledWith({
      sessionId: "proc-2",
      update: {
        sessionUpdate: "turn_complete",
        stopReason: "end_turn",
      },
    });
  });

  describe("durable prompt delivery (promptId)", () => {
    const factories = {
      jsonrpcResponse: (id: string | number | null, result: unknown, error?: unknown) =>
        new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`,
    };

    it("acknowledges a promptId durably and returns the ack in the result", async () => {
      managerMock.getProcess.mockReturnValue({
        alive: true,
        prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
      });
      managerMock.getAcpSessionId.mockReturnValue("agent-ack");

      const response = await handleSessionPrompt({
        id: 30,
        params: { sessionId: "ack-1", prompt: "hello", promptId: "prompt-uuid-1" },
        ...factories,
      });

      const payload = await response.json() as { result: Record<string, unknown> };
      expect(payload.result).toMatchObject({
        stopReason: "end_turn",
        promptId: "prompt-uuid-1",
        promptAccepted: true,
      });
      expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledWith(
        "ack-1",
        expect.objectContaining({
          eventId: "prompt-uuid-1",
          update: expect.objectContaining({ sessionUpdate: "user_message" }),
        }),
      );
      expect(storeMock.pushUserMessage).toHaveBeenCalledWith("ack-1", "hello", "prompt-uuid-1");
    });

    it("returns the existing ack without appending or dispatching for a duplicate promptId", async () => {
      hasSessionHistoryEventInDbMock.mockResolvedValue(true);
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-dup");

      const response = await handleSessionPrompt({
        id: 31,
        params: { sessionId: "dup-1", prompt: "hello again", promptId: "prompt-uuid-2" },
        ...factories,
      });

      const payload = await response.json() as { result: Record<string, unknown> };
      expect(payload.result).toMatchObject({
        sessionId: "dup-1",
        promptId: "prompt-uuid-2",
        promptAccepted: true,
        duplicate: true,
      });
      expect(procPrompt).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).not.toHaveBeenCalled();
      expect(appendSessionNotificationEventOnceMock).not.toHaveBeenCalled();
    });

    it("fails the prompt (no dispatch, no promptAccepted) when durable recording is unavailable", async () => {
      appendSessionNotificationEventOnceMock.mockResolvedValueOnce({
        status: "unavailable",
        error: "database is locked",
      });
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-unavailable");

      const response = await handleSessionPrompt({
        id: 33,
        params: { sessionId: "unavail-1", prompt: "hello", promptId: "prompt-unavail" },
        ...factories,
      });

      const payload = await response.json() as {
        result?: Record<string, unknown>;
        error?: { code: number; message: string; data?: Record<string, unknown> };
      };
      // A persistence failure must NOT be reported as an accepted (or
      // duplicate) prompt: the client keeps the input and can retry.
      expect(payload.error).toBeTruthy();
      expect(payload.result).toBeNull();
      expect(payload.error?.data).toMatchObject({
        reason: "prompt_delivery_unavailable",
        retryable: true,
        promptId: "prompt-unavail",
      });
      expect(procPrompt).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).not.toHaveBeenCalled();
    });

    it("fails with session_not_found when the durable session row is missing", async () => {
      appendSessionNotificationEventOnceMock.mockResolvedValueOnce({ status: "session_not_found" });
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-missing");

      const response = await handleSessionPrompt({
        id: 34,
        params: { sessionId: "missing-row", prompt: "hello", promptId: "prompt-missing" },
        ...factories,
      });

      const payload = await response.json() as {
        result?: Record<string, unknown>;
        error?: { code: number; data?: Record<string, unknown> };
      };
      expect(payload.error).toBeTruthy();
      expect(payload.result).toBeNull();
      expect(payload.error?.code).toBe(-32004);
      expect(payload.error?.data).toMatchObject({ reason: "session_not_found", retryable: false });
      expect(procPrompt).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).not.toHaveBeenCalled();
    });

    it("re-dispatches a recorded team report without a delivered receipt (at-least-once)", async () => {
      const deliveryId = "team-report:lead-session:child-session:task-1:0";
      hasSessionHistoryEventInDbMock.mockImplementation(
        async (_sessionId: string, eventId: string) => eventId === deliveryId,
      );
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-report");

      const response = await handleSessionPrompt({
        id: 32,
        params: { sessionId: "lead-session", prompt: "report body", promptId: deliveryId },
        ...factories,
      });

      const payload = await response.json() as { result: Record<string, unknown> };
      expect(payload.result).toMatchObject({ promptId: deliveryId, promptAccepted: true });
      expect(payload.result.duplicate).toBeUndefined();
      expect(procPrompt).toHaveBeenCalledTimes(1);
      // The durable record already exists: re-dispatch must not append again.
      expect(appendSessionNotificationEventOnceMock).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).toHaveBeenCalledWith("lead-session", "report body", deliveryId);
    });

    it("treats a team report with a delivered receipt as a duplicate", async () => {
      const deliveryId = "team-report:lead-session:child-session:task-1:0";
      hasSessionHistoryEventInDbMock.mockResolvedValue(true);
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-report-2");

      const response = await handleSessionPrompt({
        id: 33,
        params: { sessionId: "lead-session", prompt: "report body", promptId: deliveryId },
        ...factories,
      });

      const payload = await response.json() as { result: Record<string, unknown> };
      expect(payload.result.duplicate).toBe(true);
      expect(procPrompt).not.toHaveBeenCalled();
    });

    it("deduplicates a concurrent in-flight delivery with the same promptId", async () => {
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-race");

      const first = await handleSessionPrompt({
        id: 34,
        params: { sessionId: "race-1", prompt: "hello", promptId: "prompt-uuid-race" },
        ...factories,
      });
      const second = await handleSessionPrompt({
        id: 35,
        params: { sessionId: "race-1", prompt: "hello", promptId: "prompt-uuid-race" },
        ...factories,
      });

      const firstPayload = await first.json() as { result: Record<string, unknown> };
      const secondPayload = await second.json() as { result: Record<string, unknown> };
      expect(firstPayload.result.duplicate).toBeUndefined();
      expect(secondPayload.result).toMatchObject({ promptId: "prompt-uuid-race", duplicate: true });
      expect(procPrompt).toHaveBeenCalledTimes(1);
      expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledTimes(1);
    });

    it("treats a lost append race as duplicate instead of double-dispatching", async () => {
      appendSessionNotificationEventOnceMock.mockResolvedValue({ status: "duplicate" });
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-lost-race");

      const response = await handleSessionPrompt({
        id: 36,
        params: { sessionId: "lost-1", prompt: "hello", promptId: "prompt-uuid-lost" },
        ...factories,
      });

      const payload = await response.json() as { result: Record<string, unknown> };
      expect(payload.result.duplicate).toBe(true);
      expect(procPrompt).not.toHaveBeenCalled();
    });

    it("emits a prompt_accepted session/update frame at stream start", async () => {
      managerMock.isClaudeCodeSdkSessionAsync.mockResolvedValue(true);
      managerMock.getOrRecreateClaudeCodeSdkAdapter.mockResolvedValue({
        alive: true,
        promptStream: async function* promptStream() {
          // No provider events; the ack frame must still be emitted first.
        },
      });

      const response = await handleSessionPrompt({
        id: 37,
        params: { sessionId: "stream-ack", prompt: "hello", promptId: "prompt-uuid-stream" },
        ...factories,
      });

      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      const text = await readStreamText(response);
      const openIndex = text.indexOf(": stream-open");
      const ackIndex = text.indexOf('"sessionUpdate":"prompt_accepted"');
      expect(openIndex).toBeGreaterThanOrEqual(0);
      expect(ackIndex).toBeGreaterThan(openIndex);
      expect(text).toContain('"promptId":"prompt-uuid-stream"');
    });
  });

  describe("one-shot recovery context prefix", () => {
    const RECOVERY_PREFIX =
      '<routa-internal-recovery-context schema="routa.recovery-envelope@1">\n' +
      "NOT a user message\n" +
      "</routa-internal-recovery-context>";

    const factories = {
      jsonrpcResponse: (id: unknown, result: unknown, error?: unknown) =>
        new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    };

    it("prepends a queued recovery context to the dispatched prompt without recording it", async () => {
      const procPrompt = vi.fn(async (_sessionId: string, _prompt: string) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-rc-1");
      consumePendingRecoveryContextMock.mockReturnValueOnce(RECOVERY_PREFIX);

      const response = await handleSessionPrompt({
        id: 40,
        params: { sessionId: "rc-1", prompt: "keep going", promptId: "prompt-rc-1" },
        ...factories,
      });

      const payload = await response.json() as { result: Record<string, unknown> };
      expect(payload.result.stopReason).toBe("end_turn");

      expect(consumePendingRecoveryContextMock).toHaveBeenCalledWith("rc-1");
      // The provider receives the clearly-marked recovery context followed by
      // the user's prompt.
      expect(procPrompt).toHaveBeenCalledTimes(1);
      const dispatched = procPrompt.mock.calls[0][1] as string;
      expect(dispatched).toContain(RECOVERY_PREFIX);
      expect(dispatched.endsWith("keep going")).toBe(true);
      // The durable history records ONLY the visible user prompt, never the
      // internal recovery block.
      expect(storeMock.pushUserMessage).toHaveBeenCalledWith("rc-1", "keep going", "prompt-rc-1");
    });

    it("dispatches the prompt unchanged when no recovery context is pending", async () => {
      const procPrompt = vi.fn(async (_sessionId: string, _prompt: string) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-rc-2");

      await handleSessionPrompt({
        id: 41,
        params: { sessionId: "rc-2", prompt: "plain prompt" },
        ...factories,
      });

      expect(procPrompt).toHaveBeenCalledWith("agent-rc-2", "plain prompt", [
        { type: "text", text: "plain prompt" },
      ]);
    });

    it("does not consume the recovery context when prompt delivery fails closed", async () => {
      appendSessionNotificationEventOnceMock.mockResolvedValue({
        status: "unavailable",
        error: "database is locked",
      });
      const procPrompt = vi.fn(async (_sessionId: string, _prompt: string) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-rc-3");
      consumePendingRecoveryContextMock.mockReturnValueOnce(RECOVERY_PREFIX);

      const response = await handleSessionPrompt({
        id: 42,
        params: { sessionId: "rc-3", prompt: "keep going", promptId: "prompt-rc-3" },
        ...factories,
      });

      const payload = await response.json() as { error: { code: number } };
      expect(payload.error.code).toBe(-32000);
      expect(procPrompt).not.toHaveBeenCalled();
      // The prefix must stay queued so the retried delivery still receives it.
      expect(consumePendingRecoveryContextMock).not.toHaveBeenCalled();
    });
  });

  describe("embedded lease heartbeat gating (P1 fail-closed)", () => {
    // Prompt acceptance refreshes the embedded lease via the SAME atomic CAS
    // as recovery. When the CAS proves the lease was lost (another instance
    // holds it), dispatch must stop and the orphaned runtime must be isolated
    // — never keep prompting a runtime that no longer owns the session. When
    // the lease cannot be verified at all (DB outage), dispatch stops but the
    // runtime is kept (fail-closed, no kill).

    const factories = {
      jsonrpcResponse: (id: unknown, result: unknown, error?: unknown) =>
        new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    };

    function embeddedSession(sessionId: string) {
      return {
        sessionId,
        cwd: "/workspace",
        workspaceId: "ws-1",
        provider: "opencode",
        executionMode: "embedded" as const,
        ownerInstanceId: "instance-under-test",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
      };
    }

    it("stops dispatch and isolates the runtime when the heartbeat lease was lost", async () => {
      const futureLease = new Date(Date.now() + 600_000).toISOString();
      storeMock.getSession.mockReturnValue(embeddedSession("hb-lost"));
      const procPrompt = vi.fn(async (_sessionId: string, _prompt: string) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-hb-lost");
      // The CAS refresh proves another instance now owns the session.
      acquireSessionLeaseInDbMock.mockResolvedValue({
        outcome: "conflict",
        ownerInstanceId: "other-instance",
        leaseExpiresAt: futureLease,
      });

      const response = await handleSessionPrompt({
        id: 50,
        params: { sessionId: "hb-lost", prompt: "keep going", promptId: "prompt-hb-lost" },
        ...factories,
      });

      const payload = await response.json() as {
        result?: unknown;
        error?: { code: number; data?: Record<string, unknown> };
      };
      expect(payload.error?.code).toBe(-32010);
      expect(payload.error?.data).toMatchObject({
        reason: "runtime_owned",
        retryable: true,
        ownerInstanceId: "other-instance",
      });
      // No dispatch, no history mutation...
      expect(procPrompt).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).not.toHaveBeenCalled();
      expect(appendSessionNotificationEventOnceMock).not.toHaveBeenCalled();
      // ...and the orphaned runtime is isolated so it cannot keep acting on
      // a session it no longer owns.
      expect(managerMock.killSession).toHaveBeenCalledWith("hb-lost");
    });

    it("stops dispatch without killing the runtime when the lease cannot be verified (DB outage)", async () => {
      storeMock.getSession.mockReturnValue(embeddedSession("hb-unavailable"));
      const procPrompt = vi.fn(async (_sessionId: string, _prompt: string) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-hb-unavail");
      acquireSessionLeaseInDbMock.mockResolvedValue({ outcome: "unavailable" });

      const response = await handleSessionPrompt({
        id: 51,
        params: { sessionId: "hb-unavailable", prompt: "keep going" },
        ...factories,
      });

      const payload = await response.json() as {
        result?: unknown;
        error?: { code: number; data?: Record<string, unknown> };
      };
      expect(payload.error?.code).toBe(-32011);
      expect(payload.error?.data).toMatchObject({
        reason: "recovery_unavailable",
        retryable: true,
      });
      expect(procPrompt).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).not.toHaveBeenCalled();
      // Fail-closed but non-destructive: the runtime survives the outage.
      expect(managerMock.killSession).not.toHaveBeenCalled();
    });

    it("dispatches normally when the heartbeat confirms ownership", async () => {
      storeMock.getSession.mockReturnValue(embeddedSession("hb-owned"));
      const procPrompt = vi.fn(async (_sessionId: string, _prompt: string) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt });
      managerMock.getAcpSessionId.mockReturnValue("agent-hb-owned");
      acquireSessionLeaseInDbMock.mockResolvedValue({ outcome: "already_owned" });

      const response = await handleSessionPrompt({
        id: 52,
        params: { sessionId: "hb-owned", prompt: "keep going" },
        ...factories,
      });

      expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
      expect(procPrompt).toHaveBeenCalledTimes(1);
      expect(storeMock.pushUserMessage).toHaveBeenCalledWith("hb-owned", "keep going");
      expect(managerMock.killSession).not.toHaveBeenCalled();
    });
  });

  describe("Team attachment content blocks", () => {
    // First-prompt attachment blocks must survive the Web session/prompt
    // pipeline: text-only adapters receive delimited text resources, standard
    // ACP providers receive preserved blocks, and binary content on a path
    // that cannot carry it is rejected whole — never silently dropped.

    const factories = {
      jsonrpcResponse: (id: unknown, result: unknown, error?: unknown) =>
        new Response(JSON.stringify({ id, result, error })),
      createSessionUpdateForwarder: () => vi.fn(),
      buildMcpConfigForClaude: vi.fn(async () => []),
      requireWorkspaceId: vi.fn(() => "ws-1"),
      encodeSsePayload: JSON.stringify,
    };

    const binaryPrompt = [
      { type: "text", text: "look at this" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ];

    it("rejects a binary prompt on the Claude path with the structured reason", async () => {
      managerMock.isClaudeSession.mockReturnValue(true);
      const claudePrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getClaudeProcess.mockReturnValue({ alive: true, prompt: claudePrompt });

      const response = await handleSessionPrompt({
        id: 60,
        params: { sessionId: "claude-binary", prompt: binaryPrompt },
        ...factories,
      });

      const payload = await response.json() as {
        error: { code: number; message: string; data?: Record<string, unknown> };
      };
      expect(payload.error.code).toBe(-32000);
      expect(payload.error.data).toMatchObject({
        reason: "prompt_images_unsupported",
        retryable: false,
        sessionId: "claude-binary",
      });
      expect(payload.error.message).toContain("NOT dispatched");
      // Nothing is dispatched or recorded on rejection.
      expect(claudePrompt).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).not.toHaveBeenCalled();
      expect(storeMock.markFirstPromptSent).not.toHaveBeenCalled();
    });

    it("rejects a binary prompt when the ACP agent does not advertise image capability", async () => {
      const procPrompt = vi.fn(async () => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({ alive: true, prompt: procPrompt, initResult: {} });
      managerMock.getAcpSessionId.mockReturnValue("agent-no-image");

      const response = await handleSessionPrompt({
        id: 61,
        params: { sessionId: "acp-no-image", prompt: binaryPrompt },
        ...factories,
      });

      const payload = await response.json() as {
        error: { code: number; data?: Record<string, unknown> };
      };
      expect(payload.error.code).toBe(-32000);
      expect(payload.error.data).toMatchObject({
        reason: "prompt_images_unsupported",
        retryable: false,
      });
      expect(procPrompt).not.toHaveBeenCalled();
      expect(storeMock.pushUserMessage).not.toHaveBeenCalled();
    });

    it("dispatches preserved blocks to a standard ACP provider with image capability", async () => {
      const procPrompt = vi.fn(async (..._args: unknown[]) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({
        alive: true,
        prompt: procPrompt,
        initResult: {
          agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
        },
      });
      managerMock.getAcpSessionId.mockReturnValue("agent-team-lead");

      const response = await handleSessionPrompt({
        id: 62,
        params: {
          sessionId: "acp-team",
          prompt: [
            { type: "text", text: "Deliver feature X" },
            { type: "text", text: "Repository files:\n- src/a.ts" },
            {
              type: "resource",
              resource: {
                uri: "routa-team-input://transfer-1/0",
                mimeType: "text/plain",
                text: "attached text",
              },
            },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        },
        ...factories,
      });

      expect(await response.json()).toMatchObject({ result: { stopReason: "end_turn" } });
      expect(procPrompt).toHaveBeenCalledTimes(1);
      const [acpSessionId, promptText, dispatchBlocks] = procPrompt.mock.calls[0] as [
        string,
        string,
        Array<Record<string, unknown>>,
      ];
      expect(acpSessionId).toBe("agent-team-lead");
      expect(promptText).toBe("Deliver feature X\nRepository files:\n- src/a.ts");
      // Both text blocks merge into the leading block; the resource and the
      // image pass through unchanged with embedded-context support.
      expect(dispatchBlocks).toHaveLength(3);
      expect(dispatchBlocks[0]).toEqual({
        type: "text",
        text: "Deliver feature X\nRepository files:\n- src/a.ts",
      });
      expect(dispatchBlocks[1]).toMatchObject({ type: "resource" });
      expect(dispatchBlocks[2]).toMatchObject({ type: "image", mimeType: "image/png" });
      // History records the visible text only — never attachment bytes.
      expect(storeMock.pushUserMessage).toHaveBeenCalledWith(
        "acp-team",
        "Deliver feature X\nRepository files:\n- src/a.ts",
      );
    });

    it("converts text resources into delimited text for agents without embedded context", async () => {
      const procPrompt = vi.fn(async (..._args: unknown[]) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({
        alive: true,
        prompt: procPrompt,
        initResult: { agentCapabilities: { promptCapabilities: { image: true } } },
      });
      managerMock.getAcpSessionId.mockReturnValue("agent-no-context");

      await handleSessionPrompt({
        id: 63,
        params: {
          sessionId: "acp-no-context",
          prompt: [
            { type: "text", text: "request" },
            {
              type: "resource",
              resource: { uri: "routa-team-input://t/0", mimeType: "text/plain", text: "notes" },
            },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        },
        ...factories,
      });

      const dispatchBlocks = procPrompt.mock.calls[0][2] as Array<Record<string, unknown>>;
      expect(dispatchBlocks).toHaveLength(2);
      const leading = (dispatchBlocks[0] as { text: string }).text;
      expect(leading.startsWith("request")).toBe(true);
      expect(leading).toContain("----- Attached file");
      expect(leading).toContain("notes");
      expect(dispatchBlocks[1]).toMatchObject({ type: "image" });
    });

    it("keeps pure-text prompts as a single text block on the ACP path", async () => {
      const procPrompt = vi.fn(async (..._args: unknown[]) => ({ stopReason: "end_turn" }));
      managerMock.getProcess.mockReturnValue({
        alive: true,
        prompt: procPrompt,
        initResult: {
          agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
        },
      });
      managerMock.getAcpSessionId.mockReturnValue("agent-plain");

      await handleSessionPrompt({
        id: 64,
        params: { sessionId: "acp-plain", prompt: "plain prompt" },
        ...factories,
      });

      expect(procPrompt).toHaveBeenCalledWith("agent-plain", "plain prompt", [
        { type: "text", text: "plain prompt" },
      ]);
    });

    it("flattens text resources for the Claude path without rejecting them", async () => {
      managerMock.isClaudeSession.mockReturnValue(true);
      const claudePrompt = vi.fn(async (..._args: unknown[]) => ({ stopReason: "end_turn" }));
      managerMock.getClaudeProcess.mockReturnValue({ alive: true, prompt: claudePrompt });

      await handleSessionPrompt({
        id: 65,
        params: {
          sessionId: "claude-text-resource",
          prompt: [
            { type: "text", text: "review this" },
            {
              type: "resource",
              resource: { uri: "routa-team-input://t/0", mimeType: "text/plain", text: "notes" },
            },
          ],
        },
        ...factories,
      });

      expect(claudePrompt).toHaveBeenCalledTimes(1);
      const dispatched = claudePrompt.mock.calls[0][1] as string;
      expect(dispatched.startsWith("review this")).toBe(true);
      expect(dispatched).toContain("----- Attached file");
      expect(dispatched).toContain("notes");
      expect(storeMock.pushUserMessage).toHaveBeenCalledWith("claude-text-resource", "review this");
    });

    describe("resolveBinaryPromptRejection", () => {
      it("rejects every text-only adapter path", async () => {
        const manager = managerMock as unknown as ProcessManagerUnderTest;

        managerMock.isOpencodeAdapterSession.mockReturnValue(true);
        expect(await resolveBinaryPromptRejection(manager, "s-1")).toBe("non_acp_provider");
        managerMock.isOpencodeAdapterSession.mockReturnValue(false);

        managerMock.isDockerAdapterSession.mockReturnValue(true);
        expect(await resolveBinaryPromptRejection(manager, "s-1")).toBe("non_acp_provider");
        managerMock.isDockerAdapterSession.mockReturnValue(false);

        managerMock.isClaudeSession.mockReturnValue(true);
        expect(await resolveBinaryPromptRejection(manager, "s-1")).toBe("non_acp_provider");
        managerMock.isClaudeSession.mockReturnValue(false);

        managerMock.isOpencodeSdkSessionAsync.mockResolvedValue(true);
        expect(await resolveBinaryPromptRejection(manager, "s-1")).toBe("non_acp_provider");
        managerMock.isOpencodeSdkSessionAsync.mockResolvedValue(false);

        managerMock.isClaudeCodeSdkSessionAsync.mockResolvedValue(true);
        expect(await resolveBinaryPromptRejection(manager, "s-1")).toBe("non_acp_provider");
        managerMock.isClaudeCodeSdkSessionAsync.mockResolvedValue(false);
      });

      it("requires an explicit image capability on the standard ACP path", async () => {
        const manager = managerMock as unknown as ProcessManagerUnderTest;

        managerMock.getProcess.mockReturnValue(undefined);
        expect(await resolveBinaryPromptRejection(manager, "s-2")).toBe("image_capability_missing");

        managerMock.getProcess.mockReturnValue({ initResult: {} });
        expect(await resolveBinaryPromptRejection(manager, "s-2")).toBe("image_capability_missing");

        managerMock.getProcess.mockReturnValue({
          initResult: { agentCapabilities: { promptCapabilities: { image: true } } },
        });
        expect(await resolveBinaryPromptRejection(manager, "s-2")).toBeNull();
      });
    });

    describe("buildAcpDispatchBlocks", () => {
      it("passes non-text blocks through with embedded context", () => {
        const blocks = buildAcpDispatchBlocks(
          "final text",
          [
            { type: "text", text: "request" },
            {
              type: "resource",
              resource: { type: "resource", uri: "routa-team-input://t/0", text: "notes" },
            },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
          { embeddedContext: true },
        );
        expect(blocks).toHaveLength(3);
        expect(blocks[0]).toEqual({ type: "text", text: "final text" });
        expect(blocks[1].type).toBe("resource");
        expect(blocks[2].type).toBe("image");
      });

      it("merges text resources into the leading block without embedded context", () => {
        const blocks = buildAcpDispatchBlocks(
          "final text",
          [
            { type: "text", text: "request" },
            {
              type: "resource",
              resource: { type: "resource", uri: "routa-team-input://t/0", text: "notes" },
            },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
          { embeddedContext: false },
        );
        expect(blocks).toHaveLength(2);
        expect(blocks[0].type).toBe("text");
        if (blocks[0].type === "text") {
          expect(blocks[0].text).toContain("final text");
          expect(blocks[0].text).toContain("notes");
        }
        expect(blocks[1].type).toBe("image");
      });

      it("produces exactly one text block for pure-text prompts", () => {
        expect(
          buildAcpDispatchBlocks("plain", [{ type: "text", text: "plain" }], {
            embeddedContext: false,
          }),
        ).toEqual([{ type: "text", text: "plain" }]);
      });
    });
  });
});
