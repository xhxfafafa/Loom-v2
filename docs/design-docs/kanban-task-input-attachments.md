---
title: Kanban Task Input Attachments
status: proposed
purpose: Add bounded text and image input attachments to manual Kanban tasks and the initial Team Run launch.
---

# Kanban Task Input Attachments

## Decision

The manual Kanban task form may include a small number of local text files and static images.

The implementation reuses the existing `Artifact`, `ArtifactStore`, task Artifact API, task detail
UI, and MCP `list_artifacts` / `get_artifact` tools. It adds one Artifact type, `attachment`, whose
meaning is user-provided task input rather than Agent delivery evidence.

Attachments travel in the initial `POST /api/tasks` JSON body and are persisted before initial-column
automation starts. This prevents an Agent from receiving its first prompt before the attachments
exist.

The first version does not add a new table, upload service, object storage, multipart protocol,
background job, or filesystem mount.

## Current implementation baseline

The implementation starts from these existing behaviors:

- `KanbanCreateModal` owns text-only `TaskDraft` fields and has no submitting/error state.
- `createTaskCard` converts the draft into one JSON `POST /api/tasks` request.
- the Next.js route may create a linked GitHub Issue, saves the Task, publishes a created event, and
  may immediately call `processKanbanColumnTransition`;
- the Rust handler currently may create a linked GitHub Issue and trigger an Agent before its final
  Task save;
- Artifact content is stored inline as database text in Web and desktop stores;
- task detail fetches all Artifact content through `GET /api/tasks/{taskId}/artifacts`;
- MCP `list_artifacts` returns summaries, while `get_artifact` returns complete content and metadata;
- current evidence summaries count all stored Artifacts, and the TypeScript completion fallback
  treats the existence of any Artifact as evidence;
- Rust task deletion has an Artifact foreign-key cascade, while Web task deletion does not.

These are implementation facts to change or preserve. The attachment work must not create a second
task or Artifact lifecycle beside them.

## Invariants

1. A successful create response means the Task and every submitted attachment are durable.
2. Initial automation cannot start before all input attachments are readable.
3. Attachment failure cannot leave a Task, Artifact, created event, Agent run, or linked GitHub Issue.
4. User input and Agent evidence remain distinguishable by Artifact type.
5. Existing tasks and requests without `attachments` behave unchanged.
6. Web and desktop expose the same request validation, persisted metadata, read behavior, and errors.

## Scope

The first version supports attachments in the manual Kanban task creation modal. The bounded Team
Run launch extension is defined later in this document; it deliberately uses the ACP prompt chain
instead of the task Artifact lifecycle.

Supported text:

- `.txt`, `.md`, `.mdx`, `.json`, `.yaml`, `.yml`, `.csv`, `.log`
- source: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.rs`, `.go`, `.java`, `.kt`,
  `.swift`, `.c`, `.h`, `.cpp`, `.hpp`, `.cs`, `.rb`, `.php`, `.sh`, `.sql`
- configuration/styles: `.toml`, `.ini`, `.conf`, `.properties`, `.xml`, `.css`, `.scss`

Extension matching is case-insensitive. Extensionless UTF-8 text files such as `Dockerfile` or
`LICENSE` are allowed. Any other extension is rejected even if its bytes happen to decode as text;
this keeps SVG, HTML, and future media formats outside the MVP.

Supported images:

- PNG
- JPEG
- WebP

Limits:

| Limit | Value |
|---|---:|
| Total files per task | 5 |
| Images per task | 3 |
| Text file size | 256 KiB |
| Image file size | 2 MiB |
| Total decoded attachment size | 6 MiB |
| Filename length | 255 characters |

The client validates for immediate feedback. Both backends repeat the validation and reject the
entire task creation request if any attachment is invalid.

## Non-goals

- Adding, replacing, or deleting attachments after task creation.
- Uploads from Chat, Notes, Team Run messages after launch, or other surfaces.
- PDF, Office, archives, SVG, GIF, audio, or video.
- OCR, media conversion, embeddings, indexing, or virus-scanning services.
- Guaranteed image understanding across Agent providers.
- Copying attachments into a repository or worktree.
- Syncing attachment contents to GitHub Issues.
- General-purpose or large-file storage.

## Artifact contract

Add `attachment` to the TypeScript, Rust, UI, and API read models for `ArtifactType`:

```ts
type ArtifactType =
  | "screenshot"
  | "test_results"
  | "code_diff"
  | "logs"
  | "canvas"
  | "attachment";

type EvidenceArtifactType = Exclude<ArtifactType, "attachment">;
type AgentWritableArtifactType = "screenshot" | "test_results" | "code_diff" | "logs";
```

No database migration is required. Every current Artifact store persists `type` as text, and
`providedByAgentId` is nullable.

An attachment uses the existing Artifact fields:

```json
{
  "type": "attachment",
  "taskId": "task-id",
  "workspaceId": "workspace-id",
  "status": "provided",
  "content": "text or base64",
  "context": "Input attachment supplied when the task was created",
  "metadata": {
    "filename": "prototype.png",
    "mediaType": "image/png",
    "encoding": "base64",
    "size": "184200",
    "source": "user"
  }
}
```

Text uses `encoding=utf8`; images use `encoding=base64`. The backend derives trusted media type and
decoded size. `providedByAgentId` stays empty because the source is the user.

Each attachment receives its own UUID. Persist metadata only after validation and derive the media
type from decoded content. `size` is a decimal string because the existing Artifact metadata contract
is `Record<string, string>` / `BTreeMap<String, String>`.

### Write boundary

`attachment` is not an Agent-creatable Artifact type.

The task creation route writes attachments directly through `ArtifactStore`. The following existing
Agent evidence creation paths must continue to reject `type=attachment`:

- MCP `provide_artifact` schemas and executors;
- `POST /api/tasks/{taskId}/artifacts`;
- Rust RPC `tasks.provideArtifact`;
- Rust REST Artifact creation validation.

Read paths may accept `attachment`: task Artifact GET, MCP `list_artifacts`, and MCP `get_artifact`.
If `api-contract.yaml` uses a shared Artifact type for reads, evidence-write requests must use an
explicit evidence-only enum rather than inheriting `attachment`.

Do not weaken this boundary with a special Agent ID such as `"user"`. A missing
`providedByAgentId` is the persisted source distinction, and attachment writes exist only inside
task creation.

### Evidence boundary

`attachment` never counts as delivery evidence and can never be configured as a required transition
Artifact.

The implementations that build evidence summaries must filter it out:

- `src/core/kanban/task-derived-summary.ts`;
- `crates/routa-server/src/api/tasks/evidence.rs`, including its batch variant;
- `crates/routa-core/src/models/task.rs`.

`src/core/kanban/completion-fallback-artifact.ts` must check for existing evidence Artifacts, not
merely any Artifact. Rust required-Artifact validation must explicitly reject `attachment` even
though the domain enum can parse it.

Task cards and the Evidence Bundle prompt continue to report evidence-only totals. Task detail shows
attachments in a separate `Input attachments` group.

## Task creation API

Extend the existing JSON request:

```ts
interface CreateTaskAttachmentInput {
  filename: string;
  contentBase64: string;
}

interface CreateTaskRequest {
  // Existing fields remain unchanged.
  attachments?: CreateTaskAttachmentInput[];
}
```

Backend validation:

- sanitize path components and control characters from the filename;
- derive byte sizes instead of trusting the client;
- strictly decode raw Base64 and reject a `data:` URL prefix;
- reject invalid UTF-8, NUL bytes, or disallowed control characters in text;
- validate PNG, JPEG, and WebP magic bytes and derive the media type;
- enforce all count and size limits before writing the task.

Validation is intentionally format-level, not content-aware:

```text
for each attachment
  sanitize filename
  strictly decode contentBase64 to original bytes
  if bytes match an allowed image signature
    require a compatible image filename extension
    derive image media type
    persist content as normalized Base64 with encoding=base64
  otherwise
    reject filenames with an image or unsupported extension
    decode bytes as UTF-8 without replacement
    reject NUL and C0 controls other than tab, LF, and CR
    derive a known text media type or use text/plain
    persist decoded text with encoding=utf8
  enforce per-file and aggregate decoded-byte limits
  construct trusted Artifact metadata
```

Do not parse JSON/YAML, re-encode images, strip EXIF, or inspect source syntax. Those operations are
not required to establish a safe bounded attachment.

Both validators produce the same normalized shape before persistence:

```ts
interface NormalizedTaskAttachment {
  filename: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}
```

The route converts this normalized value into an Artifact with a generated ID, fixed context,
`status=provided`, empty `providedByAgentId`, and trusted string metadata. Keep Artifact construction
near the task-create application flow; do not expose the normalizer as a generic upload API.

### Error contract

Attachment validation failures return HTTP 400 in the existing JSON error shape:

```json
{
  "error": "Invalid task attachment"
}
```

Validators may use an internal reason enum for focused tests, but it is not a new public API. The UI
provides specific localized feedback from its preflight checks and maps any backend attachment 400
to a generic localized invalid-attachment message. Persistence failure returns the existing generic
HTTP 500 task creation error; it does not expose file content, database errors, or filesystem paths.

### API contract changes

Update `api-contract.yaml` in the same change:

- add `attachment` to the Artifact read type;
- add an evidence-write type that contains only `screenshot`, `test_results`, `code_diff`, and
  `logs`;
- use the evidence-write type for `provideTaskArtifact`;
- add optional `attachments` to the task-create request schema;
- document Base64 as raw file bytes without a `data:` prefix;
- document the count and decoded-size limits;
- document the HTTP 400 attachment validation response.

The new request field is optional, so existing API clients remain compatible. Do not change the Task
response schema merely to expose attachments.

The response keeps the existing Task shape. Attachments are fetched through the existing task
Artifact endpoint instead of being duplicated on every Task response.

### Request size

Six MiB of decoded attachments can produce approximately eight MiB of Base64. The Rust/Axum
task-create route therefore gets a route-local 10 MiB request-body limit. Do not apply this limit
globally. The Next.js route already reads the request body directly and needs no separate body-limit
configuration.

## Creation ordering

Validation completes before any write.

### Next.js

```text
validate task and attachments
  -> construct and save Task without external side effects
  -> save attachment Artifacts
  -> create the optional linked GitHub Issue and save updated Task fields
  -> emit the task-created event
  -> processKanbanColumnTransition when enabled
  -> return Task
```

Attachment persistence belongs between `taskStore.save` and `processKanbanColumnTransition` in
`src/app/api/tasks/route.ts`. Move the task-created event after attachment persistence so a failed
request cannot publish a task that is immediately rolled back.

Move optional GitHub Issue creation after attachment persistence as well. Otherwise an attachment
write failure can leave a remote Issue for a rolled-back Task. GitHub failure remains non-fatal and
is recorded through the existing `lastSyncError` behavior. Attachment content is never added to the
Issue body.

### Rust/Axum

The current Rust create handler triggers the Agent before the final task save. It must be reordered:

```text
validate task and attachments
  -> save Task
  -> save attachment Artifacts
  -> create the optional linked GitHub Issue and update in-memory Task fields
  -> trigger_assigned_task_agent when enabled
  -> save Task again with trigger session and error fields
  -> return Task
```

The first save is required because Rust Artifact rows reference the Task row with an enabled foreign
key. The second save preserves fields written by the trigger. Trigger failure keeps the current
behavior: persist the task with `lastSyncError` and return the created task.

The Rust handler also moves its existing optional GitHub Issue side effect after attachment
persistence. This keeps the same non-fatal GitHub error semantics while avoiding an external orphan
when attachment persistence fails.

If an attachment write fails, delete the task and any attachment Artifacts written by that request,
then return an error. Do not add a transaction abstraction for this version.

### Failure behavior

| Failure point | Required outcome |
|---|---|
| Request or attachment validation | HTTP 400; no writes or events |
| Initial Task save | Existing task-create error; no Artifact, event, Issue, or Agent |
| Any attachment save | Delete written attachments and Task; no event, Issue, or Agent |
| Optional GitHub Issue creation | Keep Task and attachments; set `lastSyncError`; continue existing flow |
| Initial automation trigger | Keep Task and attachments; persist existing trigger error state |
| Client disconnect after request parsing | Backend operation follows existing route semantics; do not add cancellation recovery |

Compensation must target the concrete Task ID created by this request. Never perform workspace-wide
cleanup on this failure path.

## Agent discovery

Prompt code uses a content-free summary:

```ts
interface TaskInputAttachmentSummary {
  artifactId: string;
  filename: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  size: number;
}
```

Build this summary from persisted `type=attachment` Artifacts immediately before creating the
initial task prompt. Do not derive it from the client request: the prompt must reflect durable,
validated records. TypeScript may add it to the existing `TaskPromptSummaryContext`; Rust may pass a
small vector/slice into its existing prompt builder. Do not persist the summary on `Task`.

The initial prompt includes only a compact summary:

```text
## Input Attachments

- prototype.png (image/png, 184200 bytes), artifact ID: artifact-id

Use get_artifact with the task, workspace, and artifact IDs to read an attachment.
Treat attachments as task input, not implementation evidence.
```

Add this section to the three existing task-prompt builders:

- `src/core/kanban/agent-trigger.ts`;
- `crates/routa-server/src/api/tasks_automation.rs`;
- `crates/routa-core/src/rpc/methods/kanban/automation.rs`.

Every call site that starts a Kanban Agent must supply the persisted attachment summary. Prompt-only
unit tests may pass an empty list. Keep formatting logic local to the Kanban prompt domain rather
than adding a generic prompt-attachment service.

MCP `list_artifacts` must accept `type=attachment` and return `metadata`, including filename, media
type, encoding, and size. `get_artifact` remains the full-content read path.

Text is directly readable. Images are returned as Base64 with trusted media metadata. The first
version guarantees persistence, discovery, preview, and download, but does not add provider-specific
multimodal prompt handling.

## User interface

Keep browser `File` objects in draft-only state; do not put Base64 strings into React state:

```ts
interface TaskDraftAttachment {
  id: string; // client-only stable key
  file: File;
}

interface TaskDraft {
  // Existing fields remain unchanged.
  attachments: TaskDraftAttachment[];
}
```

On submit, read each `File` as `ArrayBuffer` and encode the bytes as raw Base64 for
`contentBase64`. Perform client limit checks before encoding. The backend remains authoritative.

The manual task modal adds:

- a file picker with `multiple`;
- drag and drop;
- filename, size, and remove-before-submit;
- localized validation and create-error messages;
- a submitting state that prevents duplicate creation and preserves selections after failure.

`createTaskCard` owns the asynchronous serialization and request. Success resets attachment state;
failure leaves the modal, text draft, and selected `File` objects intact. Closing/cancelling the
modal follows the existing draft policy and does not make a network request.

Add i18n strings for the attachment label, choose/drop hint, remove action, limits, unsupported
format, invalid file, submitting state, and generic create failure. Do not render backend English
validation text directly to the user.

Task detail adds a separate `Input attachments` group:

- text uses the existing code viewer and a download action;
- PNG, JPEG, and WebP use a validated `data:` URL and a download action;
- image rendering checks `type=attachment`, trusted MIME type, and valid Base64;
- attachments are not rendered through the delivery `screenshot` branch.

Within `KanbanCardArtifacts`, split the fetched list once:

```ts
const inputAttachments = artifacts.filter((item) => item.type === "attachment");
const evidenceArtifacts = artifacts.filter((item) => item.type !== "attachment");
```

Coverage chips, required-Artifact checks, and evidence empty states use `evidenceArtifacts` only.
The input group uses `inputAttachments`. Text download uses a UTF-8 `Blob`; image download decodes
Base64 into a typed `Blob`. Revoke temporary object URLs after use. Do not add a download API in the
first version.

## Storage and read behavior

- Content remains inline in the existing Artifact `content` column.
- Text is stored as decoded UTF-8; images are stored as normalized Base64 without a `data:` prefix.
- Task list and Task create responses do not inline attachments.
- `GET /api/tasks/{taskId}/artifacts` continues to return full Artifact content for task detail.
- MCP `list_artifacts` returns metadata and content length but not content.
- MCP `get_artifact` returns the selected full content.
- Existing newest-first Artifact ordering remains unchanged.
- There is no deduplication, checksum contract, retention policy, or compression in this version.

Returning full task-detail content is an accepted tradeoff under the 6 MiB decoded limit. Do not add
pagination, signed URLs, or a second content endpoint for this release.

## Security boundary

- Attachment APIs inherit existing Task/workspace access control; do not add a public file route.
- `get_artifact` keeps its existing task and workspace ownership checks.
- Never execute attachment content or interpolate it into HTML.
- Never include content or Base64 in logs, traces, events, or error responses.
- Image previews use only the three derived MIME types; client metadata cannot select a `data:` MIME.
- Attachment text is untrusted user input when shown to an Agent. The prompt labels it as input and
  does not treat instructions inside a file as Routa system policy.
- Filenames are display metadata only and are never joined to a filesystem path.

## Deletion

Rust uses the existing `tasks -> artifacts` foreign-key cascade.

Next.js Postgres, SQLite, and in-memory Task stores do not have that cascade. Both Web task deletion
paths must explicitly remove Artifacts:

- single-task deletion calls `artifactStore.deleteByTask(taskId)`;
- workspace deletion lists the affected tasks and deletes their Artifacts before deleting tasks.

This also fixes cleanup for existing evidence Artifacts; no new cleanup service is needed.

## Implementation map

| Concern | Primary files |
|---|---|
| Modal and draft | `kanban-create-modal.tsx`, `kanban-tab.tsx` |
| Validation/normalization | one focused TS task-domain module and `crates/routa-server/src/api/tasks/attachments.rs` |
| Web create/delete API | `src/app/api/tasks/route.ts`, `src/app/api/tasks/[taskId]/route.ts` |
| Web Artifact model/tools | `src/core/models/artifact.ts`, `src/core/tools/agent-tools.ts`, `src/core/mcp/mcp-tool-executor.ts`, `routa-mcp-tool-manager.ts` |
| Web evidence isolation | `task-derived-summary.ts`, `completion-fallback-artifact.ts` |
| Rust request and orchestration | `crates/routa-server/src/api/tasks/dto.rs`, `handlers.rs` |
| Rust Artifact and evidence | `crates/routa-core/src/models/artifact.rs`, Artifact store/RPC methods, server `evidence.rs` |
| Rust MCP boundary | `crates/routa-server/src/api/mcp_routes/tool_catalog.rs`, task tool executor |
| Prompt discovery | the three task-prompt builders listed above |
| Detail rendering | `kanban-card-artifacts.tsx`, workspace `types.ts` |
| Contract | `api-contract.yaml` |

Do not introduce a generic upload abstraction or new top-level domain object.

## Recommended implementation sequence

Keep each slice reviewable and behavior-complete:

1. **Contracts and types:** add the attachment read type, evidence-only write type, create-request
   DTOs, UI type, and API contract.
2. **Validation:** add one task-attachment validation/normalization module per backend. These are
   task-domain modules, not generic upload frameworks. Each returns normalized Artifact inputs so
   route handlers do not duplicate Base64, magic-byte, filename, and limit rules.
3. **Persistence ordering:** implement Web and Rust create flows, compensation, GitHub side-effect
   ordering, event ordering, and Axum route limit.
4. **Evidence isolation:** update all three evidence-summary implementations, completion fallback,
   and required-Artifact validation.
5. **MCP and prompts:** expose attachment metadata on reads, keep writes closed, and update all three
   prompt builders from persisted summaries.
6. **UI:** add draft selection/serialization/error states and task-detail rendering.
7. **Deletion:** add explicit Web Artifact cleanup and verify Rust cascade behavior.
8. **Verification:** run focused tests, contract checks, then normal fitness validation.

Do not begin UI work by inventing a temporary endpoint. The Task create contract is the only upload
entry point in this design.

## Verification

Required behavior tests:

1. Creating a task without attachments follows the unchanged path.
2. Valid text and image attachments persist in both backends before initial automation starts.
3. Invalid count, size, Base64 content, filename, UTF-8, or image signature rejects the whole request.
4. `list_artifacts` returns attachment metadata and `get_artifact` returns its content.
5. Agent evidence-write APIs reject `type=attachment` in both backends.
6. Attachments do not affect evidence totals, transition gates, or completion fallback.
7. Rust accepts a valid request above its previous 2 MiB default and rejects one above 10 MiB.
8. Task detail safely renders text and validated static images.
9. Single-task and workspace deletion remove attachments in Web; Rust deletion cascades.
10. A simulated attachment-save failure leaves no task or Artifact records and starts no Agent.

Minimum test placement:

| Layer | Coverage |
|---|---|
| TypeScript unit | validator/normalizer, evidence filtering, completion fallback, prompt formatting |
| Next.js route | valid create, every validation reason, compensation, event/trigger ordering, delete cleanup |
| Rust unit/API | validator parity, FK-safe create order, 10 MiB route limit, evidence/gate filtering, cascade |
| MCP | list metadata, get content, evidence-write rejection |
| React | selection/removal, limit feedback, duplicate-submit prevention, failure retention, safe rendering |
| Contract | optional create field, attachment read enum, evidence-only write enum, error response |

Use small generated fixtures in tests. Do not commit screenshots or large binary fixtures; construct
minimal PNG/JPEG/WebP signature fixtures in test code or ignored temporary paths.

Run focused TypeScript and Rust tests, API contract validation, and `entrix run --tier normal` because
the change affects shared APIs and workflow orchestration.

## Definition of done

The feature is complete only when:

- the same valid request produces equivalent attachment records in both backends;
- invalid requests produce matching HTTP status and no-write behavior;
- attachment records are visible before the first automated prompt is dispatched;
- no Agent evidence API can create an attachment;
- evidence totals and gates are unchanged by input attachments;
- task detail can preview/download every supported attachment;
- deleting the owning Task removes its attachments in every store;
- existing no-attachment task creation tests remain green;
- `api-contract.yaml`, focused tests, and normal `entrix` validation pass.

## Team Run initial input extension

### Decision and boundary

The Team page may attach local text files and static images only while launching a new top-level
Team Run. This is an input-composer feature, not a second task-attachment feature.

The extension:

- uses the same supported formats, filename rules, file count, image count, and decoded-size limits
  defined above;
- adds file picker, drag-and-drop, selected-file list, removal, and localized errors to the Team
  launch input;
- sends attachments with the first Team Lead prompt through ACP content blocks;
- keeps the existing `@` behavior for files already present in the selected repository;
- is opt-in for the Team launch mode and does not expose local attachment controls on Home, Chat,
  Notes, an existing Team Run, or other `HomeInput` consumers.

Do not create a Task, synthetic Artifact, upload endpoint, database table, object-store abstraction,
or repository copy for this extension. Team launch attachments do not count as evidence and do not
appear in the Kanban attachment UI.

Team launch attachments are one-turn input. They are not a durable file library: after the first
prompt is accepted, the temporary browser copy is removed. Reloading the Team Run does not provide
an attachment preview or download. The Agent conversation may retain the provider's normal prompt
history, but Routa does not add separate attachment retention in this version.

### Existing problem to correct

`TiptapInput` currently uses `@` to search the selected repository through `/api/files/search`.
That is a repository file reference, not a local upload. `HomeInput` currently drops
`InputContext.files` when it builds the first prompt, so even the repository references are not
delivered to the Team Lead.

The implementation must distinguish these concepts:

```ts
interface RepositoryFileReference {
  path: string;
  label: string;
}

interface LocalInputAttachment {
  id: string;       // browser-only stable key
  file: File;
}
```

Repository references remain `@` mentions. Local attachments use an explicit paperclip/file-picker
control; do not overload the `@` search dropdown with files from the user's computer.

### UI and shared validation

Add an opt-in attachment capability to the existing launcher configuration. The Team launch mode
enables it; all other modes default to disabled. Keep `File` objects in local component state and
serialize only when the user sends.

Reuse one client attachment-draft helper for the Kanban modal and Team launcher. If necessary, move
the existing draft helper from the Kanban route folder into `src/client/utils/`; do not duplicate
the extension, size, Base64, image-signature, or filename rules. The picker must permit
extensionless files such as `Dockerfile` and `LICENSE`, so backend/client validation remains the
format authority.

The Team launcher must support:

- selecting multiple files and drag-and-drop;
- filename and decoded size display;
- removing a file before send;
- preserving the text and selected files when preflight or launch preparation fails;
- disabling attachment mutation and duplicate send while launching;
- clearing the draft only after the Team session and pending first prompt are prepared.

The send button still requires non-empty request text. An attachment by itself does not launch a
Team Run.

### Navigation-safe handoff

Team creation navigates before sending its pending first prompt. Do not put Base64 or `File` objects
in `sessionStorage`; the existing limits can exceed its quota.

Use a small IndexedDB helper for the temporary handoff:

```ts
interface PendingTeamAttachmentRecord {
  transferId: string;
  createdAt: number;
  attachments: File[];
}

interface PendingPromptPayload {
  // Existing fields remain unchanged.
  attachmentTransferId?: string;
  repositoryFiles?: RepositoryFileReference[];
}
```

Prepare and validate the temporary record before creating the session. After session creation,
store only its opaque `transferId` and repository references in the pending-prompt payload, then
navigate normally. If session creation fails, delete the temporary record and keep the UI draft.
Records older than 30 minutes are removed when the helper opens. Successful first-prompt delivery
deletes the record. A send failure keeps it for Retry/Resume until the TTL expires.

The transfer ID is random and is never accepted as a filesystem path. Attachment names are display
metadata only.

### First prompt construction

Extend the browser ACP client and `useAcp.promptSession` to accept `ContentBlock[]` while preserving
the existing text overload. Build the initial Team prompt in this order:

1. one text block containing the user's request;
2. a compact `Repository files` text section containing normalized paths from `@` mentions;
3. text attachments as ACP embedded text resources with a synthetic
   `routa-team-input://<transferId>/<index>` URI;
4. PNG, JPEG, and WebP attachments as ACP `image` blocks using normalized raw Base64 and trusted
   media type.

Text and image bytes must pass the same strict normalization used by Kanban attachments immediately
before content-block construction. Do not put attachment Base64 in logs, errors, visible prompt
text, pending-prompt JSON, or session names.

The repository section contains paths only. Because Team mode requires a selected repository and
the Agent runs with that repository as `cwd`, the Team Lead can read those files through its normal
filesystem tools. Reject any repository reference outside the selected repository instead of
embedding its contents.

### ACP and provider behavior

Both Next.js and Rust `session/prompt` routes must preserve validated prompt content blocks instead
of flattening the request to text at the transport boundary. Existing text-only callers continue to
send exactly one text block and behave unchanged.

Provider dispatch follows these rules:

- standard ACP providers receive the supported `ContentBlock[]` unchanged;
- embedded text resources may be converted to clearly delimited text only in an adapter that does
  not support embedded context;
- image blocks may be sent only when that provider path supports ACP image input;
- if the selected provider cannot accept every selected image, fail before launching with a
  localized unsupported-provider message; never silently drop an image or replace it with Base64
  text.

Expose or retain the initialized ACP prompt capability needed for this check. Do not add
provider-name allowlists to React components. Provider-specific conversion belongs in the existing
ACP adapter boundary.

The Rust route currently extracts only text blocks, and the TypeScript provider paths largely pass
plain strings. Updating these boundaries is required for image support; changing only the file
picker is not a complete implementation.

### Failure behavior

| Failure point | Required outcome |
|---|---|
| Client selection/preflight | No session; keep request text and accepted files; show localized error |
| IndexedDB preparation | No session; keep draft; show generic attachment preparation error |
| Session creation | Delete temporary transfer; keep draft; use existing launch error behavior |
| Pending payload storage/navigation | Keep temporary transfer and surface retry; do not send a text-only prompt |
| First prompt validation/provider capability | Do not send a partial prompt; preserve transfer for retry |
| First prompt accepted | Delete temporary transfer and clear pending payload |

No compensation API is added for a session that was created but whose prompt has not yet been
accepted. It remains an empty recoverable Team session under existing session lifecycle behavior.

### Implementation map

| Concern | Primary files |
|---|---|
| Team opt-in and launch | `team/team-page-client.tsx`, `src/client/components/home-input.tsx` |
| Picker/draft UI | `src/client/components/tiptap-input.tsx` and a shared client attachment helper |
| Temporary handoff | `src/client/utils/pending-prompt.ts` plus one focused IndexedDB helper |
| Team pending consumption | `team/[sessionId]/team-run-page-client.tsx` |
| Browser ACP content blocks | `src/client/acp-client.ts`, `src/client/hooks/use-acp.ts` |
| Web prompt dispatch | `src/core/acp/session-prompt.ts` and existing provider adapters |
| Rust prompt dispatch | `crates/routa-server/src/api/acp_routes.rs` and `crates/routa-core/src/acp/` |
| Localization | existing English/Chinese i18n dictionaries and types |

Do not change `POST /api/tasks`, the Artifact schema, task evidence logic, or Kanban persistence as
part of this extension except for moving/reusing client-only draft helpers.

### Verification

Minimum required coverage:

1. Team mode shows the local attachment control; other `HomeInput` modes do not.
2. Text, PNG, JPEG, WebP, and extensionless UTF-8 files pass; existing count/size/signature failures
   are shown before session creation.
3. `@` repository references survive launch and appear as readable paths in the first prompt.
4. Pending prompt JSON contains only transfer metadata, never file content or Base64.
5. Navigation consumes the IndexedDB transfer exactly once; success deletes it and failure retains
   it for retry.
6. Web and Rust preserve text resource and image blocks through `session/prompt`.
7. A provider without image capability rejects the launch without sending a partial prompt.
8. Existing text-only Home, Chat, Session, and Team launches remain unchanged.

Add focused Vitest tests for the launcher, pending transfer, first-prompt construction, and Web ACP
route. Add Rust unit/API tests for content-block preservation and unsupported-image behavior. Run
`npm run api:check`, focused tests, and `entrix run --tier normal` because this changes shared ACP
prompt orchestration.

The Team extension is complete when a user can select supported local text or image files on the
Team page, launch once, and the Team Lead receives every selected input in the same first prompt
without any content being silently discarded.

## Review disposition

The 2026-08-12 review concluded “implementable after correction.” This revision incorporates its
three blocking findings: explicit Web cleanup, Rust create-handler reordering, and preventing Agents
from creating user-input attachments. Larger storage and multimodal extensions remain deferred.
