//! Prompt content-block handling shared by the desktop `session/prompt` route.
//!
//! Mirrors the Web `src/core/acp/prompt-content.ts` behavior: the transport
//! boundary validates and preserves ACP content blocks instead of flattening
//! requests to text. Provider dispatch then decides whether blocks pass
//! through unchanged (standard ACP providers), embedded text resources
//! become clearly-delimited text (adapters without embedded context), or the
//! prompt fails explicitly (binary content on a path that cannot carry it).

use serde_json::Value;

/// Error reason carried in JSON-RPC `error.data.reason` for capability failures.
pub const PROMPT_IMAGE_UNSUPPORTED_REASON: &str = "prompt_images_unsupported";

pub const EMBEDDED_RESOURCE_DELIMITER: &str = "----- Attached file";

/// Validated prompt content blocks plus the text-block projection.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedPromptContent {
    /// Validated blocks in request order.
    pub blocks: Vec<Value>,
    /// Text-block content only, for history and text-only adapters.
    pub prompt_text: String,
    /// True when any block carries binary content (image data or blob resource).
    pub has_binary: bool,
}

fn parse_embedded_resource(value: &Value) -> Option<Value> {
    let resource = value.get("resource")?;
    let uri = resource.get("uri")?.as_str()?;
    if uri.is_empty() {
        return None;
    }
    let text = resource.get("text").and_then(Value::as_str);
    let blob = resource
        .get("blob")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if text.is_none() && blob.is_none() {
        return None;
    }
    let mut parsed = serde_json::json!({ "type": "resource", "uri": uri });
    if let Some(text) = text {
        parsed["text"] = Value::String(text.to_string());
    }
    if let Some(blob) = blob {
        parsed["blob"] = Value::String(blob.to_string());
    }
    if let Some(mime_type) = resource.get("mimeType").and_then(Value::as_str) {
        parsed["mimeType"] = Value::String(mime_type.to_string());
    }
    Some(parsed)
}

fn is_binary_block(block: &Value) -> bool {
    if block.get("type").and_then(Value::as_str) == Some("image") {
        return true;
    }
    block.get("type").and_then(Value::as_str) == Some("resource")
        && block
            .get("resource")
            .and_then(|resource| resource.get("blob"))
            .and_then(Value::as_str)
            .is_some()
}

/// Validate a raw `session/prompt` `prompt` field into preserved content
/// blocks. Plain strings and text-block arrays behave exactly as before;
/// unknown block types stay ignored like the previous text-only extraction.
pub fn parse_prompt_content_blocks(raw_prompt: Option<&Value>) -> ParsedPromptContent {
    match raw_prompt {
        Some(Value::String(text)) => ParsedPromptContent {
            blocks: vec![serde_json::json!({ "type": "text", "text": text })],
            prompt_text: text.clone(),
            has_binary: false,
        },
        Some(Value::Array(entries)) => {
            let mut blocks: Vec<Value> = Vec::new();
            for entry in entries {
                let block_type = entry.get("type").and_then(Value::as_str);
                match block_type {
                    Some("text") => {
                        if let Some(text) = entry.get("text").and_then(Value::as_str) {
                            blocks.push(serde_json::json!({ "type": "text", "text": text }));
                        }
                    }
                    Some("image") => {
                        let data = entry
                            .get("data")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let mime_type = entry
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !data.is_empty() && !mime_type.is_empty() {
                            blocks.push(serde_json::json!({
                                "type": "image",
                                "data": data,
                                "mimeType": mime_type,
                            }));
                        }
                    }
                    Some("resource") => {
                        if let Some(resource) = parse_embedded_resource(entry) {
                            blocks.push(serde_json::json!({
                                "type": "resource",
                                "resource": resource,
                            }));
                        }
                    }
                    _ => {}
                }
            }
            let prompt_text = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            let has_binary = blocks.iter().any(is_binary_block);
            ParsedPromptContent {
                blocks,
                prompt_text,
                has_binary,
            }
        }
        _ => ParsedPromptContent::default(),
    }
}

/// Render one embedded text resource as clearly-delimited prompt text.
pub fn format_embedded_resource_as_text(resource: &Value) -> String {
    let uri = resource
        .get("uri")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = uri
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(uri);
    let text = resource
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!(
        "{EMBEDDED_RESOURCE_DELIMITER}: {name} -----\n{text}\n----- End of attached file: {name} -----"
    )
}

/// Append the delimited embedded text resources to an already-finalized
/// prompt text. Binary blocks are never appended and must have been rejected
/// beforehand.
pub fn append_embedded_resources_as_text(prompt_text: &str, blocks: &[Value]) -> String {
    let sections: Vec<String> = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("resource"))
        .filter_map(|block| block.get("resource"))
        .filter(|resource| resource.get("text").and_then(Value::as_str).is_some())
        .map(format_embedded_resource_as_text)
        .collect();
    if sections.is_empty() {
        return prompt_text.to_string();
    }
    let mut combined = prompt_text.to_string();
    for section in sections {
        combined.push_str("\n\n");
        combined.push_str(&section);
    }
    combined
}

/// Prompt capabilities advertised by an initialized ACP agent. A capability
/// the agent did not declare is treated as unsupported, matching the ACP
/// protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AgentPromptCapabilities {
    pub image: bool,
    pub embedded_context: bool,
}

pub fn agent_prompt_capabilities(init_result: Option<&Value>) -> AgentPromptCapabilities {
    let capabilities = init_result
        .and_then(|result| result.get("agentCapabilities"))
        .and_then(|caps| caps.get("promptCapabilities"));
    match capabilities {
        Some(Value::Object(prompt_capabilities)) => AgentPromptCapabilities {
            image: prompt_capabilities.get("image") == Some(&Value::Bool(true)),
            embedded_context: prompt_capabilities.get("embeddedContext")
                == Some(&Value::Bool(true)),
        },
        _ => AgentPromptCapabilities::default(),
    }
}

/// Build the ACP content blocks dispatched to a standard ACP provider. The
/// finalized prompt text becomes the leading text block. Non-text blocks pass
/// through unchanged when the agent declared embedded-context support;
/// otherwise embedded TEXT resources merge into the leading text block as
/// clearly delimited text. Pure-text prompts produce exactly one text block,
/// matching the previous behavior.
pub fn build_acp_dispatch_blocks(
    prompt_text: &str,
    blocks: &[Value],
    capabilities: AgentPromptCapabilities,
) -> Vec<Value> {
    let mut leading_text = prompt_text.to_string();
    let mut trailing: Vec<Value> = Vec::new();
    for block in blocks {
        let block_type = block.get("type").and_then(Value::as_str);
        if block_type == Some("text") {
            continue;
        }
        let is_text_resource = block_type == Some("resource")
            && block
                .get("resource")
                .and_then(|resource| resource.get("text"))
                .and_then(Value::as_str)
                .is_some();
        if !capabilities.embedded_context && is_text_resource {
            leading_text =
                append_embedded_resources_as_text(&leading_text, std::slice::from_ref(block));
            continue;
        }
        trailing.push(block.clone());
    }
    let mut dispatch = vec![serde_json::json!({ "type": "text", "text": leading_text })];
    dispatch.extend(trailing);
    dispatch
}

/// Replace the leading text block's text (or insert one) so recovery-context
/// prefixes applied after block construction stay in the dispatched prompt.
pub fn with_leading_prompt_text(blocks: Vec<Value>, text: &str) -> Vec<Value> {
    let mut updated = blocks;
    if let Some(first) = updated.first_mut() {
        if first.get("type").and_then(Value::as_str) == Some("text") {
            first["text"] = Value::String(text.to_string());
            return updated;
        }
    }
    updated.insert(0, serde_json::json!({ "type": "text", "text": text }));
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_plain_string_prompt() {
        let parsed = parse_prompt_content_blocks(Some(&json!("hello")));
        assert_eq!(parsed.prompt_text, "hello");
        assert_eq!(parsed.blocks.len(), 1);
        assert!(!parsed.has_binary);
    }

    #[test]
    fn parses_mixed_blocks_and_projects_text() {
        let parsed = parse_prompt_content_blocks(Some(&json!([
            { "type": "text", "text": "request" },
            { "type": "text", "text": "Repository files:\n- src/main.rs" },
            {
                "type": "resource",
                "resource": {
                    "uri": "routa-team-input://t/0",
                    "mimeType": "text/plain",
                    "text": "notes"
                }
            },
            { "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" },
            { "type": "unknown" }
        ])));
        assert_eq!(
            parsed.prompt_text,
            "request\nRepository files:\n- src/main.rs"
        );
        assert_eq!(parsed.blocks.len(), 4);
        assert!(parsed.has_binary);
    }

    #[test]
    fn ignores_invalid_blocks() {
        let parsed = parse_prompt_content_blocks(Some(&json!([
            { "type": "text" },
            { "type": "image", "data": "", "mimeType": "image/png" },
            { "type": "resource", "resource": { "uri": "" } },
            { "type": "resource", "resource": { "uri": "file:///a" } },
            "not-an-object"
        ])));
        assert!(parsed.blocks.is_empty());
        assert_eq!(parsed.prompt_text, "");
        assert!(!parsed.has_binary);
    }

    #[test]
    fn blob_resources_count_as_binary() {
        let parsed = parse_prompt_content_blocks(Some(&json!([
            {
                "type": "resource",
                "resource": { "uri": "file:///a.bin", "blob": "YmluYXJ5" }
            }
        ])));
        assert!(parsed.has_binary);
    }

    #[test]
    fn appends_delimited_text_resources() {
        let blocks = vec![json!({
            "type": "resource",
            "resource": { "uri": "routa-team-input://t/0", "text": "content" }
        })];
        let combined = append_embedded_resources_as_text("prompt", &blocks);
        assert!(combined.starts_with("prompt\n\n"));
        assert!(combined.contains("Attached file: 0"));
        assert!(combined.contains("content"));
        assert!(combined.contains("End of attached file: 0"));
    }

    #[test]
    fn capabilities_default_to_unsupported() {
        let caps = agent_prompt_capabilities(None);
        assert!(!caps.image);
        assert!(!caps.embedded_context);
        let caps = agent_prompt_capabilities(Some(&json!({ "agentCapabilities": {} })));
        assert!(!caps.image);
    }

    #[test]
    fn reads_declared_capabilities() {
        let caps = agent_prompt_capabilities(Some(&json!({
            "agentCapabilities": {
                "promptCapabilities": { "image": true, "embeddedContext": true }
            }
        })));
        assert!(caps.image);
        assert!(caps.embedded_context);
    }

    #[test]
    fn dispatch_blocks_pass_through_with_capabilities() {
        let blocks = vec![
            json!({ "type": "text", "text": "request" }),
            json!({
                "type": "resource",
                "resource": { "uri": "routa-team-input://t/0", "text": "notes" }
            }),
            json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" }),
        ];
        let dispatch = build_acp_dispatch_blocks(
            "final text",
            &blocks,
            AgentPromptCapabilities {
                image: true,
                embedded_context: true,
            },
        );
        assert_eq!(dispatch.len(), 3);
        assert_eq!(dispatch[0]["text"], "final text");
        assert_eq!(dispatch[1]["type"], "resource");
        assert_eq!(dispatch[2]["type"], "image");
    }

    #[test]
    fn dispatch_blocks_convert_resources_without_embedded_context() {
        let blocks = vec![
            json!({ "type": "text", "text": "request" }),
            json!({
                "type": "resource",
                "resource": { "uri": "routa-team-input://t/0", "text": "notes" }
            }),
            json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" }),
        ];
        let dispatch = build_acp_dispatch_blocks(
            "final text",
            &blocks,
            AgentPromptCapabilities {
                image: true,
                embedded_context: false,
            },
        );
        assert_eq!(dispatch.len(), 2);
        let leading = dispatch[0]["text"].as_str().unwrap_or_default();
        assert!(leading.starts_with("final text"));
        assert!(leading.contains("notes"));
        assert_eq!(dispatch[1]["type"], "image");
    }

    #[test]
    fn pure_text_dispatch_is_single_text_block() {
        let dispatch = build_acp_dispatch_blocks(
            "plain",
            &[json!({ "type": "text", "text": "plain" })],
            AgentPromptCapabilities::default(),
        );
        assert_eq!(dispatch, vec![json!({ "type": "text", "text": "plain" })]);
    }

    #[test]
    fn leading_text_replacement_keeps_trailing_blocks() {
        let blocks = vec![
            json!({ "type": "text", "text": "original" }),
            json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" }),
        ];
        let updated = with_leading_prompt_text(blocks, "prefixed");
        assert_eq!(updated[0]["text"], "prefixed");
        assert_eq!(updated[1]["type"], "image");
    }
}
