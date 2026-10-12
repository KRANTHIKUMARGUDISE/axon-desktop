# Session v1-S1 — Local-first Core (remove axon-api)

Read first: `CLAUDE.md`, `docs/v1-review.md` (A1–A6, B7, C4, C6, D1–D2, D8), `docs/v1-decisions.md`.
Start in plan mode; show the plan, then implement.

## Goal
axon-desktop runs fully with no network and no axon-api: create, list, run, pause, approve, reject,
cancel and resume deliveries, all persisted locally. The executor becomes a testable engine.

## Scope

1. **`shared/` package** (own tsconfig, referenced by renderer and main): zod schemas + inferred
   types for `Block`, `Pipeline`, `PipelineNode`, `PipelineEdge` (incl. `condition`), `Delivery`,
   `DeliveryStep`, `AgentOutput`, `DeliveryEvent` (D2), settings. Every document has `id`,
   `schemaVersion`, `createdAt`, `updatedAt`. Delete the duplicate types in `executor.ts:196-254`
   and the duplicate `AGENTIC_TOOL_CEILING`.
2. **Store interface** `Store` (blocks, pipelines, deliveries, steps) + `FileStore` implementation
   in main: `{userData}/store/`, one file per delivery, atomic write helper (tmp + fsync + rename),
   single writer per delivery (in-process lock). Step upsert keyed by `(nodeId, itemKey)` with
   `itemKey = null` for now (ForEach items arrive in Session 4). This interface is what `GitRepoStore` (S3) and a future `ApiStore` implement.
3. **Engine split** of `executor.ts`: `engine/` (pure state machine; store, runners, clock,
   event bus injected), `runners/` (claude prompt, claude agentic, axon native), `ipc/` (thin
   handlers). Delivery creation builds `pipelineSnapshot` locally, including block ids + versions.
4. **Events:** one typed IPC channel carrying `DeliveryEvent`. Delete `useSignalR`, the
   `@microsoft/signalr` dependency, and the second live-update path in `DeliveryLiveView`.
5. **Gate approve/reject = IPC** handled in main: records `approvedBy` (local identity
   placeholder `local-user` until S3), timestamp, comment; reject requires a comment and sets
   Delivery `Failed`.
6. **Crash recovery:** on boot, any `Running` delivery without an active context → new status
   `Interrupted` (resumable). `before-quit` aborts contexts, persists state, kills child agent
   processes.
7. **Delete:** `apiClient.ts`, `api.ts`, `mockData.ts`, auth/JWT/refresh code, the
   `rejectUnauthorized:false` agent, `backendUrl` setting, `confidenceThreshold`,
   `defaultAutonomyLevel`, `AdapterType`/`executorType` types, `claude:call` stub, broken unused
   preload git methods (grep before deleting), "NeedsHuman" wording → "Awaiting approval".
   `Setup.tsx` becomes a temporary local setup (workspace root + Claude key) until S3 onboarding.
8. **Bug fixes:** git token key mismatch (single typed accessor); DS1 large-output files move to
   `{userData}/runs/{deliveryId}/` and resume reloads them (review C4 truncated-marker bug);
   rename `cachedDefinition` → `instructions` in runners; Prompt-mode timeout + abort + bounded
   429 retry with `retry-after` (D4); default `workspaceRoot` per D7; Windows `split('/')` bug.
9. **Repo hygiene:** `git rm --cached .env.local build*.log`; `.gitignore` adds `*.log`, `.axon/`.
10. **Keep for now:** the existing PR tail in `runStepLoop` (removed in S4), but it must fail the
    delivery visibly instead of reporting Completed when git fails.
11. **Tests:** add vitest. ≥ 25 engine tests: start, linear run, gate approve, gate reject,
    cancel, resume after pause, crash → Interrupted → resume, double start blocked, step upsert,
    DS1 file round-trip.

## Acceptance criteria
- Airplane mode: full delivery lifecycle works with a mock runner block.
- `kill -9` mid-run → restart shows `Interrupted` → Resume completes the delivery.
- `grep -rn "/api/\|signalr\|apiClient" src electron` returns nothing.
- After a run, `git status` in the target worktree shows no AXON-written files.
- `npm run typecheck`, `npm test`, `npm run build` all pass.

## Out of scope
Registry, identity, Jira, provisioning, loops, security hardening (S2).
