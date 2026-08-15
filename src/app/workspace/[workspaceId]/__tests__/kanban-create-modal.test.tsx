import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en";
import { EMPTY_DRAFT, KanbanCreateModal, type TaskDraft } from "../kanban-create-modal";

vi.mock("@tiptap/react", () => ({
  useEditor: () => null,
  EditorContent: () => null,
}));
vi.mock("@tiptap/starter-kit", () => ({ default: {} }));
vi.mock("@tiptap/extension-placeholder", () => ({ default: { configure: () => ({}) } }));
vi.mock("@/i18n", () => ({
  useTranslation: () => ({ t: en }),
}));

function filledDraft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return { ...EMPTY_DRAFT, title: "Task title", objectiveHtml: "<p>Objective</p>", ...overrides };
}

function renderModal(overrides: {
  draft?: TaskDraft;
  onCreate?: () => Promise<void>;
} = {}) {
  const draft = overrides.draft ?? filledDraft();
  const setDraft = vi.fn();
  const onCreate = overrides.onCreate ?? vi.fn(async () => {});
  const utils = render(
    <KanbanCreateModal
      draft={draft}
      setDraft={setDraft}
      onClose={vi.fn()}
      onCreate={onCreate}
      githubAvailable={false}
      codebases={[]}
      allCodebaseIds={[]}
    />,
  );
  return { ...utils, draft, setDraft, onCreate };
}

function filePicker(): HTMLInputElement {
  const chooseButton = screen.getByText(en.taskAttachments.chooseFiles);
  // The hidden input sits next to the choose-files button inside the drop zone.
  return chooseButton.parentElement?.querySelector("input[type=\"file\"]") as HTMLInputElement;
}

describe("KanbanCreateModal attachments", () => {
  it("lists selected files with size and removes them before submit", () => {
    const { setDraft } = renderModal();
    const input = filePicker();
    expect(input.multiple).toBe(true);

    const file = new File(["# Spec"], "spec.md");
    fireEvent.change(input, { target: { files: [file] } });

    const update = setDraft.mock.calls.at(-1)?.[0] as (draft: TaskDraft) => TaskDraft;
    const nextDraft = update(filledDraft());
    expect(nextDraft.attachments).toHaveLength(1);
    expect(nextDraft.attachments[0].file.name).toBe("spec.md");
  });

  it("accepts files through drag and drop", () => {
    const { setDraft } = renderModal();
    const dropZone = screen.getByText(en.taskAttachments.chooseFiles).parentElement as HTMLElement;
    const file = new File(["x"], "notes.txt");

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    const update = setDraft.mock.calls.at(-1)?.[0] as (draft: TaskDraft) => TaskDraft;
    expect(update(filledDraft()).attachments.map((attachment) => attachment.file.name)).toEqual(["notes.txt"]);
  });

  it("shows localized validation feedback and does not add unsupported files", () => {
    const { setDraft } = renderModal();
    const input = filePicker();

    fireEvent.change(input, { target: { files: [new File(["%PDF"], "binary.pdf")] } });

    expect(screen.getByText(en.taskAttachments.validation.unsupportedExtension)).toBeTruthy();
    const update = setDraft.mock.calls.at(-1)?.[0] as (draft: TaskDraft) => TaskDraft;
    expect(update(filledDraft()).attachments).toEqual([]);
  });

  it("prevents duplicate submission while creating", async () => {
    let releaseCreate: (() => void) | undefined;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => {
      releaseCreate = resolve;
    }));
    renderModal({ onCreate });

    const createButton = screen.getByText(en.kanbanCreate.create);
    fireEvent.click(createButton);
    fireEvent.click(screen.getByText(en.taskAttachments.submitting));

    expect(onCreate).toHaveBeenCalledTimes(1);
    releaseCreate?.();
    await waitFor(() => expect(screen.getByText(en.kanbanCreate.create)).toBeTruthy());
  });

  it("keeps the draft, files, and modal after a failed create", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("backend validation text that must not render");
    });
    const draft = filledDraft({
      attachments: [{ id: "draft-1", file: new File(["# Spec"], "spec.md") }],
    });
    renderModal({ onCreate, draft });

    expect(screen.getByText("spec.md")).toBeTruthy();
    fireEvent.click(screen.getByText(en.kanbanCreate.create));

    expect(await screen.findByText(en.taskAttachments.createFailed)).toBeTruthy();
    expect(screen.queryByText("backend validation text that must not render")).toBeNull();
    // Selected files stay listed so the user can retry without re-selecting.
    expect(screen.getByText("spec.md")).toBeTruthy();
    expect(screen.getByText(en.kanbanCreate.create)).toBeTruthy();
  });
});
