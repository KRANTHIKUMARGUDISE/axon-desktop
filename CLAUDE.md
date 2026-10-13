# AXON Desktop — Claude Context

## What this is

Electron desktop app that lets developers run AI-powered delivery pipelines locally.
- **Local-first with a shared registry (v1 / Sessions 1–3):** there is no backend. Blocks, pipelines and deliveries are persisted on this machine and the app runs fully offline (except agent calls to Anthropic and git operations). Since S3 the engineer's own blocks/pipelines also sync to a shared `axon-registry` git repo (`users/{email}/…`), and Team/Org definitions are read from it. Deliveries never leave the machine — only a whitelisted run summary does.
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
  ├── store/     Store interface + FileStore ({userData}/store/{blocks,pipelines,deliveries}/{id}.json, published versions in
  │              versions/{blocks|pipelines}/{id}/v{n}.json, atomic tmp+fsync+rename writes, per-key mutex = single writer,
  │              optional read-only `definitions` source = registry org/team docs) · GitRepoStore (wraps FileStore, mirrors the
  │              engineer's own docs into the registry write queue) · seed.ts (verified seed bundle → built-in Axon blocks)
  ├── registry/  layout (paths + the write guard), queue (durable ops), sync (clone/fetch/replay/commit/push), reader (org/team
  │              docs from the clone), docs (YAML mapping), promote (PR flow), runSummary, secretScan, onboarding (Jira/GitHub checks),
  │              service (profile/activity/run records, hydration), config (build-time default URL)
  ├── identity.ts  machine id + verified identity provider (replaces the old `local-user` placeholder)
  ├── engine/    createEngine({store, runner, workspace, bus, runsDir, ...}) — pure state machine
  │              (start/resume/cancel/approveGate/rejectGate/previewResume/reconcileOnBoot/shutdown),
  │              context.ts, runs.ts (DS1 files), bus.ts (typed event bus)
  ├── runners/   claudePrompt (timeout/abort/bounded 429 retry), claudeAgentic (Agent SDK), axonNative
  │              (human-gate), codex (stub, hidden in UI), output.ts (normalizeAgentOutput)
  ├── workspace/ gitWorkspace.ts (WorkspacePort: only resolves the delivery root dir) · provisioner.ts (mirrors + worktrees) · prCreator.ts (commit/push/PR)
  └── ipc/       thin handlers: data.ts (store CRUD), delivery.ts (engine + event channel),
                 secrets.ts (named secrets only), settings.ts, workspace.ts, claudeKeyStore.ts, system.ts, git.ts (library)
```

`Store` is the port that a future `GitRepoStore` (S3) / `ApiStore` implement. `WorkspacePort` and `Runner` are injected so the engine is unit-tested with fakes (`electron/engine/__tests__/harness.ts`).

## Registry, identity and versioning (S3)

- **Layout (D9, single branch `main`, folder = future DB collection):** `registry.yaml` (schemaVersion, minAppVersion) · `catalog/` (PR only) · `org/{pipelines,blocks}` and `teams/{team}/…` (PR only) · `users/{email}/{profile.yaml, pipelines, blocks, runs/{yyyy-mm}/{id}.json, activity.log}` (direct commit by that user). `{email}` is lowercased and validated (`registry/layout.ts`). Every doc carries `id, schemaVersion, scope (Personal|Team|Org), owner`.
- **The write guard:** every direct registry write goes through `assertWritable(path, email)` — only `users/{email}/…`. It runs at enqueue time, again when ops are replayed at commit, and the staged file list is re-checked before `git commit`. Org/team changes only happen through `promote` (a PR branch + GitHub API).
- **Sync (`registry/sync.ts`):** fetch → reset the clone to `origin/{branch}` → replay queued ops → secret scan → commit → push. Because each engineer only writes their own folder this is equivalent to rebasing and cannot conflict; a non-fast-forward push re-fetches and replays with backoff (5 tries) before the state becomes `NeedsAttention`. Offline → `Offline`; `registry.yaml.minAppVersion` > app (or a newer schema) → `ReadOnly` (queue kept). **The queue** (`{userData}/registry-queue/pending/*.json`, atomic) is the source of truth until a push succeeds — ops are removed only afterwards, so a crash/offline/rejected push never loses a write. Ops that trip the secret scan move to `rejected/` (kept, shown in Settings) and are forgotten when a newer version of the file syncs. States are pushed to the renderer on `registry:status`.
- **Offline cache:** the clone in `{userData}/registry/` *is* the read-through cache. `RegistryReader` (org + teams) feeds `FileStore`'s `definitions` fallback, so `getBlock/getPipeline/listBlocks/createDelivery` see shared docs transparently; scope/team come from where a file lives, never from its contents, and seeded ids can't be shadowed. Documents this engineer authored on another machine are *hydrated* (imported if missing locally); a one-time **backfill** queues pre-S3 local docs.
- **Versioning (D13):** blocks and pipelines have `version`, `status: Draft|Published|Deprecated`, `versionLabel?`, `changeNote?`, `derivedFrom?{id,version}`. A Draft's `version` is the number it will get when published; **editing a Draft edits in place, editing a Published doc starts the next Draft (version+1)**. `publish` freezes `versions/…/v{n}.json` (immutable; only `status` may flip to Deprecated). Publishing a pipeline pins every node's `blockVersion` (blocks must be published first). Registry files: pipelines `{root}/pipelines/{id}/{draft|v{n}}.yaml`; blocks `{root}/blocks/{id}/{draft|v{n}}/block.yaml` + `files/…` (skill files). `createDelivery` records `pipelineId/pipelineVersion/blockVersions`; **the engine runs the pinned block versions** (falls back to the current block only for legacy deliveries that predate version files). UI: scope/status badges, version history + Publish/Deprecate/Duplicate/Promote dialog (`VersionDialog`), "newer block version available" on pipeline cards (`newerBlockVersion` in `shared/versioning.ts`).
- **Schema versioning:** `SCHEMA_VERSION = 2`; `shared/migrations.ts` upgrades N-1 in memory on every read (v1 local docs become Published Personal docs) and refuses newer/older documents (`SchemaVersionError`; unreadable registry docs are skipped and listed, never fatal).
- **Seed bundle:** `resources/seed/{manifest.json, blocks/*/block.yaml}` (human-gate + stubs for workspace-provisioner, pr-creator, ticket-fetcher, test-runner — stubs have no native handler yet). Loaded as `sourceType: Axon, scope: Org, immutable`; sha256 per block is verified on load (mismatch → skipped). Regenerate the manifest with `node scripts/build-seed-manifest.js` after editing a seed block. Immutability is enforced in `FileStore` (update/delete/duplicate/promote refuse), not just the UI. Packaged via `extraResources`.
- **Identity:** `profile.yaml` = email, displayName (from Jira), team, machines[{id,name,lastSeen}]. Machine id = random UUID in `{userData}/machine.json`. **`userEmail/userName/jiraSite/jiraVerifiedAt/setupComplete` are written only by main (`onboarding:complete` / `jira:commitChange`)** (after `/myself` returned the same email) — they are not renderer-writable settings. `identity.actor()` (email) is the gate approver; `identity.displayName()` is `createdByName`. `LOCAL_USER` remains only as the engine's last-resort fallback.
- **Jira account (Settings → Accounts → Jira)** — `registry/jiraAccount.ts` owns every change to the identity: the site/email are read-only in the UI (plus "last verified"); **Replace API token** verifies the new token against `/myself` and stores it only if it returns the *registered* email (otherwise rejected, old token kept); **Test connection** re-runs `/myself` with the stored token; **Change Jira account or site…** never edits the email in place — it `stage()`s a new account (verified, held in main memory), shows a confirmation explaining the email is the AXON identity (a different email = new `users/{email}/` folder, approvals/audit under the new email, personal docs republished there), and only `commit()` persists token + identity together (a different email triggers `onIdentityChanged`: profile, login entry, backfill, sync). Site must be `https` + `*.atlassian.net` (`JiraSiteSchema`). Onboarding uses the same stage/commit, so tokens are persisted only when onboarding completes. Channels: `jira:{status,replaceToken,test,stageChange,commitChange,cancelChange}`; the renderer never receives a token.
- **Two About screens:** the sidebar **About** page (`src/pages/About.tsx`) is the product page — static copy (what AXON does, what teams build with it, how it works, where data lives), the existing logo assets, no external links/remote assets and no user data. **Settings → About** is the support page: version/platform/Electron/Node, **Copy diagnostics** and **Third-party licenses**. Diagnostics (`electron/diagnostics.ts`, `system:copyDiagnostics`, copied to the clipboard in main) is an allow-list of strictly-shaped facts — versions, OS, registry *host only*, sync state + last sync time, queued count — and the text also goes through the logger `redact()`; unit-tested with seeded secrets/emails/paths/URL credentials. Licenses are generated at build time by `scripts/generate-licenses.js` (production dependency closure + installed optional deps, i.e. the Agent SDK's bundled Claude Code binary package, + the Electron runtime) into `resources/licenses.json` (gitignored, shipped via `extraResources`, `npm run licenses` to regenerate) and shown by `LicensesDialog` via `system:getLicenses`.
- **Feature flags (D6):** `system:getFeatures` → `{ intelligence }`, default **off**; on with env `AXON_FEATURE_INTELLIGENCE=1` or the main-only setting `featureIntelligence` in `config.json`. When off the Intelligence page is removed from the sidebar and `/intelligence` falls through to the dashboard (its data is static demo data). Renderer hook: `useFeatures()`.
- **Settings UI** is shadcn-only (`src/components/settings/*`, `components/ui/*`): Tabs (Accounts · Registry · Workspace · Preferences · About), one `SettingsCard` per concern (header + status badge, labelled fields, right-aligned footer actions), dialogs for secrets. Azure DevOps was removed from the Git settings (GitHub is the only host in v1).
- **Onboarding** (`src/pages/Setup.tsx`, `electron/ipc/registry.ts`): registry URL + branch (default from `resources/registry-default.json` / `AXON_REGISTRY_URL`, overridable in Settings) with "Test connection" (`ls-remote` read + `push --dry-run` of a throwaway ref) → Jira site + email + API token (blocked unless `/myself` email matches) → optional GitHub token check → Claude key (D3) → workspace root (D7) → `activity.log` consent (email + machine name). `activity.log` entries (launch/login) are appended to the queue and ride the next sync — no commit per login.
- **Run summaries** (`registry/runSummary.ts`): explicit field copy only (status, timings, gate outcomes who/when, rerunOf/rerunReason, pipelineId+version, blockVersions, prUrls, repoUrls, tokens/cost); strict zod schema; free text capped at 200 chars; never output/context/step summaries/errors. Queued on terminal delivery events (`completed|failed|cancelled`) from `main.ts`.
- **Promotion:** `registry/promote.ts` pushes `axon/promote/{user}-{kind}-{shortId}-v{n}` (force-pushed own namespaced branch) with the files under `org/` or `teams/{team}/`, then find-or-creates the PR via the GitHub REST API with the engineer's token. Refuses seeded ids, non-Published docs, pipelines using Personal blocks, an already-existing version path, and content that trips the secret scan. GitHub registries only.
- **Not yet:** deletes don't propagate to the same engineer's other machines; Azure DevOps PRs for the registry; Jira write-permission checks (S5); org/team *edit-in-place* (PR only by design).

## Key conventions

- **Documents** all carry `id`, `schemaVersion`, `createdAt`, `updatedAt`. Delivery has `localSeq` (per-machine display counter only — never in refs/paths, D1). `pipelineSnapshot` is built locally at delivery creation (nodes, edges, `blockVersions`).
- **Delivery status:** `Pending | Running | Paused | Completed | Failed | Cancelled | Interrupted`. `Interrupted` = was Running with no live run (crash/kill/quit); resumable. Resume allowed from `Paused | Cancelled | Interrupted`. Step status `AwaitingApproval` is shown as "Awaiting approval" (never "Needs Human").
- **Steps** are keyed by `(nodeId, itemKey)`, `itemKey = null` until ForEach (S4); upsert *replaces* the record.
- **Gates:** only Control-role blocks pause. `approveGate`/`rejectGate` are IPC handled in main: record `approvedBy` (`local-user` placeholder until S3 identity), timestamp, comment. Approve resumes; reject requires a comment and sets the delivery `Failed`.
- **Cancel/shutdown:** a run has a `stopped` flag + AbortController; every loop write goes through `guarded()`, so an aborted runner returning `failed` can never overwrite Cancelled/Interrupted. `before-quit` calls `engine.shutdown()` (abort, persist Interrupted). Boot calls `engine.reconcileOnBoot()`.
- **Git token** has one accessor: `getGitToken()` in `ipc/secrets.ts` (key `axon-git-token`). It is optional for clone/branch/push (falls back to local git credentials); PR creation (REST) needs it. The renderer can only `setGitToken/hasGitToken/clearGitToken` — never read it.
- **Branch name:** `axon/{userSlug}/{ticket}-{shortId}` (D1; shortId = 6-char base32 of the delivery id). Default workspace dir: `{workspaceRoot}/{ticket}-{shortId}`; default `workspaceRoot` per D7 (`%LOCALAPPDATA%\AXON\work` on Windows).
- **No hidden git (S4).** The engine has no clone/branch/commit/PR step: a delivery is `Completed` only when its terminal node succeeds. Workspaces and PRs come from the explicit `workspace-provisioner` / `pr-creator` blocks (see "Workspace, PRs and ForEach (S4)"). **Existing pipelines get no migration** — to get a PR add a Workspace Provisioner first and a PR Creator last (the validator tells you).
- **Seeded Axon blocks** (`human-gate`, `workspace-provisioner`, `pr-creator` runnable; `ticket-fetcher`, `test-runner` still stubs) are `immutable`; `FileStore` refuses update/delete.

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
| `electron/workspace/{gitWorkspace,provisioner,prCreator}.ts` | Delivery root dir · bare mirrors + per-delivery worktrees · stage/commit/push/find-or-create PR |
| `electron/runners/native/*` | Native block registry (`artifactName` → zod input/output + handler) |
| `shared/{pipelineValidator,workItems,itemProgress,pipelineGraph}.ts` | Validator (Creator + `engine.start`), WorkItemList validation, ForEach lane progress, canvas<->stored node translation |
| `electron/ipc/settings.ts` | `electron-store` settings: `workspaceRoot`, `gitProvider`, `theme`, `maxContextSnapshotSizeKb`, `registryUrl`, `registryBranch`, `syncIntervalMinutes`, `team`, `activityConsent` (renderer-writable via per-key validators) + main-only `setupComplete`, `userEmail`, `userName`, `jiraSite`, `jiraVerifiedAt`, `gitTokenSuffix` |
| `electron/registry/*`, `electron/store/gitRepoStore.ts` | Registry sync, queue, layout guard, promotion, run summaries (see "Registry, identity and versioning") |
| `electron/ipc/registry.ts` | `identity:*`, `onboarding:*`, `registry:*`, `versions:*` channels |
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
window.axon.identity.get()                         // {onboarded,email,displayName,team,machineName}
window.axon.onboarding.{defaults,testRegistry,verifyJira,verifyGithub,complete}   // identity proven in main; tokens never returned
window.axon.jira.{status,replaceToken,test,stageChange,commitChange,cancelChange}   // Settings → Jira; identity fields settable only by main after /myself
window.axon.registry.{status,syncNow,onStatus(cb)} // RegistryStatus: Unconfigured|Idle|Syncing|Offline|NeedsAttention|ReadOnly + queued + rejected
window.axon.versions.{list,publish,deprecate,duplicate,promote}(kind:'block'|'pipeline', id, …)
window.axon.workspace.{readFile,listFilesRecursive}   // path-guarded; clearing = delivery.clearWorkspace(id)
window.axon.claudeKey.{getStatus,set,confirmDetected,rejectDetected}   // in-memory Claude key (D3: Console API key only)
window.axon.dialog.{openDirectory,openFile}
window.axon.shell.{openExternal,openPath,openInVSCode}
window.axon.system.{getInfo,checkForUpdates,getFeatures,getLicenses,copyDiagnostics}
window.axon.window.setTitle(title)
```

## Security model (S2)

- **IPC**: register channels only via `electron/ipc/guard.ts` `handle(channel, zodTupleSchema, fn)` / `on(...)` — it checks the sender frame (dev server origin or packaged index.html) and validates args. Never call `ipcMain.handle` directly.
- **Paths**: `electron/security/paths.ts` `resolveInside(p, roots)` (realpath, no `~`/UNC/relative) for anything renderer- or agent-supplied. Renderer file access = `workspaceRoot` / `{userData}` / `{userData}/registry` + folders picked in a native dialog this session (read-only). No renderer write/clear of arbitrary paths exists.
- **Settings**: writable keys have validators in `SETTING_VALIDATORS` (`shared/schemas.ts`); add a validator before exposing a new key. URL settings must use `parseHttpsUrl(value, allowedHosts)`.
- **Secrets**: named `secrets:*` / `claudeKey:*` APIs only, never returning values. Register new secrets with `registerSecret()` (logger redaction). A Claude key found in `~/.claude.json` is a *candidate* until confirmed in the UI (D3).
- **Logging**: use `log` from `electron/log.ts` (no `console.*` in `electron/`); output is redacted and rotated in `{userData}/logs`.
- **Git credentials**: never in URLs/argv — `makeGit()` in `ipc/git.ts` supplies the token via `GIT_ASKPASS` env and applies `protocol.ext/file.allow=never`. simple-git 4 refuses to run git when editor/pager/ssh/config env vars are inherited, so `buildGitEnv` (`security/gitAuth.ts`) strips `EDITOR`, `VISUAL`, `PAGER`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_CONFIG_*`, etc. **Custom SSH setups must be configured in `~/.ssh/config`** (`IdentityFile`, `ProxyCommand`, `Host` aliases), not via `GIT_SSH_COMMAND`; `SSH_AUTH_SOCK` (ssh-agent) is kept.
- **Agents**: `security/agentPolicy.ts` (`decideToolUse`, `buildAgentEnv`, `MANAGED_DENY_RULES`) powers the PreToolUse hook in `runners/claudeAgentic.ts`; denials land in `toolsDenied` + `denials`. Ticket text is fenced via `buildUntrustedContext`; `outputSchema` fields are enforced on success outputs.
- **CSP** is a `<meta>` injected by the `axon-csp-meta` Vite plugin (`vite.config.mts`); add new `connect-src` hosts there. Fonts are bundled (`@fontsource-variable/*`), no remote font hosts.

## Constraints — do not change these

- **`electron-store` is pinned to `8.1.0`** — v8.2+ is ESM-only and breaks CommonJS Electron main. Do not upgrade.
- **`electron-keytar` is not used** — it was removed from npm. Auth uses Electron's built-in `safeStorage` API instead.
- **Node ≥ 22.12 (22 or 24)** — required by Electron 44's npm package. The Electron binary is fetched on first run (no postinstall); fix a failed download with `npx install-electron` (see SETUP.md). Install without `--legacy-peer-deps` — peers resolve cleanly.
- **CSP is relaxed in dev** (`unsafe-inline`, `unsafe-eval`) — this is intentional for Vite HMR. Production uses a strict policy.
- **`index.html` has a React refresh preamble script** — required by `@vitejs/plugin-react` when loading from Electron (not a browser). Do not remove it.

## IPC channel naming convention

```
<domain>:<action>
```
Examples: `auth:storeToken`, `workspace:readFile`, `git:clone`

## What is NOT built yet

- Marketplace/CDF sources and browse UI (out of scope for v1); `ApiStore` (the `Store` port is ready for it)

## Workspace, PRs and ForEach (S4, D16-D18)

- **Where nodes run (D17).** Each delivery gets a *Delivery Folder* `{workspaceRoot}/deliveries/{id}/` at start (`delivery.deliveryFolder`). `WorkspacePort` = `prepare / resolveCwd / release / reacquire` (`workspace/gitWorkspace.ts`, locks in `workspace/locks.ts`). cwd of every node = item `workspacePath` -> delivery Workspace path (`delivery.workspacePath`, D18) -> Delivery Folder. Any explicit path must resolve **inside the Workspace Root** (`Workspace path must be inside the Workspace Root: <path>`) and exist; relative paths resolve against the Delivery Folder. Paths under the delivery own folder are used directly; any other git repo folder must have a clean tree and is **locked per delivery** (lock files in `{root}/.axon/locks/`; a lock whose owner delivery is not Running/Paused/Interrupted is stale and taken over); non-git folders inside the root are used as is.
- **New Delivery (D18).** Ticket ID (required, `^[A-Z][A-Z0-9]+-\d+$`), Pipeline, optional **Workspace path** (folder picker opens at the root; pre-checked via `delivery:checkWorkspacePath`), Advanced: JSON inputs + store-full-context. A given path must be a git repo folder inside the root with a clean tree and not locked; at start AXON locks it, records `workspaceBase.originalBranch`, creates `axon/{user}/{ticket}-{short}` there, and **restores the original branch + releases locks when the delivery ends (Completed, Failed, Cancelled)**. If leftover changes block the switch they are stashed (`--include-untracked`) as `axon/<deliveryId>` and the branch is restored; whenever something was stashed (or the restore still fails) `delivery.workspaceNotice` is set, a `workspace_notice` event is emitted, the Live View shows an amber notice (what was stashed, the stash name, how to recover) and it is logged — the folder is never left on the AXON branch silently. An **Interrupted** delivery keeps its branch and lock (a lock is stale only when its owner is not Running/Paused/Interrupted) until it is resumed or cancelled. Resume of a Failed/Cancelled delivery re-locks and re-checks-out the delivery branch (no clean check). Errors: outside root / not a git repository / uncommitted changes / in use by another delivery. `delivery:clearWorkspace` only ever removes the Delivery Folder, never the user repo.
- **Declared inputs only.** The engine hands every block (native ones too) only the fields in its `contextRequirements` (Selective, the default; Full = whole pool, explicit opt-in). The recorded snapshot and the Live View availability chips describe exactly that view, so there is no "+N undeclared fields also sent". Native inputs the engine injects are declared in the seed blocks: provisioner `workItemList`, PR Creator `stepCwds` + `acceptanceCriteria` (the latter shows as "missing" when the delivery has none).
- **Repository catalog** is visible in Settings -> Registry -> "Repository catalog" (`registry:catalog`): entries, registry file path, last sync, and every dropped/malformed entry with its reason (`parseCatalogDetailed`). The provisioner error reads `... is not in the catalog: N repos in catalog; last synced <time>; Settings → Registry to check`.
- **Confidence (D5)** is optional and display-only: no threshold or warning anywhere, hidden for native Axon blocks and when absent (`shared/confidence.ts`; the engine no longer writes `confidence: 0` on synthetic failures).
- **Native block registry** (`electron/runners/native/registry.ts`): `artifactName` -> `{ input, output, run }` (zod). Services injected by `main.ts`.
- **WorkItemList (D16)**: `{ items: [{ key, task, workspacePath? }], shared? }`; `key` (unique) and `task` (string) required, extra fields pass through. Items run **in list order** (no `dependsOn`). A block declares **at most one** WorkItemList output field (enforced in `FileStore`, the validator and the Create Block form). It is validated when the producing step completes (`validateWorkItemList`): on failure that step is marked Failed with a message naming the item, before any item runs. Empty list / max items are checked at the ForEach (`onEmpty` default **Fail**, `maxItems` default 10).
- **ForEach** is a pipeline node (`type: 'forEach'`, only `maxItems`, `onEmpty`, `size`); it iterates the list returned by its **single direct predecessor** (no picker, no key/repo/order fields). Children carry `parentId` (relative positions, flat list, parents first). Body = a straight chain (one entry/exit), no edges across the border, Human Gate / PR Creator outside, no nesting. Body nodes get `task, shared, item, itemKey, completedItems` if they declare them; per-item fields (`item, itemKey, task, completedItems`) outside a ForEach are a validation error. Output `itemResults[{key,status,summary,result}]`. The item plan (keys in order) is frozen in `delivery.itemPlan`; one failed item fails the delivery and **Resume (allowed from Failed only when an item failed)** restarts that item at its failing body node.
- **workspace-provisioner**: input = the predecessor WorkItemList (items name a catalog repo in `repo`: `catalog/repositories.yaml`, name or url); output `workItems` = the same list (all fields + `shared` preserved) with `workspacePath` set to that repo per-delivery worktree, plus `provisionedRepos`. Unknown repo -> fails naming it. Bare mirror per repo (`{root}/mirrors/{name}.git`, per-repo lock, fetch refspec into `refs/remotes/origin/*`), worktree `{root}/deliveries/{id}/{name}` on the D1 branch off the detected default branch. Windows worktree path <= 200 chars.
- **pr-creator**: one PR per distinct git repo behind the folders this delivery steps ran in. **Every step records its resolved working folder (`step.cwd`)**; the engine hands PR Creator the distinct recorded cwds (`stepCwds`, minus the Delivery Folder) and it resolves each to its git top level (`reposFromCwds`: origin url, current branch, base branch from the remote). It never scans the disk or reads agent output. Per repo with changes: stage explicit paths (no AXON files) -> commit -> push (askpass env) -> find-or-create PR (GitHub only) -> link sibling PRs. No repo at all -> fails with "No repository to create a PR from"; push failure fails the delivery. The validator only *warns* when a PR Creator has no Workspace Provisioner upstream.
- **Validator** (`shared/pipelineValidator.ts`, Creator + `engine.start`): ForEach contract above; Agentic blocks must declare `contextRequirements`. (No "must follow a provisioner" rule any more: planners and agents may run in the Delivery Folder.) `contextMode` Selective|Full (default Selective).
- **UI**: Creator "Flow" palette + container; ForEach panel = Name + collapsed Advanced (Max items, If empty = Fail); header "Runs once per item from <predecessor>"; edge panel keeps only Default route + delete (conditions are not evaluated in v1); Draft saves keep `blockVersion` pins (`shared/pipelineGraph.ts`) with an explicit "Update block versions" action. Live View lanes + "2 of 4 · key" counter (`shared/itemProgress.ts`). Samples: `docs/samples/`.

## Agent Standard (S4b)

Rules live in `docs/agent-standard.md`; the short version is shown on Create Block (`shared/agentStandard.ts`, which also holds the Decision-with-Edit/Write/Bash warning).

- **Fencing (rule 7):** `buildInputFieldsText` (`runners/output.ts`) wraps *every* context field (task, shared, item, itemKey, completedItems, repoCatalog, upstream outputs) in `<untrusted_field name="…">`; the ticket header and values are defanged (forged `</untrusted_field>`/`</untrusted_ticket_data>` neutralised) inside the outer `untrusted_ticket_data` fence.
- **Output validation (rules 2–3):** `validateAgentResult(output, outputSchema)` checks presence **and** declared type (string|number|boolean|array|object; WorkItemList is checked by the engine). The engine applies it to every non-gate step (native blocks too) right after the runner. Errors name the field.
- **Handoff contracts:** a WorkItemList output field may declare `itemFields` (extra per-item fields, e.g. `["repo"]`); a block may declare `requiredItemFields`. The Workspace Provisioner is a **pass-through**: its effective item fields are its input's fields + `workspacePath` (`effectiveItemFields` in `shared/pipelineValidator.ts`), so ForEach body blocks' `requiredItemFields` validate against it (validator and runtime). `validatePipeline` errors when the feeding block's `itemFields` don't cover them; at runtime `checkProducedLists` passes the direct consumers' `requiredItemFields` to `validateWorkItemList`, so the *producing* step fails naming the item and field. Seed Workspace Provisioner is v5 (`requiredItemFields: [repo]`). The Pipeline page shows each outgoing edge's contract (`shared/handoffs.ts` `describeHandoff`: "Demo Planner → Workspace Provisioner: WorkItemList (key, task, repo)").
- **Summary cap (rule 8):** `completedItems[].summary` ≤ 500 chars (`capSummary`); only `{key,status,summary}` ever passes between items.
- **Resume vs Rerun (Failed/Interrupted deliveries):** *Resume* = same delivery, same workspace, continues from the failed step/item (allowed from Paused/Cancelled/Interrupted and from Failed when a step failed, except a rejected approval); the step's snapshot is restored first. *Rerun* (Live View button, `RerunDialog`) = a new delivery from the first step: asks `rerunReason` (`RequirementUpdated` default | `AgentUpdated` | `PlatformRetry` | `Other`), sets `retriedFromDeliveryId`, `attemptNumber` = previous + 1, and `FileStore.createDelivery` marks a Failed/Cancelled predecessor `Superseded` (+ `supersededBy`; Completed ones are only linked — "Run again"). Superseded deliveries are terminal (no resume/cancel), keep their folders/refs until the 14-day cleanup, show "view the newer attempt" (and the new one "view previous attempt"). Run summaries carry `attemptNumber`/`supersededBy`; `shared/deliveryChains.ts` (`buildStories`, `storyCounts`) counts a chain as one story with N attempts — a Superseded attempt is never a separate failure.
- **Snapshots (rule 9, `workspace/snapshots.ts`):** before each agent step (non-Axon runtime, not a gate) the step's repo working tree (tracked + untracked, non-ignored) is committed as a dangling commit via a temp `GIT_INDEX_FILE` (`add -A`, `write-tree`, `commit-tree`) under `refs/axon/<deliveryId>/<nodeId[@itemKey]>`; it never touches the branch/index/worktree. A failed attempt is **left in the folder** (for debugging) and the ref is kept; when a step starts and its ref already exists (Resume of a Failed/Interrupted delivery) the folder is restored to the snapshot first (files back, files not in the snapshot removed). Refs are deleted when the delivery Completes, is cancelled or its workspace is cleared/discarded (`engine.discardSnapshots`), and for Failed/Superseded deliveries older than 14 days (`engine.cleanupFailedSnapshots`, run at boot). Live View shows "Changes from the failed attempt are still in the folder; Resume restores the pre-step state." Non-git folders (Delivery Folder) are skipped. Agents never commit; PR Creator makes the only commit.
- **repoCatalog (opt-in):** catalog entries gain `description` (≤200, truncated with a warning shown in Settings) and `tags`. `repoCatalog` is injected **only** if the block lists it in `contextRequirements`: lines `<name>: <description> [<tags>]`, no URLs; block setting `catalogTags` filters. The delivery records `catalogVersion` (registry clone HEAD, also in the run summary) and each step `catalogStats {repos, approxTokens}` (shown in Live View). Engine deps: `snapshots`, `getRepoCatalog`.
- Samples in `docs/samples` follow the standard (planner: Prompt, no tools, `repoCatalog`, `workItems` WorkItemList with `itemFields:[repo]`; coder: Agentic Read+Edit).

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
grep -rn "/api/\|signalr\|apiClient" src electron | grep -v "rest/api/3"   # must print nothing (Jira's /rest/api/3/myself is the only /api/ left)
```

In DevTools: `window.axon` → `blocks, pipelines, deliveries, delivery, events, secrets, settings, ...`. Subscribe with `window.axon.events.onDeliveryEvent(console.log)`, create a pipeline with the built-in Human Gate block, create a delivery and `window.axon.delivery.start(id)`.
