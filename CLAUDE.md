# AXON Desktop — Claude Context

## What this is

Electron desktop app that lets developers run AI-powered delivery pipelines locally.
- **Local-first (v1 / Session 1):** there is no backend. Blocks, pipelines and deliveries are persisted on this machine; the app runs fully offline (except agent calls to Anthropic and git operations).
- Pipeline execution runs in the **Electron main process** (Node.js) as a testable engine; Claude is called directly from main.
- Git operations run locally via `simple-git`.
- The React UI lives in `src/`; shared schemas/types live in `shared/` (imported as `@shared` in the renderer, relatively from `electron/`).
- Session docs: `docs/v1-review.md`, `docs/v1-decisions.md` (locked decisions D1–D16), `docs/session-v1-s*.md`, progress log `docs/v1-progress.md`.

## How to run

```bash
npx vite                                            # Terminal 1 — React renderer (5173)
npx tsc -p tsconfig.electron.json && npx electron . # Terminal 2 — after Vite says "ready"
npm run typecheck && npm test && npm run build      # must all pass before finishing a session
```

Always recompile (`tsc -p tsconfig.electron.json`) after editing `electron/` or `shared/`. Main compiles to `dist-electron/electron/main.js` (`rootDir` is the repo root so `shared/` compiles alongside; `package.json` `main` points there).

## Architecture

```
shared/                      zod schemas + inferred types (Block, Pipeline, Delivery, DeliveryStep,
                             AgentOutput, DeliveryEvent, Settings), graph helpers, ids, AxonBridge types
Renderer (React/Vite)
  └── window.axon.*          ← contextBridge API (preload.ts), typed by shared/bridge.ts
        └── services/*Service.ts → window.axon.{blocks,pipelines,deliveries,delivery} (IPC)
        └── window.axon.events.onDeliveryEvent(cb)   ← the ONE live-update channel ('delivery:event')

Main process
  ├── store/     Store interface + FileStore ({userData}/store/{blocks,pipelines,deliveries}/{id}.json,
  │              atomic tmp+fsync+rename writes, per-key mutex = single writer, seed.ts built-in blocks)
  ├── engine/    createEngine({store, runner, workspace, bus, runsDir, ...}) — pure state machine
  │              (start/resume/cancel/approveGate/rejectGate/previewResume/reconcileOnBoot/shutdown),
  │              context.ts, runs.ts (DS1 files), bus.ts (typed event bus)
  ├── runners/   claudePrompt (timeout/abort/bounded 429 retry), claudeAgentic (Agent SDK), axonNative
  │              (human-gate), codex (stub, hidden in UI), output.ts (normalizeAgentOutput)
  ├── workspace/ gitWorkspace.ts — real WorkspacePort (clone, delivery branch, commit/push/PR tail)
  └── ipc/       thin handlers: data.ts (store CRUD), delivery.ts (engine + event channel),
                 secrets.ts (named secrets only), settings.ts, workspace.ts, claudeKeyStore.ts, system.ts, git.ts (library)
```

`Store` is the port that a future `GitRepoStore` (S3) / `ApiStore` implement. `WorkspacePort` and `Runner` are injected so the engine is unit-tested with fakes (`electron/engine/__tests__/harness.ts`).

## Key conventions

- **Documents** all carry `id`, `schemaVersion`, `createdAt`, `updatedAt`. Delivery has `localSeq` (per-machine display counter only — never in refs/paths, D1). `pipelineSnapshot` is built locally at delivery creation (nodes, edges, `blockVersions`).
- **Delivery status:** `Pending | Running | Paused | Completed | Failed | Cancelled | Interrupted`. `Interrupted` = was Running with no live run (crash/kill/quit); resumable. Resume allowed from `Paused | Cancelled | Interrupted`. Step status `AwaitingApproval` is shown as "Awaiting approval" (never "Needs Human").
- **Steps** are keyed by `(nodeId, itemKey)`, `itemKey = null` until ForEach (S4); upsert *replaces* the record.
- **Gates:** only Control-role blocks pause. `approveGate`/`rejectGate` are IPC handled in main: record `approvedBy` (`local-user` placeholder until S3 identity), timestamp, comment. Approve resumes; reject requires a comment and sets the delivery `Failed`.
- **Cancel/shutdown:** a run has a `stopped` flag + AbortController; every loop write goes through `guarded()`, so an aborted runner returning `failed` can never overwrite Cancelled/Interrupted. `before-quit` calls `engine.shutdown()` (abort, persist Interrupted). Boot calls `engine.reconcileOnBoot()`.
- **Git token** has one accessor: `getGitToken()` in `ipc/secrets.ts` (key `axon-git-token`). It is optional for clone/branch/push (falls back to local git credentials); PR creation (REST) needs it. The renderer can only `setGitToken/hasGitToken/clearGitToken` — never read it.
- **Branch name:** `axon/{userSlug}/{ticket}-{shortId}` (D1; shortId = 6-char base32 of the delivery id). Default workspace dir: `{workspaceRoot}/{ticket}-{shortId}`; default `workspaceRoot` per D7 (`%LOCALAPPDATA%\AXON\work` on Windows).
- **End-of-pipeline git tail** (commit → push → PR) still lives at the end of the engine's run loop via `WorkspacePort.finalize` (removed in S4). If it throws the delivery is `Failed` with the message — never reported Completed.
- **Seeded Axon blocks** (currently only `human-gate`, id `axon-human-gate`) are `immutable`; `FileStore` refuses update/delete. The full seed bundle arrives in S3.

## Key files

| File | Purpose |
|------|---------|
| `electron/main.ts` | Window, CSP, single-instance lock, wiring of store/engine/handlers, `before-quit` shutdown, boot reconcile |
| `electron/preload.ts` | `contextBridge.exposeInMainWorld('axon', {...})` |
| `shared/bridge.ts` | `AxonBridge` type for `window.axon` (declared globally in `src/axon.d.ts`) |
| `shared/schemas.ts` | All zod schemas + types; `DeliveryEvent` discriminated union (D2) |
| `electron/engine/engine.ts` | The state machine (run loop, gates, cancel, resume, crash recovery) |
| `electron/store/fileStore.ts` | Local persistence implementation of `Store` |
| `electron/runners/*` | Prompt / Agentic / native runners behind one `Runner` function |
| `electron/workspace/gitWorkspace.ts` | Real workspace + git side effects |
| `electron/ipc/settings.ts` | `electron-store` settings: `workspaceRoot`, `gitProvider`, `theme`, `setupComplete`, `userEmail`, `userName`, `maxContextSnapshotSizeKb`, `gitTokenSuffix` (writes validated against an allow-list) |
| `src/services/*Service.ts` | Renderer data layer — IPC wrappers that map stored docs to UI types |
| `src/App.tsx` | App shell, setup gate, global `delivery:event` → react-query invalidation |
| `tsconfig.electron.json` / `tsconfig.json` / `tsconfig.test.json` | Main (CJS) / renderer (ESNext) / test typecheck |
| `electron-builder.config.js` | `appId: com.company.axon`, NSIS on Win, DMG on Mac |

## Types (D8 BuildingBlock Artifact Model)

Canonical definitions are the zod schemas in `shared/schemas.ts` (`BlockSchema`, `PipelineSchema`, `DeliverySchema`, `DeliveryStepSchema`, `AgentOutputSchema`, `DeliveryEventSchema`). `src/types/index.ts` holds the UI-shaped view models (e.g. `BuildingBlock` lists `cachedFiles` as paths; the stored `Block` holds `{relativePath, content}`) and re-exports the shared enums.

```ts
// Block essentials (shared/schemas.ts)
role: 'Decision' | 'Execution' | 'Knowledge' | 'Control' | 'IO' | 'Utility'
sourceType: 'Axon' | 'Local' | 'Marketplace' | 'CDF'   // Axon = seeded, immutable
agentRuntime: 'Axon' | 'Claude' | 'Codex'                // Codex hidden in UI (D4)
artifactFormat: 'Native' | 'Skill'
executionType?: 'Prompt' | 'Agentic'
version: number                                          // bumped on every update
cachedFiles?: { relativePath: string; content: string }[]; entryPointPath?: string
contextRequirements?: string[]; outputSchema?: string[]; allowedTools?: string[]

// Runner contract (electron/runners/types.ts)
RunnerInput { block, nodeLabel, instructions /* entry-file content */, deliveryContext,
              workspacePath, effectiveTools, timeoutSeconds, signal }
AgentOutput { status: 'success'|'partial'|'failed', confidence?, summary, result, errorMessage?,
              toolsUsed?, toolsDenied?, timedOut?, isTruncated?, outputFileRef? }   // confidence is display-only (D5)
```

## DS1 — Large Output Storage (implemented)

The engine captures two things per step:

- **`contextSnapshot`** — the full resolved context pool the block saw (only when the delivery has `storeFullContext`).
- **`output.result`** — `AgentOutput.result` as returned by the agent.

Both pass through `storeIfLarge()` (`electron/engine/runs.ts`):
- **Under the threshold** (`maxContextSnapshotSizeKb`, default 50KB) they are stored inline in the delivery document.
- **At/over it**, the full JSON is written to `{userData}/runs/{deliveryId}/{inputs|outputs}/{nodeId}-{ts}.json` (never inside the repo worktree) and the document keeps a marker (`{ truncated: true, sizeBytes, note }`) plus `contextFileRef` / `output.outputFileRef` (relative to the delivery's runs dir). A failed write fails the step.
- **Resume** reloads the full result from the file (`reconstructResults`), so downstream steps never see the marker. `deliveries:stepData` (IPC) returns full content for the UI, reading the file when needed.
- In-memory handoff between steps in one run always uses the full, untruncated result.

## window.axon API surface

```ts
window.axon.blocks.{list,get,create,update,delete}
window.axon.pipelines.{list,get,create,update,delete}
window.axon.deliveries.{list,get,create,stepData(deliveryId,nodeId,'context'|'output')}
window.axon.delivery.{start,resume,cancel,previewResume,approveGate(id,comment?),rejectGate(id,comment),clearWorkspace(id)}
window.axon.events.onDeliveryEvent(cb) // returns unsubscribe; payload is the typed DeliveryEvent union
window.axon.secrets.{setGitToken,hasGitToken,setJiraToken,hasJiraToken,clearJiraToken}
window.axon.settings.{get,set,getAll}
window.axon.workspace.{readFile,listFilesRecursive}   // path-guarded; clearing = delivery.clearWorkspace(id)
window.axon.claudeKey.{getStatus,set,confirmDetected,rejectDetected}   // in-memory Claude key (D3: Console API key only)
window.axon.dialog.{openDirectory,openFile}
window.axon.shell.{openExternal,openPath,openInVSCode}
window.axon.system.{getInfo,checkForUpdates}
window.axon.window.setTitle(title)
```

## Security model (S2)

- **IPC**: register channels only via `electron/ipc/guard.ts` `handle(channel, zodTupleSchema, fn)` / `on(...)` — it checks the sender frame (dev server origin or packaged index.html) and validates args. Never call `ipcMain.handle` directly.
- **Paths**: `electron/security/paths.ts` `resolveInside(p, roots)` (realpath, no `~`/UNC/relative) for anything renderer- or agent-supplied. Renderer file access = `workspaceRoot` / `{userData}` / `{userData}/registry` + folders picked in a native dialog this session (read-only). No renderer write/clear of arbitrary paths exists.
- **Settings**: writable keys have validators in `SETTING_VALIDATORS` (`shared/schemas.ts`); add a validator before exposing a new key. URL settings must use `parseHttpsUrl(value, allowedHosts)`.
- **Secrets**: named `secrets:*` / `claudeKey:*` APIs only, never returning values. Register new secrets with `registerSecret()` (logger redaction). A Claude key found in `~/.claude.json` is a *candidate* until confirmed in the UI (D3).
- **Logging**: use `log` from `electron/log.ts` (no `console.*` in `electron/`); output is redacted and rotated in `{userData}/logs`.
- **Git credentials**: never in URLs/argv — `makeGit()` in `ipc/git.ts` supplies the token via `GIT_ASKPASS` env and applies `protocol.ext/file.allow=never`.
- **Agents**: `security/agentPolicy.ts` (`decideToolUse`, `buildAgentEnv`, `MANAGED_DENY_RULES`) powers the PreToolUse hook in `runners/claudeAgentic.ts`; denials land in `toolsDenied` + `denials`. Ticket text is fenced via `buildUntrustedContext`; `outputSchema` fields are enforced on success outputs.
- **CSP** is a `<meta>` injected by the `axon-csp-meta` Vite plugin (`vite.config.mts`); add new `connect-src` hosts there. Fonts are bundled (`@fontsource-variable/*`), no remote font hosts.

## Constraints — do not change these

- **`electron-store` is pinned to `8.1.0`** — v8.2+ is ESM-only and breaks CommonJS Electron main. Do not upgrade.
- **`electron-keytar` is not used** — it was removed from npm. Auth uses Electron's built-in `safeStorage` API instead.
- **Node ≥ 22.12 (22 or 24)** — required by Electron 44's npm package. `package.json` `allowScripts` is keyed by exact Electron version (`electron@44.7.0`): bump it together with Electron or the binary postinstall is skipped silently (fix: `node node_modules/electron/install.js`; see SETUP.md).
- **CSP is relaxed in dev** (`unsafe-inline`, `unsafe-eval`) — this is intentional for Vite HMR. Production uses a strict policy.
- **`index.html` has a React refresh preamble script** — required by `@vitejs/plugin-react` when loading from Electron (not a browser). Do not remove it.

## IPC channel naming convention

```
<domain>:<action>
```
Examples: `auth:storeToken`, `workspace:readFile`, `git:clone`

## What is NOT built yet

- D9: Marketplace/CDF browse UI, version management, edit/delete for blocks

## Delivery Live View — Pipeline Graph

`DeliveryLiveView.tsx` renders `delivery.pipelineSnapshot.nodes/edges` as a read-only
`@xyflow/react` graph, reusing the exact same node components as Pipeline Creator
(`src/components/pipeline/nodes/*`, `nodeTypes`/`edgeTypes` map) — not a parallel
component. `nodesDraggable`/`nodesConnectable` are `false`.

- **Role/Runtime per node**: `pipelineSnapshot.nodes` only has `{id, blockId, label,
  position, ...}` — no role/runtime. The view fetches all blocks once via `getBlocks()`
  (same as Pipeline Creator) and resolves `node.blockId → block.role/agentRuntime`.
- **Status overlay**: `BaseNode.tsx` gained one new optional prop, `data.executionStatus?:
  'Pending' | 'Running' | 'Success' | 'Failed' | 'AwaitingApproval'` — renders a colored ring +
  badge on the existing node shape. Undefined in Pipeline Creator's own usage (zero visual
  change there); driven by matching `delivery.steps[]` (by `nodeId`) in the Live View.
- **Live updates**: driven entirely by the single typed `delivery:event` channel
  (`window.axon.events.onDeliveryEvent`); SignalR is gone. `status_changed` events drive the displayed status.
- **Node click → detail panel**: replaces the right-side Live Signals/Job Details panel
  while a node is selected (toggled via `display: none/block`, not unmount, to preserve
  the signals feed underneath). Shows status/timing, `contextSnapshot` (Input) and
  `output.result` (Output) as key/value lists, confidence bar, summary, error/gate reason,
  and Approve/Reject when the selected node is the delivery's current paused gate
  (`node.id === delivery.currentNodeId && delivery.status === 'Paused'`).
- **Truncated content** (`isContextTruncated`/`isTruncated` — see DS1): shows a "view full
  content in workspace" button instead of the inline list, calling
  `window.axon.workspace.readFile()` on `contextFileRef`/`outputFileRef` and displaying the
  result in a modal. Uses `deliveries.stepData` (main reads the DS1 file from `{userData}/runs/`).

## Create Block Flow (D8 — Artifact Model)

**UI Components:**
- `src/components/blocks/CreateBlockForm.tsx` — Main form with Role, Runtime, Source Type, Artifact sections
- `src/components/blocks/ArtifactPopup.tsx` — Modal for folder selection + SKILL.md parsing

**Flow:**
1. User clicks "+ Create Block" on Building Blocks page
2. CreateBlockForm opens with Name, Description, Role (icon picker), Runtime dropdown
3. User selects Source Type (Axon: disabled; Local: default; Marketplace/CDF: coming soon)
4. If Local selected: "Add Artifact" button opens ArtifactPopup
5. ArtifactPopup:
   - Opens Electron file dialog (`window.axon.dialog.openDirectory()`)
   - Calls `window.axon.workspace.listFilesRecursive(path, 2)` to read all files one level deep
   - Looks for SKILL.md at root; if found, sets as entryPointPath
   - Parses YAML frontmatter from SKILL.md using `parseSkillFrontmatter()` (minimal inline parser)
   - Extracts `name` and `description` keys, shows them in preview
   - If user clicks Attach, returns cachedFiles + entryPointPath + parsed metadata to CreateBlockForm
6. CreateBlockForm auto-fills Name and Description from SKILL.md metadata (if empty)
   - Shows "from SKILL.md" label next to auto-filled fields
7. User sets Tags, Context Requirements, Output Schema
8. Create Block button submits via `createBlock()` service with new shape:
   ```
   { name, role, description, sourceType, agentRuntime, artifactFormat: 'Skill',
     artifactName, cachedFiles, entryPointPath, tags, contextRequirements, outputSchema }
   ```

**Utilities:**
- `src/utils/skillParser.ts` — `parseSkillFrontmatter(content)` returns `{ name?, description? }`
  - Minimal inline parser for YAML frontmatter (no external YAML dependency)
  - Pattern: `^---\s*\n([\s\S]*?)\n---` (frontmatter is delimited by `---`)
  - Extracts `key: value` pairs, handles optional quotes
  - Returns null if no frontmatter found
- `src/utils/runtimeIcons.ts` — Runtime color/label maps for badge display

**Block Detail & Card Display:**
- BlockCard: shows Runtime badge (top-right) + Source Type indicator (dot + label)
  - Axon blocks: yellow dot + "Axon" label (distinct visual treatment)
  - Local/Marketplace/CDF blocks: grey dot + type label
- BlockDetailPanel: shows Source Type, Runtime, full Artifact section (entry point + file list)
  - Axon-sourced blocks hide Edit/Delete/Sync buttons
- Pipeline Creator nodes: Runtime badge in corner (secondary indicator, doesn't compete with Role shape)

**Validation:**
- Create Block disabled until: Name filled, Role selected, Runtime selected (or fixed to Axon), Source Type selected, and (if Local) artifact attached
- If Source Type = Marketplace or CDF: "Coming soon" placeholder, Create Block disabled

## Delivery Execution Flow

1. User creates a delivery (`deliveries:create` → FileStore builds the snapshot) and the Live View calls `delivery:start`.
2. `engine.start`: claim the delivery (double start blocked), validate the snapshot graph, `WorkspacePort.prepare` (clone/open + branch; failure leaves it `Pending`), mark `Running`, launch the run loop.
3. Per node: emit `step_started`, upsert a Running step, build `DeliveryContext` (flat pool of prior results + inputs), call the `Runner`, store output (DS1), upsert the finalized step, emit `step_completed`.
4. Control-role block → step `AwaitingApproval`, delivery `Paused`, `gate_reached`; the run unwinds (nothing is kept in memory). `approveGate` / `resume` rebuild context from the store and continue at the first node without a Completed step.
5. After the last node: git tail (`finalize`) if a branch exists, then `Completed` (+ `prUrl`). Any failure → `Failed` + `failed` event.

## Verify it works

```bash
npm run typecheck && npm test && npm run build
grep -rn "/api/\|signalr\|apiClient" src electron   # must print nothing
```

In DevTools: `window.axon` → `blocks, pipelines, deliveries, delivery, events, secrets, settings, ...`. Subscribe with `window.axon.events.onDeliveryEvent(console.log)`, create a pipeline with the built-in Human Gate block, create a delivery and `window.axon.delivery.start(id)`.
