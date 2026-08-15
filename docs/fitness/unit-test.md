---
dimension: testability
weight: 20
tier: normal
threshold:
  pass: 80
  warn: 70
  block: 0  # 测试失败直接阻断

metrics:
  - name: ts_test_pass
    command: npm run test:run:fast 2>&1
    pattern: "Tests\\s+(\\d+)\\s+passed"
    hard_gate: true
    tier: fast

  - name: ts_test_pass_full
    command: npm run test:run 2>&1
    pattern: "Tests\\s+(\\d+)\\s+passed"
    hard_gate: true
    tier: normal

  - name: ts_test_coverage
    command: npm run test:cov:ts 2>&1
    tier: normal
    description: "Vitest V8 line coverage must stay at or above 80%."

  - name: rust_test_pass
    command: cargo test --workspace --exclude routa-desktop 2>&1
    pattern: "test result: ok"
    serial: true
    hard_gate: true
    tier: normal

  - name: graph_test_radius_probe
    command: entrix graph test-radius --json
    tier: normal
    execution_scope: ci
    gate: advisory
    kind: holistic
    analysis: static
    evidence_type: probe
    scope: [web, rust]
    run_when_changed:
      - src/**
      - apps/**
      - crates/**
    description: "通过代码图估算 changed targets 的测试半径；图后端缺失时跳过不计分"

  - name: graph_test_mapping_probe
    command: entrix graph test-mapping --no-graph --json
    tier: normal
    execution_scope: local
    gate: advisory
    kind: holistic
    analysis: static
    evidence_type: probe
    scope: [web, rust, java]
    run_when_changed:
      - src/**
      - apps/**
      - crates/**
    description: "检查 changed source file 是否存在对应测试映射；TS/JS/Java 走路径规则，Rust 允许 inline test 或弱断言 unknown"
---

# 单元测试与集成测试证据

> 本文件记录测试条目的验证状态，作为 testability 维度的证据来源。

## 适用范围
- `routa-core`, `routa-server` 为本版主线；`routa-cli`, `routa-rpc` 在联动改动时同步纳入。

## 评估目标
- 用例以“行为正确性”计分，不以文件字数或命令日志计分。
- 每条规则有固定状态，禁止快照式增量字段（`delta` / `phase` / `current`）作为进度依据。

## 规则清单（逐项可验）

### 单元测试（`routa-core`）
- [ ] store: workspace
  - status: `TODO`
  - required: CRUD、查询过滤、归档状态一致性
  - evidence:
- [ ] store: codebase
  - status: `TODO`
  - required: 唯一性、默认配置、文件索引兼容性
  - evidence:
- [ ] store: task
  - status: `TODO`
  - required: 状态流转、列映射、并发冲突边界
  - evidence:
- [ ] store: agent
  - status: `TODO`
  - required: 创建/状态更新/不可变字段保护
  - evidence:
- [ ] store: session
  - status: `VERIFIED`
  - required: 任务归属、状态持久化、DB → local JSONL fallback、session transcript/history hydration
  - evidence: `src/core/__tests__/session-history.test.ts`, `src/client/components/chat-panel/hooks/__tests__/use-chat-messages.test.tsx`, `src/app/api/acp/__tests__/route.test.ts`, `src/app/api/sessions/[sessionId]/history/__tests__/route.test.ts`
- [ ] workflow/规则映射层
  - status: `TODO`
  - required: 列表/状态转换边界、冲突校验（如同 ID/非法状态）
  - evidence:

### 单元测试（`routa-server`）
- [ ] error contract helpers
  - status: `TODO`
  - required: 错误分类与状态码映射一致性
  - evidence:
- [x] application/use-case: tasks
  - status: `VERIFIED`
  - required: task 创建默认值推导、标签清洗、状态/列一致性校验、retry trigger 行为
  - evidence: `crates/routa-server/src/application/tasks.rs`
- [x] application/use-case: sessions
  - status: `VERIFIED`
  - required: 内存/数据库 session 合并、workspace/parent 过滤、context 构建、history fallback 与缓存
  - evidence: `crates/routa-server/src/application/sessions.rs`
- [ ] 参数校验器 / 清洗函数
  - status: `TODO`
  - required: 空值、非法类型、越界输入
  - evidence:
- [x] 轻量 handler-level 辅助逻辑
  - status: `VERIFIED`
  - required: 会话历史 chunk 合并逻辑正确性
  - evidence: `crates/routa-server/src/api/sessions.rs`

### 集成测试（与 API 行为强绑定）
- [x] notes 流程
  - status: `VERIFIED`
  - required: create/list/get/delete 的成功/失败闭环
  - evidence: `docs/fitness/rust-api-test.md`
- [x] tasks 流程
  - status: `VERIFIED`
  - required: create/update/status/list/delete + 无效状态更新
  - evidence: `docs/fitness/rust-api-test.md`
- [x] codebase/files 流程
  - status: `VERIFIED`
  - required: create/update/delete/search + 文件元数据一致性
  - evidence: `docs/fitness/rust-api-test.md`
- [x] agents 流程
  - status: `VERIFIED`
  - required: list/get/create/delete + invalid status handling
  - evidence: `docs/fitness/rust-api-test.md`
- [x] sessions 流程
  - status: `VERIFIED`
  - required: get/list/polling + 生命周期错误场景
  - evidence: `docs/fitness/rust-api-test.md`

## 一致性要求
- 同一业务行为修改，必须在本文件添加 `status=VERIFIED` 条目并写明测试文件路径。
- 阻塞项统一标记为 `BLOCKED`，并写明阻塞原因与负责人。
- 删除/关闭的规则项后需保留审计历史（可在 issue 记录中补充）。

## 近期优先级
- P0: `acp` / `agents` / `sessions` / polling 的 API 行为测试补齐
- P1: `agent` 与 `session` 错误状态回归
- P2: `task` 与 `codebase` 关键边界场景复测

## Common Failures (High Frequency)

- 状态不一致：`task.status` 与 `columnId` 不匹配
  - 对应修正：统一入口校验，添加冲突用例并固定错误信息
- 外部依赖触发失败导致超时/抖动
  - 对应修正：测试时优先隔离外部依赖，避免真实网络请求影响核心路径
- DB 状态污染
  - 对应修正：每个测试独立数据库（临时 db_path）并确保销毁
- 文件系统副作用未清理
  - 对应修正：临时目录/文件在 `Drop` 或测试尾部清理
- 查询参数命名不一致（camelCase / snake_case）
  - 对应修正：接口文档与用例字段统一验证

## This Batch
- 新增：`crates/routa-server/tests/rust_api_end_to_end.rs`
- 入口文件：`docs/fitness/rust-api-test.md`
- 下一个批次：补 `acp / agents / sessions / polling` 用例与健康检查场景

## Team Run Deletion (Web)

- `src/core/orchestration/__tests__/team-run-identity.test.ts`
  - 锁定 Team Run 身份识别规则：显式标记（team-agent-lead / ROUTA + team 名称）、parentSessionId 树收集（含环保护）、根判定（顶层 + 标记或 ROUTA 有后代）。
- `src/core/orchestration/__tests__/team-run-deletion.test.ts`
  - 锁定删除服务安全边界：空 team、多级子会话、先停活进程再删数据、无法停止时零变更中止、runner 会话拒绝、仅删除 team 专属看板卡、共享 worktree/卡片保留、非 team 根/跨 workspace 拒绝、sqlite 单事务删除路径。
  - 锁定卡片所有权矩阵（`teamRunId` 为权威来源，Session 执行历史不得覆盖）：显式 Team-owned 卡片在无 Session 引用、仅有不存在 Session、关联存活但无 Team 父级的 lane Session、同时关联树内与树外存活 Session 时均删除；显式属于其他 Team 的卡片即使关联待删树也保留；无 `teamRunId` 的历史卡片仅按 Team Session 树保守推断（仅树内引用删除、树内+树外存活 Session 保留为共享、无树内引用保留）；Artifact 仅随实际删除的卡片删除；共享 Worktree 继续受存活卡片保护；preview 的 explicit/legacy/preserved 计数与实际删除计划一致。
- `src/app/api/team-runs/__tests__/route.test.ts`
  - 锁定 `DELETE /api/team-runs/:rootSessionId` 与 `GET /api/team-runs/:rootSessionId/preview` 的语义响应：成功计数、404/409/422/500 错误码映射、预览 no-store。
  - 锁定显式所有权回归：`teamRunId` 指向待删 Team 根、且唯一存活 Session 为无 Team 父级 lane Session 的卡片，会在 DELETE 中实际删除并计入 preview 的 `explicitKanbanCards`。
- `src/app/workspace/[workspaceId]/team/__tests__/delete-team-run-dialog.test.tsx`
  - 锁定删除确认对话框：预览统计展示、输入 DELETE/Team 名才可确认、取消、runner 阻断、删除/预览失败的本地化错误。

## Team Task Lifecycle / Kanban Consistency (Web + Rust)

锁定 design doc `docs/design-docs/team-task-lifecycle-consistency.md` 的两个问题：
Team 子 Agent 已创建 Task/Agent/子 Session 时，Team 任务树与看板卡片必须立即可见且 Session 可读；
终态 Task（COMPLETED/BLOCKED）无论 `columnId` 为空还是过期，都必须显示在语义终态列且不可再 Run。

### Web

- `src/core/kanban/__tests__/task-status-transition.test.ts`
  - 锁定共享读写规则 `applyTaskStatusTransition` / `resolveEffectiveColumnIdForRead` / `isTaskTerminalForRead`：终态状态优先于列、终态列解析顺序（语义 stage → 字面 id → 保留合法当前列 → Backlog 兜底，永不写幻影列）、NEEDS_FIX 不自动映射列、历史 `COMPLETED + 空 columnId` 读侧投影到 Done。
- `src/app/api/tasks/[taskId]/status/__tests__/route.test.ts`
  - 锁定 `POST /api/tasks/[taskId]/status`：COMPLETED/BLOCKED 一次写入同时落状态与语义终态列；无终态列时保留合法当前列；无 board 上下文回退字面终态 id；非终态状态保留历史 status→column 映射；非法状态与未知任务分别 400/404。
- `src/app/api/tasks/__tests__/route.test.ts`
  - 锁定 `GET /api/tasks?teamRunId=` 过滤优先于其他查询参数，且 `teamRunId` 字段序列化 undefined-safe。
- `src/core/orchestration/__tests__/orchestrator.test.ts`
  - 锁定 delegation 持久化与幂等：绑定 claim 先于激活/派发持久化；claim 前子会话创建失败任务零变更；重复 delegate 复用活跃绑定而不重复 spawn；非活跃绑定不复用；prompt 派发失败保留会话用于诊断并阻塞任务；claim 版本竞态失败时清理新资源（或返回赢家绑定）；持久化异常绝不返回成功；同一任务的并发 delegation 串行化；`sessionId` 永远是创建者会话，子会话去重追加进 `sessionIds`。
- `src/core/tools/__tests__/agent-tools-extended.test.ts`
  - 锁定 AgentTools 终态写入经由统一 transition 落到 board 语义终态列（自定义 done/blocked id、无 board 回退字面 id、NEEDS_FIX 保留列）。
  - 锁定端到端生命周期链：创建 Team Task → 委托绑定持久化 → `buildTeamTaskTree` 立即出现带子 Session 的卡片 → `getPreferredTaskSessionId` 显示子 Session → `hasActiveTaskSession` 仅在运行时真实存活时阻断 Run → report 成功后同一 Task COMPLETED 且落在自定义 Done 列、创建者 `sessionId` 不变 → 读侧投影终态（含历史空 columnId 变体）不可再 Run。
- `src/app/workspace/[workspaceId]/kanban/__tests__/kanban-tab-helpers.test.ts`
  - 锁定 Run 门禁与首选 Session 显示分离：`getPreferredTaskSessionId`（triggerSessionId → laneSession → sessionIds 尾）只服务展示；`hasActiveTaskSession` 覆盖任务拥有的全部 Session；`isTaskSessionLive` 中已完成/错误/缺运行时的 Session 一律不 live。
- `src/app/workspace/[workspaceId]/kanban/__tests__/kanban-card.test.tsx`
  - 锁定卡片 Run 门禁矩阵：终态任务（含空/过期 columnId）隐藏 Run；排队任务隐藏 Run；真实存活 Session 隐藏 Run；记录会话已死提供 Rerun；done-stage 列即使 status 滞后也按终态处理。
- `src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-model.test.ts`
  - 锁定 Team 任务树以持久化 Task 为主源（不再依赖 task-shaped Note）：`buildTeamTaskTree` 每个持久化 Task 成为节点、重复 Note 去重、legacy Note 保留层级；`delegated` 归一为 in-progress；delegation 结果解析（结构化字段 / JSON envelope / MCP content / 纯文本 / 正则兜底）。

### Rust

- `crates/routa-core/src/kanban.rs`（inline tests）
  - 锁定与 Web 同名的镜像函数：`apply_task_status_transition` / `resolve_effective_column_id_for_read` / `is_task_terminal_for_read` / `load_task_board` / board-aware `task_to_card`。
- `crates/routa-core/src/orchestration/mod.rs`（inline tests）
  - 锁定 delegation 绑定的 `sessionIds` 去重追加；`handle_report_submitted` 成功报告将任务移到 board 语义 Done 列并写 completion_summary、agent 置 Completed；失败报告置 NEEDS_FIX 且保留原列。
- `crates/routa-core/src/store/task_store.rs`（inline tests）
  - 锁定 `list_by_team_run_is_workspace_scoped` 的 workspace 隔离。
- `crates/routa-server/tests/rust_api_end_to_end.rs::api_tasks_filter_by_team_run_id_with_workspace_isolation`
  - 锁定 `GET /api/tasks?teamRunId=`：正向过滤、响应携带 `teamRunId`、workspace 隔离、未绑定任务不出现、未知 teamRunId 返回空数组。

## Session Persistence / Recovery Characterization

- `src/core/__tests__/session-history.test.ts`
  - 锁定 session history 在 in-memory session metadata 缺失时，仍会使用本地 session 记录里的 `cwd` 去读取 DB / JSONL 历史。
- `src/client/components/chat-panel/hooks/__tests__/use-chat-messages.test.tsx`
  - 锁定 active session 首屏 transcript hydration 的重试行为，避免 live pane 因首轮空历史而停在空白态。
- `src/app/api/acp/__tests__/route.test.ts`
  - 锁定 `session/prompt` 在内存 store 丢失 session 时，仍能用本地持久化 metadata 重建 session。
- `src/app/api/sessions/[sessionId]/history/__tests__/route.test.ts`
  - 锁定 `/api/sessions/:id/history` 的 API fallback，确保 session metadata 与历史读取链路一致。

## Local Folder Import (git optional)

- `src/core/git/__tests__/validate-local-folder.test.ts`
  - 锁定 `validateRepoInput` 本地文件夹语义：任意可读取目录均可导入；git 仓库报告 `isGit`/`isBareGit`；不存在/文件路径/不可读路径分别返回 `not_found`/`not_a_directory`/`not_readable` 且不触发 git 命令；GitHub URL 解析不受影响。
- `src/app/api/clone/local/__tests__/route.test.ts`
  - 锁定 `POST /api/clone/local`：普通目录返回 `git=false` 与空 branch/status 且不调用 `getBranchInfo`/`getRepoStatus`；git 仓库返回完整 branch/status；错误路径返回 400 携带 `errorCode`；bare 仓库、缺失 path 字段、GitHub URL 均被拒绝。
- `src/app/api/workspaces/[workspaceId]/codebases/__tests__/route.test.ts`
  - 锁定 codebase 创建：普通目录返回 201 且成为默认 codebase；git 仓库仍可导入；不存在/文件/不可读路径返回 400 携带 `errorCode` 且不落库；bare 仓库保持拒绝。
- `src/client/components/__tests__/repo-picker.test.tsx`
  - 锁定 RepoPicker 本地文件夹交互：普通目录选择传播 `git=false`；`errorCode` 映射为本地化错误文案；非 git 项目显示「未启用版本管理」并隐藏分支控件；git 项目保留分支控件。
- `crates/routa-server/src/api/repo_context.rs`（inline unit tests）
  - 锁定 `validate_local_folder_path` / `validate_local_project_path`：普通目录通过校验；缺失路径与文件路径被拒绝。

## Kanban Task Input Attachments (Web + Rust)

- `src/core/kanban/__tests__/task-attachments.test.ts`
  - 锁定统一校验/归一化：文件数/图片数/单文件/总量上限、文件名清洗与长度、Base64 严格解码、UTF-8 与控制字符过滤、PNG/JPEG/WEBP 签名与扩展名互斥；`buildTaskInputArtifact` metadata 形状；摘要过滤与 prompt section 格式。
- `src/app/workspace/[workspaceId]/kanban/__tests__/task-attachment-draft.test.ts`
  - 锁定浏览器草稿层：accept 列表、逐文件拒绝原因、跨已选草稿的计数/总量上限、提交时 `arrayBuffer → Base64` 序列化（无 data: 前缀）、本地化错误映射。
- `src/app/workspace/[workspaceId]/__tests__/kanban-create-modal.test.tsx`
  - 锁定创建弹窗附件交互：文件选择/拖拽入草稿、非法扩展本地化反馈、提交中防重复点击、创建失败保留草稿与文件且只显示本地化 `createFailed`。
- `src/app/workspace/[workspaceId]/kanban/__tests__/kanban-card-artifacts.test.tsx`
  - 锁定任务详情渲染：附件与证据分组、附件不计入证据总数/缺口、仅签名推导的 3 种 MIME 可作为 data: URL 图片渲染、不可信 mediaType 不渲染为图片。
- `src/app/api/tasks/__tests__/route.test.ts`
  - 锁定 Web 路由：附件先于自动化触发持久化（transition 时可见）、无附件路径不变、非法附件整体 400 且不落库、持久化失败补偿（删任务、不触发 transition）、workspace 删除逐任务清理附件。
- `src/core/tools/__tests__/agent-tools.test.ts`
  - 锁定 MCP 写边界：`provideArtifact(type=attachment)` 拒绝且不落库；`listArtifacts` 返回 metadata + contentLength（无 content）且可按 attachment 过滤；`getArtifact` 返回完整内容。
- `src/core/mcp/__tests__/mcp-tool-executor.test.ts`
  - 锁定 MCP schema enum：`list_artifacts.type` 含 attachment；`provide_artifact.type` / `request_artifact.artifactType` 保持四个 agent 可写类型。
- `src/core/kanban/__tests__/task-derived-summary.test.ts`、`completion-fallback-artifact.test.ts`、`agent-trigger.test.ts`
  - 锁定证据隔离：证据摘要/总数排除附件、附件不能满足 transition 必需 artifact、仅附件任务仍生成 completion fallback、prompt 的 Input Attachments section 有/无附件两种形态。
- `crates/routa-server/src/api/tasks/attachments.rs`（inline tests）
  - 锁定 Rust validator 与 Web 等价：上限、文件名清洗、签名/扩展名匹配、UTF-8/控制字符、总量预算。
- `crates/routa-server/tests/rust_api_task_artifacts.rs`、`rust_api_mcp_routes.rs`
  - 锁定 Rust API/MCP：附件随任务创建持久化与读回、整体 400 拒绝、10 MiB body limit、删除级联、`tasks.provideArtifact` 拒绝 attachment、MCP tools/call 读暴露与写拒绝（见 `docs/fitness/rust-api-test.md` 端点矩阵）。
