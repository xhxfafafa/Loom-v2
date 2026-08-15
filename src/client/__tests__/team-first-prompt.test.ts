import { describe, expect, it } from "vitest";

import type { FileReference } from "@/client/components/tiptap-input";
import type { NormalizedTaskAttachment } from "@/core/kanban/task-attachments";

import {
  TEAM_INPUT_RESOURCE_SCHEME,
  buildTeamFirstPromptBlocks,
  formatRepositoryFilesSection,
  resolveRepositoryFileReferences,
} from "../utils/team-first-prompt";

function fileReference(path: string, label?: string): FileReference {
  return { path, label: label ?? path.split("/").pop() ?? path };
}

describe("resolveRepositoryFileReferences", () => {
  const repoPath = "/workspace/repo";

  it("converts references inside the repository to repo-relative paths", () => {
    const resolved = resolveRepositoryFileReferences(
      [fileReference("/workspace/repo/src/main.ts", "main.ts")],
      repoPath,
    );
    expect(resolved).toEqual([{ path: "src/main.ts", label: "main.ts" }]);
  });

  it("rejects references outside the selected repository instead of embedding them", () => {
    const resolved = resolveRepositoryFileReferences(
      [
        fileReference("/workspace/other/src/leak.ts"),
        fileReference("/workspace/repo-extra/file.ts"),
        fileReference("/etc/passwd"),
      ],
      repoPath,
    );
    expect(resolved).toEqual([]);
  });

  it("rejects .. segments even when the path starts inside the repository", () => {
    const resolved = resolveRepositoryFileReferences(
      [fileReference("/workspace/repo/../secret.ts"), fileReference("/workspace/repo/a/../../b.ts")],
      repoPath,
    );
    expect(resolved).toEqual([]);
  });

  it("keeps only the first occurrence of a duplicated relative path", () => {
    const resolved = resolveRepositoryFileReferences(
      [
        fileReference("/workspace/repo/src/a.ts", "first"),
        fileReference("/workspace/repo/src/a.ts", "second"),
      ],
      repoPath,
    );
    expect(resolved).toEqual([{ path: "src/a.ts", label: "first" }]);
  });

  it("normalizes backslash separators and trailing slashes", () => {
    const resolved = resolveRepositoryFileReferences(
      [fileReference("C:\\workspace\\repo\\src\\win.ts")],
      "C:/workspace/repo/",
    );
    expect(resolved).toEqual([
      { path: "src/win.ts", label: "C:\\workspace\\repo\\src\\win.ts" },
    ]);
  });

  it("returns nothing without files or without a repository path", () => {
    expect(resolveRepositoryFileReferences(undefined, repoPath)).toEqual([]);
    expect(resolveRepositoryFileReferences([], repoPath)).toEqual([]);
    expect(
      resolveRepositoryFileReferences([fileReference("/workspace/repo/src/a.ts")], undefined),
    ).toEqual([]);
    expect(
      resolveRepositoryFileReferences([fileReference("/workspace/repo/src/a.ts")], ""),
    ).toEqual([]);
  });
});

describe("formatRepositoryFilesSection", () => {
  it("returns undefined when there are no repository files", () => {
    expect(formatRepositoryFilesSection([])).toBeUndefined();
  });

  it("lists repository-relative paths under a stable header", () => {
    expect(
      formatRepositoryFilesSection([
        { path: "src/a.ts", label: "a.ts" },
        { path: "docs/readme.md", label: "readme.md" },
      ]),
    ).toBe("Repository files:\n- src/a.ts\n- docs/readme.md");
  });
});

describe("buildTeamFirstPromptBlocks", () => {
  const textAttachment: NormalizedTaskAttachment = {
    filename: "notes.txt",
    mediaType: "text/plain",
    encoding: "utf8",
    content: "attached text content",
    size: 21,
  };
  const imageAttachment: NormalizedTaskAttachment = {
    filename: "photo.png",
    mediaType: "image/png",
    encoding: "base64",
    content: "aW1hZ2U=",
    size: 5,
  };

  it("keeps a pure-text request as a single text block", () => {
    expect(buildTeamFirstPromptBlocks({ text: "Deliver feature X" })).toEqual([
      { type: "text", text: "Deliver feature X" },
    ]);
  });

  it("orders blocks: request text, repository paths, text resources, then images", () => {
    const blocks = buildTeamFirstPromptBlocks({
      text: "Deliver feature X",
      repositoryFiles: [{ path: "src/a.ts", label: "a.ts" }],
      attachments: [textAttachment, imageAttachment],
      transferId: "transfer-1",
    });

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: "text", text: "Deliver feature X" });
    expect(blocks[1]).toEqual({ type: "text", text: "Repository files:\n- src/a.ts" });
    expect(blocks[2]).toMatchObject({
      type: "resource",
      resource: {
        uri: `${TEAM_INPUT_RESOURCE_SCHEME}transfer-1/0`,
        mimeType: "text/plain",
        text: "attached text content",
      },
    });
    expect(blocks[3]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
  });

  it("counts resource indices over text attachments only", () => {
    const blocks = buildTeamFirstPromptBlocks({
      text: "request",
      attachments: [textAttachment, imageAttachment, { ...textAttachment, filename: "more.md" }],
      transferId: "transfer-2",
    });

    const uris = blocks
      .filter((block) => block.type === "resource")
      .map((block) => (block.type === "resource" ? block.resource.uri : ""));
    expect(uris).toEqual([
      `${TEAM_INPUT_RESOURCE_SCHEME}transfer-2/0`,
      `${TEAM_INPUT_RESOURCE_SCHEME}transfer-2/1`,
    ]);
  });

  it("never copies attachment content into visible text blocks", () => {
    const blocks = buildTeamFirstPromptBlocks({
      text: "request",
      attachments: [textAttachment, imageAttachment],
      transferId: "transfer-3",
    });
    const visibleText = blocks
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(visibleText).toBe("request");
  });
});
