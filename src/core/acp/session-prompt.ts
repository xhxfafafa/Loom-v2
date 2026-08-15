import { getHttpSessionStore, type SessionUpdateNotification } from "@/core/acp/http-session-store";
import { AgentRole } from "@/core/models/agent";
import { consumeAcpPromptResponse } from "@/core/acp/prompt-response";
import { buildCoordinatorPrompt } from "@/core/orchestration/specialist-prompts";
import { resolveSkillContent } from "@/core/skills/skill-resolver";
import { checkEmbeddedSessionLeaseForDispatch } from "@/core/acp/session-lease";
import {
  buildRecoveryErrorData,
  buildRecoveryFailedError,
  computeLeaseRetryAfterMs,
  RECOVERY_JSON_RPC_CODES,
} from "@/core/acp/session-recovery-errors";
import type { McpServerProfile } from "@/core/mcp/mcp-server-profiles";
import { pendingAcpCreations } from "@/core/acp/pending-acp-creations";
import { persistSessionHistorySnapshot } from "@/core/acp/session-history";
import { acknowledgePromptDeliveryOnce } from "@/core/acp/prompt-delivery";
import { consumePendingRecoveryContext } from "@/core/acp/recovery-context";
import { persistCapturedProviderSessionId } from "@/core/acp/session-db-persister";
import {
  PROMPT_IMAGE_UNSUPPORTED_ERROR_CODE,
  appendEmbeddedResourcesAsText,
  agentPromptCapabilities,
  hasBinaryContentBlock,
  parsePromptContentBlocks,
} from "@/core/acp/prompt-content";
import type { AcpContentBlock } from "@/core/acp/protocol-types";
import type { AcpProcessManager, AcpSessionKillResult } from "@/core/acp/acp-process-manager";
import {
  ensureSessionRuntime,
  sanitizeClaudeProviderSessionId,
  SessionRuntimeRecoveryError,
} from "@/core/acp/session-runtime-recovery";

type JsonRpcResponseFactory = (
  id: string | number | null,
  result: unknown,
  error?: { code: number; message: string; data?: Record<string, unknown> }
) => Response;

type SessionUpdateForwarderFactory = (
  store: ReturnType<typeof getHttpSessionStore>,
  sessionId: string,
) => (msg: { method?: string; params?: Record<string, unknown> }) => void;

type ClaudeMcpConfigBuilder = (
  workspaceId?: string,
  sessionId?: string,
  toolMode?: "essential" | "full",
  mcpProfile?: McpServerProfile,
) => Promise<string[]>;

type WorkspaceIdResolver = (value: unknown) => string | null;
type SsePayloadEncoder = (payload: unknown) => string;

interface DispatchSessionPromptParams {
  sessionId: string;
  prompt: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  workspaceId?: string;
  provider?: string;
  cwd?: string;
  skillName?: string;
  skillContent?: string;
  /**
   * Persistent delivery identity for this prompt: a client-generated UUID for
   * user prompts (retained across network retries), the deterministic
   * `team-report:…` delivery ID for child completion reports, or a
   * `resume:…` request ID for explicit Resume. Deduplicated durably via
   * `appendHistoryOnce`; never a provider conversation ID.
   */
  promptId?: string;
}

type AcpErrorLike = Error & {
  code: number;
  authMethods?: unknown;
  agentInfo?: unknown;
  data?: unknown;
};

function inlineJsonrpcResponse(
  id: string | number | null,
  result: unknown,
  error?: { code: number; message: string; data?: Record<string, unknown> },
): Response {
  const body = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function inlineRequireWorkspaceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function inlineEncodeSsePayload(payload: unknown): string {
  const params = typeof payload === "object" && payload !== null
    ? (payload as { params?: { eventId?: string } }).params
    : undefined;
  const eventId = typeof params?.eventId === "string" ? params.eventId : undefined;
  return `${eventId ? `id: ${eventId}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
}

function inlineCreateSessionUpdateForwarder(
  store: ReturnType<typeof getHttpSessionStore>,
  sessionId: string,
): (msg: { method?: string; params?: Record<string, unknown> }) => void {
  return (msg) => {
    if (msg.method !== "session/update" || !msg.params) return;
    store.pushNotification({
      ...msg.params,
      sessionId,
    } as SessionUpdateNotification);
  };
}

async function inlineBuildMcpConfigForClaude(
  workspaceId?: string,
  sessionId?: string,
  toolMode?: "essential" | "full",
  mcpProfile?: McpServerProfile,
): Promise<string[]> {
  const [
    { getDefaultRoutaMcpConfig },
    { ensureMcpForProvider },
  ] = await Promise.all([
    import("@/core/acp/mcp-config-generator"),
    import("@/core/acp/mcp-setup"),
  ]);
  const config = workspaceId
    ? getDefaultRoutaMcpConfig(workspaceId, sessionId, toolMode, mcpProfile)
    : undefined;
  const result = await ensureMcpForProvider("claude", config);
  return result.mcpConfigs;
}

function markSessionPromptError(
  store: ReturnType<typeof getHttpSessionStore>,
  sessionId: string,
  error: unknown,
  fallbackMessage: string,
): string {
  const message = error instanceof Error ? error.message : fallbackMessage;
  store.updateSessionAcpStatus(sessionId, "error", message);
  return message;
}

export function isSessionPromptTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Timeout waiting for session/prompt");
}

function getPromptErrorData(error: unknown): Record<string, unknown> | undefined {
  if (isAcpErrorLike(error)) {
    return {
      source: "acp",
      code: error.code,
      authMethods: error.authMethods,
      agentInfo: error.agentInfo,
      data: error.data,
    };
  }
  if (error instanceof Error) {
    return {
      source: "app",
      errorName: error.name,
      errorMessage: error.message,
    };
  }
  return undefined;
}

function maybePushSyntheticTurnComplete(
  store: ReturnType<typeof getHttpSessionStore>,
  sessionId: string,
  result: unknown,
): void {
  if (!result || typeof result !== "object") {
    return;
  }

  const payload = result as Record<string, unknown>;
  const stopReason = typeof payload.stopReason === "string" ? payload.stopReason : undefined;
  if (!stopReason) {
    return;
  }

  const lastNotification = store.getHistory(sessionId).at(-1);
  const lastUpdate = lastNotification?.update as Record<string, unknown> | undefined;
  if (lastUpdate?.sessionUpdate === "turn_complete") {
    return;
  }

  const rawUsage = payload.usage;
  const usageRecord = rawUsage && typeof rawUsage === "object"
    ? rawUsage as Record<string, unknown>
    : undefined;
  const inputTokens = typeof usageRecord?.input_tokens === "number"
    ? usageRecord.input_tokens
    : typeof usageRecord?.inputTokens === "number"
      ? usageRecord.inputTokens
      : undefined;
  const outputTokens = typeof usageRecord?.output_tokens === "number"
    ? usageRecord.output_tokens
    : typeof usageRecord?.outputTokens === "number"
      ? usageRecord.outputTokens
      : undefined;

  store.pushNotification({
    sessionId,
    update: {
      sessionUpdate: "turn_complete",
      stopReason,
      ...(inputTokens !== undefined || outputTokens !== undefined
        ? {
            usage: {
              ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
              ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
            },
          }
        : {}),
    },
  });
}

function isCompletedClaudeTurn(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const stopReason = (result as { stopReason?: unknown }).stopReason;
  // `tool_use` and `max_tokens` may require the current runtime to keep
  // working. A normal completed turn can be restarted from the saved session.
  return stopReason === "end_turn" || stopReason === "stop_sequence";
}

async function releaseCompletedClaudeProcess(
  sessionId: string,
  result: unknown,
  manager: {
    killSession(sessionId: string): Promise<AcpSessionKillResult | void>;
    hasActiveSession(sessionId: string): boolean;
  },
  store: ReturnType<typeof getHttpSessionStore>,
): Promise<void> {
  if (!isCompletedClaudeTurn(result)) return;
  const { finalizeSessionRuntime } = await import("@/core/acp/session-runtime-finalizer");
  const release = await finalizeSessionRuntime(sessionId, "completed", { manager, store });
  if (!release.released) return;
}

function isAcpErrorLike(error: unknown): error is AcpErrorLike {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return candidate.name === "AcpError"
    && typeof candidate.message === "string"
    && typeof candidate.code === "number";
}

function buildCoordinatorContextPrompt(input: {
  agentId: string;
  workspaceId: string;
  userRequest: string;
}): string {
  return `**Your Agent ID:** ${input.agentId}\n`
    + `**Workspace ID:** ${input.workspaceId}\n\n`
    + `## User Request\n\n${input.userRequest}\n`;
}

function buildTeamLeadFirstTurnContract(): string {
  return [
    "## First-Turn Operating Contract",
    "",
    "You are the team lead for a live Team Run.",
    "",
    "On your first working turn:",
    "1. Do not browse the repository yourself with read/glob/grep/search tools.",
    "2. Keep the active wave small. Spawn at most 3 real child sessions at once.",
    "3. Do not create placeholder teammates or idle agents just to mirror the roster.",
    "4. If codebase context is unknown, your first action must be `create_task` plus `delegate_task_to_agent` for a real `researcher` child session.",
    "5. After delegating, stop and wait for child updates unless the user must answer a blocking question.",
    "6. Never create teammate-specific specialist files like `frontend-dev-lee.yaml` or `backend-dev-bill.yaml`.",
    "7. The team specialist catalog is one canonical file per role under `resources/specialists/team/`.",
    "8. Teammate names belong in roster text, prompts, or runtime labels, not in new YAML filenames or specialist ids.",
    "",
    "Use Team UI motion as the source of truth: visible child sessions first, lead-side exploration later.",
  ].join("\n");
}

function buildCoordinatorFirstPrompt(input: {
  agentId: string;
  workspaceId: string;
  userRequest: string;
  specialistId?: string;
  specialistSystemPrompt?: string;
  provider?: string;
}): string {
  const contextPrompt = buildCoordinatorContextPrompt({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    userRequest: input.userRequest,
  });
  const teamLeadFirstTurnContract = input.specialistId === "team-agent-lead"
    ? `\n\n---\n\n${buildTeamLeadFirstTurnContract()}`
    : "";

  if (input.provider === "claude-code-sdk" && input.specialistSystemPrompt) {
    return `${contextPrompt}${teamLeadFirstTurnContract}`;
  }

  if (input.specialistSystemPrompt) {
    return `${input.specialistSystemPrompt}\n\n---\n\n${contextPrompt}${teamLeadFirstTurnContract}`;
  }

  return `${buildCoordinatorPrompt({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    userRequest: input.userRequest,
  })}${teamLeadFirstTurnContract}`;
}

async function ensurePromptSessionExists(args: {
  id: string | number | null;
  params: Record<string, unknown>;
  sessionId: string;
  jsonrpcResponse: JsonRpcResponseFactory;
  createSessionUpdateForwarder: SessionUpdateForwarderFactory;
  buildMcpConfigForClaude: ClaudeMcpConfigBuilder;
  requireWorkspaceId: WorkspaceIdResolver;
  serverUrlOverride?: string;
}): Promise<Response | null> {
  const {
    id,
    params,
    sessionId,
    jsonrpcResponse,
    createSessionUpdateForwarder,
    buildMcpConfigForClaude,
    requireWorkspaceId,
    serverUrlOverride,
  } = args;

  // User prompts recover the provider runtime through the same unified entry
  // point as explicit session/load Resume and sub-Agent reports.
  try {
    await ensureSessionRuntime({
      sessionId,
      cwdFallback: params.cwd as string | undefined,
      providerOverride: params.provider as string | undefined,
      workspaceId: requireWorkspaceId(params.workspaceId) ?? undefined,
      dockerAuthJson: params.authJson as string | undefined,
      serverUrlOverride,
      allowFreshCreate: true,
      traceSessionStart: true,
      createSessionUpdateForwarder,
      buildMcpConfigForClaude,
    });
    return null;
  } catch (err) {
    if (err instanceof SessionRuntimeRecoveryError) {
      return jsonrpcResponse(id ?? null, null, err.jsonRpcError);
    }
    console.error("[ACP Route] Failed to auto-create session:", err);
    const failureError = buildRecoveryFailedError(
      `Failed to auto-create session: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return jsonrpcResponse(id ?? null, null, failureError);
  }
}

function createStreamingSseResponse(args: {
  sessionId: string;
  store: ReturnType<typeof getHttpSessionStore>;
  encodeSsePayload?: SsePayloadEncoder;
  /** When present, emit a `prompt_accepted` session/update frame first. */
  promptId?: string;
  run: (controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder) => Promise<void>;
}): Response {
  const { sessionId, store, encodeSsePayload, promptId, run } = args;
  store.enterStreamingMode(sessionId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Emit an initial comment frame so proxies/clients start consuming the stream early.
      controller.enqueue(encoder.encode(": stream-open\n\n"));

      // Durable delivery acknowledgement: this promptId was accepted for
      // execution before any provider event is emitted.
      if (promptId && encodeSsePayload) {
        controller.enqueue(encoder.encode(encodeSsePayload({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "prompt_accepted", promptId },
          },
        })));
      }

      // Do not await the long-running prompt stream in `start()`.
      // Keeping start non-blocking avoids buffering the whole SSE response.
      void run(controller, encoder).catch((err) => {
        console.error(`[ACP Route] Streaming run failed for session ${sessionId}:`, err);
        try {
          controller.error(err);
        } catch {
          // Stream already closed by the producer path.
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Binary content (image blocks, blob resources) can only travel through the
 * standard ACP process path, and only when the initialized agent advertises
 * image prompt capability. Every other provider path is text-only. Returns
 * the rejection reason when the prompt cannot be carried as-is, or null when
 * dispatch may proceed. There is deliberately no text-only fallback: a
 * prompt whose binary blocks cannot be delivered is rejected whole instead
 * of being partially dispatched with the attachments dropped.
 */
export async function resolveBinaryPromptRejection(
  manager: AcpProcessManager,
  sessionId: string,
): Promise<"non_acp_provider" | "image_capability_missing" | null> {
  const isTextOnlyAdapterPath =
    manager.isOpencodeAdapterSession(sessionId)
    || await manager.isOpencodeSdkSessionAsync(sessionId)
    || manager.isDockerAdapterSession(sessionId)
    || await manager.isClaudeCodeSdkSessionAsync(sessionId)
    || manager.isClaudeSession(sessionId);
  if (isTextOnlyAdapterPath) return "non_acp_provider";
  const capabilities = agentPromptCapabilities(manager.getProcess(sessionId)?.initResult);
  return capabilities.image ? null : "image_capability_missing";
}

/**
 * Build the ACP content blocks dispatched to a standard ACP provider. The
 * finalized prompt text (including recovery/specialist mutations) becomes
 * the leading text block. Non-text blocks pass through unchanged when the
 * agent declared embedded-context support; otherwise embedded TEXT resources
 * merge into the leading text block as clearly delimited text. Pure-text
 * prompts produce exactly one text block, matching the previous behavior.
 */
export function buildAcpDispatchBlocks(
  promptText: string,
  blocks: AcpContentBlock[],
  capabilities: { embeddedContext: boolean },
): AcpContentBlock[] {
  let leadingText = promptText;
  const trailingBlocks: AcpContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") continue;
    if (
      !capabilities.embeddedContext
      && block.type === "resource"
      && block.resource.text !== undefined
    ) {
      leadingText = appendEmbeddedResourcesAsText(leadingText, [block]);
      continue;
    }
    trailingBlocks.push(block);
  }
  return [{ type: "text", text: leadingText }, ...trailingBlocks];
}

interface HandleSessionPromptArgs {
  id: string | number | null;
  params: Record<string, unknown>;
  jsonrpcResponse: JsonRpcResponseFactory;
  createSessionUpdateForwarder: SessionUpdateForwarderFactory;
  buildMcpConfigForClaude: ClaudeMcpConfigBuilder;
  requireWorkspaceId: WorkspaceIdResolver;
  encodeSsePayload: SsePayloadEncoder;
  serverUrlOverride?: string;
}

export async function handleSessionPrompt({
  id,
  params,
  jsonrpcResponse,
  createSessionUpdateForwarder,
  buildMcpConfigForClaude,
  requireWorkspaceId,
  encodeSsePayload,
  serverUrlOverride,
}: HandleSessionPromptArgs): Promise<Response> {
  const p = params;
  const sessionId = p.sessionId as string;

  if (!sessionId) {
    return jsonrpcResponse(id ?? null, null, {
      code: -32602,
      message: "Missing sessionId",
    });
  }

  const promptId = typeof p.promptId === "string" ? p.promptId.trim() : "";

  // Merge the durable delivery acknowledgement into non-streaming results.
  const withPromptAck = (result: unknown): unknown => {
    if (!promptId) return result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), promptId, promptAccepted: true };
    }
    return { result, promptId, promptAccepted: true };
  };

  const { getAcpProcessManager } = await import("@/core/acp/processer");
  const manager = getAcpProcessManager();
  const store = getHttpSessionStore();
  const forwardSessionUpdate = createSessionUpdateForwarder(store, sessionId);

  // Content blocks are validated and preserved at the transport boundary;
  // dispatch below decides per adapter whether blocks pass through unchanged
  // (standard ACP providers), embedded text resources become delimited text
  // (adapters without embedded context), or the prompt fails explicitly
  // (binary content on a path that cannot carry it). `promptText` stays
  // text-block-only so history recording and text mutations behave exactly
  // as before; attachment bytes never enter history or visible text.
  const { blocks: promptContentBlocks, promptText: parsedPromptText } = parsePromptContentBlocks(p.prompt);
  const promptHasBinaryContent = hasBinaryContentBlock(promptContentBlocks);
  let promptText = parsedPromptText;

  const skillName = p.skillName as string | undefined;
  let skillContent = p.skillContent as string | undefined;
  if (skillName && !skillContent) {
    const cwd = (p.cwd as string | undefined) ?? process.cwd();
    console.log(`[ACP Route] Loading skill content for: ${skillName}`);
    skillContent = await resolveSkillContent(skillName, cwd);
    if (!skillContent) {
      console.warn(`[ACP Route] Could not load skill content for: ${skillName}, proceeding without skill`);
    }
  }

  const pendingCreation = pendingAcpCreations.get(sessionId);
  if (pendingCreation) {
    console.log(`[ACP Route] Waiting for pending ACP creation for session ${sessionId}...`);
    await pendingCreation;
  }

  const autoCreateResponse = await ensurePromptSessionExists({
    id,
    params: p,
    sessionId,
    jsonrpcResponse,
    createSessionUpdateForwarder,
    buildMcpConfigForClaude,
    requireWorkspaceId,
    serverUrlOverride,
  });
  if (autoCreateResponse) {
    return autoCreateResponse;
  }

  // Capability gate BEFORE delivery is recorded or the first prompt is
  // mutated: when this session's provider path cannot carry binary content,
  // reject the whole prompt explicitly. Nothing is partially dispatched and
  // nothing is silently dropped; the client keeps the input and attachments
  // for retry. Pure-text prompts never reach this branch.
  if (promptHasBinaryContent) {
    const binaryRejection = await resolveBinaryPromptRejection(manager, sessionId);
    if (binaryRejection) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message:
          binaryRejection === "image_capability_missing"
            ? "The connected ACP agent does not accept image content in prompts; the prompt was NOT dispatched. Remove the images or choose an agent with image support and retry."
            : "This provider path only accepts text prompts; the prompt was NOT dispatched. Remove the images or choose an ACP provider with image support and retry.",
        data: { reason: PROMPT_IMAGE_UNSUPPORTED_ERROR_CODE, retryable: false, sessionId },
      });
    }
  }

  const visiblePromptText = promptText;

  // Checked lease heartbeat on prompt acceptance (fail-closed). The refresh
  // uses the same atomic compare-and-swap as recovery acquisition, so it can
  // never clobber a binding owned by another instance — but when the CAS
  // PROVES the lease was lost, dispatch must stop and the orphaned runtime is
  // isolated. When the lease cannot be verified at all (DB outage), dispatch
  // stops fail-closed WITHOUT killing the runtime; the client keeps the input
  // and can retry. Sessions without a durable embedded lease record proceed.
  const leaseCheck = await checkEmbeddedSessionLeaseForDispatch(store, store.getSession(sessionId));
  if (leaseCheck.status === "lost") {
    manager.killSession(sessionId);
    return jsonrpcResponse(id ?? null, null, {
      code: RECOVERY_JSON_RPC_CODES.runtimeOwned,
      message:
        `Session ${sessionId} is currently owned by instance ${leaseCheck.ownerInstanceId ?? "another instance"}; ` +
        "the local runtime was isolated. The prompt was NOT dispatched; retry against the owning instance.",
      data: buildRecoveryErrorData("runtime_owned", {
        ownerInstanceId: leaseCheck.ownerInstanceId,
        leaseExpiresAt: leaseCheck.leaseExpiresAt,
        retryAfterMs: computeLeaseRetryAfterMs(leaseCheck.leaseExpiresAt),
        sessionId,
      }),
    });
  }
  if (leaseCheck.status === "unavailable") {
    return jsonrpcResponse(id ?? null, null, {
      code: RECOVERY_JSON_RPC_CODES.recoveryUnavailable,
      message:
        `Session runtime lease for ${sessionId} could not be verified because the session database is unavailable. ` +
        "The prompt was NOT dispatched; please retry.",
      data: buildRecoveryErrorData("recovery_unavailable", { retryable: true, sessionId }),
    });
  }

  const { getRoutaOrchestrator } = await import("@/core/orchestration/orchestrator-singleton");
  const orchestrator = getRoutaOrchestrator();
  if (orchestrator) {
    const sessionRecord = store.getSession(sessionId);
    if (sessionRecord?.routaAgentId) {
      const { getRoutaSystem } = await import("@/core/routa-system");
      const system = getRoutaSystem();
      const agent = await system.agentStore.get(sessionRecord.routaAgentId);
      if (agent?.role === AgentRole.ROUTA) {
        const isFirstPrompt = !sessionRecord.firstPromptSent;
        if (isFirstPrompt) {
          promptText = buildCoordinatorFirstPrompt({
            agentId: agent.id,
            workspaceId: sessionRecord.workspaceId,
            userRequest: promptText,
            specialistId: sessionRecord.specialistId,
            specialistSystemPrompt: sessionRecord.specialistSystemPrompt,
            provider: sessionRecord.provider,
          });
          store.markFirstPromptSent(sessionId);
        }
      }
    }
  }

  {
    const sessionRecord = store.getSession(sessionId);
    if (sessionRecord?.specialistSystemPrompt && !sessionRecord.firstPromptSent) {
      promptText = sessionRecord.provider === "claude-code-sdk"
        ? promptText
        : `${sessionRecord.specialistSystemPrompt}\n\n---\n\n${promptText}`;
      store.markFirstPromptSent(sessionId);
      console.log(
        `[ACP Route] Injected specialist systemPrompt for ${sessionRecord.specialistId} into session ${sessionId}`,
      );
    }
  }

  // Durable prompt delivery acknowledgement. With a promptId, the user
  // message / delivery event is recorded exactly once (appendHistoryOnce) and
  // a duplicate delivery during normal retries neither appends nor dispatches
  // again — the caller receives the existing acknowledgement. Persistence
  // failures FAIL CLOSED: the prompt is not dispatched and not reported as
  // accepted (or duplicate), so the client keeps the input and can retry.
  if (promptId) {
    const deliveryAck = await acknowledgePromptDeliveryOnce(sessionId, promptId, visiblePromptText);
    if (deliveryAck.status === "duplicate") {
      return jsonrpcResponse(id ?? null, {
        sessionId,
        promptId,
        promptAccepted: true,
        duplicate: true,
      });
    }
    if (deliveryAck.status === "session_not_found") {
      return jsonrpcResponse(id ?? null, null, {
        code: -32004,
        message: `Session ${sessionId} was not found; the prompt was not recorded or delivered`,
        data: { reason: "session_not_found", retryable: false, promptId },
      });
    }
    if (deliveryAck.status === "unavailable") {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: `Prompt delivery could not be durably recorded: ${deliveryAck.error}. The prompt was NOT dispatched; please retry.`,
        data: { reason: "prompt_delivery_unavailable", retryable: true, promptId },
      });
    }
    store.pushUserMessage(sessionId, visiblePromptText, promptId);
  } else {
    store.pushUserMessage(sessionId, visiblePromptText);
  }
  await persistSessionHistorySnapshot(sessionId, store);

  // One-shot recovery context prefix: providers without a system-prompt
  // append channel receive the bounded recovery envelope as a clearly-marked
  // prefix on the first dispatched prompt after a context rebuild. It is
  // consumed exactly once here and only after delivery was durably recorded —
  // a fail-closed persistence failure above keeps it queued for the retry.
  // The envelope is never recorded in durable history (only visiblePromptText
  // is) and never re-dispatched on later prompts.
  const pendingRecoveryContext = consumePendingRecoveryContext(sessionId);
  if (pendingRecoveryContext) {
    promptText = `${pendingRecoveryContext}\n\n${promptText}`;
  }

  const sessionRecord = store.getSession(sessionId);

  // Text-only provider paths receive embedded text resources as clearly
  // delimited prompt text appended after the finalized prompt text. Binary
  // content was rejected above for every path that cannot carry it, so this
  // flattening drops nothing.
  const flattenedDispatchText = appendEmbeddedResourcesAsText(promptText, promptContentBlocks);

  if (manager.isOpencodeAdapterSession(sessionId) || await manager.isOpencodeSdkSessionAsync(sessionId)) {
    const opcAdapter = await manager.getOrRecreateOpencodeSdkAdapter(
      sessionId,
      forwardSessionUpdate,
    );

    if (!opcAdapter) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: `No OpenCode SDK adapter for session: ${sessionId}`,
      });
    }

    if (!opcAdapter.alive) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: "OpenCode SDK adapter is not connected",
      });
    }

    return createStreamingSseResponse({
      sessionId,
      store,
      encodeSsePayload,
      promptId: promptId || undefined,
      run: async (controller, encoder) => {
        try {
          for await (const event of opcAdapter.promptStream(flattenedDispatchText, sessionId, skillContent, sessionRecord?.workspaceId ?? undefined)) {
            controller.enqueue(encoder.encode(event));
          }
          store.flushAgentBuffer(sessionId);
          store.exitStreamingMode(sessionId);
          await persistSessionHistorySnapshot(sessionId, store);
          controller.close();
        } catch (err) {
          if (isSessionPromptTimeoutError(err)) {
            console.warn(
              `[ACP Route] session/prompt timed out while waiting for ${sessionId}; keeping ACP session alive for continued lifecycle updates.`,
              err,
            );
            store.flushAgentBuffer(sessionId);
            store.exitStreamingMode(sessionId);
            await persistSessionHistorySnapshot(sessionId, store);
            controller.close();
            return;
          }
          const message = markSessionPromptError(store, sessionId, err, "OpenCode SDK prompt failed");
          store.flushAgentBuffer(sessionId);
          store.exitStreamingMode(sessionId);
          await persistSessionHistorySnapshot(sessionId, store);
          controller.enqueue(encoder.encode(encodeSsePayload({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              type: "error",
              error: { message },
            },
          })));
          controller.close();
        }
      },
    });
  }

  if (manager.isDockerAdapterSession(sessionId)) {
    const dockerAdapter = manager.getDockerAdapter(sessionId);
    if (!dockerAdapter) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: `No Docker OpenCode adapter for session: ${sessionId}`,
      });
    }

    if (!dockerAdapter.alive) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: "Docker OpenCode adapter is not connected",
      });
    }

    return createStreamingSseResponse({
      sessionId,
      store,
      encodeSsePayload,
      promptId: promptId || undefined,
      run: async (controller, encoder) => {
        try {
          for await (const event of dockerAdapter.promptStream(
            flattenedDispatchText,
            sessionId,
            skillContent,
            sessionRecord?.workspaceId ?? undefined,
          )) {
            controller.enqueue(encoder.encode(event));
          }
          store.flushAgentBuffer(sessionId);
          store.exitStreamingMode(sessionId);
          await persistSessionHistorySnapshot(sessionId, store);
          controller.close();
        } catch (err) {
          if (isSessionPromptTimeoutError(err)) {
            console.warn(
              `[ACP Route] session/prompt timed out while waiting for ${sessionId}; keeping ACP session alive for continued lifecycle updates.`,
              err,
            );
            store.flushAgentBuffer(sessionId);
            store.exitStreamingMode(sessionId);
            await persistSessionHistorySnapshot(sessionId, store);
            controller.close();
            return;
          }
          const message = markSessionPromptError(store, sessionId, err, "Docker OpenCode prompt failed");
          store.flushAgentBuffer(sessionId);
          store.exitStreamingMode(sessionId);
          await persistSessionHistorySnapshot(sessionId, store);
          controller.enqueue(encoder.encode(encodeSsePayload({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              type: "error",
              error: { message },
            },
          })));
          controller.close();
        }
      },
    });
  }

  if (await manager.isClaudeCodeSdkSessionAsync(sessionId)) {
    const adapter = await manager.getOrRecreateClaudeCodeSdkAdapter(
      sessionId,
      forwardSessionUpdate,
    );

    if (!adapter) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: `No Claude Code SDK adapter for session: ${sessionId}`,
      });
    }

    if (!adapter.alive) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: "Claude Code SDK adapter is not connected",
      });
    }

    return createStreamingSseResponse({
      sessionId,
      store,
      encodeSsePayload,
      promptId: promptId || undefined,
      run: async (controller, encoder) => {
        try {
          for await (const event of adapter.promptStream(flattenedDispatchText, sessionId, skillContent)) {
            controller.enqueue(encoder.encode(event));
          }
          store.flushAgentBuffer(sessionId);
          store.exitStreamingMode(sessionId);
          await persistSessionHistorySnapshot(sessionId, store);
          controller.close();
        } catch (err) {
          if (isSessionPromptTimeoutError(err)) {
            console.warn(
              `[ACP Route] session/prompt timed out while waiting for ${sessionId}; keeping ACP session alive for continued lifecycle updates.`,
              err,
            );
            store.flushAgentBuffer(sessionId);
            store.exitStreamingMode(sessionId);
            await persistSessionHistorySnapshot(sessionId, store);
            controller.close();
            return;
          }
          const message = markSessionPromptError(store, sessionId, err, "Claude Code SDK prompt failed");
          store.flushAgentBuffer(sessionId);
          store.exitStreamingMode(sessionId);
          await persistSessionHistorySnapshot(sessionId, store);
          controller.enqueue(encoder.encode(encodeSsePayload({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              type: "error",
              error: { message },
            },
          })));
          controller.close();
        }
      },
    });
  }

  if (manager.isClaudeSession(sessionId)) {
    const claudeProc = manager.getClaudeProcess(sessionId);
    if (!claudeProc) {
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message: `No Claude Code process for session: ${sessionId}`,
      });
    }

    if (!claudeProc.alive) {
      console.warn(`[ACP Route] Claude Code process for session ${sessionId} is dead — attempting restart`);
      await manager.killSession(sessionId);
      const restartRecord = store.getSession(sessionId);
      if (!restartRecord) {
        return jsonrpcResponse(id ?? null, null, {
          code: -32000,
          message: `Session ${sessionId} not found in store — cannot restart`,
        });
      }
      const restartCwd = restartRecord.cwd ?? process.cwd();
      const restartWorkspaceId = restartRecord.workspaceId;
      if (!restartWorkspaceId) {
        return jsonrpcResponse(id ?? null, null, {
          code: -32602,
          message: "workspaceId is missing for session restart",
        });
      }
      const restartRole = restartRecord.role ?? "CRAFTER";
      const restartToolMode = restartRecord.toolMode;
      const restartMcpProfile = restartRecord.mcpProfile;
      const restartAllowedNativeTools = restartRecord.allowedNativeTools;
      try {
        const mcpConfigs = await buildMcpConfigForClaude(
          restartWorkspaceId,
          sessionId,
          restartToolMode,
          restartMcpProfile,
        );
        // Seed the restart with the persisted provider-native ID when one was
        // captured from system/init (never the Routa Session ID), so the
        // conversation resumes natively; the capture hook persists any new
        // native ID the restarted CLI reports.
        const restartResumeSeed = sanitizeClaudeProviderSessionId(
          restartRecord.providerSessionId,
          sessionId,
        );
        await manager.createClaudeSession(
          sessionId,
          restartCwd,
          forwardSessionUpdate,
          mcpConfigs,
          undefined,
          restartRole,
          undefined,
          restartAllowedNativeTools,
          restartResumeSeed,
          (captured: string) => {
            void persistCapturedProviderSessionId(sessionId, captured);
          },
        );
        console.info(`[ACP Route] Restarted Claude Code process for session ${sessionId}`);
      } catch (restartErr) {
        return jsonrpcResponse(id ?? null, null, {
          code: -32000,
          message: `Failed to restart Claude Code process: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`,
        });
      }
      const restarted = manager.getClaudeProcess(sessionId);
      if (!restarted) {
        return jsonrpcResponse(id ?? null, null, {
          code: -32000,
          message: "Claude Code process restart failed unexpectedly",
        });
      }
      try {
        const result = await restarted.prompt(sessionId, flattenedDispatchText);
        maybePushSyntheticTurnComplete(store, sessionId, result);
        store.flushAgentBuffer(sessionId);
        await persistSessionHistorySnapshot(sessionId, store);
        await releaseCompletedClaudeProcess(sessionId, result, manager, store);
        return jsonrpcResponse(id ?? null, withPromptAck(result));
      } catch (err) {
        if (isSessionPromptTimeoutError(err)) {
          console.warn(
            `[ACP Route] session/prompt timed out while waiting for ${sessionId}; keeping ACP session alive for continued lifecycle updates.`,
            err,
          );
          store.flushAgentBuffer(sessionId);
          void persistSessionHistorySnapshot(sessionId, store);
          return jsonrpcResponse(id ?? null, withPromptAck({ sessionId, pending: true }));
        }
        const message = markSessionPromptError(store, sessionId, err, "Claude Code prompt failed after restart");
        store.flushAgentBuffer(sessionId);
        void persistSessionHistorySnapshot(sessionId, store);
        return jsonrpcResponse(id ?? null, null, {
          code: -32000,
          message,
          data: getPromptErrorData(err),
        });
      }
    }

    try {
      const result = await claudeProc.prompt(sessionId, flattenedDispatchText);
      maybePushSyntheticTurnComplete(store, sessionId, result);
      store.flushAgentBuffer(sessionId);
      await persistSessionHistorySnapshot(sessionId, store);
      await releaseCompletedClaudeProcess(sessionId, result, manager, store);
      return jsonrpcResponse(id ?? null, withPromptAck(result));
    } catch (err) {
      if (isSessionPromptTimeoutError(err)) {
        console.warn(
          `[ACP Route] session/prompt timed out while waiting for ${sessionId}; keeping ACP session alive for continued lifecycle updates.`,
          err,
        );
        store.flushAgentBuffer(sessionId);
        void persistSessionHistorySnapshot(sessionId, store);
        return jsonrpcResponse(id ?? null, withPromptAck({ sessionId, pending: true }));
      }
      const message = markSessionPromptError(store, sessionId, err, "Claude Code prompt failed");
      store.flushAgentBuffer(sessionId);
      void persistSessionHistorySnapshot(sessionId, store);
      return jsonrpcResponse(id ?? null, null, {
        code: -32000,
        message,
        data: getPromptErrorData(err),
      });
    }
  }

  const proc = manager.getProcess(sessionId);
  const acpSessionId = manager.getAcpSessionId(sessionId);

  if (!proc || !acpSessionId) {
    return jsonrpcResponse(id ?? null, null, {
      code: -32000,
      message: `No ACP agent process for session: ${sessionId}`,
    });
  }

  if (!proc.alive) {
    const presetId = manager.getPresetId(sessionId) ?? "unknown";
    return jsonrpcResponse(id ?? null, null, {
      code: -32000,
      message: `ACP agent (${presetId}) process is not running`,
    });
  }

  try {
    // Standard ACP providers receive preserved content blocks; text-only
    // prompts collapse to the same single text block as before.
    const dispatchBlocks = buildAcpDispatchBlocks(
      promptText,
      promptContentBlocks,
      agentPromptCapabilities(proc.initResult),
    );
    const result = await proc.prompt(acpSessionId, promptText, dispatchBlocks);
    maybePushSyntheticTurnComplete(store, sessionId, result);
    store.flushAgentBuffer(sessionId);
    void persistSessionHistorySnapshot(sessionId, store);
    return jsonrpcResponse(id ?? null, withPromptAck(result));
  } catch (err) {
    if (isSessionPromptTimeoutError(err)) {
      console.warn(
        `[ACP Route] session/prompt timed out while waiting for ${sessionId}; keeping ACP session alive for continued lifecycle updates.`,
        err,
      );
      store.flushAgentBuffer(sessionId);
      void persistSessionHistorySnapshot(sessionId, store);
      return jsonrpcResponse(id ?? null, withPromptAck({ sessionId, pending: true }));
    }
    const message = markSessionPromptError(store, sessionId, err, "Prompt failed");
    store.flushAgentBuffer(sessionId);
    void persistSessionHistorySnapshot(sessionId, store);
    return jsonrpcResponse(id ?? null, null, {
      code: -32000,
      message,
      data: getPromptErrorData(err),
    });
  }
}

export async function dispatchSessionPrompt(params: DispatchSessionPromptParams): Promise<void> {
  const response = await handleSessionPrompt({
    id: params.sessionId,
    params: params as unknown as Record<string, unknown>,
    jsonrpcResponse: inlineJsonrpcResponse,
    createSessionUpdateForwarder: inlineCreateSessionUpdateForwarder,
    buildMcpConfigForClaude: inlineBuildMcpConfigForClaude,
    requireWorkspaceId: inlineRequireWorkspaceId,
    encodeSsePayload: inlineEncodeSsePayload,
  });
  await consumeAcpPromptResponse(response);
}
