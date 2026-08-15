use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::error::ServerError;
use crate::models::kanban::{
    column_id_to_task_status, task_status_to_column_id, KanbanAutomationStep, KanbanBoard,
};
use crate::models::task::{Task, TaskLaneSessionStatus, TaskStatus, VerificationVerdict};
use crate::state::AppState;
use crate::store::{KanbanStore, TaskStore};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCard {
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    pub status: String,
    pub column_id: String,
    pub position: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub async fn ensure_task_board_context(
    state: &AppState,
    task: &mut Task,
) -> Result<(), ServerError> {
    if task.board_id.is_none() {
        let default_board = state
            .kanban_store
            .ensure_default_board(&task.workspace_id)
            .await?;
        task.board_id = Some(default_board.id);
    }

    if task.column_id.is_none() {
        task.column_id = Some(task_status_to_column_id(&task.status).to_string());
    }

    Ok(())
}

pub fn sync_task_status_from_column(task: &mut Task) {
    task.status = column_id_to_task_status(task.column_id.as_deref());
}

pub fn sync_task_column_from_status(task: &mut Task) {
    task.column_id = Some(task_status_to_column_id(&task.status).to_string());
}

pub fn set_task_column(task: &mut Task, column_id: impl Into<String>) {
    task.column_id = Some(column_id.into());
    sync_task_status_from_column(task);
}

/// Resolve the column of a board that carries a semantic stage (`done`, `blocked`, ...).
/// Shared by review-lane convergence and the terminal status transition so custom
/// boards are matched by stage instead of literal column ids.
pub fn resolve_board_column_id_for_stage(board: &KanbanBoard, stage: &str) -> Option<String> {
    board
        .columns
        .iter()
        .find(|column| column.stage == stage)
        .map(|column| column.id.clone())
}

// ─── Terminal Status Transition ──────────────────────────────────────────
//
// Status transition helpers that keep Task.status and its Kanban projection
// consistent in one write. Every production entry point that can write a
// terminal status on a Kanban-visible task must route through
// `apply_task_status_transition` (or an equivalent store-level operation)
// instead of assigning the status alone.

/// Statuses that map onto a terminal Kanban stage.
pub fn is_terminal_task_status(status: &TaskStatus) -> bool {
    matches!(status, TaskStatus::Completed | TaskStatus::Blocked)
}

/// Resolve the column a terminal status should land on.
///
/// Resolution order:
/// 1. no board context loadable -> literal stage id (legacy fallback);
/// 2. the board column whose semantic stage matches (`done`/`blocked`);
/// 3. a literal `done`/`blocked` column when that column exists on the board;
/// 4. keep the task's current column when it is a valid column of the board
///    (returns `None` so callers preserve it);
/// 5. the board's Backlog column;
/// 6. never write a phantom column id (returns `None`).
///
/// `NeedsFix` intentionally receives no automatic column mapping: it is not a
/// terminal status and its desired board stage is a separate product decision.
pub fn resolve_terminal_column_id_for_status(
    board: Option<&KanbanBoard>,
    status: &TaskStatus,
    current_column_id: Option<&str>,
) -> Option<String> {
    let stage = match status {
        TaskStatus::Completed => "done",
        TaskStatus::Blocked => "blocked",
        _ => return None,
    };

    let Some(board) = board else {
        // No board context can be loaded: fall back to the literal stage id.
        return Some(stage.to_string());
    };
    if board.columns.is_empty() {
        return Some(stage.to_string());
    }

    if let Some(column_id) = resolve_board_column_id_for_stage(board, stage) {
        return Some(column_id);
    }

    if board.columns.iter().any(|column| column.id == stage) {
        return Some(stage.to_string());
    }

    if let Some(current) = current_column_id {
        if board.columns.iter().any(|column| column.id == current) {
            // Preserve the valid current column rather than writing a phantom id.
            return None;
        }
    }

    resolve_board_column_id_for_stage(board, "backlog").or_else(|| {
        board
            .columns
            .iter()
            .find(|column| column.id == "backlog")
            .map(|column| column.id.clone())
    })
}

/// Apply a status transition to a task: update the status, resolve the
/// matching terminal column when applicable, and refresh `updated_at`. The
/// caller performs one final save.
pub fn apply_task_status_transition(
    task: &mut Task,
    next_status: TaskStatus,
    board: Option<&KanbanBoard>,
) {
    let column_id =
        resolve_terminal_column_id_for_status(board, &next_status, task.column_id.as_deref());
    task.status = next_status;
    if let Some(column_id) = column_id {
        task.column_id = Some(column_id);
    }
    task.updated_at = Utc::now();
}

/// Load the board context for a task without creating boards:
/// 1. the task's `board_id` board;
/// 2. the workspace default board when `board_id` is absent or missing;
/// 3. `None` when no board context can be loaded.
///
/// The transition must stay read-only on board state, so this never falls
/// back to `ensure_default_board`.
pub async fn load_task_board(kanban_store: &KanbanStore, task: &Task) -> Option<KanbanBoard> {
    if let Some(board_id) = task.board_id.as_deref() {
        if let Ok(Some(board)) = kanban_store.get(board_id).await {
            if !board.columns.is_empty() {
                return Some(board);
            }
        }
    }
    let Ok(boards) = kanban_store.list_by_workspace(&task.workspace_id).await else {
        return None;
    };
    boards
        .into_iter()
        .find(|board| board.is_default && !board.columns.is_empty())
}

/// Persist a task status change through the unified status transition.
///
/// Loads the task, applies [`apply_task_status_transition`] (terminal
/// statuses resolve the board's done/blocked stage column in the same
/// write), and saves once. Returns `true` when the task existed and was
/// updated.
///
/// Every production entry point that writes a task status (MCP
/// `report_to_parent`, MCP/core `update_task_status`, REST/RPC status
/// update, orchestrator report handling) must route through this helper —
/// or an equivalent store-level operation — instead of calling
/// `TaskStore::update_status` directly, so `Task.status` and its Kanban
/// projection never drift apart.
pub async fn update_task_status_with_transition(
    task_store: &TaskStore,
    kanban_store: &KanbanStore,
    task_id: &str,
    next_status: TaskStatus,
) -> Result<bool, ServerError> {
    let Some(mut task) = task_store.get(task_id).await? else {
        return Ok(false);
    };
    let board = load_task_board(kanban_store, &task).await;
    apply_task_status_transition(&mut task, next_status, board.as_ref());
    task_store.save(&task).await?;
    Ok(true)
}

// ─── Read-side Compatibility Projection ────────────────────────────────
//
// Historical rows may carry a terminal status with an empty or stale
// columnId (written before the unified transition existed). Reads must
// project an effective column instead of trusting the stored columnId
// alone; no stored data is rewritten.

/// Resolve the column a task effectively belongs to for reads.
///
/// Precedence (mirrors the Web `resolveEffectiveColumnIdForRead`):
/// 1. a terminal `task.status` maps to the resolved terminal stage column
///    of the board (keeping a valid current column when no terminal stage
///    matches);
/// 2. otherwise, the explicit `task.column_id` when present and non-empty;
/// 3. otherwise, the legacy status-to-column fallback.
pub fn resolve_effective_column_id_for_read(task: &Task, board: Option<&KanbanBoard>) -> String {
    let current_column_id = task.column_id.as_deref().filter(|value| !value.is_empty());
    if is_terminal_task_status(&task.status) {
        if let Some(column_id) =
            resolve_terminal_column_id_for_status(board, &task.status, current_column_id)
        {
            return column_id;
        }
        if let Some(column_id) = current_column_id {
            return column_id.to_string();
        }
    }
    if let Some(column_id) = current_column_id {
        return column_id.to_string();
    }
    task_status_to_column_id(&task.status).to_string()
}

fn find_review_step_index(task: &Task, steps: &[KanbanAutomationStep]) -> Option<usize> {
    if let Some(current_column_id) = task.column_id.as_deref() {
        if let Some(step_index) = task
            .lane_sessions
            .iter()
            .rev()
            .find(|session| {
                session.column_id.as_deref() == Some(current_column_id)
                    && session.status == TaskLaneSessionStatus::Running
            })
            .and_then(|session| session.step_index)
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < steps.len())
        {
            return Some(step_index);
        }
    }

    let mut best_match: Option<(usize, i32)> = None;
    for (index, step) in steps.iter().enumerate() {
        let mut score = 0;

        if let (Some(step_id), Some(task_id)) = (
            step.specialist_id.as_deref(),
            task.assigned_specialist_id.as_deref(),
        ) {
            if step_id != task_id {
                continue;
            }
            score += 8;
        }
        if let (Some(step_name), Some(task_name)) = (
            step.specialist_name.as_deref(),
            task.assigned_specialist_name.as_deref(),
        ) {
            if step_name != task_name {
                continue;
            }
            score += 4;
        }
        if let (Some(step_role), Some(task_role)) =
            (step.role.as_deref(), task.assigned_role.as_deref())
        {
            if step_role != task_role {
                continue;
            }
            score += 2;
        }
        if let (Some(step_provider), Some(task_provider)) = (
            step.provider_id.as_deref(),
            task.assigned_provider.as_deref(),
        ) {
            if step_provider != task_provider {
                continue;
            }
            score += 1;
        }

        if score > 0
            && best_match
                .map(|(_, best_score)| score > best_score)
                .unwrap_or(true)
        {
            best_match = Some((index, score));
        }
    }

    best_match
        .map(|(index, _)| index)
        .or_else(|| (steps.len() == 1).then_some(0))
}

pub fn resolve_review_lane_convergence_column(
    task: &Task,
    board: Option<&KanbanBoard>,
) -> Option<String> {
    let verdict = task.verification_verdict.as_ref()?;
    let current_column_id = task.column_id.as_deref()?;
    let is_review_stage = board
        .and_then(|value| {
            value
                .columns
                .iter()
                .find(|column| column.id == current_column_id)
        })
        .map(|column| column.stage == "review")
        .unwrap_or(current_column_id == "review");
    if !is_review_stage {
        return None;
    }

    let has_remaining_steps = board
        .and_then(|value| {
            value
                .columns
                .iter()
                .find(|column| column.id == current_column_id)
        })
        .and_then(|column| column.automation.as_ref())
        .and_then(|automation| automation.steps.as_ref())
        .map(|steps| {
            if steps.is_empty() {
                return false;
            }
            match find_review_step_index(task, steps) {
                Some(step_index) => step_index + 1 < steps.len(),
                None => steps.len() > 1,
            }
        })
        .unwrap_or(false);
    if has_remaining_steps {
        return None;
    }

    match verdict {
        VerificationVerdict::Approved => board
            .and_then(|value| resolve_board_column_id_for_stage(value, "done"))
            .or_else(|| Some("done".to_string())),
        VerificationVerdict::NotApproved => board
            .and_then(|value| resolve_board_column_id_for_stage(value, "dev"))
            .or_else(|| Some("dev".to_string())),
        VerificationVerdict::Blocked => board
            .and_then(|value| resolve_board_column_id_for_stage(value, "blocked"))
            .or_else(|| Some("blocked".to_string())),
    }
}

pub fn task_to_card(task: &Task) -> KanbanCard {
    task_to_card_with_board(task, None)
}

pub fn task_to_card_with_board(task: &Task, board: Option<&KanbanBoard>) -> KanbanCard {
    KanbanCard {
        id: task.id.clone(),
        title: task.title.clone(),
        description: task.objective.clone(),
        comment: task.comment.clone(),
        status: task.status.as_str().to_string(),
        column_id: resolve_effective_column_id_for_read(task, board),
        position: task.position,
        priority: task
            .priority
            .as_ref()
            .map(|priority| priority.as_str().to_string()),
        labels: task.labels.clone(),
        assignee: task.assignee.clone(),
        created_at: task.created_at,
        updated_at: task.updated_at,
    }
}

/// Content-free summary of a persisted `type=attachment` Artifact record,
/// used by Kanban task prompts to announce user-provided input attachments.
#[derive(Debug, Clone)]
pub struct TaskInputAttachmentSummary {
    pub artifact_id: String,
    pub filename: String,
    pub media_type: String,
    pub encoding: String,
    pub size: u64,
}

/// Build prompt summaries from persisted attachment Artifact records.
pub fn build_task_input_attachment_summaries(
    artifacts: &[crate::models::artifact::Artifact],
) -> Vec<TaskInputAttachmentSummary> {
    artifacts
        .iter()
        .filter(|artifact| artifact.artifact_type.is_attachment())
        .map(|artifact| {
            let metadata = artifact.metadata.clone().unwrap_or_default();
            TaskInputAttachmentSummary {
                artifact_id: artifact.id.clone(),
                filename: metadata
                    .get("filename")
                    .cloned()
                    .unwrap_or_else(|| "attachment".to_string()),
                media_type: metadata
                    .get("mediaType")
                    .cloned()
                    .unwrap_or_else(|| "text/plain".to_string()),
                encoding: if metadata.get("encoding").map(String::as_str) == Some("base64") {
                    "base64".to_string()
                } else {
                    "utf8".to_string()
                },
                size: metadata
                    .get("size")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
            }
        })
        .collect()
}

/// Render the "## Input Attachments" prompt section, or `None` when the task
/// has no persisted input attachments.
pub fn format_task_input_attachment_section(
    summaries: &[TaskInputAttachmentSummary],
) -> Option<String> {
    if summaries.is_empty() {
        return None;
    }
    let mut lines = vec!["## Input Attachments".to_string(), String::new()];
    for summary in summaries {
        lines.push(format!(
            "- {} ({}, {} bytes), artifact ID: {}",
            summary.filename, summary.media_type, summary.size, summary.artifact_id
        ));
    }
    lines.push(String::new());
    lines.push(
        "Use get_artifact with the task, workspace, and artifact IDs to read an attachment."
            .to_string(),
    );
    lines.push("Treat attachments as task input, not implementation evidence.".to_string());
    lines.push(String::new());
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::kanban::{
        default_kanban_board, KanbanAutomationStep, KanbanColumnAutomation,
    };
    use crate::models::task::{Task, TaskStatus, VerificationVerdict};
    use crate::state::{AppState, AppStateInner};
    use std::sync::Arc;

    async fn setup_state() -> AppState {
        let db = Database::open_in_memory().expect("in-memory db should open");
        let state: AppState = Arc::new(AppStateInner::new(db));
        state
            .workspace_store
            .ensure_default()
            .await
            .expect("default workspace should exist");
        state
    }

    #[tokio::test]
    async fn ensure_task_board_context_backfills_board_and_column() {
        let state = setup_state().await;
        let mut task = Task::new(
            "task-1".to_string(),
            "Legacy card".to_string(),
            "Repair missing board context".to_string(),
            "default".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        task.status = TaskStatus::Pending;
        task.board_id = None;
        task.column_id = None;

        ensure_task_board_context(&state, &mut task)
            .await
            .expect("board context should be filled");

        assert!(task.board_id.is_some());
        assert_eq!(task.column_id.as_deref(), Some("backlog"));
    }

    #[test]
    fn review_lane_convergence_waits_for_final_review_step() {
        let mut board = default_kanban_board("default".to_string());
        let review = board
            .columns
            .iter_mut()
            .find(|column| column.id == "review")
            .expect("review column should exist");
        review.automation = Some(KanbanColumnAutomation {
            enabled: true,
            steps: Some(vec![
                KanbanAutomationStep {
                    id: "qa-frontend".to_string(),
                    role: Some("GATE".to_string()),
                    specialist_id: Some("kanban-qa-frontend".to_string()),
                    specialist_name: Some("QA Frontend".to_string()),
                    ..Default::default()
                },
                KanbanAutomationStep {
                    id: "review-guard".to_string(),
                    role: Some("GATE".to_string()),
                    specialist_id: Some("kanban-review-guard".to_string()),
                    specialist_name: Some("Review Guard".to_string()),
                    ..Default::default()
                },
            ]),
            ..Default::default()
        });

        let mut task = Task::new(
            "task-1".to_string(),
            "Review".to_string(),
            "Review".to_string(),
            "default".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        task.column_id = Some("review".to_string());
        task.assigned_specialist_id = Some("kanban-qa-frontend".to_string());
        task.verification_verdict = Some(VerificationVerdict::NotApproved);

        assert_eq!(
            resolve_review_lane_convergence_column(&task, Some(&board)),
            None
        );

        task.assigned_specialist_id = Some("kanban-review-guard".to_string());
        task.assigned_specialist_name = Some("Review Guard".to_string());
        task.verification_verdict = Some(VerificationVerdict::Approved);

        assert_eq!(
            resolve_review_lane_convergence_column(&task, Some(&board)).as_deref(),
            Some("done")
        );
    }

    fn transition_task(column_id: Option<&str>) -> Task {
        let mut task = Task::new(
            "task-transition".to_string(),
            "Transition".to_string(),
            "Terminal transition".to_string(),
            "default".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        task.column_id = column_id.map(|value| value.to_string());
        task
    }

    #[test]
    fn terminal_status_prefers_semantic_stage_over_literal_id() {
        // A custom board whose done-stage column carries a custom id.
        let mut board = default_kanban_board("default".to_string());
        for column in board.columns.iter_mut() {
            if column.stage == "done" {
                column.id = "shipped".to_string();
            }
        }
        assert_eq!(
            resolve_terminal_column_id_for_status(Some(&board), &TaskStatus::Completed, None)
                .as_deref(),
            Some("shipped")
        );
    }

    #[test]
    fn terminal_status_without_matching_stage_keeps_valid_current_column() {
        // Board with neither a done-stage nor a literal done column: a valid
        // current column is preserved (None) instead of writing a phantom id.
        let mut board = default_kanban_board("default".to_string());
        board.columns.retain(|column| column.stage != "done");
        assert_eq!(
            resolve_terminal_column_id_for_status(
                Some(&board),
                &TaskStatus::Completed,
                Some("dev")
            ),
            None
        );
        // With no valid current column either, fall back to the Backlog column.
        assert_eq!(
            resolve_terminal_column_id_for_status(
                Some(&board),
                &TaskStatus::Completed,
                Some("phantom-column")
            )
            .as_deref(),
            Some("backlog")
        );
    }

    #[test]
    fn apply_task_status_transition_writes_status_column_and_timestamp() {
        let board = default_kanban_board("default".to_string());
        let mut task = transition_task(Some("dev"));
        let before = task.updated_at;
        apply_task_status_transition(&mut task, TaskStatus::Completed, Some(&board));
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.column_id.as_deref(), Some("done"));
        assert!(task.updated_at >= before);

        // Non-terminal transitions leave the column untouched.
        let mut task = transition_task(Some("dev"));
        apply_task_status_transition(&mut task, TaskStatus::NeedsFix, Some(&board));
        assert_eq!(task.status, TaskStatus::NeedsFix);
        assert_eq!(task.column_id.as_deref(), Some("dev"));
    }

    #[tokio::test]
    async fn update_task_status_with_transition_persists_terminal_column() {
        let state = setup_state().await;
        let board = state
            .kanban_store
            .ensure_default_board(&"default".to_string())
            .await
            .expect("default board should be created");
        let mut task = transition_task(Some("dev"));
        task.board_id = Some(board.id.clone());
        state
            .task_store
            .save(&task)
            .await
            .expect("task should save");

        let updated = update_task_status_with_transition(
            &state.task_store,
            &state.kanban_store,
            "task-transition",
            TaskStatus::Completed,
        )
        .await
        .expect("transition should succeed");
        assert!(updated);

        let stored = state
            .task_store
            .get("task-transition")
            .await
            .expect("task should load")
            .expect("task should exist");
        assert_eq!(stored.status, TaskStatus::Completed);
        assert_eq!(stored.column_id.as_deref(), Some("done"));

        let missing = update_task_status_with_transition(
            &state.task_store,
            &state.kanban_store,
            "missing-task",
            TaskStatus::Completed,
        )
        .await
        .expect("missing task should not error");
        assert!(!missing);
    }

    #[test]
    fn read_projection_resolves_terminal_rows_with_missing_or_stale_columns() {
        let board = default_kanban_board("default".to_string());

        // Historical COMPLETED + empty columnId renders on the done column.
        let mut task = transition_task(None);
        task.status = TaskStatus::Completed;
        assert_eq!(
            resolve_effective_column_id_for_read(&task, Some(&board)),
            "done"
        );

        // COMPLETED + stale dev columnId also projects to done.
        let mut task = transition_task(Some("dev"));
        task.status = TaskStatus::Completed;
        assert_eq!(
            resolve_effective_column_id_for_read(&task, Some(&board)),
            "done"
        );

        // Without any board context the literal stage id is used.
        assert_eq!(resolve_effective_column_id_for_read(&task, None), "done");

        // Non-terminal rows keep their explicit column.
        let mut task = transition_task(Some("review"));
        task.status = TaskStatus::ReviewRequired;
        assert_eq!(
            resolve_effective_column_id_for_read(&task, Some(&board)),
            "review"
        );

        // Non-terminal rows without a column fall back to the status mapping.
        let mut task = transition_task(None);
        task.status = TaskStatus::InProgress;
        assert_eq!(
            resolve_effective_column_id_for_read(&task, Some(&board)),
            "dev"
        );
    }

    #[test]
    fn task_to_card_projects_historical_terminal_rows_into_done() {
        let board = default_kanban_board("default".to_string());
        let mut task = transition_task(None);
        task.status = TaskStatus::Completed;

        let card = task_to_card_with_board(&task, Some(&board));
        assert_eq!(card.column_id, "done");
        assert_eq!(card.status, "COMPLETED");

        // No board context: literal stage fallback still avoids Backlog.
        let card = task_to_card(&task);
        assert_eq!(card.column_id, "done");
    }
}
