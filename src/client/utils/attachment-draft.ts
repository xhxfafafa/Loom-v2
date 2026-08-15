/**
 * Client-side attachment draft state and serialization shared by the Kanban
 * task-create modal and the Team Run launch input.
 *
 * Browser `File` objects stay in draft-only React state; Base64 encoding only
 * happens at submit time. The limit checks here are preflight convenience for
 * immediate localized feedback — the backend remains authoritative.
 */

import {
  IMAGE_EXTENSION_MEDIA_TYPES,
  TASK_ATTACHMENT_LIMITS,
  TEXT_EXTENSIONS,
  encodeBytesToBase64,
  getAttachmentExtension,
  sanitizeAttachmentFilename,
  type CreateTaskAttachmentInput,
  type TaskAttachmentValidationError,
} from "@/core/kanban/task-attachments";
import type { TranslationDictionary } from "@/i18n";

/** Local input attachment draft (`File` stays in browser state until send). */
export interface TaskDraftAttachment {
  id: string; // client-only stable key
  file: File;
}

/** A repository file selected through the `@` mention search. */
export interface RepositoryFileReference {
  /** Repository-relative path used in prompt text. */
  path: string;
  /** Display label shown in the input. */
  label: string;
}

export interface AttachmentDraftRejection {
  filename: string;
  reason: TaskAttachmentValidationError;
}

const ACCEPTED_EXTENSIONS = [
  ...TEXT_EXTENSIONS,
  ...Object.keys(IMAGE_EXTENSION_MEDIA_TYPES),
].sort();

/** `accept` attribute for the file picker: explicit extensions only. */
export const ATTACHMENT_PICKER_ACCEPT = ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`).join(",");

let attachmentDraftSequence = 0;

function nextAttachmentDraftId(): string {
  attachmentDraftSequence += 1;
  return `attachment-draft-${attachmentDraftSequence}`;
}

export function isImageAttachmentFilename(filename: string): boolean {
  return getAttachmentExtension(filename) in IMAGE_EXTENSION_MEDIA_TYPES;
}

/**
 * Validate incoming files against the current draft and merge the accepted
 * ones. Invalid or over-limit files are reported with a validation reason so
 * the UI can show a localized message without submitting anything.
 */
export function addAttachmentDrafts(
  existing: TaskDraftAttachment[],
  files: ArrayLike<File>,
): { drafts: TaskDraftAttachment[]; rejections: AttachmentDraftRejection[] } {
  const drafts = [...existing];
  const rejections: AttachmentDraftRejection[] = [];
  let imageCount = drafts.filter((draft) => isImageAttachmentFilename(draft.file.name)).length;
  let totalBytes = drafts.reduce((sum, draft) => sum + draft.file.size, 0);

  for (const file of Array.from(files)) {
    const filename = sanitizeAttachmentFilename(file.name);
    const reject = (reason: TaskAttachmentValidationError) => {
      rejections.push({ filename: filename || file.name, reason });
    };

    if (!filename) {
      reject("invalid_filename");
      continue;
    }
    if (filename.length > TASK_ATTACHMENT_LIMITS.maxFilenameLength) {
      reject("filename_too_long");
      continue;
    }
    const extension = getAttachmentExtension(filename);
    const isImage = extension in IMAGE_EXTENSION_MEDIA_TYPES;
    // Extensionless files (Dockerfile, LICENSE, ...) pass preflight as text
    // candidates; the backends stay authoritative on UTF-8 validity.
    if (!isImage && extension !== "" && !TEXT_EXTENSIONS.has(extension)) {
      reject("unsupported_extension");
      continue;
    }
    if (isImage && file.size > TASK_ATTACHMENT_LIMITS.maxImageBytes) {
      reject("image_too_large");
      continue;
    }
    if (!isImage && file.size > TASK_ATTACHMENT_LIMITS.maxTextBytes) {
      reject("text_too_large");
      continue;
    }
    if (drafts.length >= TASK_ATTACHMENT_LIMITS.maxFiles) {
      reject("too_many_attachments");
      continue;
    }
    if (isImage) {
      if (imageCount >= TASK_ATTACHMENT_LIMITS.maxImages) {
        reject("too_many_images");
        continue;
      }
      imageCount += 1;
    }
    if (totalBytes + file.size > TASK_ATTACHMENT_LIMITS.maxTotalDecodedBytes) {
      reject("total_too_large");
      continue;
    }

    totalBytes += file.size;
    drafts.push({ id: nextAttachmentDraftId(), file });
  }

  return { drafts, rejections };
}

/** Read each draft `File` as bytes and encode raw Base64 for the request body. */
export async function serializeAttachmentDrafts(
  drafts: TaskDraftAttachment[],
): Promise<CreateTaskAttachmentInput[]> {
  const inputs: CreateTaskAttachmentInput[] = [];
  for (const draft of drafts) {
    const buffer = await draft.file.arrayBuffer();
    inputs.push({
      filename: sanitizeAttachmentFilename(draft.file.name),
      contentBase64: encodeBytesToBase64(new Uint8Array(buffer)),
    });
  }
  return inputs;
}

export function formatAttachmentFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAttachmentValidationError(
  t: TranslationDictionary,
  reason: TaskAttachmentValidationError,
): string {
  const { validation } = t.taskAttachments;
  switch (reason) {
    case "too_many_attachments":
      return validation.tooManyAttachments;
    case "too_many_images":
      return validation.tooManyImages;
    case "invalid_filename":
      return validation.invalidFilename;
    case "filename_too_long":
      return validation.filenameTooLong;
    case "unsupported_extension":
      return validation.unsupportedExtension;
    case "text_too_large":
      return validation.textTooLarge;
    case "image_too_large":
      return validation.imageTooLarge;
    case "total_too_large":
      return validation.totalTooLarge;
    default:
      return validation.invalidFile;
  }
}
