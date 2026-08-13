import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";
import { TASK_ATTACHMENT_LIMITS } from "@/core/kanban/task-attachments";
import {
  ATTACHMENT_PICKER_ACCEPT,
  addAttachmentDrafts,
  formatAttachmentFileSize,
  formatAttachmentValidationError,
  serializeAttachmentDrafts,
  type TaskDraftAttachment,
} from "../utils/attachment-draft";

function makeFile(name: string, content: Uint8Array<ArrayBuffer> | string): File {
  return new File([content], name);
}

function draftOf(name: string, size: number): TaskDraftAttachment {
  return { id: `existing-${name}`, file: makeFile(name, new Uint8Array(size)) };
}

describe("ATTACHMENT_PICKER_ACCEPT", () => {
  it("lists text and image extensions only", () => {
    expect(ATTACHMENT_PICKER_ACCEPT).toContain(".md");
    expect(ATTACHMENT_PICKER_ACCEPT).toContain(".png");
    expect(ATTACHMENT_PICKER_ACCEPT).toContain(".webp");
    expect(ATTACHMENT_PICKER_ACCEPT).not.toContain(".pdf");
  });
});

describe("addAttachmentDrafts", () => {
  it("accepts supported text and image files with stable client ids", () => {
    const { drafts, rejections } = addAttachmentDrafts([], [
      makeFile("spec.md", "# Spec"),
      makeFile("photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ]);
    expect(rejections).toEqual([]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].id).not.toBe(drafts[1].id);
    expect(drafts[0].file.name).toBe("spec.md");
  });

  it("keeps existing drafts and appends accepted files", () => {
    const existing = [draftOf("kept.txt", 10)];
    const { drafts } = addAttachmentDrafts(existing, [makeFile("new.txt", "x")]);
    expect(drafts.map((draft) => draft.file.name)).toEqual(["kept.txt", "new.txt"]);
  });

  it("rejects unsupported extensions", () => {
    const { drafts, rejections } = addAttachmentDrafts([], [makeFile("binary.pdf", "%PDF")]);
    expect(drafts).toEqual([]);
    expect(rejections).toEqual([{ filename: "binary.pdf", reason: "unsupported_extension" }]);
  });

  it("accepts extensionless text files such as Dockerfile and LICENSE", () => {
    // Preflight cannot read bytes, so extensionless files pass as text
    // candidates; the backends stay authoritative on UTF-8 validity.
    const { drafts, rejections } = addAttachmentDrafts([], [
      makeFile("Dockerfile", "FROM scratch"),
      makeFile("LICENSE", "MIT License"),
    ]);
    expect(rejections).toEqual([]);
    expect(drafts.map((draft) => draft.file.name)).toEqual(["Dockerfile", "LICENSE"]);
  });

  it("rejects empty filenames after sanitization", () => {
    const { rejections } = addAttachmentDrafts([], [makeFile(" ", "x")]);
    expect(rejections[0].reason).toBe("invalid_filename");
  });

  it("rejects text above 256 KiB and images above 2 MiB", () => {
    const bigText = makeFile("big.txt", new Uint8Array(TASK_ATTACHMENT_LIMITS.maxTextBytes + 1));
    expect(addAttachmentDrafts([], [bigText]).rejections[0].reason).toBe("text_too_large");

    const bigImage = makeFile("big.png", new Uint8Array(TASK_ATTACHMENT_LIMITS.maxImageBytes + 1));
    expect(addAttachmentDrafts([], [bigImage]).rejections[0].reason).toBe("image_too_large");
  });

  it("enforces the five-file cap across existing drafts", () => {
    const existing = Array.from({ length: 5 }, (_, index) => draftOf(`file-${index}.txt`, 10));
    const { rejections } = addAttachmentDrafts(existing, [makeFile("one-more.txt", "x")]);
    expect(rejections[0].reason).toBe("too_many_attachments");
  });

  it("enforces the three-image cap across existing drafts", () => {
    const existing = Array.from({ length: 3 }, (_, index) => draftOf(`img-${index}.png`, 10));
    const { rejections } = addAttachmentDrafts(existing, [makeFile("img-3.png", "x")]);
    expect(rejections[0].reason).toBe("too_many_images");
  });

  it("enforces the 6 MiB decoded total budget", () => {
    const imageSize = Math.floor(TASK_ATTACHMENT_LIMITS.maxImageBytes * 0.95);
    const existing = [
      draftOf("img-0.png", imageSize),
      draftOf("img-1.png", imageSize),
      draftOf("img-2.png", imageSize),
    ];
    const { rejections } = addAttachmentDrafts(existing, [
      makeFile("notes-0.txt", new Uint8Array(TASK_ATTACHMENT_LIMITS.maxTextBytes)),
      makeFile("notes-1.txt", new Uint8Array(TASK_ATTACHMENT_LIMITS.maxTextBytes)),
    ]);
    expect(rejections[0].reason).toBe("total_too_large");
  });
});

describe("serializeAttachmentDrafts", () => {
  it("reads files as bytes and encodes raw Base64 without a data: prefix", async () => {
    const text = "# Spec\n\n内容";
    const bytes = new TextEncoder().encode(text);
    const inputs = await serializeAttachmentDrafts([
      { id: "draft-1", file: makeFile("spec.md", bytes) },
    ]);
    expect(inputs).toEqual([{
      filename: "spec.md",
      contentBase64: btoa(String.fromCharCode(...bytes)),
    }]);
    expect(inputs[0].contentBase64).not.toMatch(/^data:/);
  });

  it("sanitizes filenames during serialization", async () => {
    const inputs = await serializeAttachmentDrafts([
      { id: "draft-2", file: makeFile("dir/spec.md", "x") },
    ]);
    expect(inputs[0].filename).toBe("spec.md");
  });
});

describe("formatAttachmentFileSize", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatAttachmentFileSize(512)).toBe("512 B");
    expect(formatAttachmentFileSize(1024)).toBe("1.0 KB");
    expect(formatAttachmentFileSize(256 * 1024)).toBe("256.0 KB");
    expect(formatAttachmentFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("formatAttachmentValidationError", () => {
  it("maps every reason to a localized message", () => {
    expect(formatAttachmentValidationError(en, "too_many_attachments"))
      .toBe(en.taskAttachments.validation.tooManyAttachments);
    expect(formatAttachmentValidationError(en, "unsupported_extension"))
      .toBe(en.taskAttachments.validation.unsupportedExtension);
    expect(formatAttachmentValidationError(en, "total_too_large"))
      .toBe(en.taskAttachments.validation.totalTooLarge);
  });

  it("falls back to the generic invalid-file message for server-only reasons", () => {
    expect(formatAttachmentValidationError(en, "invalid_base64"))
      .toBe(en.taskAttachments.validation.invalidFile);
    expect(formatAttachmentValidationError(en, "image_signature_mismatch"))
      .toBe(en.taskAttachments.validation.invalidFile);
  });
});
