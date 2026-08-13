"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslation } from "@/i18n";
import { DesktopAppShell } from "@/client/components/desktop-app-shell";
import { WorkspaceSwitcher } from "@/client/components/workspace-switcher";
import { HomeInput } from "@/client/components/home-input";
import { useWorkspaces } from "@/client/hooks/use-workspaces";
import { desktopAwareFetch } from "@/client/utils/diagnostics";
import { filterSpecialistsByCategory } from "@/client/utils/specialist-categories";
import { formatRelativeTime } from "../ui-components";
import type { SessionInfo } from "../types";
import { MoreHorizontal, PieChart, Trash2, X } from "lucide-react";
import {
  DeleteTeamRunDialog,
  type TeamRunDeletionResultSummary,
  type TeamRunTarget,
} from "./delete-team-run-dialog";


const TEAM_LEAD_SPECIALIST_ID = "team-agent-lead";

interface SpecialistSummary {
  id: string;
  name: string;
  description?: string;
  role?: string;
}

interface TeamRunSessionInfo extends SessionInfo {
  descendants: number;
  directDelegates: number;
}

const TEAM_MEMBER_DISPLAY_ORDER = [
  TEAM_LEAD_SPECIALIST_ID,
  "team-researcher",
  "team-frontend-dev",
  "team-backend-dev",
  "team-qa",
  "team-code-reviewer",
  "team-ux-designer",
  "team-operations",
  "team-general-engineer",
] as const;

function compareTeamSpecialists(a: SpecialistSummary, b: SpecialistSummary): number {
  const aIndex = TEAM_MEMBER_DISPLAY_ORDER.indexOf(a.id as typeof TEAM_MEMBER_DISPLAY_ORDER[number]);
  const bIndex = TEAM_MEMBER_DISPLAY_ORDER.indexOf(b.id as typeof TEAM_MEMBER_DISPLAY_ORDER[number]);
  const normalizedA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
  const normalizedB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
  if (normalizedA !== normalizedB) return normalizedA - normalizedB;
  return a.name.localeCompare(b.name);
}

function buildTeamRunName(requirement: string): string {
  const normalized = requirement.replace(/\s+/g, " ").trim();
  if (!normalized) return "Team run";
  return normalized.length > 56 ? `Team - ${normalized.slice(0, 53)}...` : `Team - ${normalized}`;
}

export function TeamPageClient() {
  const { t } = useTranslation();
  const params = useParams();
  const router = useRouter();
  const rawWorkspaceId = params.workspaceId as string;
  const workspaceId =
    rawWorkspaceId === "__placeholder__" && typeof window !== "undefined"
      ? (window.location.pathname.match(/^\/workspace\/([^/]+)/)?.[1] ?? rawWorkspaceId)
      : rawWorkspaceId;

  const workspacesHook = useWorkspaces();

  const [teamRuns, setTeamRuns] = useState<TeamRunSessionInfo[]>([]);
  const [specialists, setSpecialists] = useState<SpecialistSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isBenchPaused, setIsBenchPaused] = useState(false);
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeamRunTarget | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  // Close the more-actions menu on outside click.
  useEffect(() => {
    if (!openMenuSessionId) return undefined;
    const handleMouseDown = (event: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setOpenMenuSessionId(null);
      }
    };
    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  }, [openMenuSessionId]);

  // Auto-dismiss the success toast.
  useEffect(() => {
    if (!successToast) return undefined;
    const timer = setTimeout(() => setSuccessToast(null), 6000);
    return () => clearTimeout(timer);
  }, [successToast]);

  // When returning from a detail-page deletion, show the toast and clean the URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const search = new URLSearchParams(window.location.search);
    if (search.get("teamRunDeleted") !== "1") return;
    setSuccessToast(
      t.team.deleteSuccess
        .replace("{sessions}", search.get("sessions") ?? "0")
        .replace("{kanbanCards}", search.get("kanbanCards") ?? "0")
        .replace("{worktrees}", search.get("worktrees") ?? "0"),
    );
    router.replace(`/workspace/${workspaceId}/team`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await desktopAwareFetch(`/api/sessions?workspaceId=${encodeURIComponent(workspaceId)}&surface=team`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await res.json();
        if (controller.signal.aborted) return;
        setTeamRuns(Array.isArray(data?.sessions) ? data.sessions : []);
      } catch {
        if (controller.signal.aborted) return;
        setTeamRuns([]);
      }
    })();
    return () => controller.abort();
  }, [workspaceId, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await desktopAwareFetch("/api/specialists", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await res.json();
        if (controller.signal.aborted) return;
        setSpecialists(Array.isArray(data?.specialists) ? data.specialists : []);
      } catch {
        if (controller.signal.aborted) return;
        setSpecialists([]);
      }
    })();
    return () => controller.abort();
  }, []);

  const teamSpecialists = useMemo(
    () => filterSpecialistsByCategory(specialists, "team").sort(compareTeamSpecialists),
    [specialists],
  );
  const shouldAutoScrollBench = teamSpecialists.length > 4;
  const benchItems = shouldAutoScrollBench ? [...teamSpecialists, ...teamSpecialists] : teamSpecialists;

  const workspace = workspacesHook.workspaces.find((item) => item.id === workspaceId);
  const activeRuns = teamRuns.filter((run) => run.acpStatus === "connecting" || run.acpStatus === "ready").length;
  const availableMembers = Math.max(teamSpecialists.length - 1, 0);

  const handleWorkspaceSelect = useCallback((nextWorkspaceId: string) => {
    router.push(`/workspace/${nextWorkspaceId}/team`);
  }, [router]);

  const handleWorkspaceCreate = useCallback(async (title: string) => {
    const workspaceResult = await workspacesHook.createWorkspace(title);
    if (workspaceResult) {
      router.push(`/workspace/${workspaceResult.id}/team`);
    }
  }, [router, workspacesHook]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((current) => current + 1);
  }, []);

  const handleTeamSessionCreated = useCallback((
    sessionId: string,
    promptText: string,
    sessionContext?: { cwd?: string; branch?: string; repoName?: string },
  ) => {
    const optimisticName = buildTeamRunName(promptText);
    setTeamRuns((current) => {
      if (current.some((run) => run.sessionId === sessionId)) {
        return current.map((run) => (
          run.sessionId === sessionId
            ? {
              ...run,
              name: optimisticName,
              cwd: run.cwd || sessionContext?.cwd || "",
              branch: run.branch ?? sessionContext?.branch,
              role: run.role ?? "ROUTA",
              specialistId: run.specialistId ?? TEAM_LEAD_SPECIALIST_ID,
            }
            : run
        ));
      }

      return [{
        sessionId,
        name: optimisticName,
        cwd: sessionContext?.cwd ?? "",
        branch: sessionContext?.branch,
        workspaceId,
        role: "ROUTA",
        specialistId: TEAM_LEAD_SPECIALIST_ID,
        createdAt: new Date().toISOString(),
        directDelegates: 0,
        descendants: 0,
      }, ...current];
    });

    void desktopAwareFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: optimisticName }),
    }).catch(() => {});
    setRefreshKey((current) => current + 1);
  }, [workspaceId]);

  const handleTeamRunDeleted = useCallback((result: TeamRunDeletionResultSummary) => {
    setTeamRuns((current) => current.filter((run) => run.sessionId !== result.rootSessionId));
    setDeleteTarget(null);
    setOpenMenuSessionId(null);
    setSuccessToast(
      t.team.deleteSuccess
        .replace("{sessions}", String(result.deleted.sessions))
        .replace("{kanbanCards}", String(result.deleted.kanbanCards))
        .replace("{worktrees}", String(result.deleted.worktrees)),
    );
  }, [t]);

  const openTeamRun = useCallback((sessionId: string) => {
    router.push(`/workspace/${workspaceId}/team/${sessionId}`);
  }, [router, workspaceId]);

  const handleTeamRunCardKeyDown = useCallback((event: React.KeyboardEvent, sessionId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openTeamRun(sessionId);
  }, [openTeamRun]);

  if (workspacesHook.loading && workspaceId !== "default") {
    return (
      <div className="desktop-theme flex h-screen items-center justify-center bg-desktop-bg-primary">
        <div className="flex items-center gap-3 text-desktop-text-secondary">
          <PieChart className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24"/>
          {t.team.loadingWorkspace}
        </div>
      </div>
    );
  }

  return (
    <DesktopAppShell
      workspaceId={workspaceId}
      workspaceTitle={workspace?.title ?? (workspaceId === "default" ? "Default Workspace" : workspaceId)}
      workspaceSwitcher={(
        <WorkspaceSwitcher
          workspaces={workspacesHook.workspaces}
          activeWorkspaceId={workspaceId}
          activeWorkspaceTitle={workspace?.title ?? (workspaceId === "default" ? "Default Workspace" : workspaceId)}
          onSelect={handleWorkspaceSelect}
          onCreate={handleWorkspaceCreate}
          loading={workspacesHook.loading}
          compact
          desktop
        />
      )}
    >
      <div className="flex h-full min-h-0 bg-[#f6f4ef] dark:bg-[#0c1118]">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-8 lg:px-10 lg:py-10">
              <section className="flex flex-1 flex-col justify-center">
                <div className="mx-auto w-full max-w-3xl text-center">
                  <div className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    {workspace?.title ?? t.common.workspace}
                  </div>
                  <h1 className="mt-4 font-['Avenir_Next_Condensed','Avenir_Next','Segoe_UI','Helvetica_Neue',sans-serif] text-5xl font-semibold tracking-[-0.05em] text-slate-900 dark:text-slate-100 sm:text-6xl">
                    {t.team.launchTeamLead}
                  </h1>
                  <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-slate-600 dark:text-slate-300">
                    {t.team.reusesInput}
                  </p>
                </div>

                <div className="mx-auto mt-8 flex w-full max-w-3xl flex-wrap items-center justify-center gap-3 text-sm text-slate-500 dark:text-slate-400">
                  <div className="inline-flex items-center gap-2 rounded-full border border-black/8 bg-white/75 px-4 py-2 dark:border-white/10 dark:bg-white/5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">{t.team.runs}</span>
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{teamRuns.length}</span>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-black/8 bg-white/75 px-4 py-2 dark:border-white/10 dark:bg-white/5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">{t.team.active}</span>
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{activeRuns}</span>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-black/8 bg-white/75 px-4 py-2 dark:border-white/10 dark:bg-white/5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">{t.team.members}</span>
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{availableMembers}</span>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <div className="border-t border-black/6 bg-[#f3f1eb]/92 px-4 py-4 dark:border-white/8 dark:bg-[#0f141c]/92">
            <div className="mx-auto w-full max-w-4xl">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-500">
                  {t.team.teamBench}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400">
                  {teamSpecialists.length} {t.team.specialists}
                </div>
              </div>
              <div
                className="mb-3 overflow-hidden pb-1"
                onMouseEnter={() => setIsBenchPaused(true)}
                onMouseLeave={() => setIsBenchPaused(false)}
              >
                <div
                  className="flex w-max gap-2"
                  style={shouldAutoScrollBench ? {
                    animation: "teamBenchMarquee 24s linear infinite",
                    animationPlayState: isBenchPaused ? "paused" : "running",
                  } : undefined}
                >
                  {benchItems.map((specialist, index) => {
                    const roleLabel = specialist.id === TEAM_LEAD_SPECIALIST_ID ? "Lead" : (specialist.role ?? "Specialist");
                    const isLead = specialist.id === TEAM_LEAD_SPECIALIST_ID;

                    return (
                      <div
                        key={`${specialist.id}-${index}`}
                        className={`flex w-42.5 shrink-0 items-center rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                          isLead
                            ? "bg-white/80 text-slate-900 dark:bg-white/8 dark:text-slate-100"
                            : "bg-black/3 text-slate-700 dark:bg-white/3 dark:text-slate-200"
                        }`}
                        title={specialist.description ?? specialist.id}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium leading-5">
                            {specialist.name}
                          </div>
                          <div className="truncate text-[9px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                            {roleLabel}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <HomeInput
                workspaceId={workspaceId}
                variant="default"
                footerMetaMode="repo-only"
                initialLaunchModeId="team"
                launchModes={[{
                  id: "team",
                  label: t.home.modeTeamTitle,
                  description: t.home.modeTeamDescription,
                  placeholder: t.home.modeTeamPlaceholder,
                  defaultAgentRole: "ROUTA",
                  allowRoleSwitch: false,
                  allowCustomSpecialist: false,
                  lockedSpecialistId: TEAM_LEAD_SPECIALIST_ID,
                  requireRepoSelection: true,
                  attachSelectedRepoToWorkspace: true,
                  teamChainSelector: true,
                  allowLocalAttachments: true,
                  dispatchMode: "pending-prompt",
                  buildSessionUrl: (nextWorkspaceId, sessionId) =>
                    `/workspace/${nextWorkspaceId ?? workspaceId}/team/${sessionId}`,
                }]}
                onSessionCreated={handleTeamSessionCreated}
              />
            </div>
          </div>
          <style>{`
            @keyframes teamBenchMarquee {
              from {
                transform: translateX(0);
              }
              to {
                transform: translateX(calc(-50% - 0.5rem));
              }
            }
          `}</style>
        </main>

        <aside className="hidden w-[320px] shrink-0 border-l border-black/6 bg-[#efede6] dark:border-white/8 dark:bg-[#11161f] xl:flex xl:flex-col">
          <div className="border-b border-black/6 px-5 py-4 dark:border-white/8">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-500">
                  {t.team.teamRuns}
                </div>
                <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {t.team.topLevelOnly}
                </div>
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                className="rounded-full border border-black/8 bg-white/90 px-3 py-1.5 text-[11px] font-medium text-slate-600 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-slate-300 dark:hover:bg-white/10"
              >
                {t.common.refresh}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {teamRuns.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-black/10 bg-[#f8f6f1] px-5 py-8 text-center dark:border-white/10 dark:bg-white/4">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {t.team.noTeamRunsYet}
                </div>
                <div className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  {t.team.launchAbove}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {teamRuns.slice(0, 8).map((run) => (
                  <div
                    key={run.sessionId}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTeamRun(run.sessionId)}
                    onKeyDown={(event) => handleTeamRunCardKeyDown(event, run.sessionId)}
                    className="w-full cursor-pointer rounded-[18px] border border-black/6 bg-[#fbfaf7] px-4 py-3 text-left transition-colors hover:bg-white dark:border-white/8 dark:bg-white/4 dark:hover:bg-white/[0.07]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {run.name ?? t.team.unnamedRun}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                          <span>{formatRelativeTime(run.createdAt)}</span>
                          {run.branch ? (
                            <>
                              <span>·</span>
                              <span className="truncate">{run.branch}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusPill status={run.acpStatus} />
                        <div ref={openMenuSessionId === run.sessionId ? menuContainerRef : undefined} className="relative">
                          <button
                            type="button"
                            aria-label={t.team.moreActions}
                            title={t.team.moreActions}
                            aria-haspopup="menu"
                            aria-expanded={openMenuSessionId === run.sessionId}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenMenuSessionId((current) => (current === run.sessionId ? null : run.sessionId));
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-black/5 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-200"
                          >
                            <MoreHorizontal className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} />
                          </button>
                          {openMenuSessionId === run.sessionId ? (
                            <div
                              role="menu"
                              className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-black/8 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-[#161c26]"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setOpenMenuSessionId(null);
                                  setDeleteTarget({ sessionId: run.sessionId, name: run.name ?? t.team.unnamedRun });
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                              >
                                <Trash2 className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} />
                                {t.team.deleteTeam}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {successToast ? (
          <div className="pointer-events-none fixed bottom-6 right-6 z-50">
            <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg dark:border-emerald-500/25 dark:bg-emerald-500/15 dark:text-emerald-200">
              <span>{successToast}</span>
              <button
                type="button"
                onClick={() => setSuccessToast(null)}
                aria-label={t.common.dismiss}
                className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-emerald-600 transition-colors hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-100"
              >
                <X className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} />
              </button>
            </div>
          </div>
        ) : null}

        <DeleteTeamRunDialog
          workspaceId={workspaceId}
          teamRun={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleTeamRunDeleted}
        />
      </div>
    </DesktopAppShell>
  );
}

function StatusPill({ status }: { status?: SessionInfo["acpStatus"] }) {
  if (status === "error") {
    return <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">error</span>;
  }
  if (status === "connecting") {
    return <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">connecting</span>;
  }
  return <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">ready</span>;
}
