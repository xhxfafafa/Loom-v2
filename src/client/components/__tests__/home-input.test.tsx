import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeInput, resolveHomeInputSpecialistId } from "../home-input";

const {
  pushMock,
  createSessionMock,
  promptSessionMock,
  listProviderModelsMock,
  setProviderMock,
  clearDockerConfigErrorMock,
  loadRepoSkillsMock,
  clearRepoSkillsMock,
  useWorkspacesMock,
  useCodebasesMock,
  storePendingPromptMock,
  desktopAwareFetchMock,
  collectAccessibleRepoPathsMock,
  loadProviderConnectionConfigMock,
  getModelDefinitionByAliasMock,
  saveTeamAttachmentTransferMock,
  deleteTeamAttachmentTransferMock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  createSessionMock: vi.fn(),
  promptSessionMock: vi.fn(),
  listProviderModelsMock: vi.fn(),
  setProviderMock: vi.fn(),
  clearDockerConfigErrorMock: vi.fn(),
  loadRepoSkillsMock: vi.fn(),
  clearRepoSkillsMock: vi.fn(),
  useWorkspacesMock: vi.fn(),
  useCodebasesMock: vi.fn(),
  storePendingPromptMock: vi.fn(),
  desktopAwareFetchMock: vi.fn(),
  collectAccessibleRepoPathsMock: vi.fn(),
  loadProviderConnectionConfigMock: vi.fn(),
  getModelDefinitionByAliasMock: vi.fn(),
  saveTeamAttachmentTransferMock: vi.fn(),
  deleteTeamAttachmentTransferMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock("../tiptap-input", () => ({
  TiptapInput: (props: {
    onSend: (text: string, context: Record<string, unknown>) => Promise<void>;
    onTextChange?: (text: string) => void;
    pendingSkill?: string | null;
    disabled?: boolean;
    repoSelection?: { path?: string; name?: string; branch?: string } | null;
    onRepoChange?: (selection: { path: string; name: string; branch: string }) => void;
    skills?: Array<{ name: string }>;
    repoSkills?: Array<{ name: string }>;
    attachmentsEnabled?: boolean;
    attachmentDrafts?: Array<{ id: string; file: File }>;
    attachmentErrors?: string[];
    onAddAttachmentFiles?: (files: File[]) => void;
    onRemoveAttachment?: (id: string) => void;
    prefillText?: string | null;
  }) => (
    <div>
      <div data-testid="pending-skill">{props.pendingSkill ?? ""}</div>
      <div data-testid="repo-selection">{props.repoSelection?.path ?? ""}</div>
      <div data-testid="disabled-state">{String(Boolean(props.disabled))}</div>
      <div data-testid="skills-count">{props.skills?.length ?? 0}</div>
      <div data-testid="repo-skills-count">{props.repoSkills?.length ?? 0}</div>
      <div data-testid="attachments-enabled">{String(Boolean(props.attachmentsEnabled))}</div>
      <div data-testid="attachment-drafts-count">{props.attachmentDrafts?.length ?? 0}</div>
      <div data-testid="attachment-errors">{(props.attachmentErrors ?? []).join("|")}</div>
      <div data-testid="prefill-text">{props.prefillText ?? ""}</div>
      <button
        type="button"
        onClick={() => props.onTextChange?.("Run the database migration and update permissions")}
      >
        Type high-risk text
      </button>
      <button
        type="button"
        onClick={() => void props.onSend("Ship it", {
          cwd: props.repoSelection?.path,
          provider: "provider-x",
          mode: "mode-fast",
          model: "alias-model",
          skill: props.pendingSkill || undefined,
        })}
      >
        Send
      </button>
      <button
        type="button"
        onClick={() => void props.onSend("Ship it", {
          cwd: props.repoSelection?.path,
          provider: "provider-x",
          mode: "mode-fast",
          model: "alias-model",
          files: [
            { path: "/repo/main/src/a.ts", label: "a.ts" },
            { path: "/outside/b.ts", label: "b.ts" },
          ],
        })}
      >
        Send with repo files
      </button>
      <button
        type="button"
        onClick={() => props.onAddAttachmentFiles?.([
          new File(["hello notes"], "notes.txt", { type: "text/plain" }),
        ])}
      >
        Add text attachment
      </button>
      <button
        type="button"
        onClick={() => props.onAddAttachmentFiles?.([
          new File(["zipped"], "archive.zip", { type: "application/zip" }),
        ])}
      >
        Add unsupported attachment
      </button>
      <button
        type="button"
        onClick={() => props.onAddAttachmentFiles?.([
          new File(["not really a png"], "fake.png", { type: "image/png" }),
        ])}
      >
        Add fake png
      </button>
      <button
        type="button"
        onClick={() => props.onRemoveAttachment?.(props.attachmentDrafts?.[0]?.id ?? "")}
      >
        Remove first attachment
      </button>
      <button
        type="button"
        onClick={() => props.onRepoChange?.({
          path: "/repo/other",
          name: "Other Repo",
          branch: "main",
        })}
      >
        Select other repo
      </button>
    </div>
  ),
}));

vi.mock("../settings-panel", () => ({
  loadProviderConnectionConfig: loadProviderConnectionConfigMock,
  getModelDefinitionByAlias: getModelDefinitionByAliasMock,
  DockerConfigModal: () => null,
}));

vi.mock("../../hooks/use-acp", () => ({
  useAcp: () => ({
    connected: true,
    loading: false,
    providers: [{ id: "provider-x", name: "Provider X" }],
    selectedProvider: "provider-default",
    setProvider: setProviderMock,
    connect: vi.fn(),
    createSession: createSessionMock,
    promptSession: promptSessionMock,
    listProviderModels: listProviderModelsMock,
    dockerConfigError: null,
    clearDockerConfigError: clearDockerConfigErrorMock,
  }),
}));

vi.mock("../../hooks/use-skills", () => ({
  useSkills: () => ({
    skills: [{ name: "local-skill", description: "Local skill" }],
    repoSkills: [{ name: "repo-skill", description: "Repo skill" }],
    loadRepoSkills: loadRepoSkillsMock,
    clearRepoSkills: clearRepoSkillsMock,
  }),
}));

vi.mock("../../hooks/use-workspaces", () => ({
  useWorkspaces: () => useWorkspacesMock(),
  useCodebases: (workspaceId: string) => useCodebasesMock(workspaceId),
}));

vi.mock("../../utils/pending-prompt", () => ({
  storePendingPrompt: storePendingPromptMock,
}));

vi.mock("../../utils/team-attachment-transfer", () => ({
  saveTeamAttachmentTransfer: saveTeamAttachmentTransferMock,
  deleteTeamAttachmentTransfer: deleteTeamAttachmentTransferMock,
}));

vi.mock("../../utils/diagnostics", () => ({
  desktopAwareFetch: desktopAwareFetchMock,
}));

vi.mock("@/client/utils/repo-validation", () => ({
  collectAccessibleRepoPaths: collectAccessibleRepoPathsMock,
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      common: {
        session: "Session",
        clearSpecialist: "Clear specialist",
        agentMode: "Agent mode",
      },
      home: {
        directDesc: "Direct coding",
        inputPlaceholder: "Describe work",
        multiAgent: "Multi-agent",
        crafter: "Crafter",
        repoPath: "Repo path",
        repoAttachFailed: "Failed to attach repository",
        launchFailed: "Failed to launch session",
        multiAgentDesc: "Multi-agent orchestration",
      },
      workspace: {
        workspaces: "Workspaces",
      },
      settings: {
        specialists: "Specialists",
      },
      teamChain: {
        label: "Execution Chain",
        recommended: "Recommended",
        lightweight: "Lightweight",
        standardDelivery: "Standard Delivery",
        fullDelivery: "Full Delivery",
        lightweightPurpose: "One bounded change, delivered fast.",
        standardDeliveryPurpose: "One primary change with independent verification.",
        fullDeliveryPurpose: "Full multi-stage delivery with research and review.",
        lightweightPattern: "Lead -> one implementer -> delivery",
        standardDeliveryPattern: "Lead -> one implementer -> one independent verifier",
        fullDeliveryPattern: "Lead -> research, implementation, QA and review waves",
        lightweightVerification: "Self-verification by the implementer",
        standardDeliveryVerification: "One independent QA or code review",
        fullDeliveryVerification: "Independent QA and code review",
        reasonHighRisk: "High-risk change detected",
        reasonBoundedScope: "Small, bounded scope",
        reasonStandardTask: "Standard development task",
        reasonAnalysisOnly: "Analysis-only request",
        analysisOnlyNote: "The MVP has no enforced read-only Team chain. This run may still modify code.",
      },
      taskAttachments: {
        validation: {
          tooManyAttachments: "Too many attachments",
          tooManyImages: "Too many images",
          invalidFilename: "Invalid filename",
          filenameTooLong: "Filename too long",
          unsupportedExtension: "Unsupported file type",
          invalidFile: "Invalid file",
          textTooLarge: "Text file too large",
          imageTooLarge: "Image too large",
          totalTooLarge: "Attachments exceed the total limit",
        },
      },
      teamAttachments: {
        addFiles: "Add files",
        removeFile: "Remove file",
        prepareFailed: "Attachment preparation failed",
        handoffFailed: "Attachment handoff failed",
        firstPromptFailed: "First prompt failed",
      },
    },
  }),
}));

describe("HomeInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useWorkspacesMock.mockReturnValue({
      workspaces: [
        { id: "ws-1", title: "Workspace One" },
        { id: "ws-2", title: "Workspace Two" },
      ],
    });
    useCodebasesMock.mockReturnValue({
      codebases: [
        {
          id: "cb-1",
          workspaceId: "ws-1",
          repoPath: "/repo/main",
          branch: "main",
          label: "Main Repo",
          isDefault: true,
        },
      ],
    });
    collectAccessibleRepoPathsMock.mockResolvedValue(new Set(["/repo/main"]));
    desktopAwareFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        specialists: [
          {
            id: "spec-review",
            name: "Reviewer",
            role: "CRAFTER",
            defaultProvider: "provider-specialist",
            model: "special-model",
          },
        ],
      }),
    });
    createSessionMock.mockResolvedValue({ sessionId: "session-1" });
    promptSessionMock.mockResolvedValue(undefined);
    saveTeamAttachmentTransferMock.mockResolvedValue("transfer-1");
    deleteTeamAttachmentTransferMock.mockResolvedValue(undefined);
    storePendingPromptMock.mockReturnValue(true);
    loadProviderConnectionConfigMock.mockReturnValue({
      model: "provider-default-model",
      baseUrl: "https://provider.example",
      apiKey: "secret",
    });
    getModelDefinitionByAliasMock.mockReturnValue({
      modelName: "resolved-model",
      baseUrl: "https://models.example",
      apiKey: "model-secret",
    });
  });

  it("resolves specialist ids according to lock and custom-selection rules", () => {
    expect(resolveHomeInputSpecialistId({
      lockedSpecialistId: "locked",
      allowCustomSpecialist: true,
      selectedSpecialistId: "selected",
    })).toBe("locked");

    expect(resolveHomeInputSpecialistId({
      lockedSpecialistId: undefined,
      allowCustomSpecialist: true,
      selectedSpecialistId: "selected",
    })).toBe("selected");

    expect(resolveHomeInputSpecialistId({
      lockedSpecialistId: undefined,
      allowCustomSpecialist: false,
      selectedSpecialistId: "selected",
    })).toBeNull();
  });

  it("auto-selects the first workspace, exposes repo context, and consumes external skills", async () => {
    const onWorkspaceChange = vi.fn();
    const onExternalSkillConsumed = vi.fn();

    render(
      <HomeInput
        onWorkspaceChange={onWorkspaceChange}
        externalPendingSkill="reviewer"
        onExternalSkillConsumed={onExternalSkillConsumed}
        displaySkills={[{ name: "fix-tests", description: "Fix tests" }]}
      />,
    );

    await waitFor(() => {
      expect(onWorkspaceChange).toHaveBeenCalledWith("ws-1");
    });
    await waitFor(() => {
      expect(loadRepoSkillsMock).toHaveBeenCalledWith("/repo/main");
    });
    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });

    expect(screen.getByTestId("pending-skill").textContent).toBe("reviewer");
    expect(onExternalSkillConsumed).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /fix-tests/i }));

    expect(screen.getByTestId("pending-skill").textContent).toBe("fix-tests");
  });

  it("preserves an explicit repository selection when codebases refresh", async () => {
    const { rerender } = render(<HomeInput workspaceId="ws-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });

    fireEvent.click(screen.getByRole("button", { name: "Select other repo" }));
    expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/other");

    useCodebasesMock.mockReturnValue({
      codebases: [
        {
          id: "cb-1",
          workspaceId: "ws-1",
          repoPath: "/repo/main",
          branch: "main",
          label: "Main Repo",
          isDefault: true,
        },
        {
          id: "cb-2",
          workspaceId: "ws-1",
          repoPath: "/repo/other",
          branch: "main",
          label: "Other Repo",
          isDefault: false,
        },
      ],
    });
    collectAccessibleRepoPathsMock.mockResolvedValue(new Set(["/repo/main", "/repo/other"]));
    rerender(<HomeInput workspaceId="ws-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/other");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledWith(
        "/repo/other",
        "provider-x",
        "mode-fast",
        "ROUTA",
        "ws-1",
        "resolved-model",
        expect.anything(),
        undefined,
        undefined,
        "https://models.example",
        "model-secret",
        "main",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  it("attaches an unregistered repository before launching a Team session", async () => {
    desktopAwareFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/workspaces/ws-1/codebases" && init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          json: async () => ({ codebase: { id: "cb-2" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ specialists: [] }),
      };
    });

    render(
      <HomeInput
        workspaceId="ws-1"
        initialLaunchModeId="team"
        launchModes={[{
          id: "team",
          label: "Team",
          description: "Team run",
          requireRepoSelection: true,
          attachSelectedRepoToWorkspace: true,
        }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });
    fireEvent.click(screen.getByRole("button", { name: "Select other repo" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(desktopAwareFetchMock).toHaveBeenCalledWith(
        "/api/workspaces/ws-1/codebases",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            repoPath: "/repo/other",
            branch: "main",
            label: "Other Repo",
          }),
        }),
      );
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    const attachCall = desktopAwareFetchMock.mock.invocationCallOrder.find((_, index) => {
      const [url, init] = desktopAwareFetchMock.mock.calls[index] ?? [];
      return url === "/api/workspaces/ws-1/codebases" && init?.method === "POST";
    });
    expect(attachCall).toBeLessThan(createSessionMock.mock.invocationCallOrder[0]);
  });

  it("stores pending prompts for the default dispatch mode", async () => {
    const onSessionCreated = vi.fn();

    render(
      <HomeInput
        workspaceId="ws-1"
        onSessionCreated={onSessionCreated}
        displaySkills={[{ name: "fix-tests", description: "Fix tests" }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });

    fireEvent.click(screen.getByRole("button", { name: /fix-tests/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    const args = createSessionMock.mock.calls[0];
    expect(args[0]).toBe("/repo/main");
    expect(args[1]).toBe("provider-x");
    expect(args[2]).toBe("mode-fast");
    expect(args[3]).toBe("ROUTA");
    expect(args[4]).toBe("ws-1");
    expect(args[5]).toBe("resolved-model");
    expect(args[11]).toBe("main");

    await waitFor(() => {
      expect(storePendingPromptMock).toHaveBeenCalledWith("session-1", {
        text: "Ship it",
        skillName: "fix-tests",
        skillRepoPath: "/repo/main",
      });
    });
    expect(promptSessionMock).not.toHaveBeenCalled();
    expect(onSessionCreated).toHaveBeenCalledWith(
      "session-1",
      "/fix-tests Ship it",
      { cwd: "/repo/main", branch: "main", repoName: "Main Repo" },
    );
    expect(pushMock).toHaveBeenCalledWith("/workspace/ws-1/sessions/session-1");
  });

  it("uses direct prompt dispatch when launch mode requests it", async () => {
    render(
      <HomeInput
        workspaceId="ws-1"
        launchModes={[
          {
            id: "direct",
            label: "Direct",
            description: "Direct coding",
            dispatchMode: "direct-prompt",
            sessionConfig: {
              role: "CRAFTER",
              mcpProfile: "kanban-planning",
              systemPrompt: (text: string) => `System: ${text}`,
            },
          },
        ]}
        initialLaunchModeId="direct"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(promptSessionMock).toHaveBeenCalledWith("session-1", "Ship it");
    });

    const args = createSessionMock.mock.calls[0];
    expect(args[3]).toBe("CRAFTER");
    expect(args[14]).toBe("kanban-planning");
    expect(args[15]).toBe("System: Ship it");
    expect(storePendingPromptMock).not.toHaveBeenCalled();
  });

  it("hides the Team chain selector outside the Team launch mode", async () => {
    render(<HomeInput workspaceId="ws-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });

    expect(screen.queryByTestId("team-chain-selector")).toBeNull();
  });

  it("passes the recommended Team chain when creating a Team session", async () => {
    render(
      <HomeInput
        workspaceId="ws-1"
        initialLaunchModeId="team"
        launchModes={[{
          id: "team",
          label: "Team",
          description: "Team run",
          teamChainSelector: true,
        }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });
    expect(screen.getByTestId("team-chain-selector-value").textContent).toBe("Standard Delivery");

    fireEvent.click(screen.getByRole("button", { name: "Type high-risk text" }));
    await waitFor(() => {
      expect(screen.getByTestId("team-chain-selector-value").textContent).toBe("Full Delivery");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });
    expect(createSessionMock.mock.calls[0][19]).toBe("full_delivery");
  });

  it("lets the user override the recommended Team chain before launch", async () => {
    render(
      <HomeInput
        workspaceId="ws-1"
        initialLaunchModeId="team"
        launchModes={[{
          id: "team",
          label: "Team",
          description: "Team run",
          teamChainSelector: true,
        }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
    });

    fireEvent.click(screen.getByTestId("team-chain-selector"));
    fireEvent.click(screen.getByTestId("team-chain-option-lightweight"));
    await waitFor(() => {
      expect(screen.getByTestId("team-chain-selector-value").textContent).toBe("Lightweight");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });
    expect(createSessionMock.mock.calls[0][19]).toBe("lightweight");
  });

  describe("Team launch attachments", () => {
    const teamLaunchMode = {
      id: "team",
      label: "Team",
      description: "Team run",
      allowLocalAttachments: true,
      dispatchMode: "pending-prompt" as const,
    };

    it("shows attachment controls only when the active launch mode opts in", async () => {
      const { unmount } = render(
        <HomeInput
          workspaceId="ws-1"
          initialLaunchModeId="team"
          launchModes={[teamLaunchMode]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });
      expect(screen.getByTestId("attachments-enabled").textContent).toBe("true");
      unmount();

      render(<HomeInput workspaceId="ws-1" />);
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });
      expect(screen.getByTestId("attachments-enabled").textContent).toBe("false");
    });

    it("rejects unsupported file types at the picker without creating drafts", async () => {
      render(
        <HomeInput
          workspaceId="ws-1"
          initialLaunchModeId="team"
          launchModes={[teamLaunchMode]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });

      fireEvent.click(screen.getByRole("button", { name: "Add unsupported attachment" }));

      expect(screen.getByTestId("attachment-drafts-count").textContent).toBe("0");
      expect(screen.getByTestId("attachment-errors").textContent).toBe("Unsupported file type");
      expect(saveTeamAttachmentTransferMock).not.toHaveBeenCalled();
    });

    it("blocks session creation when attachment bytes fail preflight validation", async () => {
      render(
        <HomeInput
          workspaceId="ws-1"
          initialLaunchModeId="team"
          launchModes={[teamLaunchMode]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });

      // A .png whose bytes are not a PNG passes the extension preflight but
      // fails byte validation; the launch must stop BEFORE creating a session.
      fireEvent.click(screen.getByRole("button", { name: "Add fake png" }));
      expect(screen.getByTestId("attachment-drafts-count").textContent).toBe("1");

      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(screen.getByTestId("attachment-errors").textContent).toBe("Invalid file");
      });
      expect(createSessionMock).not.toHaveBeenCalled();
      expect(saveTeamAttachmentTransferMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
      // The composed text is restored for retry.
      expect(screen.getByTestId("prefill-text").textContent).toBe("Ship it");
    });

    it("parks files in IndexedDB before creating the session and stores transfer metadata only", async () => {
      render(
        <HomeInput
          workspaceId="ws-1"
          initialLaunchModeId="team"
          launchModes={[teamLaunchMode]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });

      fireEvent.click(screen.getByRole("button", { name: "Add text attachment" }));
      expect(screen.getByTestId("attachment-drafts-count").textContent).toBe("1");

      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(createSessionMock).toHaveBeenCalledTimes(1);
      });
      // The transfer record is saved BEFORE the session is created so a
      // handoff failure never leaves a session without its attachments.
      expect(saveTeamAttachmentTransferMock).toHaveBeenCalledTimes(1);
      const savedFiles = saveTeamAttachmentTransferMock.mock.calls[0][0] as File[];
      expect(savedFiles).toHaveLength(1);
      expect(savedFiles[0].name).toBe("notes.txt");
      expect(saveTeamAttachmentTransferMock.mock.invocationCallOrder[0]).toBeLessThan(
        createSessionMock.mock.invocationCallOrder[0],
      );
      // The sessionStorage payload references the transfer by opaque ID only —
      // no file content, no Base64.
      expect(storePendingPromptMock).toHaveBeenCalledWith("session-1", {
        text: "Ship it",
        attachmentTransferId: "transfer-1",
      });
      await waitFor(() => {
        expect(screen.getByTestId("attachment-drafts-count").textContent).toBe("0");
      });
      expect(pushMock).toHaveBeenCalledWith("/workspace/ws-1/sessions/session-1");
    });

    it("carries @-selected repo files as repo-relative paths and rejects outside references", async () => {
      render(
        <HomeInput
          workspaceId="ws-1"
          initialLaunchModeId="team"
          launchModes={[teamLaunchMode]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });

      fireEvent.click(screen.getByRole("button", { name: "Send with repo files" }));

      await waitFor(() => {
        expect(storePendingPromptMock).toHaveBeenCalledWith("session-1", {
          text: "Ship it",
          repositoryFiles: [{ path: "src/a.ts", label: "a.ts" }],
        });
      });
      // The out-of-repo reference is rejected, never embedded.
      const payload = storePendingPromptMock.mock.calls[0][1] as {
        repositoryFiles?: Array<{ path: string }>;
      };
      expect(payload.repositoryFiles?.some((file) => file.path.includes("outside"))).toBe(false);
    });

    it("keeps the transfer for retry when the pending-prompt handoff fails", async () => {
      storePendingPromptMock.mockReturnValue(false);
      render(
        <HomeInput
          workspaceId="ws-1"
          initialLaunchModeId="team"
          launchModes={[teamLaunchMode]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });

      fireEvent.click(screen.getByRole("button", { name: "Add text attachment" }));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(screen.getByTestId("attachment-errors").textContent).toBe("Attachment handoff failed");
      });
      // No navigation toward a text-only prompt: the transfer is kept for
      // retry and the draft stays visible.
      expect(pushMock).not.toHaveBeenCalled();
      expect(deleteTeamAttachmentTransferMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("attachment-drafts-count").textContent).toBe("1");
      expect(screen.getByTestId("prefill-text").textContent).toBe("Ship it");
    });

    it("deletes the temporary transfer when session creation fails", async () => {
      createSessionMock.mockRejectedValue(new Error("launch failed"));
      render(
        <HomeInput
          workspaceId="ws-1"
          initialLaunchModeId="team"
          launchModes={[teamLaunchMode]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("repo-selection").textContent).toBe("/repo/main");
      });

      fireEvent.click(screen.getByRole("button", { name: "Add text attachment" }));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(deleteTeamAttachmentTransferMock).toHaveBeenCalledWith("transfer-1");
      });
      expect(pushMock).not.toHaveBeenCalled();
      expect(screen.getByText("Failed to launch session")).toBeTruthy();
    });
  });
});
