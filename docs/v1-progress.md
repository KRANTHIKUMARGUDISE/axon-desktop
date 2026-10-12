# AXON v1 — Progress log

## Session 1 — Local-first core (2026-10-12)

### Done
- **`shared/`** package: zod schemas + types for Block, Pipeline, Delivery, DeliveryStep, AgentOutput, DeliveryEvent (D2), Settings; graph helpers (cycle-safe resume walk, validator), id helpers (`shortId`, `safeSegment`), `AxonBridge` types. Duplicate types in the old `executor.ts` and the second `AGENTIC_TOOL_CEILING` are gone.
- **Store**: `Store` interface + `FileStore` (`{userData}/store/`, one file per delivery, atomic tmp+fsync+rename writes, per-key mutex, step upsert by `(nodeId, itemKey=null)`, `localSeq` counter, local `pipelineSnapshot` incl. block versions, immutable seeded `human-gate` block).
- **Engine split**: `electron/engine/` (pure state machine; store, runner, workspace, bus, clock injected), `electron/runners/` (prompt / agentic / native / codex stub), `electron/ipc/` (thin handlers), `electron/workspace/gitWorkspace.ts` (real git port). `executor.ts` deleted.
- **Events**: one typed channel `delivery:event` carrying `DeliveryEvent`. `useSignalR`, `@microsoft/signalr`, and the second live-update path in `DeliveryLiveView` removed.
- **Gates**: approve/reject are IPC handled in main (`local-user`, timestamp, comment); reject requires a comment and fails the delivery; approve resumes.
- **Crash recovery**: `reconcileOnBoot()` → `Interrupted` (resumable); `before-quit` → `engine.shutdown()` aborts runs and persists.
- **Deleted**: `apiClient`, `api.ts`, `mockData.ts`, JWT/refresh code, the `rejectUnauthorized:false` agent, `backendUrl` / `confidenceThreshold` / `defaultAutonomyLevel` settings + UI, `AdapterType`/`executorType`, `claude:call` stub, broken preload git methods, generic secret oracle (`auth:getSecure` etc. → named `secrets:*` only), `system:getLatency`. "NeedsHuman" → "AwaitingApproval"/"Awaiting approval". `Setup.tsx` is a temporary local setup (workspace root + optional Claude key).
- **Bug fixes**: git token key mismatch (single `getGitToken()`); DS1 files moved to `{userData}/runs/{deliveryId}/` and reloaded on resume (and on `previewResume`); a failed DS1 write now fails the step; `cachedDefinition` → `instructions`; Prompt mode gets a timeout, abort and bounded 429 retry honouring `retry-after`; default `workspaceRoot` per D7; Windows `split('/')` bug; git/PR tail failure now fails the delivery; branch creation failure now fails fast (delivery stays `Pending`).
- **Repo hygiene**: `.env.local`, `build.log`, `build-win.log` untracked (`git rm --cached`, staged but not committed); `.gitignore` += `*.log`, `.axon/`.
- **Tests**: vitest, 82 tests (engine 41, store 15, runners 13, shared 13) incl. start, linear run, gate approve/reject, cancel (+ no overwrite by aborted runner), resume after pause/cancel, crash → Interrupted → resume, double start/approve blocked, step upsert, DS1 round-trip + resume reload + clean worktree.
- **Verified**: `npm run typecheck`, `npm test`, `npm run build` pass; `grep -rn "/api/\|signalr\|apiClient" src electron` is empty. A CDP script drove the real Electron app (IPC → engine → FileStore, no backend): create pipeline/delivery, start, pause at gate, reject-without-comment refused, approve → Completed with approver recorded, simulated hard kill → relaunch shows `Interrupted` → resume → Completed.

### Deferred / not done
- No manual click-through of the React UI (only the IPC-level e2e above and a clean build). Worth one visual pass over Dashboard / Deliveries / Live View / Settings / Setup.
- Child agent processes are stopped via the abort signal passed to the Agent SDK; I did not verify there are no orphaned `claude.exe` processes on Windows after a hard kill.
- Security hardening (unrestricted `workspace:*` IPC incl. `clear`, `shell:openExternal`, agent env scrubbing, `settingSources:['project']`, CSP) is S2. Intelligence page is still visible (D6 flag not in S1 scope). Codex is hidden only in the Create Block runtime picker.
- PR tail still lives in the engine loop via `WorkspacePort.finalize` (removed in S4); PR base branch is now the detected default branch rather than hardcoded `main`.

### Surprises
- The renderer never typechecked cleanly (unused locals, missing asset/CSS module declarations, loose types). Fixed to make `npm run typecheck` meaningful; added `src/vite-env.d.ts`, dropped deprecated `baseUrl` and the `references` entry from `tsconfig.json`.
- `vitest@5` needs Vite ≥ 6 (project is on Vite 5) → pinned `vitest@^3`.
- Installing with `--legacy-peer-deps` pruned `react-is` (peer of recharts) and broke `vite build`; re-added as a dependency.
- Moving `shared/` into the main compile changed the output layout to `dist-electron/electron/main.js`; updated `package.json` `main`, `electron-builder.config.js`, `BUILD.md`, and the `__dirname`-relative icon/`index.html` paths in `main.ts`.

### Assumptions made
- Local identity string is `local-user` until S3 identity; `localSeq` (shown as `#N`) replaces `jobNumber` for display only.
- Minimal built-in `human-gate` seed (id `axon-human-gate`) in S1; the versioned seed bundle is S3.
- Existing axon-api data is not migrated (fresh local store); legacy token files (`auth.token`, `axon-access-token.enc`, `axon-refresh-token.enc`, `git-token.enc`) are deleted on boot.
- Default workspace dir is `{workspaceRoot}/{ticket}-{shortId}` (not just `{ticket}`) so reruns of a ticket never collide and a hostile ticket id can't escape the root.
- Block `version` is an integer bumped on each update; pipeline `version` likewise (full D13 Draft/Published model is later).
- `partial` agent status is treated as a completed step (unchanged behaviour).
