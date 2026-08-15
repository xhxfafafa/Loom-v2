mod agents_tasks;
mod delegation;
mod events_kanban;
mod notes_workspace;

use crate::rpc::RpcRouter;
use crate::state::AppState;

pub(super) async fn resolve_team_codebase_ids(
    state: &AppState,
    workspace_id: &str,
    session_id: Option<&str>,
) -> Vec<String> {
    let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };

    let mut current = match state.acp_session_store.get(session_id).await {
        Ok(Some(session)) if session.workspace_id == workspace_id => session,
        _ => return Vec::new(),
    };
    let mut visited = std::collections::HashSet::new();
    while let Some(parent_id) = current.parent_session_id.clone() {
        if !visited.insert(current.id.clone()) {
            return Vec::new();
        }
        current = match state.acp_session_store.get(&parent_id).await {
            Ok(Some(parent)) if parent.workspace_id == workspace_id => parent,
            _ => return Vec::new(),
        };
    }

    let active_root = state.acp_manager.get_session(&current.id).await;
    let is_team_root = active_root
        .as_ref()
        .and_then(|session| session.specialist_id.as_deref())
        == Some("team-agent-lead")
        || (current.role.as_deref() == Some("ROUTA")
            && current
                .name
                .as_deref()
                .map(|name| name.trim().to_ascii_lowercase().starts_with("team -"))
                .unwrap_or(false));
    if !is_team_root {
        return Vec::new();
    }

    match state
        .codebase_store
        .find_by_repo_path(workspace_id, &current.cwd)
        .await
    {
        Ok(Some(codebase)) => vec![codebase.id],
        _ => Vec::new(),
    }
}

pub(super) async fn execute_tool_public(
    state: &AppState,
    name: &str,
    args: &serde_json::Value,
) -> serde_json::Value {
    execute_tool(state, normalize_tool_name(name), args, None).await
}

pub(super) async fn execute_tool_for_profile_public(
    state: &AppState,
    name: &str,
    args: &serde_json::Value,
    mcp_profile: Option<&str>,
) -> serde_json::Value {
    execute_tool(state, normalize_tool_name(name), args, mcp_profile).await
}

pub(super) fn normalize_tool_name_public(name: &str) -> &str {
    normalize_tool_name(name)
}

async fn execute_tool(
    state: &AppState,
    name: &str,
    args: &serde_json::Value,
    mcp_profile: Option<&str>,
) -> serde_json::Value {
    let workspace_id = args
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("default");

    if let Some(result) = agents_tasks::execute(state, name, args, workspace_id, mcp_profile).await
    {
        return result;
    }
    if let Some(result) = delegation::execute(state, name, args, workspace_id).await {
        return result;
    }
    if let Some(result) = notes_workspace::execute(state, name, args, workspace_id).await {
        return result;
    }
    if let Some(result) = events_kanban::execute(state, name, args, workspace_id).await {
        return result;
    }

    tool_result_error(&format!("Unknown tool: {name}"))
}

fn normalize_tool_name(name: &str) -> &str {
    name.strip_prefix("routa-coordination_")
        .or_else(|| name.strip_prefix("kanban-planning-mcp_"))
        .unwrap_or(name)
}

pub(super) fn tool_result_text(text: &str) -> serde_json::Value {
    serde_json::json!({
        "isError": false,
        "content": [{ "type": "text", "text": text }]
    })
}

pub(super) async fn rpc_tool_result(
    state: &AppState,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let rpc = RpcRouter::new(state.clone());
    let response = rpc
        .handle_value(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }))
        .await;

    if let Some(result) = response.get("result") {
        Ok(result.clone())
    } else {
        Err(response
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("RPC error")
            .to_string())
    }
}

pub(super) fn tool_result_json(value: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "isError": false,
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(value).unwrap_or_default() }]
    })
}

pub(super) fn tool_result_error(msg: &str) -> serde_json::Value {
    serde_json::json!({
        "isError": true,
        "content": [{ "type": "text", "text": msg }]
    })
}

#[cfg(test)]
mod team_codebase_tests {
    use std::sync::Arc;

    use routa_core::models::codebase::{Codebase, CodebaseSourceType};
    use routa_core::store::acp_session_store::CreateAcpSessionParams;

    use super::resolve_team_codebase_ids;

    #[tokio::test]
    async fn resolves_registered_codebase_from_team_root_for_nested_session() {
        let db = crate::db::Database::open(":memory:").expect("open database");
        let state: crate::state::AppState = Arc::new(crate::state::AppStateInner::new(db));
        state
            .workspace_store
            .ensure_default()
            .await
            .expect("ensure workspace");
        state
            .codebase_store
            .save(&Codebase::new(
                "codebase-team".to_string(),
                "default".to_string(),
                "/repo/team".to_string(),
                Some("main".to_string()),
                Some("owner/team".to_string()),
                true,
                Some(CodebaseSourceType::Local),
                None,
            ))
            .await
            .expect("save codebase");

        state
            .acp_session_store
            .create(CreateAcpSessionParams {
                id: "team-root",
                cwd: "/repo/team",
                branch: Some("main"),
                workspace_id: "default",
                provider: Some("claude"),
                role: Some("ROUTA"),
                custom_command: None,
                custom_args: None,
                parent_session_id: None,
                team_chain_id: None,
            })
            .await
            .expect("save root session");
        state
            .acp_session_store
            .rename("team-root", "Team - selected repo")
            .await
            .expect("name root session");
        state
            .acp_session_store
            .create(CreateAcpSessionParams {
                id: "team-child",
                cwd: "/repo/team",
                branch: Some("main"),
                workspace_id: "default",
                provider: Some("claude"),
                role: Some("CRAFTER"),
                custom_command: None,
                custom_args: None,
                parent_session_id: Some("team-root"),
                team_chain_id: None,
            })
            .await
            .expect("save child session");

        let codebase_ids = resolve_team_codebase_ids(&state, "default", Some("team-child")).await;
        assert_eq!(codebase_ids, vec!["codebase-team"]);

        super::events_kanban::execute(
            &state,
            "create_card",
            &serde_json::json!({ "title": "Team card", "sessionId": "team-child" }),
            "default",
        )
        .await
        .expect("create card tool should be handled");
        let tasks = state
            .task_store
            .list_by_workspace("default")
            .await
            .expect("list tasks");
        assert_eq!(tasks[0].codebase_ids, vec!["codebase-team"]);
    }

    #[tokio::test]
    async fn does_not_assign_a_codebase_to_an_ordinary_session() {
        let db = crate::db::Database::open(":memory:").expect("open database");
        let state: crate::state::AppState = Arc::new(crate::state::AppStateInner::new(db));
        state
            .workspace_store
            .ensure_default()
            .await
            .expect("ensure workspace");
        state
            .acp_session_store
            .create(CreateAcpSessionParams {
                id: "ordinary-session",
                cwd: "/repo/team",
                branch: Some("main"),
                workspace_id: "default",
                provider: Some("claude"),
                role: Some("ROUTA"),
                custom_command: None,
                custom_args: None,
                parent_session_id: None,
                team_chain_id: None,
            })
            .await
            .expect("save ordinary session");

        let codebase_ids =
            resolve_team_codebase_ids(&state, "default", Some("ordinary-session")).await;
        assert!(codebase_ids.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_tool_name_public;

    #[test]
    fn normalize_tool_name_supports_compat_prefixes() {
        assert_eq!(
            normalize_tool_name_public("routa-coordination_list_agents"),
            "list_agents"
        );
        assert_eq!(
            normalize_tool_name_public("kanban-planning-mcp_create_card"),
            "create_card"
        );
        assert_eq!(normalize_tool_name_public("list_tasks"), "list_tasks");
    }
}
