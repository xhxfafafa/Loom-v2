//! Task management API module
//!
//! This module provides the HTTP API handlers for task management, including
//! CRUD operations, evidence aggregation, change tracking, and kanban automation.

mod attachments;
mod changes;
mod dto;
mod evidence;
mod handlers;

pub use handlers::router;

// Re-export commonly used types
pub use dto::{
    CreateTaskArtifactRequest, CreateTaskAttachmentInput, CreateTaskRequest, ListTasksQuery,
    TaskChangeCommitQuery, TaskChangeFileQuery, TaskChangeStatsQuery, TaskEvidenceSummary,
    TaskRunLedgerEntry, UpdateStatusRequest, UpdateTaskRequest,
};

pub use attachments::{
    build_task_input_attachment, normalize_task_attachments, NormalizedTaskAttachment,
    TaskAttachmentValidationError, TASK_INPUT_ATTACHMENT_CONTEXT,
};

pub use evidence::{
    build_task_evidence_summary, build_task_run_ledger, ensure_transition_artifacts,
    resolve_next_required_artifacts, resolve_next_required_task_fields,
    serialize_task_with_evidence, serialize_tasks_batch, task_lane_session_status_as_str,
};

pub use changes::{
    get_task_change_commit, get_task_change_file, get_task_change_stats, get_task_changes,
    repo_label_from_path,
};
