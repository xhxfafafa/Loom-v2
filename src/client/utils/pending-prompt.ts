/**
 * Pending Prompt Storage Utility
 *
 * Stores initial prompt text in sessionStorage when creating a new session
 * from the home page. This allows the prompt to be sent after navigation
 * completes, avoiding issues where page navigation cancels in-flight ACP requests.
 *
 * Flow:
 * 1. Home page creates session, stores prompt with session ID
 * 2. Navigation to session page
 * 3. Session page loads, checks for pending prompt
 * 4. If found, sends the prompt and clears storage
 */

import type { RepositoryFileReference } from "./attachment-draft";

const STORAGE_KEY_PREFIX = "routa_pending_prompt_";

export interface PendingPromptPayload {
  text: string;
  timestamp: number;
  skillName?: string;
  skillRepoPath?: string;
  /**
   * Opaque reference to the temporary IndexedDB record holding Team launch
   * attachment `File` objects. The payload itself only carries this ID —
   * never file content or Base64, which would exceed sessionStorage quotas.
   */
  attachmentTransferId?: string;
  /** Repository files chosen through `@` mentions, relative to the repo. */
  repositoryFiles?: RepositoryFileReference[];
}

export type PendingPromptInput =
  | string
  | {
      text: string;
      skillName?: string;
      skillRepoPath?: string;
      attachmentTransferId?: string;
      repositoryFiles?: RepositoryFileReference[];
    };

/**
 * Store a pending prompt for a session. Returns false when the payload could
 * not be written (e.g. sessionStorage unavailable) so callers can keep the
 * draft and surface a retry instead of navigating without a handoff.
 */
export function storePendingPrompt(
  sessionId: string,
  input: PendingPromptInput,
): boolean {
  if (typeof window === "undefined") return false;

  const data: PendingPromptPayload = {
    text: typeof input === "string" ? input : input.text,
    timestamp: Date.now(),
    skillName: typeof input === "string" ? undefined : input.skillName,
    skillRepoPath: typeof input === "string" ? undefined : input.skillRepoPath,
    attachmentTransferId: typeof input === "string" ? undefined : input.attachmentTransferId,
    repositoryFiles: typeof input === "string" ? undefined : input.repositoryFiles,
  };

  try {
    sessionStorage.setItem(
      `${STORAGE_KEY_PREFIX}${sessionId}`,
      JSON.stringify(data)
    );
    return true;
  } catch (e) {
    console.warn("[PendingPrompt] Failed to store pending prompt:", e);
    return false;
  }
}

/**
 * Retrieve and clear a pending prompt for a session
 * Returns null if no pending prompt exists or if it's too old (> 30 seconds)
 */
export function consumePendingPrompt(sessionId: string): string | null {
  return consumePendingPromptPayload(sessionId)?.text ?? null;
}

/**
 * Read a stored payload without removing it. Returns null when nothing is
 * stored or the entry is older than 30 seconds.
 */
function readPendingPayload(sessionId: string): PendingPromptPayload | null {
  if (typeof window === "undefined") return null;

  const key = `${STORAGE_KEY_PREFIX}${sessionId}`;

  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;

    const data = JSON.parse(raw) as PendingPromptPayload;

    // Check if the prompt is too old (> 30 seconds)
    const age = Date.now() - data.timestamp;
    if (age > 30000) {
      console.warn("[PendingPrompt] Pending prompt too old, discarding");
      return null;
    }

    return data;
  } catch (e) {
    console.warn("[PendingPrompt] Failed to retrieve pending prompt:", e);
    return null;
  }
}

/**
 * Retrieve and clear a structured pending prompt payload for a session.
 * Returns null if no pending prompt exists or if it's too old (> 30 seconds)
 */
export function consumePendingPromptPayload(
  sessionId: string,
): PendingPromptPayload | null {
  const data = readPendingPayload(sessionId);
  // Always remove the item, regardless of whether we use it
  clearPendingPrompt(sessionId);
  return data;
}

/**
 * Retrieve a structured pending prompt payload WITHOUT removing it. Used by
 * the Team Run first prompt, which must keep the transfer metadata available
 * for retry until delivery succeeds. Call `clearPendingPrompt` after the
 * prompt was accepted.
 */
export function peekPendingPromptPayload(
  sessionId: string,
): PendingPromptPayload | null {
  return readPendingPayload(sessionId);
}

/** Remove the pending prompt entry for a session, if present. */
export function clearPendingPrompt(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${sessionId}`);
  } catch (e) {
    console.warn("[PendingPrompt] Failed to clear pending prompt:", e);
  }
}

/**
 * Clear any pending prompts older than the max age
 * Call this on app init to clean up stale entries
 */
export function cleanupOldPendingPrompts(maxAgeMs: number = 60000): void {
  if (typeof window === "undefined") return;

  try {
    const keysToRemove: string[] = [];

    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue;

      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) continue;

        const data = JSON.parse(raw) as PendingPromptPayload;
        const age = Date.now() - data.timestamp;
        if (age > maxAgeMs) {
          keysToRemove.push(key);
        }
      } catch {
        // Invalid data, remove it
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }

    if (keysToRemove.length > 0) {
      console.log(
        `[PendingPrompt] Cleaned up ${keysToRemove.length} old pending prompts`
      );
    }
  } catch (e) {
    console.warn("[PendingPrompt] Failed to cleanup old pending prompts:", e);
  }
}
