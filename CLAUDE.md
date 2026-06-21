# AXON Desktop — Claude Context

## What this is

Electron desktop app that lets developers run AI-powered delivery pipelines locally.
- Pipeline execution runs in the **Electron main process** (Node.js), not a server
- Claude API is called directly from the main process
- Git operations run locally via `simple-git`
- Results are logged to the AXON Backend API (separate repo: `axon-api`)
- The React UI lives in `src/` — there is no dependency on the separate `axon-ui` folder

## How to run

Two terminals required:

```bash
# Terminal 1 — React renderer
npx vite

# Terminal 2 — after Vite says "ready"
npx tsc -p tsconfig.electron.json && npx electron .
```

Always recompile (`tsc -p tsconfig.electron.json`) after editing any file in `electron/`.

## Architecture

```
Renderer (React/Vite, port 5173)
  └── window.axon.*          ← contextBridge API (preload.ts)
        └── ipcRenderer.invoke(channel, ...args)
  └── useAuthReady()          ← Auth guard hook (D6 fix)
        └── Delays queries until token + backendUrl ready

Main process (Node.js/Electron)
  └── ipcMain.handle(channel, handler)
        ├── auth.ts          ← safeStorage (OS keychain)
        ├── settings.ts      ← electron-store (disk, non-sensitive)
        ├── workspace.ts     ← fs/promises wrappers
        ├── git.ts           ← Real simple-git operations (clone, branch, commit, push, PR)
        ├── executor.ts      ← Real agent execution + block fetching (D6)
        └── claude.ts        ← Real Claude API calls (D6)
```

## Key files

| File | Purpose |
|------|---------|
| `electron/main.ts` | BrowserWindow creation, CSP, single-instance lock, IPC registration |
| `electron/preload.ts` | `contextBridge.exposeInMainWorld('axon', {...})` — defines the full `window.axon` API |
| `electron/types.d.ts` | `AxonBridge` interface + `Window` augmentation for renderer type safety |
| `electron/ipc/auth.ts` | Token store/get/clear via `safeStorage` + encrypted file in `userData` |
| `electron/ipc/settings.ts` | `electron-store` schema: `backendUrl`, `workspaceRoot`, `defaultAutonomyLevel`, `confidenceThreshold`, `gitProvider`, `theme` |
| `electron/ipc/workspace.ts` | `listDirs`, `exists`, `readFile`, `writeFile`, `createDir`, `listFilesRecursive` |
| `electron/ipc/git.ts` | Real `simple-git` operations: clone/open, branch creation, commit, push, PR creation (GitHub + Azure DevOps) |

`createDeliveryBranch()` names branches `axon/{osUsername}/{jobNumber}/{ticketId}`
(e.g. `axon/kranthi/247/PROJ-2341`) — `{osUsername}` is `os.userInfo().username`,
slugified (lowercased, non-alphanumeric → `-`) since git refs can't contain spaces/specials.
`{jobNumber}` is the delivery's globally unique counter value (see `axon-api/CLAUDE.md`).
No type prefix (`feat`/`fix`) — that needs a ticket-type lookup (e.g. via a TicketFetcher
block) that runs *after* branch creation today, so it isn't known yet; deliberately not
guessing one. The actual created branch name is persisted to `Delivery.Branch` via a
`PATCH /status` call right after creation — don't rely on a client-side guess for display.

**Git token is optional, not required**, for clone/branch-create/push (`cloneOrOpen`,
`createDeliveryBranch`, `pushBranch`) — when one isn't configured in Settings, these fall
back to plain git operations and trust whatever the local machine already has set up (SSH
key, Windows/Git Credential Manager). `injectTokenIntoUrl()` is only used when a token *is*
present. PR creation (`createGitHubPR`/`createAzureDevOpsPR`) is the one exception that
still hard-requires the token — it's a direct REST API call, not a git operation, so local
git credentials don't apply there. PR creation is also currently hardcoded into
`runStepLoop`'s end-of-pipeline tail rather than being a real pipeline block — known gap,
deferred (the seeded `pr-creator`/`ticket-fetcher` blocks have `AgentRuntime: Axon`, which
`runAgentForBlock`'s dispatcher doesn't actually handle yet — same unbuilt-native-runtime gap
as the Codex skeleton).

| `electron/ipc/executor.ts` | Real execution: fetches blocks, builds context, calls runAgent, stores step results |
| `electron/ipc/claude.ts` | Real Claude API: callClaude (POST to Anthropic), runAgent (orchestration + JSON parsing) |
| `src/hooks/useAuthReady.ts` | Auth guard: checks if backendUrl + token exist before enabling queries |
| `src/App.tsx` | App shell with setup flow and protected routes |
| `tsconfig.electron.json` | CommonJS + Node types for main process |
| `tsconfig.json` | ESNext + DOM for renderer |
| `vite.config.ts` | Renderer on port 5173, output to `dist/renderer/` |
| `electron-builder.config.js` | `appId: com.company.axon`, NSIS on Win, DMG on Mac |

## Types (D8 BuildingBlock Artifact Model)

```ts
// src/types/index.ts
export type SourceType = 'Axon' | 'Local' | 'Marketplace' | 'CDF'
export type AgentRuntime = 'Axon' | 'Claude' | 'Codex'
export type ArtifactFormat = 'Native' | 'Skill'
export type BlockType = 'Decision' | 'Execution' | 'Knowledge' | 'Control' | 'IO' | 'Utility'

export interface BuildingBlock {
  id: string
  name: string
  role: BlockType                       // renamed from 'type'
  description: string
  version: string
  sourceType: SourceType                // Axon (system), Local, Marketplace, CDF
  agentRuntime: AgentRuntime            // Claude, Codex, Axon (fixed for Axon-sourced blocks)
  artifactFormat: ArtifactFormat        // Native, Skill
  artifactName?: string                 // user-facing name of attached artifact
  cachedFiles?: string[]                // relative paths of all files in artifact
  entryPointPath?: string               // path to SKILL.md or entry point file
  contextRequirements?: string[]        // selective context injection
  outputSchema?: string[]               // branch condition fields
  tags: string[]
  verified?: boolean
  usageCount?: number
  createdAt: string
  updatedAt: string
  createdByName?: string
  usedInPipelineIds?: string[]
  syncStatus?: SyncStatus
  // Legacy fields for backward compatibility (being phased out)
  type?: BlockType
  adapterType?: string
  executorType?: string
}

// electron/ipc/claude.ts
interface DeliveryContext {
  ticketId: string
  ticketTitle?: string
  previousStepsResults: Record<string, unknown>
  currentInputs: Record<string, unknown>
}

interface StepInput {
  blockId: string
  blockName: string
  cachedDefinition: string               // AGENT.md + prompt.md combined
  deliveryContext: DeliveryContext
  contextRequirements?: string[]         // selective context injection
  claudeApiKey: string
}

interface AgentOutput {
  status: 'success' | 'partial' | 'needs_human' | 'failed'
  confidence: number
  summary: string
  result: Record<string, unknown>
  humanGateReason?: string
  errorMessage?: string
  isTruncated?: boolean      // DS1 — set by executor.ts, not by runAgent()
  outputFileRef?: string     // DS1 — relative path under {workspacePath}/.axon/outputs/
}
```

## DS1 — Large Output Storage (implemented)

`executor.ts`'s `runStepLoop` captures two things per step before POSTing to the backend:

- **`contextSnapshot`** — the actual resolved values for the block's `contextRequirements`
  (built via `buildContextSnapshot()`, mirroring `claude.ts`'s own field-selection logic) —
  i.e. exactly what the block saw as input, not just which fields it declared needing.
- **`outputResult`** — `AgentOutput.result` as returned by the agent.

Both pass through `checkAndStoreIfLarge(workspacePath, subfolder, nodeId, data)`:
- If the serialized size is **under 50KB**, sent inline as-is.
- If **50KB or over**, the full JSON is written to `{workspacePath}/.axon/{inputs|outputs}/{nodeId}-{timestamp}.json`,
  and the backend instead receives a small marker (`{ truncated: true, sizeBytes, note }`)
  plus the relative file path (`contextFileRef` / `output.outputFileRef`).

The full (untruncated) `output.result` is still what's stored in `ctx.stepResults` for
downstream steps' prompts — truncation only affects what's persisted to MongoDB, never the
in-memory pipeline handoff between steps in the same run.

Backend (`axon-api`) only stores/returns whatever it's sent — `POST /api/deliveries/{id}/steps`
rejects payloads over 500KB (`Request.ContentLength`) with a 413 as a safety net, but does no
truncation logic itself; that's entirely Desktop's responsibility, per DS1's local-first design.

## window.axon API surface

```ts
window.axon.auth.storeToken(token)
window.axon.auth.getToken()
window.axon.auth.clearToken()
window.axon.auth.storeSecure(key, value)
window.axon.auth.getSecure(key)
window.axon.auth.clearSecure(key)

window.axon.settings.get(key)
window.axon.settings.set(key, value)
window.axon.settings.getAll()

window.axon.workspace.listDirs(path)
window.axon.workspace.exists(path)
window.axon.workspace.readFile(path)
window.axon.workspace.writeFile(path, content)
window.axon.workspace.createDir(path)
window.axon.workspace.listFilesRecursive(path, maxDepth?)   // Used by artifact popup

window.axon.git.clone(repoUrl, targetPath, token)       // stub (D7)
window.axon.git.status(workspacePath)                   // stub (D7)
window.axon.git.createBranch(workspacePath, branchName) // stub (D7)
window.axon.git.addAndCommit(workspacePath, message)    // stub (D7)
window.axon.git.push(workspacePath, branch, token)      // stub (D7)

window.axon.executor.start(deliveryId)                  // Real (D6)
window.axon.executor.resume(deliveryId)                 // Real (D6)
window.axon.executor.cancel(deliveryId)                 // Real (D6)
window.axon.executor.onProgress(handler)                // Real (D6)

window.axon.claude.call(prompt, apiKey)                 // Internal only
```

## Constraints — do not change these

- **`electron-store` is pinned to `8.1.0`** — v8.2+ is ESM-only and breaks CommonJS Electron main. Do not upgrade.
- **`electron-keytar` is not used** — it was removed from npm. Auth uses Electron's built-in `safeStorage` API instead.
- **Node 20 or 22 only** — Electron 31's binary postinstall script silently fails on Node 24. The binary must be manually extracted if it fails (see SETUP.md).
- **CSP is relaxed in dev** (`unsafe-inline`, `unsafe-eval`) — this is intentional for Vite HMR. Production uses a strict policy.
- **`index.html` has a React refresh preamble script** — required by `@vitejs/plugin-react` when loading from Electron (not a browser). Do not remove it.

## IPC channel naming convention

```
<domain>:<action>
```
Examples: `auth:storeToken`, `workspace:readFile`, `git:clone`

## What is NOT built yet

- D9: Marketplace/CDF browse UI, version management, edit/delete for blocks

## What is built (D6)

**Claude API Integration** — Real agent execution end-to-end:
- `electron/ipc/claude.ts`:
  - `callClaude(apiKey, systemPrompt, userMessage)` — POST to `https://api.anthropic.com/v1/messages` with model `claude-sonnet-4-5`, max_tokens 4096
  - `runAgent(input: StepInput)` — Orchestrates: build system prompt from `block.cachedDefinition`, append output format instructions, build user message from selective context (filtered by `contextRequirements`), call Claude, parse + validate JSON, handle errors
  - Error handling: invalid API key → clear error; rate limit (429) → retry after 60s; network/parse errors → logged + graceful failures
  - Token tracking: logs input/output token usage to console

- `electron/ipc/executor.ts`:
  - `fetchBlocks(blockIds)` — Fetches all BuildingBlock definitions at delivery start
  - ExecutionContext now includes `blocks: Map<blockId, BuildingBlock>` and `stepResults` accumulator
  - Each step receives richer context: ticketId, ticketTitle, previousStepsResults (filtered by contextRequirements)
  - After successful steps, results stored in stepResults for downstream steps to access

- `src/hooks/useAuthReady.ts`:
  - Auth guard hook that checks if backendUrl + token exist
  - Used to delay queries until auth complete (fixes 401 race condition on dashboard load)
  - Applied to: Dashboard, Deliveries, Pipelines, NewDeliveryModal

- UI displays real Claude output via the Delivery Live View pipeline graph (see below) —
  `StepList.tsx`/`StepOutputViewer.tsx` (the original D6/D8 linear step list) were removed
  once the graph view replaced them entirely.

## Delivery Live View — Pipeline Graph

`DeliveryLiveView.tsx` renders `delivery.pipelineSnapshot.nodes/edges` as a read-only
`@xyflow/react` graph, reusing the exact same node components as Pipeline Creator
(`src/components/pipeline/nodes/*`, `nodeTypes`/`edgeTypes` map) — not a parallel
component. `nodesDraggable`/`nodesConnectable` are `false`.

- **Role/Runtime per node**: `pipelineSnapshot.nodes` only has `{id, blockId, label,
  position, ...}` — no role/runtime. The view fetches all blocks once via `getBlocks()`
  (same as Pipeline Creator) and resolves `node.blockId → block.role/agentRuntime`.
- **Status overlay**: `BaseNode.tsx` gained one new optional prop, `data.executionStatus?:
  'Pending' | 'Running' | 'Success' | 'Failed' | 'NeedsHuman'` — renders a colored ring +
  badge on the existing node shape. Undefined in Pipeline Creator's own usage (zero visual
  change there); driven by matching `delivery.steps[]` (by `nodeId`) in the Live View.
- **Live updates**: driven entirely by the existing `executor.onProgress` IPC channel
  (no SignalR — see DS1 section above for why SignalR isn't the live-update path here).
- **Node click → detail panel**: replaces the right-side Live Signals/Job Details panel
  while a node is selected (toggled via `display: none/block`, not unmount, to preserve
  the signals feed underneath). Shows status/timing, `contextSnapshot` (Input) and
  `output.result` (Output) as key/value lists, confidence bar, summary, error/gate reason,
  and Approve/Reject when the selected node is the delivery's current paused gate
  (`node.id === delivery.currentNodeId && delivery.status === 'Paused'`).
- **Truncated content** (`isContextTruncated`/`isTruncated` — see DS1): shows a "view full
  content in workspace" button instead of the inline list, calling
  `window.axon.workspace.readFile()` on `contextFileRef`/`outputFileRef` and displaying the
  result in a modal. No new backend endpoint — reuses the existing IPC file-read.

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

## Delivery Execution Flow (D6)

1. User clicks "Start Delivery" on dashboard (after auth + setup complete)
2. `executor.start(deliveryId)` invoked from renderer
3. Main process:
   - Fetches delivery details from backend API
   - Fetches all pipeline blocks via `GET /api/blocks/{id}` (once per delivery)
   - Clones/opens repo via git (D7 stub for now)
   - Starts async runStepLoop
4. For each step:
   - Sends `execution:progress` with type `step_started`
   - Fetches block definition from cached blocks Map
   - Builds DeliveryContext: ticketId, title, previousStepsResults (accumulated from prior steps)
   - Filters context by block.contextRequirements (selective injection)
   - Calls `runAgent(StepInput)` → calls Claude → parses JSON
   - Sends `execution:progress` with type `step_completed` + full AgentOutput
   - Posts step result to backend API (`POST /api/deliveries/{id}/steps`)
   - Stores step.result in context for next step
5. On gate (needs_human or Control node):
   - Sends `gate_reached` progress event
   - Pauses delivery (stays in activeExecutions Map)
   - Waits for `executor.resume()` or `executor.cancel()`
6. After all steps or on error:
   - Updates delivery status (Completed/Failed)
   - Cleans up from activeExecutions Map

## Auth Flow & Query Guard (D6 fix)

**Problem (pre-D6):** Dashboard queries started immediately after setup, before token loaded → 401 errors

**Solution:** `useAuthReady()` hook
- Checks: `await Promise.all([settings.get('backendUrl'), auth.getSecure('axon-access-token')])`
- Returns boolean flag
- Applied to all data-fetching pages via `enabled` prop on useDeliveries/usePipelines
- Queries automatically start once auth is ready (React Query reactivity)

**Protected routes:**
- Setup page shown until `setupComplete === true`
- Dashboard waits for `useAuthReady()` before fetching
- Auth token auto-refreshes on 401 via axios interceptor (apiClient.ts)

## Verify it works

Open DevTools Console in the Electron window and run:
```js
window.axon
// → object with auth, settings, workspace, git, executor, claude

// Start a delivery to watch Claude API calls
const result = await window.axon.executor.start('delivery-id')
console.log(result) // { success: true }

// Listen to progress events
window.axon.executor.onProgress((event, data) => {
  console.log(data.type, data.output?.summary, data.output?.confidence)
})
```
