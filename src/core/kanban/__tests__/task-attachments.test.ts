import { describe, expect, it } from "vitest";
import {
  TASK_ATTACHMENT_LIMITS,
  TASK_INPUT_ATTACHMENT_CONTEXT,
  buildTaskInputArtifact,
  buildTaskInputAttachmentSummaries,
  encodeBytesToBase64,
  formatTaskInputAttachmentSection,
  getAttachmentExtension,
  normalizeTaskAttachments,
  sanitizeAttachmentFilename,
  type CreateTaskAttachmentInput,
} from "../task-attachments";
import type { Artifact } from "../../models/artifact";

function bytesToInput(filename: string, bytes: number[]): CreateTaskAttachmentInput {
  return { filename, contentBase64: encodeBytesToBase64(new Uint8Array(bytes)) };
}

function textInput(filename: string, text: string): CreateTaskAttachmentInput {
  return { filename, contentBase64: btoa(unescape(encodeURIComponent(text))) };
}

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

describe("sanitizeAttachmentFilename", () => {
  it("keeps only the last path segment and drops control characters", () => {
    expect(sanitizeAttachmentFilename("/tmp/uploads/spec.md")).toBe("spec.md");
    expect(sanitizeAttachmentFilename("C:\\notes\\plan.txt")).toBe("plan.txt");
    expect(sanitizeAttachmentFilename("bad\u0000na\u001fme.txt")).toBe("badname.txt");
    expect(sanitizeAttachmentFilename("  padded.md  ")).toBe("padded.md");
  });
});

describe("getAttachmentExtension", () => {
  it("returns the lowercased extension without the dot", () => {
    expect(getAttachmentExtension("spec.MD")).toBe("md");
    expect(getAttachmentExtension("archive.tar.gz")).toBe("gz");
    expect(getAttachmentExtension("noext")).toBe("");
    expect(getAttachmentExtension("trailing.")).toBe("");
    expect(getAttachmentExtension(".hidden")).toBe("");
  });
});

describe("normalizeTaskAttachments", () => {
  it("accepts an empty list", () => {
    expect(normalizeTaskAttachments(undefined)).toEqual({ ok: true, attachments: [] });
    expect(normalizeTaskAttachments([])).toEqual({ ok: true, attachments: [] });
  });

  it("normalizes valid UTF-8 text attachments", () => {
    const result = normalizeTaskAttachments([textInput("notes.md", "# Title\n\n内容")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      filename: "notes.md",
      mediaType: "text/markdown",
      encoding: "utf8",
      content: "# Title\n\n内容",
    });
    expect(result.attachments[0].size).toBe(new TextEncoder().encode("# Title\n\n内容").length);
  });

  it("accepts a text file exactly at the size limit", () => {
    const text = "a".repeat(TASK_ATTACHMENT_LIMITS.maxTextBytes);
    const result = normalizeTaskAttachments([textInput("max.txt", text)]);
    expect(result.ok).toBe(true);
  });

  it("rejects text above the size limit", () => {
    const text = "a".repeat(TASK_ATTACHMENT_LIMITS.maxTextBytes + 1);
    expect(normalizeTaskAttachments([textInput("big.txt", text)])).toEqual({
      ok: false,
      reason: "text_too_large",
    });
  });

  it.each([
    ["png", PNG_BYTES, "image/png"],
    ["jpg", JPEG_BYTES, "image/jpeg"],
    ["jpeg", JPEG_BYTES, "image/jpeg"],
    ["webp", WEBP_BYTES, "image/webp"],
  ])("normalizes %s images from signature bytes", (extension, bytes, mediaType) => {
    const result = normalizeTaskAttachments([bytesToInput(`photo.${extension}`, bytes)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0]).toMatchObject({
      filename: `photo.${extension}`,
      mediaType,
      encoding: "base64",
    });
    expect(result.attachments[0].content).toBe(encodeBytesToBase64(new Uint8Array(bytes)));
    expect(result.attachments[0].size).toBe(bytes.length);
  });

  it("rejects an image whose bytes do not match its extension", () => {
    expect(normalizeTaskAttachments([bytesToInput("photo.jpg", PNG_BYTES)])).toEqual({
      ok: false,
      reason: "image_signature_mismatch",
    });
  });

  it("rejects image-extension files whose bytes are not images", () => {
    expect(normalizeTaskAttachments([textInput("fake.png", "not really an image")])).toEqual({
      ok: false,
      reason: "image_signature_mismatch",
    });
  });

  it("rejects unsupported extensions", () => {
    expect(normalizeTaskAttachments([textInput("binary.pdf", "%PDF-1.4")])).toEqual({
      ok: false,
      reason: "unsupported_extension",
    });
  });

  it("rejects non-UTF-8 text bytes", () => {
    expect(normalizeTaskAttachments([bytesToInput("latin.txt", [0xff, 0xfe, 0xfd])])).toEqual({
      ok: false,
      reason: "invalid_text_encoding",
    });
  });

  it("rejects text containing control characters other than tab, LF, and CR", () => {
    expect(normalizeTaskAttachments([bytesToInput("nul.txt", [0x61, 0x00, 0x62])])).toEqual({
      ok: false,
      reason: "invalid_text_content",
    });
    const tabNewline = normalizeTaskAttachments([bytesToInput("ok.txt", [0x09, 0x0a, 0x0d])]);
    expect(tabNewline.ok).toBe(true);
  });

  it("rejects invalid Base64 payloads", () => {
    expect(normalizeTaskAttachments([{ filename: "a.txt", contentBase64: "data:text/plain;base64,AAA=" }]))
      .toEqual({ ok: false, reason: "invalid_base64" });
    expect(normalizeTaskAttachments([{ filename: "a.txt", contentBase64: "not base64!!" }]))
      .toEqual({ ok: false, reason: "invalid_base64" });
    expect(normalizeTaskAttachments([{ filename: "a.txt", contentBase64: "AAA" }]))
      .toEqual({ ok: false, reason: "invalid_base64" });
  });

  it("rejects non-canonical Base64 while accepting its canonical form", () => {
    // "QR==" and "QQ==" decode to the same byte, but "QR==" carries non-zero
    // trailing padding bits. Rust base64::STANDARD refuses such encodings, so
    // the validator must too instead of trusting the lenient atob decoding.
    expect(normalizeTaskAttachments([{ filename: "a.txt", contentBase64: "QR==" }]))
      .toEqual({ ok: false, reason: "invalid_base64" });
    const canonical = normalizeTaskAttachments([{ filename: "a.txt", contentBase64: "QQ==" }]);
    expect(canonical).toEqual({
      ok: true,
      attachments: [expect.objectContaining({ filename: "a.txt", encoding: "utf8", content: "A" })],
    });
  });

  it("rejects empty or over-long filenames", () => {
    expect(normalizeTaskAttachments([textInput("   ", "x")])).toEqual({
      ok: false,
      reason: "invalid_filename",
    });
    const longName = `${"a".repeat(TASK_ATTACHMENT_LIMITS.maxFilenameLength - 4)}.txt`;
    expect(longName.length).toBe(TASK_ATTACHMENT_LIMITS.maxFilenameLength);
    expect(normalizeTaskAttachments([textInput(longName, "x")]).ok).toBe(true);
    expect(normalizeTaskAttachments([textInput(`a${longName}`, "x")])).toEqual({
      ok: false,
      reason: "filename_too_long",
    });
  });

  it("accepts up to five files and rejects the sixth", () => {
    const five = Array.from({ length: 5 }, (_, index) => textInput(`file-${index}.txt`, "x"));
    expect(normalizeTaskAttachments(five).ok).toBe(true);
    expect(normalizeTaskAttachments([...five, textInput("file-5.txt", "x")])).toEqual({
      ok: false,
      reason: "too_many_attachments",
    });
  });

  it("accepts up to three images and rejects the fourth", () => {
    const three = [0, 1, 2].map((index) => bytesToInput(`img-${index}.png`, PNG_BYTES));
    expect(normalizeTaskAttachments(three).ok).toBe(true);
    expect(normalizeTaskAttachments([...three, bytesToInput("img-3.png", PNG_BYTES)])).toEqual({
      ok: false,
      reason: "too_many_images",
    });
  });

  it("rejects when the decoded total exceeds the budget", () => {
    // 3 images under the per-image cap plus two max-size text files stay
    // individually valid but exceed the 6 MiB decoded total budget.
    const image = new Uint8Array(Math.floor(TASK_ATTACHMENT_LIMITS.maxImageBytes * 0.95));
    image.set(PNG_BYTES);
    const imageInput = (index: number) => ({
      filename: `img-${index}.png`,
      contentBase64: encodeBytesToBase64(image),
    });
    const text = textInput("notes-0.txt", "a".repeat(TASK_ATTACHMENT_LIMITS.maxTextBytes));
    const text2 = textInput("notes-1.txt", "a".repeat(TASK_ATTACHMENT_LIMITS.maxTextBytes));
    const inputs = [imageInput(0), imageInput(1), imageInput(2), text, text2];
    expect(normalizeTaskAttachments(inputs)).toEqual({ ok: false, reason: "total_too_large" });
  });
});

describe("buildTaskInputArtifact", () => {
  it("creates an attachment Artifact with user-source metadata", () => {
    const artifact = buildTaskInputArtifact({
      id: "artifact-1",
      taskId: "task-1",
      workspaceId: "workspace-1",
      attachment: {
        filename: "spec.md",
        mediaType: "text/markdown",
        encoding: "utf8",
        content: "# Spec",
        size: 6,
      },
    });
    expect(artifact).toMatchObject({
      id: "artifact-1",
      type: "attachment",
      taskId: "task-1",
      workspaceId: "workspace-1",
      content: "# Spec",
      context: TASK_INPUT_ATTACHMENT_CONTEXT,
      status: "provided",
    });
    expect(artifact.providedByAgentId).toBeUndefined();
    expect(artifact.metadata).toEqual({
      filename: "spec.md",
      mediaType: "text/markdown",
      encoding: "utf8",
      size: "6",
      source: "user",
    });
  });
});

describe("prompt discovery helpers", () => {
  const attachmentRecord: Artifact = {
    id: "artifact-9",
    type: "attachment",
    taskId: "task-1",
    workspaceId: "workspace-1",
    content: "ignored by summaries",
    context: TASK_INPUT_ATTACHMENT_CONTEXT,
    status: "provided",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    metadata: {
      filename: "spec.md",
      mediaType: "text/markdown",
      encoding: "utf8",
      size: "6",
      source: "user",
    },
  };

  it("builds summaries only from attachment artifacts and never exposes content", () => {
    const screenshot: Artifact = { ...attachmentRecord, id: "artifact-10", type: "screenshot" };
    const summaries = buildTaskInputAttachmentSummaries([attachmentRecord, screenshot]);
    expect(summaries).toEqual([{
      artifactId: "artifact-9",
      filename: "spec.md",
      mediaType: "text/markdown",
      encoding: "utf8",
      size: 6,
    }]);
  });

  it("formats the prompt section with read guidance and evidence boundary", () => {
    expect(formatTaskInputAttachmentSection([])).toBeUndefined();
    const section = formatTaskInputAttachmentSection([{
      artifactId: "artifact-9",
      filename: "spec.md",
      mediaType: "text/markdown",
      encoding: "utf8",
      size: 6,
    }]);
    expect(section).toContain("## Input Attachments");
    expect(section).toContain("spec.md (text/markdown, 6 bytes), artifact ID: artifact-9");
    expect(section).toContain("get_artifact");
    expect(section).toContain("not implementation evidence");
  });
});
