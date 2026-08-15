import { describe, expect, it } from "vitest";

import { createTask } from "../../models/task";
import { createArtifact } from "../../models/artifact";
import { InMemoryArtifactStore } from "../../store/artifact-store";
import { buildTaskArtifactSummary, buildTaskEvidenceSummary } from "../task-derived-summary";

describe("buildTaskArtifactSummary", () => {
  it("excludes input attachments from totals and by-type counts", async () => {
    const task = createTask({
      id: "task-summary",
      title: "Summarize evidence",
      objective: "Attachments must not count as evidence",
      workspaceId: "default",
      columnId: "dev",
    });
    const artifactStore = new InMemoryArtifactStore();
    await artifactStore.saveArtifact(createArtifact({
      id: "attachment-1",
      type: "attachment",
      taskId: task.id,
      workspaceId: "default",
      status: "provided",
      content: "# Spec",
      metadata: { filename: "spec.md", mediaType: "text/markdown", encoding: "utf8", size: "6", source: "user" },
    }));
    await artifactStore.saveArtifact(createArtifact({
      id: "attachment-2",
      type: "attachment",
      taskId: task.id,
      workspaceId: "default",
      status: "provided",
      content: "aW1hZ2U=",
      metadata: { filename: "photo.png", mediaType: "image/png", encoding: "base64", size: "8", source: "user" },
    }));
    await artifactStore.saveArtifact(createArtifact({
      id: "evidence-1",
      type: "screenshot",
      taskId: task.id,
      workspaceId: "default",
      providedByAgentId: "agent-1",
      status: "provided",
      content: "aW1hZ2U=",
    }));

    const summary = await buildTaskArtifactSummary(task, { artifactStore });

    expect(summary.total).toBe(1);
    expect(summary.byType).toEqual({ screenshot: 1 });
    // total equals the sum of byType values — attachments contribute nothing.
    expect(summary.total).toBe(Object.values(summary.byType).reduce((sum, count) => sum + (count ?? 0), 0));
  });

  it("returns an empty summary for attachment-only tasks", async () => {
    const task = createTask({
      id: "task-summary-input-only",
      title: "Input only",
      objective: "Only user attachments exist",
      workspaceId: "default",
      columnId: "dev",
    });
    const artifactStore = new InMemoryArtifactStore();
    await artifactStore.saveArtifact(createArtifact({
      id: "attachment-only",
      type: "attachment",
      taskId: task.id,
      workspaceId: "default",
      status: "provided",
      content: "notes",
      metadata: { filename: "notes.txt", mediaType: "text/plain", encoding: "utf8", size: "5", source: "user" },
    }));

    const summary = await buildTaskArtifactSummary(task, { artifactStore });

    expect(summary.total).toBe(0);
    expect(summary.byType).toEqual({});
  });
});

describe("buildTaskEvidenceSummary", () => {
  it("does not satisfy required artifacts with attachments", async () => {
    const task = createTask({
      id: "task-evidence-required",
      title: "Required evidence",
      objective: "Attachments cannot satisfy transition gates",
      workspaceId: "default",
      columnId: "dev",
      boardId: "board-1",
    });
    const artifactStore = new InMemoryArtifactStore();
    await artifactStore.saveArtifact(createArtifact({
      id: "attachment-shot",
      type: "attachment",
      taskId: task.id,
      workspaceId: "default",
      status: "provided",
      content: "aW1hZ2U=",
      metadata: { filename: "photo.png", mediaType: "image/png", encoding: "base64", size: "8", source: "user" },
    }));
    const kanbanBoardStore = {
      get: async () => ({
        columns: [
          {
            id: "dev",
          },
          {
            // Required artifacts are resolved from the next happy-path column.
            id: "review",
            automation: {
              enabled: true,
              requiredArtifacts: ["screenshot"] as Array<"screenshot" | "test_results" | "code_diff">,
            },
          },
        ],
      }),
    };

    const summary = await buildTaskEvidenceSummary(task, { artifactStore, kanbanBoardStore });

    expect(summary.artifact.requiredSatisfied).toBe(false);
    expect(summary.artifact.missingRequired).toEqual(["screenshot"]);
    expect(summary.artifact.total).toBe(0);
  });
});
