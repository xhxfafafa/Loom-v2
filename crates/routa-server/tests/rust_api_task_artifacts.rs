use axum::{
    extract::State as AxumState, http::HeaderMap, routing::get, routing::post, Json as AxumJson,
    Router,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::net::TcpListener;

use reqwest::StatusCode;
use serde_json::{json, Value};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

#[path = "common/mod.rs"]
mod common;
use common::ApiFixture;

fn json_has_error(resp: &Value, expected: &str) -> bool {
    resp.get("error")
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains(expected))
}

async fn start_mock_a2a_server() -> String {
    #[derive(Clone)]
    struct MockA2AState {
        base_url: String,
        get_task_calls: Arc<AtomicUsize>,
        required_headers: Option<std::collections::HashMap<String, String>>,
    }

    async fn card(
        AxumState(state): AxumState<MockA2AState>,
        headers: HeaderMap,
    ) -> AxumJson<Value> {
        if !headers_match(&headers, state.required_headers.as_ref()) {
            return AxumJson(json!({
                "error": "missing auth"
            }));
        }
        AxumJson(json!({
            "name": "Mock A2A Agent",
            "description": "Test agent",
            "protocolVersion": "0.3.0",
            "version": "0.1.0",
            "url": format!("{}/rpc", state.base_url),
        }))
    }

    async fn rpc(
        AxumState(state): AxumState<MockA2AState>,
        headers: HeaderMap,
        AxumJson(body): AxumJson<Value>,
    ) -> AxumJson<Value> {
        if !headers_match(&headers, state.required_headers.as_ref()) {
            return AxumJson(json!({
                "jsonrpc": "2.0",
                "id": body.get("id").cloned().unwrap_or(json!(null)),
                "error": {
                    "code": 401,
                    "message": "missing auth"
                }
            }));
        }
        let id = body.get("id").cloned().unwrap_or(json!(null));
        let method = body.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "SendMessage" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "task": {
                        "id": "remote-task-1",
                        "contextId": "ctx-1",
                        "status": {
                            "state": "submitted",
                            "timestamp": "2026-03-21T00:00:00Z"
                        }
                    }
                }
            }),
            "GetTask" => {
                let call = state.get_task_calls.fetch_add(1, Ordering::SeqCst);
                let state = if call == 0 { "working" } else { "completed" };
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "task": {
                            "id": "remote-task-1",
                            "contextId": "ctx-1",
                            "status": {
                                "state": state,
                                "timestamp": if state == "completed" {
                                    "2026-03-21T00:00:05Z"
                                } else {
                                    "2026-03-21T00:00:01Z"
                                }
                            },
                            "history": []
                        }
                    }
                })
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Unsupported method: {}", method)
                }
            }),
        };
        AxumJson(response)
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock a2a server");
    let addr = listener.local_addr().expect("mock a2a local addr");
    let base_url = format!("http://{addr}");
    let state = MockA2AState {
        base_url: base_url.clone(),
        get_task_calls: Arc::new(AtomicUsize::new(0)),
        required_headers: None,
    };
    let router = Router::new()
        .route("/card", get(card))
        .route("/rpc", post(rpc))
        .with_state(state);

    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve mock a2a server");
    });

    base_url
}

fn headers_match(
    headers: &HeaderMap,
    required_headers: Option<&std::collections::HashMap<String, String>>,
) -> bool {
    required_headers.is_none_or(|required_headers| {
        required_headers.iter().all(|(name, value)| {
            headers
                .get(name)
                .and_then(|header| header.to_str().ok())
                .is_some_and(|header| header == value)
        })
    })
}

async fn start_mock_a2a_server_with_headers(
    required_headers: std::collections::HashMap<String, String>,
) -> String {
    #[derive(Clone)]
    struct MockA2AState {
        base_url: String,
        _get_task_calls: Arc<AtomicUsize>,
        required_headers: Option<std::collections::HashMap<String, String>>,
    }

    async fn card(
        AxumState(state): AxumState<MockA2AState>,
        headers: HeaderMap,
    ) -> AxumJson<Value> {
        if !headers_match(&headers, state.required_headers.as_ref()) {
            return AxumJson(json!({ "error": "missing auth" }));
        }
        AxumJson(json!({
            "name": "Mock A2A Agent",
            "description": "Test agent",
            "protocolVersion": "0.3.0",
            "version": "0.1.0",
            "url": format!("{}/rpc", state.base_url),
        }))
    }

    async fn rpc(
        AxumState(state): AxumState<MockA2AState>,
        headers: HeaderMap,
        AxumJson(body): AxumJson<Value>,
    ) -> AxumJson<Value> {
        if !headers_match(&headers, state.required_headers.as_ref()) {
            return AxumJson(json!({
                "jsonrpc": "2.0",
                "id": body.get("id").cloned().unwrap_or(json!(null)),
                "error": { "code": 401, "message": "missing auth" }
            }));
        }
        let id = body.get("id").cloned().unwrap_or(json!(null));
        let method = body.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "SendMessage" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "task": {
                        "id": "remote-task-1",
                        "contextId": "ctx-1",
                        "status": {
                            "state": "submitted",
                            "timestamp": "2026-03-21T00:00:00Z"
                        }
                    }
                }
            }),
            "GetTask" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "task": {
                        "id": "remote-task-1",
                        "contextId": "ctx-1",
                        "status": {
                            "state": "completed",
                            "timestamp": "2026-03-21T00:00:05Z"
                        },
                        "history": []
                    }
                }
            }),
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Unsupported method: {}", method)
                }
            }),
        };
        AxumJson(response)
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock a2a server");
    let addr = listener.local_addr().expect("mock a2a local addr");
    let base_url = format!("http://{addr}");
    let state = MockA2AState {
        base_url: base_url.clone(),
        required_headers: Some(required_headers),
        _get_task_calls: Arc::new(AtomicUsize::new(0)),
    };
    let router = Router::new()
        .route("/card", get(card))
        .route("/rpc", post(rpc))
        .with_state(state);

    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve mock a2a server");
    });

    base_url
}

#[tokio::test]
async fn api_task_artifact_flow_and_gate() {
    let fixture = ApiFixture::new().await;

    let boards_response = fixture
        .client
        .get(fixture.endpoint("/api/kanban/boards?workspaceId=default"))
        .send()
        .await
        .expect("list boards");
    assert_eq!(boards_response.status(), StatusCode::OK);
    let boards_json: Value = boards_response.json().await.expect("decode boards");
    let board_id = boards_json["boards"][0]["id"].as_str().expect("board id");

    let board_response = fixture
        .client
        .get(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .send()
        .await
        .expect("get board");
    assert_eq!(board_response.status(), StatusCode::OK);
    let board_json: Value = board_response.json().await.expect("decode board");
    let mut columns = board_json["board"]["columns"]
        .as_array()
        .expect("columns array")
        .clone();
    let dev = columns
        .iter_mut()
        .find(|column| column["id"].as_str() == Some("dev"))
        .expect("dev column");
    dev["automation"] = json!({
        "enabled": true,
        "requiredArtifacts": ["screenshot"]
    });
    let review = columns
        .iter_mut()
        .find(|column| column["id"].as_str() == Some("review"))
        .expect("review column");
    review["automation"] = json!({
        "enabled": true,
        "requiredArtifacts": ["screenshot"]
    });

    let update_board = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .json(&json!({ "columns": columns }))
        .send()
        .await
        .expect("update board");
    assert_eq!(update_board.status(), StatusCode::OK);

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Artifact gated task",
            "objective": "Require screenshot before review",
            "workspaceId": "default",
            "boardId": board_id,
            "columnId": "todo"
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let task_json: Value = create_task.json().await.expect("decode task");
    let task_id = task_json["task"]["id"].as_str().expect("task id");
    assert_eq!(task_json["task"]["artifactSummary"]["total"], json!(0));
    assert_eq!(
        task_json["task"]["artifactSummary"]["requiredSatisfied"],
        json!(false)
    );
    assert_eq!(
        task_json["task"]["artifactSummary"]["missingRequired"],
        json!(["screenshot"])
    );
    assert!(
        matches!(
            task_json["task"]["evidenceSummary"]["runs"]["latestStatus"].as_str(),
            Some("idle" | "running")
        ),
        "expected latestStatus to be idle or running, got {:?}",
        task_json["task"]["evidenceSummary"]["runs"]["latestStatus"]
    );
    assert_eq!(
        task_json["task"]["storyReadiness"]["requiredTaskFields"],
        json!([])
    );
    assert_eq!(
        task_json["task"]["investValidation"]["source"],
        json!("heuristic")
    );

    let blocked_move = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/tasks/{task_id}")))
        .json(&json!({ "columnId": "review" }))
        .send()
        .await
        .expect("move blocked");
    assert_eq!(blocked_move.status(), StatusCode::BAD_REQUEST);
    let blocked_json: Value = blocked_move.json().await.expect("decode blocked move");
    assert!(json_has_error(
        &blocked_json,
        "missing required artifacts: screenshot"
    ));

    let create_artifact = fixture
        .client
        .post(fixture.endpoint(&format!("/api/tasks/{task_id}/artifacts")))
        .json(&json!({
            "agentId": "agent-1",
            "type": "screenshot",
            "content": "base64-image",
            "context": "Review screenshot"
        }))
        .send()
        .await
        .expect("create artifact");
    assert_eq!(create_artifact.status(), StatusCode::CREATED);

    let get_task = fixture
        .client
        .get(fixture.endpoint(&format!("/api/tasks/{task_id}")))
        .send()
        .await
        .expect("get task");
    assert_eq!(get_task.status(), StatusCode::OK);
    let get_task_json: Value = get_task.json().await.expect("decode task");
    assert_eq!(get_task_json["task"]["artifactSummary"]["total"], json!(1));
    assert_eq!(
        get_task_json["task"]["artifactSummary"]["byType"]["screenshot"],
        json!(1)
    );
    assert_eq!(
        get_task_json["task"]["artifactSummary"]["requiredSatisfied"],
        json!(true)
    );
    assert_eq!(
        get_task_json["task"]["artifactSummary"]["missingRequired"],
        json!([])
    );
    assert_eq!(
        get_task_json["task"]["evidenceSummary"]["artifact"]["byType"]["screenshot"],
        json!(1)
    );
    assert_eq!(
        get_task_json["task"]["storyReadiness"]["requiredTaskFields"],
        json!([])
    );

    let list_artifacts = fixture
        .client
        .get(fixture.endpoint(&format!("/api/tasks/{task_id}/artifacts")))
        .send()
        .await
        .expect("list artifacts");
    assert_eq!(list_artifacts.status(), StatusCode::OK);
    let artifacts_json: Value = list_artifacts.json().await.expect("decode artifacts");
    assert_eq!(
        artifacts_json["artifacts"]
            .as_array()
            .expect("artifact array")
            .len(),
        1
    );

    let list_tasks = fixture
        .client
        .get(fixture.endpoint("/api/tasks?workspaceId=default"))
        .send()
        .await
        .expect("list tasks");
    assert_eq!(list_tasks.status(), StatusCode::OK);
    let list_tasks_json: Value = list_tasks.json().await.expect("decode tasks");
    let listed_task = list_tasks_json["tasks"]
        .as_array()
        .expect("task array")
        .iter()
        .find(|task| task["id"].as_str() == Some(task_id))
        .expect("listed task");
    assert_eq!(listed_task["artifactSummary"]["total"], json!(1));
    assert_eq!(
        listed_task["evidenceSummary"]["artifact"]["requiredSatisfied"],
        json!(true)
    );
    assert_eq!(
        listed_task["investValidation"]["source"],
        json!("heuristic")
    );

    let ready_tasks = fixture
        .client
        .get(fixture.endpoint("/api/tasks/ready?workspaceId=default"))
        .send()
        .await
        .expect("ready tasks");
    assert_eq!(ready_tasks.status(), StatusCode::OK);
    let ready_tasks_json: Value = ready_tasks.json().await.expect("decode ready tasks");
    let ready_task = ready_tasks_json["tasks"]
        .as_array()
        .expect("ready task array")
        .iter()
        .find(|task| task["id"].as_str() == Some(task_id))
        .expect("ready task");
    assert_eq!(ready_task["artifactSummary"]["total"], json!(1));
    assert_eq!(
        ready_task["evidenceSummary"]["artifact"]["requiredSatisfied"],
        json!(true)
    );
    assert_eq!(ready_task["storyReadiness"]["ready"], json!(true));

    let allowed_move = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/tasks/{task_id}")))
        .json(&json!({ "columnId": "review" }))
        .send()
        .await
        .expect("move allowed");
    assert_eq!(allowed_move.status(), StatusCode::OK);
}

#[tokio::test]
async fn api_blocks_transition_when_required_task_fields_are_missing() {
    let fixture = ApiFixture::new().await;

    let board_response = fixture
        .client
        .get(fixture.endpoint("/api/kanban/boards?workspaceId=default"))
        .send()
        .await
        .expect("list boards");
    assert_eq!(board_response.status(), StatusCode::OK);
    let boards_json: Value = board_response.json().await.expect("decode boards");
    let board_id = boards_json["boards"][0]["id"]
        .as_str()
        .expect("default board id")
        .to_string();

    let board_detail = fixture
        .client
        .get(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .send()
        .await
        .expect("get board");
    assert_eq!(board_detail.status(), StatusCode::OK);
    let mut board_json: Value = board_detail.json().await.expect("decode board");
    let columns = board_json["board"]["columns"]
        .as_array_mut()
        .expect("columns array");
    let dev = columns
        .iter_mut()
        .find(|column| column["id"].as_str() == Some("dev"))
        .expect("dev column");
    dev["automation"] = json!({
        "enabled": true,
        "requiredTaskFields": ["scope", "acceptance_criteria", "verification_plan"]
    });

    let update_board = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .json(&json!({ "columns": columns }))
        .send()
        .await
        .expect("update board");
    assert_eq!(update_board.status(), StatusCode::OK);

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Missing scope",
            "objective": "This story is not ready for dev",
            "workspaceId": "default",
            "boardId": board_id,
            "columnId": "todo"
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let task_json: Value = create_task.json().await.expect("decode task");
    let task_id = task_json["task"]["id"].as_str().expect("task id");

    let blocked_move = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/tasks/{task_id}")))
        .json(&json!({ "columnId": "dev" }))
        .send()
        .await
        .expect("move blocked");
    assert_eq!(blocked_move.status(), StatusCode::BAD_REQUEST);
    let blocked_json: Value = blocked_move.json().await.expect("decode blocked move");
    assert!(json_has_error(
        &blocked_json,
        "missing required task fields"
    ));
}

#[tokio::test]
async fn api_kanban_import_export_roundtrip() {
    let fixture = ApiFixture::new().await;

    let import_response = fixture
        .client
        .post(fixture.endpoint("/api/kanban/import"))
        .json(&json!({
            "workspaceId": "kanban-sync",
            "yamlContent": r#"
version: 1
name: Sync Workspace
workspaceId: ignored-by-override
boards:
  - id: main
    name: Imported Board
    isDefault: true
    columns:
      - id: backlog
        name: Backlog
        stage: backlog
      - id: review
        name: Review
        stage: review
        automation:
          providerId: routa-native
          role: GATE
      - id: blocked
        name: Blocked
        stage: blocked
        automation:
          enabled: false
          transitionType: entry
          steps:
            - id: blocked-resolver
              role: CRAFTER
              specialistName: Blocked Resolver
"#
        }))
        .send()
        .await
        .expect("import kanban yaml");
    assert_eq!(import_response.status(), StatusCode::OK);

    let export_response = fixture
        .client
        .get(fixture.endpoint("/api/kanban/export?workspaceId=kanban-sync"))
        .send()
        .await
        .expect("export kanban yaml");
    assert_eq!(export_response.status(), StatusCode::OK);
    assert!(export_response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("application/yaml")));
    assert!(export_response
        .headers()
        .get("content-disposition")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("kanban-kanban-sync.yaml")));

    let exported_yaml = export_response.text().await.expect("export yaml body");
    assert!(exported_yaml.contains("workspaceId: kanban-sync"));
    assert!(exported_yaml.contains("name: Sync Workspace Kanban"));
    assert!(exported_yaml.contains("name: Imported Board"));
    assert!(exported_yaml.contains("enabled: true"));
    assert!(exported_yaml.contains("name: Blocked"));
    assert!(exported_yaml.contains("specialistName: Blocked Resolver"));
    assert!(exported_yaml.contains("enabled: false"));

    let missing_workspace = fixture
        .client
        .get(fixture.endpoint("/api/kanban/export"))
        .send()
        .await
        .expect("export without workspaceId");
    assert_eq!(missing_workspace.status(), StatusCode::BAD_REQUEST);
    let missing_workspace_json: Value = missing_workspace
        .json()
        .await
        .expect("decode missing workspace response");
    assert!(json_has_error(
        &missing_workspace_json,
        "workspaceId is required"
    ));
}

#[tokio::test]
async fn api_task_create_triggers_a2a_lane_automation_and_persists_lane_metadata() {
    let fixture = ApiFixture::new().await;
    let mock_a2a_base = start_mock_a2a_server().await;

    let boards_response = fixture
        .client
        .get(fixture.endpoint("/api/kanban/boards?workspaceId=default"))
        .send()
        .await
        .expect("list boards");
    assert_eq!(boards_response.status(), StatusCode::OK);
    let boards_json: Value = boards_response.json().await.expect("decode boards");
    let board_id = boards_json["boards"][0]["id"].as_str().expect("board id");

    let board_response = fixture
        .client
        .get(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .send()
        .await
        .expect("get board");
    assert_eq!(board_response.status(), StatusCode::OK);
    let board_json: Value = board_response.json().await.expect("decode board");
    let mut columns = board_json["board"]["columns"]
        .as_array()
        .expect("columns array")
        .clone();
    let todo = columns
        .iter_mut()
        .find(|column| column["id"].as_str() == Some("todo"))
        .expect("todo column");
    todo["automation"] = json!({
        "enabled": true,
        "steps": [
            {
                "id": "todo-a2a",
                "transport": "a2a",
                "role": "CRAFTER",
                "specialistName": "Todo Remote Worker",
                "agentCardUrl": format!("{}/card", mock_a2a_base),
                "skillId": "remote-skill"
            }
        ]
    });

    let update_board = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .json(&json!({ "columns": columns }))
        .send()
        .await
        .expect("update board");
    assert_eq!(update_board.status(), StatusCode::OK);

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "A2A lane task",
            "objective": "Trigger remote A2A automation",
            "workspaceId": "default",
            "boardId": board_id,
            "columnId": "todo"
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let task_json: Value = create_task.json().await.expect("decode task");
    let task_id = task_json["task"]["id"].as_str().expect("task id");

    let get_task = fixture
        .client
        .get(fixture.endpoint(&format!("/api/tasks/{task_id}")))
        .send()
        .await
        .expect("get task");
    assert_eq!(get_task.status(), StatusCode::OK);
    let persisted_json: Value = get_task.json().await.expect("decode persisted task");

    let trigger_session_id = persisted_json["task"]["triggerSessionId"]
        .as_str()
        .expect("trigger session id");
    assert!(
        trigger_session_id.starts_with("a2a-"),
        "expected synthetic a2a session id, got {trigger_session_id}"
    );
    assert_eq!(
        persisted_json["task"]["sessionIds"]
            .as_array()
            .expect("session ids")
            .len(),
        1
    );
    assert_eq!(
        persisted_json["task"]["sessionIds"][0].as_str(),
        Some(trigger_session_id)
    );
    assert_eq!(
        persisted_json["task"]["laneSessions"]
            .as_array()
            .expect("lane sessions")
            .len(),
        1
    );
    assert_eq!(
        persisted_json["task"]["laneSessions"][0]["transport"].as_str(),
        Some("a2a")
    );
    assert_eq!(
        persisted_json["task"]["laneSessions"][0]["externalTaskId"].as_str(),
        Some("remote-task-1")
    );
    assert_eq!(
        persisted_json["task"]["laneSessions"][0]["contextId"].as_str(),
        Some("ctx-1")
    );
    assert_eq!(
        persisted_json["task"]["laneSessions"][0]["stepId"].as_str(),
        Some("todo-a2a")
    );
}

#[tokio::test]
async fn api_task_runs_returns_normalized_a2a_ledger_entries() {
    let fixture = ApiFixture::new().await;
    let mock_a2a_base = start_mock_a2a_server().await;

    let boards_response = fixture
        .client
        .get(fixture.endpoint("/api/kanban/boards?workspaceId=default"))
        .send()
        .await
        .expect("list boards");
    assert_eq!(boards_response.status(), StatusCode::OK);
    let boards_json: Value = boards_response.json().await.expect("decode boards");
    let board_id = boards_json["boards"][0]["id"].as_str().expect("board id");

    let board_response = fixture
        .client
        .get(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .send()
        .await
        .expect("get board");
    assert_eq!(board_response.status(), StatusCode::OK);
    let board_json: Value = board_response.json().await.expect("decode board");
    let mut columns = board_json["board"]["columns"]
        .as_array()
        .expect("columns array")
        .clone();
    let todo = columns
        .iter_mut()
        .find(|column| column["id"].as_str() == Some("todo"))
        .expect("todo column");
    todo["automation"] = json!({
        "enabled": true,
        "steps": [
            {
                "id": "todo-a2a",
                "transport": "a2a",
                "role": "CRAFTER",
                "specialistName": "Todo Remote Worker",
                "agentCardUrl": format!("{}/card", mock_a2a_base),
                "skillId": "remote-skill"
            }
        ]
    });

    let update_board = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .json(&json!({ "columns": columns }))
        .send()
        .await
        .expect("update board");
    assert_eq!(update_board.status(), StatusCode::OK);

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "A2A ledger task",
            "objective": "Return normalized runs",
            "workspaceId": "default",
            "boardId": board_id,
            "columnId": "todo"
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let task_json: Value = create_task.json().await.expect("decode task");
    let task_id = task_json["task"]["id"].as_str().expect("task id");

    let runs_response = fixture
        .client
        .get(fixture.endpoint(&format!("/api/tasks/{task_id}/runs")))
        .send()
        .await
        .expect("get task runs");
    assert_eq!(runs_response.status(), StatusCode::OK);
    let runs_json: Value = runs_response.json().await.expect("decode task runs");
    let runs = runs_json["runs"].as_array().expect("runs array");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["kind"].as_str(), Some("a2a_task"));
    assert_eq!(runs[0]["status"].as_str(), Some("running"));
    assert_eq!(runs[0]["externalTaskId"].as_str(), Some("remote-task-1"));
    assert_eq!(runs[0]["contextId"].as_str(), Some("ctx-1"));
    assert_eq!(
        runs[0]["resumeTarget"]["type"].as_str(),
        Some("external_task")
    );
    assert_eq!(
        runs[0]["resumeTarget"]["id"].as_str(),
        Some("remote-task-1")
    );
}

#[tokio::test]
async fn api_task_create_reconciles_a2a_lane_terminal_state() {
    let fixture = ApiFixture::new().await;
    let mock_a2a_base = start_mock_a2a_server().await;

    let boards_response = fixture
        .client
        .get(fixture.endpoint("/api/kanban/boards?workspaceId=default"))
        .send()
        .await
        .expect("list boards");
    assert_eq!(boards_response.status(), StatusCode::OK);
    let boards_json: Value = boards_response.json().await.expect("decode boards");
    let board_id = boards_json["boards"][0]["id"].as_str().expect("board id");

    let board_response = fixture
        .client
        .get(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .send()
        .await
        .expect("get board");
    assert_eq!(board_response.status(), StatusCode::OK);
    let board_json: Value = board_response.json().await.expect("decode board");
    let mut columns = board_json["board"]["columns"]
        .as_array()
        .expect("columns array")
        .clone();
    let todo = columns
        .iter_mut()
        .find(|column| column["id"].as_str() == Some("todo"))
        .expect("todo column");
    todo["automation"] = json!({
        "enabled": true,
        "steps": [
            {
                "id": "todo-a2a",
                "transport": "a2a",
                "role": "CRAFTER",
                "specialistName": "Todo Remote Worker",
                "agentCardUrl": format!("{}/card", mock_a2a_base),
                "skillId": "remote-skill"
            }
        ]
    });

    let update_board = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .json(&json!({ "columns": columns }))
        .send()
        .await
        .expect("update board");
    assert_eq!(update_board.status(), StatusCode::OK);

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "A2A lane terminal state",
            "objective": "Track the remote A2A task until completion",
            "workspaceId": "default",
            "boardId": board_id,
            "columnId": "todo"
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let task_json: Value = create_task.json().await.expect("decode task");
    let task_id = task_json["task"]["id"].as_str().expect("task id");

    let mut completed_task = None;
    for _ in 0..40 {
        let response = fixture
            .client
            .get(fixture.endpoint(&format!("/api/tasks/{task_id}")))
            .send()
            .await
            .expect("get task");
        assert_eq!(response.status(), StatusCode::OK);
        let persisted_json: Value = response.json().await.expect("decode persisted task");
        let lane_session = &persisted_json["task"]["laneSessions"][0];
        if lane_session["status"].as_str() == Some("completed") {
            completed_task = Some(persisted_json);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let persisted_json = completed_task.expect("expected A2A lane session to complete");
    assert_eq!(persisted_json["task"]["triggerSessionId"], Value::Null);
    assert_eq!(
        persisted_json["task"]["laneSessions"][0]["status"].as_str(),
        Some("completed")
    );
    assert_eq!(
        persisted_json["task"]["laneSessions"][0]["completedAt"].as_str(),
        Some("2026-03-21T00:00:05Z")
    );
    assert_eq!(persisted_json["task"]["lastSyncError"], Value::Null);
}

#[tokio::test]
async fn api_task_create_applies_a2a_auth_config_headers() {
    let fixture = ApiFixture::new().await;
    let mock_a2a_base = start_mock_a2a_server_with_headers(std::collections::HashMap::from([
        (
            "authorization".to_string(),
            "Bearer secret-token".to_string(),
        ),
        ("x-tenant".to_string(), "review-team".to_string()),
    ]))
    .await;

    std::env::set_var(
        "ROUTA_A2A_AUTH_CONFIGS",
        r#"{"remote-review-auth":{"headers":{"Authorization":"Bearer secret-token","X-Tenant":"review-team"}}}"#,
    );

    let boards_response = fixture
        .client
        .get(fixture.endpoint("/api/kanban/boards?workspaceId=default"))
        .send()
        .await
        .expect("list boards");
    assert_eq!(boards_response.status(), StatusCode::OK);
    let boards_json: Value = boards_response.json().await.expect("decode boards");
    let board_id = boards_json["boards"][0]["id"].as_str().expect("board id");

    let board_response = fixture
        .client
        .get(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .send()
        .await
        .expect("get board");
    assert_eq!(board_response.status(), StatusCode::OK);
    let board_json: Value = board_response.json().await.expect("decode board");
    let mut columns = board_json["board"]["columns"]
        .as_array()
        .expect("columns array")
        .clone();
    let todo = columns
        .iter_mut()
        .find(|column| column["id"].as_str() == Some("todo"))
        .expect("todo column");
    todo["automation"] = json!({
        "enabled": true,
        "steps": [
            {
                "id": "todo-a2a",
                "transport": "a2a",
                "role": "CRAFTER",
                "specialistName": "Todo Remote Worker",
                "agentCardUrl": format!("{}/card", mock_a2a_base),
                "skillId": "remote-skill",
                "authConfigId": "remote-review-auth"
            }
        ]
    });

    let update_board = fixture
        .client
        .patch(fixture.endpoint(&format!("/api/kanban/boards/{board_id}")))
        .json(&json!({ "columns": columns }))
        .send()
        .await
        .expect("update board");
    assert_eq!(update_board.status(), StatusCode::OK);

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "A2A lane auth task",
            "objective": "Trigger remote A2A automation with auth",
            "workspaceId": "default",
            "boardId": board_id,
            "columnId": "todo"
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let task_json: Value = create_task.json().await.expect("decode task");
    let task_id = task_json["task"]["id"].as_str().expect("task id");

    let get_task = fixture
        .client
        .get(fixture.endpoint(&format!("/api/tasks/{task_id}")))
        .send()
        .await
        .expect("get task");
    assert_eq!(get_task.status(), StatusCode::OK);
    let persisted_json: Value = get_task.json().await.expect("decode persisted task");
    assert_eq!(
        persisted_json["task"]["laneSessions"][0]["externalTaskId"].as_str(),
        Some("remote-task-1")
    );

    std::env::remove_var("ROUTA_A2A_AUTH_CONFIGS");
}

fn png_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.resize(len.max(8), 0);
    bytes
}

async fn rpc_call(fixture: &ApiFixture, method: &str, params: Value) -> Value {
    let response = fixture
        .client
        .post(fixture.endpoint("/api/rpc"))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .expect("POST /api/rpc");
    assert_eq!(response.status(), StatusCode::OK);
    response.json().await.expect("decode rpc response")
}

#[tokio::test]
async fn api_task_create_with_attachments_persists_and_reads_back() {
    let fixture = ApiFixture::new().await;
    let text_base64 = BASE64_STANDARD.encode("# Spec\n");
    let png_base64 = BASE64_STANDARD.encode(png_bytes(64));

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Task with attachments",
            "objective": "Attachments persist before any automation",
            "workspaceId": "default",
            "columnId": "blocked",
            "attachments": [
                { "filename": "spec.md", "contentBase64": text_base64 },
                { "filename": "photo.png", "contentBase64": png_base64 }
            ]
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let created: Value = create_task.json().await.expect("decode task response");
    let task_id = created["task"]["id"].as_str().expect("task id").to_string();

    // HTTP read path returns the attachments with metadata and content.
    let list = fixture
        .client
        .get(fixture.endpoint(&format!("/api/tasks/{task_id}/artifacts")))
        .send()
        .await
        .expect("list artifacts");
    assert_eq!(list.status(), StatusCode::OK);
    let list_json: Value = list.json().await.expect("decode artifacts");
    let artifacts = list_json["artifacts"].as_array().expect("artifacts array");
    assert_eq!(artifacts.len(), 2);
    let text_artifact = artifacts
        .iter()
        .find(|artifact| artifact["metadata"]["filename"] == "spec.md")
        .expect("text attachment listed");
    assert_eq!(text_artifact["type"], "attachment");
    assert_eq!(text_artifact["metadata"]["mediaType"], "text/markdown");
    assert_eq!(text_artifact["metadata"]["encoding"], "utf8");
    assert_eq!(text_artifact["metadata"]["size"], "7");
    assert_eq!(text_artifact["metadata"]["source"], "user");
    assert_eq!(text_artifact["content"], "# Spec\n");
    let image_artifact = artifacts
        .iter()
        .find(|artifact| artifact["metadata"]["filename"] == "photo.png")
        .expect("image attachment listed");
    assert_eq!(image_artifact["metadata"]["mediaType"], "image/png");
    assert_eq!(image_artifact["metadata"]["encoding"], "base64");
    assert_eq!(image_artifact["metadata"]["size"], "64");

    // RPC list path returns the stored artifacts with metadata; the MCP
    // tool surface strips content (covered in rust_api_mcp_routes.rs).
    let rpc_list = rpc_call(
        &fixture,
        "tasks.listArtifacts",
        json!({ "taskId": task_id }),
    )
    .await;
    let rpc_artifacts = rpc_list["result"]["artifacts"]
        .as_array()
        .expect("rpc artifacts");
    assert_eq!(rpc_artifacts.len(), 2);
    for artifact in rpc_artifacts {
        assert_eq!(artifact["type"], "attachment");
        assert!(
            artifact.get("metadata").is_some(),
            "metadata must be present"
        );
    }

    // Type filter accepts attachment.
    let rpc_filtered = rpc_call(
        &fixture,
        "tasks.listArtifacts",
        json!({ "taskId": task_id, "type": "attachment" }),
    )
    .await;
    assert_eq!(
        rpc_filtered["result"]["artifacts"]
            .as_array()
            .expect("filtered artifacts")
            .len(),
        2
    );

    // RPC get path returns the full content.
    let artifact_id = text_artifact["id"].as_str().expect("artifact id");
    let rpc_get = rpc_call(
        &fixture,
        "tasks.getArtifact",
        json!({
            "artifactId": artifact_id,
            "taskId": task_id,
            "workspaceId": "default"
        }),
    )
    .await;
    assert_eq!(rpc_get["result"]["artifact"]["content"], "# Spec\n");
}

#[tokio::test]
async fn api_task_create_rejects_invalid_attachments_wholesale() {
    let fixture = ApiFixture::new().await;

    // Invalid base64 rejects the whole request.
    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Task with invalid attachment",
            "objective": "Validation must reject before persistence",
            "workspaceId": "default",
            "columnId": "blocked",
            "attachments": [
                { "filename": "spec.md", "contentBase64": "!!!not-base64" }
            ]
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::BAD_REQUEST);
    let body: Value = create_task.json().await.expect("decode error body");
    assert!(json_has_error(&body, "Invalid task attachment"));

    // PNG signature on a text extension is a signature mismatch.
    let mismatch = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Task with mismatched attachment",
            "objective": "Signature must match the extension",
            "workspaceId": "default",
            "columnId": "blocked",
            "attachments": [
                { "filename": "notes.txt", "contentBase64": BASE64_STANDARD.encode(png_bytes(16)) }
            ]
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);

    // No task was persisted by either rejected request.
    let list = fixture
        .client
        .get(fixture.endpoint("/api/tasks?workspaceId=default"))
        .send()
        .await
        .expect("list tasks");
    let list_json: Value = list.json().await.expect("decode task list");
    assert_eq!(
        list_json["tasks"].as_array().expect("tasks array").len(),
        0,
        "rejected requests must not persist tasks"
    );
}

#[tokio::test]
async fn api_rpc_provide_artifact_rejects_attachment_type() {
    let fixture = ApiFixture::new().await;

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Attachment write boundary",
            "objective": "Agents cannot create attachment artifacts",
            "workspaceId": "default",
            "columnId": "blocked"
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let created: Value = create_task.json().await.expect("decode task response");
    let task_id = created["task"]["id"].as_str().expect("task id");

    let provide = rpc_call(
        &fixture,
        "tasks.provideArtifact",
        json!({
            "taskId": task_id,
            "agentId": "agent-1",
            "type": "attachment",
            "content": "agent-created attachment"
        }),
    )
    .await;
    let message = provide["error"]["message"]
        .as_str()
        .expect("rpc error message");
    assert!(
        message.contains("Invalid artifact type: attachment"),
        "unexpected error: {message}"
    );

    let list = rpc_call(
        &fixture,
        "tasks.listArtifacts",
        json!({ "taskId": task_id }),
    )
    .await;
    assert_eq!(
        list["result"]["artifacts"]
            .as_array()
            .expect("artifacts")
            .len(),
        0,
        "rejected provideArtifact must not persist anything"
    );
}

#[tokio::test]
async fn api_task_create_body_limit_accepts_over_2mib_and_rejects_over_10mib() {
    let fixture = ApiFixture::new().await;

    // ~2 MiB image decodes to ~2.7 MiB of Base64 JSON: above axum's default
    // 2 MiB route limit, so this only passes with the route-local raise.
    let image = png_bytes(2 * 1024 * 1024);
    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Large attachment",
            "objective": "Route-local body limit allows ~6 MiB decoded",
            "workspaceId": "default",
            "columnId": "blocked",
            "attachments": [
                { "filename": "large.png", "contentBase64": BASE64_STANDARD.encode(&image) }
            ]
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);

    // An 8 MiB payload encodes to ~10.7 MiB of body and must be rejected
    // before the handler ever runs.
    let oversized = png_bytes(8 * 1024 * 1024);
    let rejected = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Oversized attachment",
            "objective": "Body limit must reject over 10 MiB",
            "workspaceId": "default",
            "columnId": "blocked",
            "attachments": [
                { "filename": "huge.png", "contentBase64": BASE64_STANDARD.encode(&oversized) }
            ]
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn api_task_delete_cascades_attachment_artifacts() {
    let fixture = ApiFixture::new().await;

    let create_task = fixture
        .client
        .post(fixture.endpoint("/api/tasks"))
        .json(&json!({
            "title": "Task to delete",
            "objective": "Deleting the task removes its attachments",
            "workspaceId": "default",
            "columnId": "blocked",
            "attachments": [
                { "filename": "spec.md", "contentBase64": BASE64_STANDARD.encode("# Spec\n") }
            ]
        }))
        .send()
        .await
        .expect("create task");
    assert_eq!(create_task.status(), StatusCode::CREATED);
    let created: Value = create_task.json().await.expect("decode task response");
    let task_id = created["task"]["id"].as_str().expect("task id").to_string();

    let delete = fixture
        .client
        .delete(fixture.endpoint(&format!("/api/tasks/{task_id}")))
        .send()
        .await
        .expect("delete task");
    assert!(delete.status().is_success());

    // Foreign-key cascade must remove the attachment artifact rows.
    let connection = rusqlite::Connection::open(&fixture.db_path).expect("open db");
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM artifacts WHERE task_id = ?1",
            [&task_id],
            |row| row.get(0),
        )
        .expect("count artifacts");
    assert_eq!(
        count, 0,
        "attachment rows must cascade-delete with the task"
    );
}
