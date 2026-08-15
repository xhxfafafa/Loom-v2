---
title: "SQLite acp_sessions missing team_chain_id breaks session lease checks"
date: "2026-08-16"
kind: issue
status: resolved
severity: high
area: "storage"
tags: ["sqlite", "acp", "schema-drift", "session-lease", "dual-backend"]
reported_by: "codex"
github_issue: null
github_state: null
github_url: null
---

# SQLite acp_sessions missing team_chain_id breaks session lease checks

## What Happened

On the web backend with a fresh local SQLite database, ACP session recovery
(`session/load`, prompt recovery) failed closed with:

```text
Session runtime lease for <sessionId> could not be verified because the
session database is unavailable. No runtime was started; retry once the
database recovers.
```

Underlying error: `SqliteError: no such column: "team_chain_id"`.

Ten Vitest cases failed for the same reason (`session-db-persister` lease
states and the ACP route native-resume tests), independent of any branch
integration work — the failure already existed on `main`.

## Why It Mattered

- Fail-closed lease acquisition is correct behavior for real DB outages, but
  here it masked a schema defect, so no Team/codex session could resume on a
  fresh web SQLite store.
- Web drifted from the Rust desktop backend, which manages its own schema and
  was not affected — violating dual-backend semantic parity expectations.

## Root Cause

The TS runtime initializes SQLite tables with raw DDL in `src/core/db/sqlite.ts`.
Drizzle SQLite schema (`acpSessions.teamChainId` in `src/core/db/sqlite-schema.ts`)
and drizzle-sqlite migration `0015_add_acp_session_team_chain_id.sql` define
`team_chain_id`, but the raw DDL path never added the column. Drizzle-generated
queries select the quoted column and threw on fresh databases.

## Fix

- Added `ALTER TABLE acp_sessions ADD COLUMN team_chain_id TEXT` to the
  migration block in `src/core/db/sqlite.ts` (same pattern as the neighboring
  column migrations), covering fresh and existing databases.
- Verified: `session-db-persister` and ACP route tests pass (42/42) after
  removing the local `routa.db` and re-running.

## Relevant Files

- `src/core/db/sqlite.ts`
- `src/core/db/sqlite-schema.ts`
- `drizzle-sqlite/0015_add_acp_session_team_chain_id.sql`
- `src/core/acp/session-runtime-recovery.ts`
