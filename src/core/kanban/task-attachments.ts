/**
 * Task input attachment validation and normalization.
 *
 * User-provided text/image files submitted with the Kanban task-create request.
 * This is a task-domain validator, not a generic upload framework: both backends
 * normalize inputs into the same shape before persisting them as
 * `type=attachment` Artifact records.
 */

import type { Artifact } from "../models/artifact";

export interface CreateTaskAttachmentInput {
  filename: string;
  contentBase64: string;
}

export interface NormalizedTaskAttachment {
  filename: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}

/** Content-free summary of persisted attachment records for task prompts. */
export interface TaskInputAttachmentSummary {
  artifactId: string;
  filename: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  size: number;
}

export type TaskAttachmentValidationError =
  | "too_many_attachments"
  | "too_many_images"
  | "invalid_filename"
  | "filename_too_long"
  | "invalid_base64"
  | "image_signature_mismatch"
  | "unsupported_extension"
  | "invalid_text_encoding"
  | "invalid_text_content"
  | "text_too_large"
  | "image_too_large"
  | "total_too_large";

export type TaskAttachmentNormalizationResult =
  | { ok: true; attachments: NormalizedTaskAttachment[] }
  | { ok: false; reason: TaskAttachmentValidationError };

export const TASK_ATTACHMENT_LIMITS = {
  maxFiles: 5,
  maxImages: 3,
  maxTextBytes: 256 * 1024,
  maxImageBytes: 2 * 1024 * 1024,
  maxTotalDecodedBytes: 6 * 1024 * 1024,
  maxFilenameLength: 255,
} as const;

export const TASK_INPUT_ATTACHMENT_CONTEXT = "Input attachment supplied when the task was created";

export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "json", "yaml", "yml", "csv", "log",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt",
  "swift", "c", "h", "cpp", "hpp", "cs", "rb", "php", "sh", "sql",
  "toml", "ini", "conf", "properties", "xml", "css", "scss",
]);

export const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const TEXT_MEDIA_TYPES: Record<string, string> = {
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  xml: "application/xml",
  css: "text/css",
  md: "text/markdown",
  mdx: "text/markdown",
};

type ImageSignature = { mediaType: string; extensions: string[] };

function detectImageSignature(bytes: Uint8Array): ImageSignature | undefined {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return { mediaType: "image/png", extensions: ["png"] };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: "image/jpeg", extensions: ["jpg", "jpeg"] };
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 // R
    && bytes[1] === 0x49 // I
    && bytes[2] === 0x46 // F
    && bytes[3] === 0x46 // F
    && bytes[8] === 0x57 // W
    && bytes[9] === 0x45 // E
    && bytes[10] === 0x42 // B
    && bytes[11] === 0x50 // P
  ) {
    return { mediaType: "image/webp", extensions: ["webp"] };
  }
  return undefined;
}

/** Keep the last path segment and drop control characters. */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // Control characters are exactly what this sanitizer must strip from
  // untrusted filenames; the regex never matches user text content.
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export function getAttachmentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Runtime-neutral Base64 helpers (`atob`/`btoa` are globals in browsers and
 * Node >= 16), so this validator supports client preflight and authoritative
 * server normalization from one module.
 */
export function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeStrictBase64(value: string): Uint8Array | undefined {
  if (value.startsWith("data:")) return undefined;
  if (value.length % 4 !== 0 || !STRICT_BASE64_PATTERN.test(value)) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64ToBytes(value);
  } catch {
    return undefined;
  }
  // Reject non-canonical encodings (for example non-zero trailing padding
  // bits): canonical re-encoding must round-trip to the original input,
  // matching Rust base64::STANDARD, which refuses to decode them.
  if (encodeBytesToBase64(bytes) !== value) return undefined;
  return bytes;
}

function normalizeOne(
  input: CreateTaskAttachmentInput,
): { ok: true; attachment: NormalizedTaskAttachment } | { ok: false; reason: TaskAttachmentValidationError } {
  const filename = sanitizeAttachmentFilename(input.filename ?? "");
  if (!filename) return { ok: false, reason: "invalid_filename" };
  if (filename.length > TASK_ATTACHMENT_LIMITS.maxFilenameLength) {
    return { ok: false, reason: "filename_too_long" };
  }

  const bytes = decodeStrictBase64(input.contentBase64 ?? "");
  if (!bytes) return { ok: false, reason: "invalid_base64" };

  const extension = getAttachmentExtension(filename);
  const signature = detectImageSignature(bytes);
  if (signature) {
    if (!signature.extensions.includes(extension)) {
      return { ok: false, reason: "image_signature_mismatch" };
    }
    if (bytes.length > TASK_ATTACHMENT_LIMITS.maxImageBytes) {
      return { ok: false, reason: "image_too_large" };
    }
    return {
      ok: true,
      attachment: {
        filename,
        mediaType: signature.mediaType,
        encoding: "base64",
        content: encodeBytesToBase64(bytes),
        size: bytes.length,
      },
    };
  }

  if (extension && !TEXT_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      reason: extension in IMAGE_EXTENSION_MEDIA_TYPES ? "image_signature_mismatch" : "unsupported_extension",
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "invalid_text_encoding" };
  }
  // Reject NUL and C0 controls other than tab, LF, and CR.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return { ok: false, reason: "invalid_text_content" };
    }
  }
  if (bytes.length > TASK_ATTACHMENT_LIMITS.maxTextBytes) {
    return { ok: false, reason: "text_too_large" };
  }

  return {
    ok: true,
    attachment: {
      filename,
      mediaType: TEXT_MEDIA_TYPES[extension] ?? "text/plain",
      encoding: "utf8",
      content: text,
      size: bytes.length,
    },
  };
}

/**
 * Validate and normalize every submitted attachment. The whole request is
 * rejected when any attachment is invalid.
 */
export function normalizeTaskAttachments(
  inputs: CreateTaskAttachmentInput[] | undefined,
): TaskAttachmentNormalizationResult {
  const attachments: NormalizedTaskAttachment[] = [];
  if (!inputs || inputs.length === 0) {
    return { ok: true, attachments };
  }
  if (inputs.length > TASK_ATTACHMENT_LIMITS.maxFiles) {
    return { ok: false, reason: "too_many_attachments" };
  }

  let imageCount = 0;
  let totalDecodedBytes = 0;
  for (const input of inputs) {
    const result = normalizeOne(input);
    if (!result.ok) return result;
    const { attachment } = result;
    if (attachment.encoding === "base64") {
      imageCount += 1;
      if (imageCount > TASK_ATTACHMENT_LIMITS.maxImages) {
        return { ok: false, reason: "too_many_images" };
      }
    }
    totalDecodedBytes += attachment.size;
    if (totalDecodedBytes > TASK_ATTACHMENT_LIMITS.maxTotalDecodedBytes) {
      return { ok: false, reason: "total_too_large" };
    }
    attachments.push(attachment);
  }
  return { ok: true, attachments };
}

/** Construct the Artifact record for a normalized attachment. */
export function buildTaskInputArtifact(params: {
  id: string;
  taskId: string;
  workspaceId: string;
  attachment: NormalizedTaskAttachment;
}): Artifact {
  const now = new Date();
  return {
    id: params.id,
    type: "attachment",
    taskId: params.taskId,
    workspaceId: params.workspaceId,
    providedByAgentId: undefined,
    content: params.attachment.content,
    context: TASK_INPUT_ATTACHMENT_CONTEXT,
    status: "provided",
    createdAt: now,
    updatedAt: now,
    metadata: {
      filename: params.attachment.filename,
      mediaType: params.attachment.mediaType,
      encoding: params.attachment.encoding,
      size: String(params.attachment.size),
      source: "user",
    },
  };
}

/** Build prompt summaries from persisted `type=attachment` Artifact records. */
export function buildTaskInputAttachmentSummaries(artifacts: Artifact[]): TaskInputAttachmentSummary[] {
  return artifacts
    .filter((artifact) => artifact.type === "attachment")
    .map((artifact) => ({
      artifactId: artifact.id,
      filename: artifact.metadata?.filename ?? "attachment",
      mediaType: artifact.metadata?.mediaType ?? "text/plain",
      encoding: artifact.metadata?.encoding === "base64" ? "base64" as const : "utf8" as const,
      size: Number(artifact.metadata?.size ?? 0) || 0,
    }));
}

/**
 * Render the "## Input Attachments" prompt section, or undefined when the
 * task has no persisted input attachments.
 */
export function formatTaskInputAttachmentSection(
  summaries: TaskInputAttachmentSummary[],
): string | undefined {
  if (summaries.length === 0) return undefined;
  const lines = summaries.map(
    (summary) => `- ${summary.filename} (${summary.mediaType}, ${summary.size} bytes), artifact ID: ${summary.artifactId}`,
  );
  return [
    "## Input Attachments",
    "",
    ...lines,
    "",
    "Use get_artifact with the task, workspace, and artifact IDs to read an attachment.",
    "Treat attachments as task input, not implementation evidence.",
    "",
  ].join("\n");
}
