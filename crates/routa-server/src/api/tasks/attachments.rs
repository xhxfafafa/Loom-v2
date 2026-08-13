//! Task input attachment validation and normalization.
//!
//! Parity module for the TypeScript validator in
//! `src/core/kanban/task-attachments.ts`: both backends normalize submitted
//! attachments into the same shape before persisting them as
//! `type=attachment` Artifact records from the task-create route.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Utc;
use routa_core::models::artifact::{Artifact, ArtifactStatus, ArtifactType};
use std::collections::BTreeMap;

use super::dto::CreateTaskAttachmentInput;

pub const TASK_INPUT_ATTACHMENT_CONTEXT: &str =
    "Input attachment supplied when the task was created";

const MAX_FILES: usize = 5;
const MAX_IMAGES: usize = 3;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES: usize = 6 * 1024 * 1024;
const MAX_FILENAME_LENGTH: usize = 255;

/// Internal validation reasons; the public HTTP contract only exposes
/// `{"error": "Invalid task attachment"}` with status 400.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAttachmentValidationError {
    TooManyAttachments,
    TooManyImages,
    InvalidFilename,
    FilenameTooLong,
    InvalidBase64,
    ImageSignatureMismatch,
    UnsupportedExtension,
    InvalidTextEncoding,
    InvalidTextContent,
    TextTooLarge,
    ImageTooLarge,
    TotalTooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAttachmentEncoding {
    Utf8,
    Base64,
}

impl TaskAttachmentEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Utf8 => "utf8",
            Self::Base64 => "base64",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTaskAttachment {
    pub filename: String,
    pub media_type: String,
    pub encoding: TaskAttachmentEncoding,
    pub content: String,
    pub size: usize,
}

/// Keep the last path segment and drop control characters.
pub fn sanitize_attachment_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|character| {
            let code = *character as u32;
            code >= 0x20 && code != 0x7f
        })
        .collect();
    cleaned.trim().to_string()
}

fn extension_of(filename: &str) -> String {
    match filename.rfind('.') {
        Some(dot) if dot > 0 && dot < filename.len() - 1 => {
            filename[dot + 1..].to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

fn detect_image_signature(bytes: &[u8]) -> Option<(&'static str, &'static [&'static str])> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(("image/png", &["png"]));
    }
    if bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff] {
        return Some(("image/jpeg", &["jpg", "jpeg"]));
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", &["webp"]));
    }
    None
}

fn is_text_extension(extension: &str) -> bool {
    matches!(
        extension,
        "txt"
            | "md"
            | "mdx"
            | "json"
            | "yaml"
            | "yml"
            | "csv"
            | "log"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "py"
            | "rs"
            | "go"
            | "java"
            | "kt"
            | "swift"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "rb"
            | "php"
            | "sh"
            | "sql"
            | "toml"
            | "ini"
            | "conf"
            | "properties"
            | "xml"
            | "css"
            | "scss"
    )
}

fn is_image_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "webp")
}

fn text_media_type(extension: &str) -> &'static str {
    match extension {
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "xml" => "application/xml",
        "css" => "text/css",
        "md" | "mdx" => "text/markdown",
        _ => "text/plain",
    }
}

fn normalize_one(
    input: &CreateTaskAttachmentInput,
) -> Result<NormalizedTaskAttachment, TaskAttachmentValidationError> {
    let filename = sanitize_attachment_filename(&input.filename);
    if filename.is_empty() {
        return Err(TaskAttachmentValidationError::InvalidFilename);
    }
    // Count Unicode scalar values, not UTF-8 bytes: 255 characters stay
    // valid even when their encoded form exceeds 255 bytes.
    if filename.chars().count() > MAX_FILENAME_LENGTH {
        return Err(TaskAttachmentValidationError::FilenameTooLong);
    }

    if input.content_base64.starts_with("data:") {
        return Err(TaskAttachmentValidationError::InvalidBase64);
    }
    let bytes = BASE64_STANDARD
        .decode(input.content_base64.as_bytes())
        .map_err(|_| TaskAttachmentValidationError::InvalidBase64)?;

    let extension = extension_of(&filename);
    if let Some((media_type, allowed_extensions)) = detect_image_signature(&bytes) {
        if !allowed_extensions.contains(&extension.as_str()) {
            return Err(TaskAttachmentValidationError::ImageSignatureMismatch);
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(TaskAttachmentValidationError::ImageTooLarge);
        }
        return Ok(NormalizedTaskAttachment {
            filename,
            media_type: media_type.to_string(),
            encoding: TaskAttachmentEncoding::Base64,
            content: BASE64_STANDARD.encode(&bytes),
            size: bytes.len(),
        });
    }

    if !extension.is_empty() && !is_text_extension(&extension) {
        return if is_image_extension(&extension) {
            Err(TaskAttachmentValidationError::ImageSignatureMismatch)
        } else {
            Err(TaskAttachmentValidationError::UnsupportedExtension)
        };
    }

    let text = String::from_utf8(bytes.clone())
        .map_err(|_| TaskAttachmentValidationError::InvalidTextEncoding)?;
    // Reject NUL and C0 controls other than tab, LF, and CR.
    if text.chars().any(|character| {
        let code = character as u32;
        code < 0x20 && character != '\t' && character != '\n' && character != '\r'
    }) {
        return Err(TaskAttachmentValidationError::InvalidTextContent);
    }
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(TaskAttachmentValidationError::TextTooLarge);
    }

    Ok(NormalizedTaskAttachment {
        filename,
        media_type: text_media_type(&extension).to_string(),
        encoding: TaskAttachmentEncoding::Utf8,
        content: text,
        size: bytes.len(),
    })
}

/// Validate and normalize every submitted attachment. The whole request is
/// rejected when any attachment is invalid.
pub fn normalize_task_attachments(
    inputs: &[CreateTaskAttachmentInput],
) -> Result<Vec<NormalizedTaskAttachment>, TaskAttachmentValidationError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    if inputs.len() > MAX_FILES {
        return Err(TaskAttachmentValidationError::TooManyAttachments);
    }

    let mut attachments = Vec::with_capacity(inputs.len());
    let mut image_count = 0usize;
    let mut total_decoded_bytes = 0usize;
    for input in inputs {
        let attachment = normalize_one(input)?;
        if attachment.encoding == TaskAttachmentEncoding::Base64 {
            image_count += 1;
            if image_count > MAX_IMAGES {
                return Err(TaskAttachmentValidationError::TooManyImages);
            }
        }
        total_decoded_bytes += attachment.size;
        if total_decoded_bytes > MAX_TOTAL_DECODED_BYTES {
            return Err(TaskAttachmentValidationError::TotalTooLarge);
        }
        attachments.push(attachment);
    }
    Ok(attachments)
}

/// Construct the Artifact record for a normalized attachment.
pub fn build_task_input_attachment(
    task_id: &str,
    workspace_id: &str,
    attachment: &NormalizedTaskAttachment,
) -> Artifact {
    let now = Utc::now();
    let mut metadata = BTreeMap::new();
    metadata.insert("filename".to_string(), attachment.filename.clone());
    metadata.insert("mediaType".to_string(), attachment.media_type.clone());
    metadata.insert(
        "encoding".to_string(),
        attachment.encoding.as_str().to_string(),
    );
    metadata.insert("size".to_string(), attachment.size.to_string());
    metadata.insert("source".to_string(), "user".to_string());
    Artifact {
        id: uuid::Uuid::new_v4().to_string(),
        artifact_type: ArtifactType::Attachment,
        task_id: task_id.to_string(),
        workspace_id: workspace_id.to_string(),
        provided_by_agent_id: None,
        requested_by_agent_id: None,
        request_id: None,
        content: Some(attachment.content.clone()),
        context: Some(TASK_INPUT_ATTACHMENT_CONTEXT.to_string()),
        status: ArtifactStatus::Provided,
        expires_at: None,
        metadata: Some(metadata),
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(filename: &str, content_base64: &str) -> CreateTaskAttachmentInput {
        CreateTaskAttachmentInput {
            filename: filename.to_string(),
            content_base64: content_base64.to_string(),
        }
    }

    const PNG_BYTES: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];

    fn base64(bytes: &[u8]) -> String {
        BASE64_STANDARD.encode(bytes)
    }

    #[test]
    fn empty_input_normalizes_to_empty_list() {
        assert_eq!(normalize_task_attachments(&[]).unwrap(), Vec::new());
    }

    #[test]
    fn valid_text_attachment_is_normalized() {
        let attachments =
            normalize_task_attachments(&[input("notes.md", &base64(b"# Title\nbody"))]).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].filename, "notes.md");
        assert_eq!(attachments[0].media_type, "text/markdown");
        assert_eq!(attachments[0].encoding, TaskAttachmentEncoding::Utf8);
        assert_eq!(attachments[0].content, "# Title\nbody");
        assert_eq!(attachments[0].size, 12);
    }

    #[test]
    fn extensionless_utf8_text_is_allowed() {
        let attachments =
            normalize_task_attachments(&[input("Dockerfile", &base64(b"FROM scratch"))]).unwrap();
        assert_eq!(attachments[0].media_type, "text/plain");
    }

    #[test]
    fn valid_png_attachment_is_normalized() {
        let attachments =
            normalize_task_attachments(&[input("icon.png", &base64(PNG_BYTES))]).unwrap();
        assert_eq!(attachments[0].media_type, "image/png");
        assert_eq!(attachments[0].encoding, TaskAttachmentEncoding::Base64);
        assert_eq!(attachments[0].content, base64(PNG_BYTES));
    }

    #[test]
    fn data_url_prefix_is_rejected() {
        let error =
            normalize_task_attachments(&[input("notes.txt", "data:text/plain;base64,aGVsbG8=")])
                .unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::InvalidBase64);
    }

    #[test]
    fn invalid_base64_is_rejected() {
        let error = normalize_task_attachments(&[input("notes.txt", "not base64!")]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::InvalidBase64);
    }

    #[test]
    fn non_canonical_base64_padding_bits_are_rejected() {
        // "QR==" and the canonical "QQ==" decode to the same byte, but the
        // trailing padding bits of "QR==" are non-zero, which
        // base64::STANDARD refuses. The TypeScript validator round-trips its
        // decoding to match this strict behavior.
        let canonical = normalize_task_attachments(&[input("notes.txt", "QQ==")]).unwrap();
        assert_eq!(canonical[0].content, "A");
        let error = normalize_task_attachments(&[input("notes.txt", "QR==")]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::InvalidBase64);
    }

    #[test]
    fn too_many_attachments_is_rejected() {
        let inputs: Vec<_> = (0..6)
            .map(|index| input(&format!("file{index}.txt"), &base64(b"x")))
            .collect();
        let error = normalize_task_attachments(&inputs).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::TooManyAttachments);
    }

    #[test]
    fn too_many_images_is_rejected() {
        let inputs: Vec<_> = (0..4)
            .map(|index| input(&format!("img{index}.png"), &base64(PNG_BYTES)))
            .collect();
        let error = normalize_task_attachments(&inputs).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::TooManyImages);
    }

    #[test]
    fn unsupported_extension_is_rejected() {
        let error =
            normalize_task_attachments(&[input("doc.pdf", &base64(b"%PDF-1.4"))]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::UnsupportedExtension);
    }

    #[test]
    fn image_extension_without_image_bytes_is_rejected() {
        let error =
            normalize_task_attachments(&[input("fake.png", &base64(b"not an image"))]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::ImageSignatureMismatch);
    }

    #[test]
    fn image_bytes_with_text_extension_is_rejected() {
        let error =
            normalize_task_attachments(&[input("icon.txt", &base64(PNG_BYTES))]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::ImageSignatureMismatch);
    }

    #[test]
    fn invalid_utf8_is_rejected() {
        let error = normalize_task_attachments(&[input("notes.txt", &base64(&[0xff, 0xfe, 0xfd]))])
            .unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::InvalidTextEncoding);
    }

    #[test]
    fn control_characters_are_rejected() {
        let error = normalize_task_attachments(&[input("notes.txt", &base64(b"bad\x01bytes"))])
            .unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::InvalidTextContent);
    }

    #[test]
    fn text_above_limit_is_rejected() {
        let big = vec![b'a'; MAX_TEXT_BYTES + 1];
        let error = normalize_task_attachments(&[input("big.txt", &base64(&big))]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::TextTooLarge);
    }

    #[test]
    fn total_decoded_size_above_limit_is_rejected() {
        let mut image_bytes = PNG_BYTES.to_vec();
        image_bytes.resize(MAX_IMAGE_BYTES, 0u8);
        let mut inputs: Vec<_> = (0..3)
            .map(|index| input(&format!("img{index}.png"), &base64(&image_bytes)))
            .collect();
        // 3 x 2 MiB images plus one text byte exceeds the 6 MiB decoded total.
        inputs.push(input("extra.txt", &base64(b"x")));
        let error = normalize_task_attachments(&inputs).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::TotalTooLarge);
    }

    #[test]
    fn total_decoded_size_at_limit_is_accepted() {
        let mut image_bytes = PNG_BYTES.to_vec();
        image_bytes.resize(MAX_IMAGE_BYTES, 0u8);
        let inputs: Vec<_> = (0..3)
            .map(|index| input(&format!("img{index}.png"), &base64(&image_bytes)))
            .collect();
        assert!(normalize_task_attachments(&inputs).is_ok());
    }

    #[test]
    fn filename_sanitization_strips_paths_and_control_chars() {
        assert_eq!(sanitize_attachment_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_attachment_filename("a\\b\\c.txt"), "c.txt");
        assert_eq!(sanitize_attachment_filename("na\x01me.txt"), "name.txt");
        assert_eq!(sanitize_attachment_filename(""), "");
        assert_eq!(sanitize_attachment_filename("   "), "");
    }

    #[test]
    fn long_filename_is_rejected() {
        let name = format!("{}.txt", "a".repeat(MAX_FILENAME_LENGTH));
        let error = normalize_task_attachments(&[input(&name, &base64(b"x"))]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::FilenameTooLong);
    }

    #[test]
    fn filename_length_counts_unicode_characters_not_bytes() {
        // 255 multi-byte characters exceed 255 UTF-8 bytes but stay within
        // the 255-character limit.
        let name: String = "汉".repeat(MAX_FILENAME_LENGTH);
        assert_eq!(name.chars().count(), MAX_FILENAME_LENGTH);
        assert!(name.len() > MAX_FILENAME_LENGTH);
        let attachments = normalize_task_attachments(&[input(&name, &base64(b"x"))]).unwrap();
        assert_eq!(attachments[0].filename, name);

        let too_long = format!("{name}a");
        let error = normalize_task_attachments(&[input(&too_long, &base64(b"x"))]).unwrap_err();
        assert_eq!(error, TaskAttachmentValidationError::FilenameTooLong);
    }

    #[test]
    fn build_artifact_uses_trusted_metadata() {
        let attachments =
            normalize_task_attachments(&[input("notes.txt", &base64(b"hi"))]).unwrap();
        let artifact = build_task_input_attachment("task-1", "workspace-1", &attachments[0]);
        assert_eq!(artifact.artifact_type, ArtifactType::Attachment);
        assert_eq!(artifact.status, ArtifactStatus::Provided);
        assert!(artifact.provided_by_agent_id.is_none());
        let metadata = artifact.metadata.unwrap();
        assert_eq!(metadata.get("filename").unwrap(), "notes.txt");
        assert_eq!(metadata.get("mediaType").unwrap(), "text/plain");
        assert_eq!(metadata.get("encoding").unwrap(), "utf8");
        assert_eq!(metadata.get("size").unwrap(), "2");
        assert_eq!(metadata.get("source").unwrap(), "user");
    }
}
