# AXON v1 — Plan Review & Gap Analysis

Scope: `axon-desktop` @ `main` (813243e). Method: static read of `electron/**`, `src/services|hooks|pages`, configs. No code run, no tests exist to run.

**Headline verdicts on the plan**
1. Direction is sound, and the code is *closer* to it than expected on the executor side (single `runStepLoop`, one IPC event channel, sane abort plumbing) but *further* on persistence: **every state transition goes through ~25 `apiPatch/apiPost` calls inside `executor.ts`** and the API also owns things you didn't list (`jobNumber`, `pipelineSnapshot` construction, gate approval records, block/pipeline validation, step upsert semantics). Those must each get a local home.
2. **Plan point 1 is factually off:** the executor IPC events are `snake_case` (`step_started`, `step_completed`, `step_failed`, `gate_reached`, `completed`, `failed`, `cancelled`, + 4 workspace/git events) — `electron/ipc/executor.ts:309-321`. The PascalCase names (`StepStarted`…) are the **SignalR** contract (`src/hooks/useSignalR.ts`). `DeliveryLiveView` currently subscribes to **both** (SignalR at `:846`, IPC at `:623`) — two live-update paths. Decide one canonical, typed event union now.
3. **A latent bug makes the plan's "no hidden git in executor" more urgent:** PRs are *never created today* — the executor reads the git token from key `git-token` (`executor.ts:909,1111`) but Settings stores it as `axon-git-token` (`Settings.tsx:72,157`). `ctx.gitToken` is always undefined → the PR branch (`executor.ts:747`) is dead code in practice.
4. **Data-leak bug:** DS1 large-output files are written to `{workspace}/.axon/…` (`executor.ts:164-169`) and `commitChanges` does `git add .` (`git.ts` commitChanges) → step inputs/outputs get **committed and pushed into the customer repo**. Violates "never context, outputs, or code" in spirit and must be fixed before anything else touches the workspace.
5. Verify-loop is further away than "needs DS2": `condition` is persisted but **never evaluated**, step records are keyed by `nodeId` (no iteration dimension), and the resume walk would **infinite-loop on a back-edge** (details in A5).

---
## A. Inventory

### A1. Every call into axon-api
| Area | Location | What it does | v1 disposition |
|---|---|---|---|
| Renderer HTTP client | `src/services/apiClient.ts:1-80` | axios + Bearer injection + 401-refresh queue + `axon:auth:expired` event | Delete |
| Dead duplicate client | `src/services/api.ts` (whole file, ~100 lines; **no importers** — grep) | 2nd axios client, 15 endpoints | Delete now |
| Blocks | `src/services/blocksService.ts:39-60` | CRUD, `/sync`, `/deactivate`, `/api/marketplace/browse|import` | Replace by `Store` adapter; marketplace/sync have no v1 meaning |
| Pipelines | `src/services/pipelinesService.ts:17-32` | CRUD + **server-side `POST /pipelines/validate`** | Validation must move local (shared validator, see C/E) |
| Deliveries | `src/services/deliveriesService.ts:35-148` | list/get/create/patch/status/steps/**gate approve+reject**/step context+output | Replace; `createDelivery` today makes the **server** build `pipelineSnapshot` + `jobNumber` |
| Hooks | `src/hooks/useBlocks.ts, useDeliveries.ts, usePipelines.ts` | react-query wrappers over the services | Keep hooks, swap the data source (good seam) |
| Auth guard | `src/hooks/useAuthReady.ts:15-45` | gates queries on `backendUrl`+token | Replace with "store ready" |
| SignalR | `src/hooks/useSignalR.ts:77-130` (`@microsoft/signalr` dep, `package.json:17`) | hub `/hubs/delivery`, 9 events | Delete; use IPC union |
| Login / health | `Setup.tsx:38,57-74`, `Settings.tsx:88,105` | `/api/health`, `/api/auth/login|me` | Replace with Jira `/myself` onboarding |
| Latency probe | `electron/ipc/system.ts:19-45` | `GET {backendUrl}/api/health` | Replace with registry "Test connection" |
| Token store | `electron/ipc/auth.ts` + keys `axon-access-token`, `axon-refresh-token` | JWT in safeStorage | Remove; keep file helper for Jira/git secrets |
| **Executor → API** | `electron/ipc/executor.ts` lines 352 (refresh), 508, 525 (`steps/start`), 592-599, 614, 626, 670-675 (finalize), 685-693, 704, 717, 765, 788, 805 (`GET /blocks/:id`), 845, 871, 886, 924, 987, 997, 1052, 1077, 1095, 1143, 1171, 1180 | Status/step persistence, block fetch, pipeline fetch, cancel | The big surgery (Session 1) |
| Token/refresh machinery in main | `executor.ts:330-428` (cache, refresh coalescing, `authedFetch`, `apiGet/Post/Patch`), `:182-193` (`rejectUnauthorized:false` Agent for localhost) | | Delete wholesale (also removes a TLS-weakening dispatcher) |

### A2. Where state lives today
| State | Writer | Reader | Notes |
|---|---|---|---|
| Delivery record, steps, status, branch, workspacePath, prUrl | executor via PATCH/POST (API) | renderer via `getDelivery` (`deliveriesService.ts:123`) | API merges "step start" + "finalize" by `nodeId` (see comment `executor.ts:516-524`) — **upsert semantics you must re-implement locally** |
| Blocks, pipelines | renderer via services; blocks re-fetched by executor per delivery (`fetchBlocks` `:794-815`) | both | Block definitions incl. `cachedFiles` content are API-stored (**block artifacts are embedded in the DB record**) |
| In-flight execution | `activeExecutions` Map (`executor.ts:323`) | executor only | Lost on restart (C4) |
| Settings | `electron-store` (`settings.ts`) | renderer + main | 11 keys; `settings:set` accepts any key |
| Secrets | `{userData}/{key}.enc` via safeStorage (`auth.ts`) | renderer *and* main | Claude key is memory-only (B6) |
| Large payloads | `{workspace}/.axon/{inputs,outputs}/` | renderer via `workspace.readFile` | Wrong location (C3) |

### A3. Executor ↔ API coupling (patch-backs)
| Patch-back | Evidence | v1 consequence |
|---|---|---|
| `workspacePath` PATCH | `executor.ts:871-876` (status `Running` + `workspacePath`) | Local delivery doc field |
| `branch` PATCH | `:924` | Same; branch name depends on API `jobNumber` (A3b) |
| Per-node `currentNodeId` advance | `:717` (best-effort `.catch`) | Becomes a local write; no longer lossy |
| Gate approve/reject | UI calls API first (`DeliveryLiveView.tsx:628-646`: `approveGate.mutateAsync` → then `executor.resume`; reject → API then `executor.cancel`). `approvedBy/At`, `rejectedBy/At`, `reviewComment` are **backend-stamped** (`deliveriesService.ts:~100-110`) | Approval must become an IPC call that main records (who = Jira email, when, comment). Today the *executor does not know the approver* |
| Step start placeholder | `:525` awaited to avoid duplicate-entry race | Disappears with a local single-writer store |
| **`jobNumber` (A3b)** | `DeliveryFromApi.jobNumber` `:270`; used in `createDeliveryBranch` (`git.ts` branch fmt `axon/{user}/{job}/{ticket}`) | **Global counter vanishes with the API** → need a replacement scheme (decision D1) |
| `pipelineSnapshot` | built server-side at delivery create; executor falls back to `GET /pipelines/:id` if absent (`:883-896`, duplicated at `:994-1006`, `:1074-1086`) | Desktop must build snapshot + record pipeline commit SHA |

### A4. Workspace provisioning & PR creation today
| Item | Evidence | Gap vs plan #6/#7 |
|---|---|---|
| Workspace path | Default: `path.join(workspaceRoot, delivery.ticketId)` (`executor.ts:867-868`); Browse: **modal dialog opened from main** (`:857-865`) | Path keyed by **ticketId** (rerun/collision; **path traversal if ticketId contains `..`**); Browse can't work for a headless Jira watcher |
| Clone | `cloneOrOpen` (`git.ts`): if `.git` exists → "already cloned", **no fetch/verify remote**; else `git clone` (token injected into URL) | Single repo, no mirror, no worktree, no catalog check; token embedded in clone URL ends up in `.git/config` remote (secret on disk) |
| Branch | `createDeliveryBranch`: `fetch`, `checkout main` else `master`, `pull`, `checkoutLocalBranch` | `main/master` hardcoded; default branch not detected; a dirty existing workspace is not detected |
| Commit/push | `commitChanges` = `git add .` + commit; `pushBranch` = `git push -u <pushUrl> HEAD:<branch>` (`git.raw`) | `add .` sweeps `.axon/` DS1 files; token in push URL |
| **PR creation tail** | `runStepLoop` after loop: `executor.ts:723-786`: commit → push → PR (`:747-771`) → `completed` event. `baseBranch: 'main'` hardcoded (`:755`); provider guessed by `repoUrl.includes('github.com')` (`:749`); PR body = counts only | Hard-wired, single repo, swallowed errors (`:773-776`, `:783-786` emit `completed` even when git failed → **delivery shown Completed with no push/PR**) |
| Native `workspace-provisioner`, `pr-creator`, `ticket-fetcher`, `test-runner` | **Do not exist.** `runAxonNativeBlock` handles only `human-gate` (`executor.ts:59-69`); default case throws | CLAUDE.md says pr-creator/ticket-fetcher are "seeded" — in the **API DB**, not this repo. Desktop needs its own seed bundle (E) |

### A5. Edge/condition handling → distance to conditional edges + back-edges
| Aspect | Today | Evidence |
|---|---|---|
| Edge model | `{sourceNodeId, targetNodeId, isDefault?, condition?: BranchCondition\|null}` | `src/types/index.ts:14-24`; executor-local copy `executor.ts:196-201` **omits `condition` entirely** |
| Authoring | Creator stores `condition` as a free string expression; one default edge required if >1 outgoing | `PipelineCreator.tsx:201-204,314,345-350,57-58` |
| Evaluation | **None.** `nextNode` = first `isDefault` edge else `outgoing[0]` | `executor.ts:435-440` |
| Cycles | Not forbidden by `validate()` (`PipelineCreator.tsx:39-62` only checks start node / default edge) but **unsupported**: `resolvePipelineProgress` loops `while (node && completedNodeIds.has(node.id))` (`:466-471`) → **infinite loop** on any cycle containing completed nodes (also in `previewResume`) | |
| Step identity | One record per `nodeId`; API upserts by nodeId | `:516-524`, `reconstructFlatResults :481-493` merges by nodeId |
| Result pool | `flatResults = {...flatResults, ...output.result}` — **last-writer-wins flat namespace** | `:700` — a loop iteration silently overwrites the previous attempt's fields; collisions between unrelated blocks undetected |
| Iteration counter / budget | None | |
| **Distance** | Need: condition grammar + evaluator (off `output.result` field, deterministic), iteration-keyed step ids (`nodeId#n`), cycle-aware validator and resume, `previousAttempt` injection slot, budget accounting. Not large but touches the heart of `runStepLoop` + resume + Live View graph (status overlay keyed by `nodeId`) | |

### A6. Leftovers
| Item | Status | Evidence |
|---|---|---|
| `needs_human` agent status | **Gone** from electron/ (grep clean); agents are `success\|partial\|failed` | `claude.ts:4,94` |
| "Needs Human" wording | Partial: internal `ExecutionStatus 'NeedsHuman'` and legend label | `BaseNode.tsx:21,28,87`, `DeliveryLiveView.tsx:120 (AwaitingApproval→NeedsHuman), :1047`. No filter pill in `Deliveries.tsx` (uses "Waiting", `:187`) |
| `autonomyLevel` | Setting remains | `settings.ts:8,23` (`defaultAutonomyLevel:'supervised'`) — unused by executor; delete |
| `confidenceThreshold` | Setting + UI remain, **read by nothing** in executor | `settings.ts:9,24`, `Settings.tsx:54-66,179,554-566` ("Minimum confidence for autonomous actions" — contradicts settled principle), `types/index.ts:38` |
| `adapterType` / `executorType` | Legacy types remain | `types/index.ts:164,204-205` |
| `cachedDefinition` | Still the live name for the entry-file content passed to agents (`executor.ts:538-545`, `claude.ts`, `claudeAgentic.ts:59`) | Not dead — but a misnomer once blocks come from git (rename `instructions`) |
| Mock data | `src/services/mockData.ts` — 526 lines, **zero importers** | dead |
| Fake analytics | Entire Intelligence page is static: no query/IPC in any of `src/pages/Intelligence.tsx`, `components/intelligence/*` (grep count 0); hardcoded `toolsDenied` rows `BlockPipelineQualityPanel.tsx:23-27` | Either hide in v1 or feed from local run summaries |
| Personal/org strings | `Sidebar.tsx:169` hardcoded **"Kranthi G"**; `Settings.tsx:665,673` & `About.tsx:287` point at `github.com/anthropics/axon-desktop`; `appId: com.company.axon`, `copyright: 'CommX Team'` (`electron-builder.config.js:5-7`); placeholder `you@company.com` (`Setup.tsx:270`) | |
| Config drift | Default backend URL is 4 different values: `localhost:3000` (`settings.ts:21`, `executor.ts` ×5), `https://localhost:7027` (`Setup.tsx:22`), `:5001` (`.env.local`) | moot after API removal |
| Tracked junk | `.env.local`, `build.log`, `build-win.log` are **committed** (`git ls-files`) despite `.gitignore` listing `.env.local` (committed before ignore). `.gitignore` lacks `*.log`, `.axon/` | contents of `.env.local` are benign (`VITE_API_URL`) but pattern is a leak risk |
| Stub IPC surface | `claude:call` returns "Not implemented" (`claude.ts:271`); preload `git.push(workspacePath, branch, token)` sends **3 args to a 4-arg handler** `(workspace, branch, repoUrl, token)` (`preload.ts` vs `git.ts` handler) and `git.createBranch(…, branchName)` is consumed as `ticketId` → these preload methods are broken *and* unused by the renderer (verify by grep before deleting) | delete |
| Doc drift | CLAUDE.md says model `claude-sonnet-4-5`; code hardcodes `claude-haiku-4-5-20251001` (`claude.ts:149`) | |
| Windows path bug | `effectiveWorkspacePath.split('/').pop()` (`DeliveryLiveView.tsx:929`) shows the whole path for `C:\…` | |

---
## B. Open items — verification
| # | Item | Verdict | Evidence / note |
|---|---|---|---|
| 1 | `BuildingBlock.contextMode` (Selective\|Full) | **Not done** | No occurrence of `contextMode` in repo. Behaviour is *implicit*: empty `contextRequirements` ⇒ inject **everything** (`claudeAgentic.ts:92-96`), non-empty ⇒ selective. Dangerous default (a block with a forgotten requirements list silently receives the full pool incl. other blocks' outputs). Plan #9 says field names are "the strict contract" — an explicit `contextMode` + default `Selective` + validator error on empty is the enforceable form |
| 2 | `toolsUsed` / `toolsDenied` split | **Confirmed** | `claude.ts:13-17`, `claudeAgentic.ts:122-123,160-174`, UI `DeliveryLiveView.tsx:1316-1327`, types `index.ts:77-78`. Aggregate analytics for it is mock only |
| 3 | PreToolUse hook denies out-of-scope tools | **Confirmed (implemented), effectiveness unproven** | `claudeAgentic.ts:152-178` returns `permissionDecision:'deny'`. But `tools: effectiveTools` (`:143`) already removes other tools from the model's menu, so the hook rarely fires; **no test**. More important: the hook matches **tool name only** — `Write/Edit/Bash` may touch any path (C2) |
| 4 | `claudeAgentic.ts` timeout source | **Partial / effectively node-level only** | Chain is `node.timeoutSeconds ?? block.defaultTimeoutSeconds ?? 120` (`executor.ts:564`). But PipelineCreator stamps `timeoutSeconds: 120` on every dropped node (`PipelineCreator.tsx:266`, and `?? 120` at `:192,341`), and `onNewNode` never reads the block's default although `CreateBlockForm.tsx:773` promises "prefills the node timeout". ⇒ **block default is dead**; node always wins with 120. Prompt-mode (`claude.ts`) has **no timeout at all** (fetch without signal) and ignores `abortController` |
| 5 | Claude key memory-only + `.enc` migration | **Confirmed** | `claudeKeyStore.ts:66-83` (consume+delete `axon-claude-key.enc` every launch; precedence: config files → conflict → migrated). Caveats: harvests `primaryApiKey` from `~/.claude.json` / `~/.claude/config.json` without consent UX; users on **subscription/OAuth login have no `primaryApiKey`** → Agentic can't run for them; `claudeKey:set` accepts any string (`:97`); key also copied into every `ExecutionContext.credentials` and into child env (`claudeAgentic.ts:148`) |
| 6 | Step Output Viewer exists? | **Confirmed in a different form** | `StepOutputViewer.tsx` was deleted (CLAUDE.md); replacement = node detail panel + `RawDataViewerModal` (`DeliveryLiveView.tsx:1285,1309,1543`; `workspace.readFile` at `:411`). No file named StepOutputViewer — don't reference it in sessions |
| 7 | >50KB truncation → file | **Confirmed, mislocated** | `executor.ts:140-180`, threshold from `maxContextSnapshotSizeKb` (`settings.ts:12,29`). Faults: files inside the repo worktree and swept by `git add .` (headline #4); write failure falls back to *sending inline despite size* (`:171-173`); `storeFullContext` gates only the input snapshot, output is always stored. In v1 the API 413 safety net (500KB) disappears — local files should live in `{userData}/runs/{deliveryId}/` |
| 8 | `codex.ts` parity | **Not done (skeleton)** | `codex.ts:24-29` throws. Gaps: no agentic path (`runAgentForBlock :42` routes only `Claude && agentic`, so Codex+Agentic hits `runCodexAgent`→throw); no abort/timeout param; `getByPath` unused; no normalize/outputMapping; **no Settings UI ever stores `axon-codex-key`**; no PreToolUse equivalent. Recommend: hide Codex in the UI for v1 rather than half-ship |

---
## C. Enterprise-grade review (opinions, each tied to evidence)

### C1. Electron security
| Finding | Evidence | Replace with |
|---|---|---|
| `contextIsolation:true`, `nodeIntegration:false` ✔; `sandbox` not set explicitly | `main.ts:34-38` | Set `sandbox:true` explicitly (default in Electron 31 but undeclared) |
| **Renderer can read/write/delete arbitrary paths** | `workspace.ts`: `readFile`, `writeFile`, `createDir`, `listDirs`, and **`workspace:clear` = `fs.rm(recursive,force)` on any path** (`:44-52`); no root allow-list; `~` expansion only | Main-side path guard: resolve → must be under `workspaceRoot`/`userData`/registry cache; delete `clear` or restrict to delivery dirs. Any XSS = full disk access |
| **Generic secret oracle** | `auth:getSecure(key)`/`storeSecure`/`clearSecure` take caller-chosen `key`; `securePath` = `path.join(userData, `${key}.enc`)` (`auth.ts:6,76-100`) → renderer can read *every* secret and `key='../../x'` escapes `userData` | Narrow named APIs (`setJiraToken`, `hasGitCredential`…); never return secrets to renderer; validate key against an enum |
| `settings:set` any key/value, no schema validation | `settings.ts:44-46` | Typed per-key setters; **`backendUrl`-style endpoint keys (registry URL) must validate scheme/host** — a renderer compromise could redirect the registry and Jira calls |
| `shell:openExternal(url)` accepts any scheme | `main.ts:~100` | Allow-list `https:` (and `vscode:` explicitly) |
| `openInVSCode` passes renderer path to `code -n <path>` (execFile, no shell ✔) | `main.ts:~125` | reject paths starting with `-`; confine to workspace |
| No `setWindowOpenHandler` / `will-navigate` guard | `main.ts` | add; deny all navigation off-origin |
| CSP set via `onHeadersReceived` | `main.ts:41-52` | Prod uses `loadFile` (`:68`); webRequest header injection **may not apply to `file://`** (*unverified — test in packaged build*). Add `<meta http-equiv=CSP>` in `index.html` as the reliable layer. Prod CSP also has `script-src 'unsafe-inline'`, `connect-src https:` (any host), and loads fonts from Google (remote content) → bundle fonts (`@fontsource-variable/geist` already a dep) and tighten `connect-src` to registry/Jira/Anthropic hosts |
| Preload surface | `preload.ts`: 7 namespaces, ~38 methods, several stubs/broken (A6) | Shrink to what the renderer needs; one validated channel per capability |
| IPC input validation | none anywhere (all handlers trust args) | zod/valibot (or hand-rolled) schemas at every `ipcMain.handle`; also verify `event.senderFrame` origin |
| Packaged `mainWindow.webContents.session.clearCache()` on every launch | `main.ts:66` | harmless; remove (slows start, hides caching bugs) |

### C2. Command / path safety & agent containment
| Finding | Evidence | Fix |
|---|---|---|
| Ticket-controlled values in paths/refs | workspace dir = `workspaceRoot/ticketId` (`executor.ts:868`); branch `…/${ticketId}` (`git.ts`) — ticketId unsanitised (`../../x`, spaces, `..`, refs like `a..b`) | Validate ticket key against `^[A-Z][A-Z0-9]+-\d+$` at ingestion (Jira makes this free); slugify for refs; resolve + assert containment |
| Repo URL untrusted | `new URL(repoUrl)` then clone (`git.ts`); no scheme/host allow-list; `file://`, `ext::` transports possible via `git clone` | Catalog allow-list (plan #6 ✔) **plus** `protocol.allow` hardening (`-c protocol.ext.allow=never`, only https/ssh) |
| simple-git use | `git.raw(['push','-u',pushUrl,'HEAD:'+branch])`, `checkoutLocalBranch(branchName)` — args array, not shell concat ✔; simple-git's unsafe-arg guard is on by default ✔ | add `--` separators; never pass user text as first token |
| Credentials in URLs | `injectTokenIntoUrl` (`git.ts:30-35`) puts PAT in clone/push URL → persists in `.git/config` (clone) and in process args | Use credential helper / `GIT_ASKPASS` / `http.extraHeader` via env; v1's "own GitHub credentials" decision makes this removable |
| **Agent is not sandboxed** | `permissionMode:'bypassPermissions'` (`claudeAgentic.ts:142`); `cwd` ≠ sandbox; hook checks tool *name* only; `Bash` can do anything the user can | Path-scoped PreToolUse (reject `file_path`/`cwd` outside worktree, deny network cmds), SDK sandbox option if available (*verify in SDK docs*), scrub env |
| **Whole `process.env` passed to the agent** | `claudeAgentic.ts:148` `env:{...process.env, ANTHROPIC_API_KEY}` | allow-list env (PATH, HOME/USERPROFILE, TEMP, key); never include git/Jira tokens |
| **Untrusted repo config executes** | `settingSources:['project']` (`:140`) loads the target repo's `.claude/settings*.json` (hooks, MCP servers, permissions) and CLAUDE.md | Drop `'project'` (or load deliberately); at minimum disallow hooks from repo settings |
| Prompt injection | Jira ticket title/description flows into agent prompt (`buildUserMessage :76-117`, JSON-stringified fields) and agent has `Bash`+`bypassPermissions` | Treat ticket text as untrusted: fence in prompt, no-network, gate before pr-creator (already your gate model) |
| Prompt-mode 429 retry | recursive `callClaude` after 60s, **unbounded** (`claude.ts:170-173`) | bounded retry w/ jitter, honor `retry-after`, abort signal |
| Output JSON parse | `extractJsonObject` first `{` … last `}` (`claude.ts:56-62`) — brittle; a failed parse stores **raw model text in `result.rawResponse`** (`:75-79`) which then flows into the pool/records | schema-validate against `outputSchema`; never persist raw text to registry |

### C3. Secrets
| Finding | Evidence | Fix |
|---|---|---|
| Git PAT key mismatch (feature broken) | `git-token` vs `axon-git-token` (A, headline #3) | single typed accessor |
| Secrets readable by renderer (C1) | `auth:getSecure` | main-only |
| JWT/refresh handled in two processes with a known race | comment `executor.ts:365-368`; refresh rotation | moot after API removal |
| Secrets in logs | `console.error('Failed to parse agent response as JSON: ${rawText}')` (`claude.ts:72`) may log customer data; 30 `console.*` calls in electron/ (no logger, no levels, no redaction) | structured logger w/ redaction; log to `userData/logs` with rotation |
| What could reach the registry repo | `activity.log` (email+machine), run summaries. **Risks:** step `summary`/`errorMessage` fields are model/Jira-derived free text; PR URLs fine; **token counts fine**. | Whitelist-serialise run summaries (explicit field copy, never spread of `output`); size-cap strings; add a CI/pre-push secret scan (gitleaks-style) on registry commits |
| `.env.local` + `build*.log` committed | A6 | `git rm --cached`, extend `.gitignore` |
| `~/.claude.json` key harvesting | B5 | explicit consent UI + show source (already shows `source`) |

### C4. Concurrency, cancellation, crash recovery
| Finding | Evidence | Fix |
|---|---|---|
| **Orphaned `Running` after crash/quit** | `activeExecutions` is memory-only (`:323`); `startDelivery` accepts only `Pending\|Paused` (`:850`); `resumeDelivery` accepts only `Paused\|Cancelled` (`:1061`) ⇒ a delivery left `Running` by a crash/quit/kill is **neither startable nor resumable** (only "cancel", which then allows resume) | On boot: reconcile — any local delivery `Running` with no active ctx → `Interrupted` (new state) → resumable. Add `before-quit` handler that aborts contexts and persists state; kill child `claude` processes (`Agent SDK` spawns a binary — **verify no orphans on Windows**) |
| Same-delivery double start guarded; **cross-delivery not** | `startingDeliveries` Set (`:821`); `isLoopActive` (`:298`) | Same-repo/same-ticket concurrency: workspace dir collision (ticketId path). Use `{deliveryId}` worktree (plan ✔). Add global concurrency cap (agent runs are heavy) and per-repo mutex for mirror fetch |
| Watcher + manual runs | n/a yet | Single-writer run store with per-delivery lock file; dedupe key `jiraKey+ruleId+rerunSeq` |
| File write races | no local writes today except DS1 + `.enc` | atomic write helper (tmp+fsync+rename) shared by cache, `.enc`, DS1 (plan #2 ✔); `.enc` files are written non-atomically today (`auth.ts:28,81`) |
| Cancel semantics | abort signal threaded to agentic only (`:306,565`); Prompt-mode `fetch` has no signal; `isCancelled` flag + `abortController` | pass signal to `callClaude`; cancel must also kill running `test-runner` child processes |
| Failure swallowed, delivery marked Completed | `executor.ts:773-786` | explicit `Completed` only after required terminal nodes succeed; with PR as a node this becomes natural |
| Resume rebuilds ctx from steps | `reconstructFlatResults :481` (good, regardless of storeFullContext) — but depends on step `output.result` which may be **truncated marker** when >50KB (`persistedOutput.result = outputResult.value`, `:635-640`) → resumed run sees `{truncated:true…}` instead of real data | reload from the local file ref on reconstruction |
| Branch/worktree already exists on rerun | `checkoutLocalBranch` throws if exists → only a `console.warn` (`:926-928`) and delivery **continues on whatever branch is checked out (likely main) and later pushes `HEAD:undefined`?** — `ctx.branch` undefined skips commit/push silently | fail fast; deterministic per-delivery branch |

### C5. Error handling, retries, idempotency
- Pervasive "log and continue" (`.catch(warn)`): `:526,718,925`. Under a local store these go away; for **network** edges you will add (Jira, git push, registry sync) define a policy table: retry (idempotent GET), retry-with-key (comments: embed hidden marker `axon:{deliveryId}:{event}` and search before posting), no-retry (push non-fast-forward → fail visibly).
- Jira label swap claim (plan #5) is not atomic. Mitigation: only the `activeMachine` polls (plan ✔) **and** claim = add `axon-running` + remove `axon-ready` in one `PUT /issue` update op; on startup re-scan `axon-running` tickets owned by this machine → reconcile with local deliveries.
- Git push idempotency: push is `HEAD:branch` to deterministic per-delivery branch ✔ (safe to retry); PR create must first `GET pulls?head=` to avoid 422/duplicate.
- Sync conflicts (registry): not covered (see D).

### C6. Observability, typing, dead code, duplication, tests
| Item | Evidence |
|---|---|
| No logger/levels; 30 raw `console.*` in `electron/` | grep |
| `any` usage: 29 occurrences in `src/electron` (e.g. `PipelineCreator.tsx:57,192,341,349` `(n.data as any)`; `ConditionalEdge.tsx:13`) | grep |
| **Types duplicated across compile targets**: executor re-declares `BuildingBlock`, `PipelineNode/Edge` (`executor.ts:196-254`) vs `src/types/index.ts`; `AGENTIC_TOOL_CEILING` duplicated (`:235` vs `src/types`) — and the executor-local `PipelineEdge` already **drifted** (no `condition`) | → extract `shared/` package (own tsconfig, referenced by both) with zod schemas = the registry file schemas |
| Duplicated logic | pipeline-load fallback ×3 (`:883,994,1074`); credential assembly ×2 (`:838-841,1107-1111`); `baseUrl/token` boilerplate ×5; context-field selection duplicated in `claude.ts` & `claudeAgentic.ts:76-100` & `executor.ts:80-138` (explicitly noted as intentional but it's 3 copies) |
| Dead code | `api.ts`, `mockData.ts`, `claude:call`, `getByPath` in codex, `confidenceThreshold`/`defaultAutonomyLevel`, `AdapterType` |
| **Tests: none** (`git ls-files` shows no test/spec files, no test runner in `package.json`) | The executor (1192 lines, resume/cancel/gate state machine) has zero coverage |
| `executor.ts` is a god-file | 1192 lines: API client, token cache, DS1, resume, runStepLoop, git tail, IPC | split: `engine/` (pure state machine, injectable store+runner), `runners/`, `store/`, `ipc/` |

### C7. Hardcoded values that should be config
`claude-haiku-4-5-20251001` + `max_tokens 4096` (`claude.ts:149-150`); default timeout 120 (`executor.ts:564`, creator); `baseBranch:'main'` (`:755`); provider detection by substring (`:749`); 60s 429 wait; 2s finalize retry (`:673`); DS1 default 50KB; `appId`; update check is a stub that always says "up to date" (`system.ts:14-17`) — fine for v1 but label honestly.

---
## D. Missing pieces the plan doesn't cover (but v1 needs)
| # | Gap | Why it matters / suggested handling | Demo-critical? |
|---|---|---|---|
| 1 | **`jobNumber` replacement** | Branch naming, UI "job #", references. Options: per-user local counter in `profile.yaml` (+ email/machine disambiguates) or short ULID | Yes |
| 2 | **Event contract** | Define `DeliveryEvent` discriminated union in `shared/`; map to legacy names for a future relay; delete SignalR | Yes |
| 3 | **Seeding Axon blocks w/o backend** | Ship `resources/seed/blocks/*` (versioned, checksummed) in the installer; on boot copy into cache as `sourceType:'Axon'`; enforce immutability **in main** (UI currently only *hides* Edit/Delete — `BlockDetailPanel`) and on registry write path (reject PRs touching seeded IDs) | Yes |
| 4 | **Native block handlers** (`workspace-provisioner`, `pr-creator`, `test-runner`, `ticket-fetcher`) behind a registry keyed by `artifactName`, each with input/output zod schema | Yes (provisioner + pr-creator + human-gate) |
| 5 | **Schema versioning/migration** | Every YAML/JSON doc gets `schemaVersion`; reader tolerates N-1; migrations run on cache + registry; refuse to write older than registry's minimum | Yes (cheap now, costly later) |
| 6 | **Sync conflict handling** | Git-as-store ⇒ non-fast-forward is routine. Rules: per-file ownership (user dir = single writer ⇒ rebase safe); for shared (org/team) = PR only; retry with `pull --rebase`; surface "needs attention" state; bounded queue + backoff; never lose queued writes on crash (queue is on disk, atomic) | Yes |
| 7 | **Registry write authz** | Git hosting ACL is the only authority. Clients must not assume `org/` writable. Branch protection + CODEOWNERS on `org/` and `teams/*` | Config, not code |
| 8 | **Pipeline pinning** | "Each delivery records pipeline commit SHA + snapshot": also pin **block versions** (blocks embed artifacts; snapshot must include block ids+versions, else reruns drift) | Yes |
| 9 | **First-run onboarding** | Registry URL → test → Jira email+token → `/myself` match → git credential check (`git ls-remote` against registry) → Claude key detect → workspace root. Replaces `Setup.tsx` | Yes |
| 10 | **Uninstall / data reset** | Menu "Reset AXON data": removes `userData` cache, `.enc` files, queued writes, optionally worktrees (list sizes first). NSIS uninstaller leaves `userData` by default | Can defer (document manual) |
| 11 | **Rate limits / API etiquette** | Jira polling interval floor (e.g. ≥60s), jitter, `429/Retry-After`; Anthropic 429 policy (C2); GitHub API for PR create/search | Yes (watcher) |
| 12 | **Time/clock & machine identity** | `activeMachine` needs a stable machine id (not hostname alone); **handoff** semantics (stale heartbeat takeover) else the watcher stops forever when a laptop dies | Yes if watcher in demo |
| 13 | **Windows/macOS path issues** | `split('/')` bugs (A6); long-path (>260) for worktrees under `Documents\…` — default `workspaceRoot` is `app.getPath('documents')` (`executor.ts:867`) which is often OneDrive-synced on Windows (sync + git = corruption/slowness) → default to `%LOCALAPPDATA%\AXON\work` or `~/axon`; case-insensitive FS collisions in `users/{email}` (lower-case emails); `:`/`@` in email as directory name (legal on NTFS? `@` yes; normalise anyway); CRLF/autocrlf for YAML; `code` CLI lookup on mac | Yes (Windows default) |
| 14 | **Bare mirror + worktree specifics** | `git worktree add` fails if branch checked out elsewhere; mirror fetch needs per-repo lock; mirror auth via same credential path; cleanup/GC policy for finished deliveries (disk growth); shallow/partial clone (`--filter=blob:none`) option for monorepos | Yes |
| 15 | **Test-runner security** | Runs repo-defined commands (npm test) = arbitrary code from repo/agent. Declare command in block config, run in worktree with timeout, env-scrubbed, output capped; this is the deterministic loop-exit judge so its output schema must be fixed (`exitCode`, `passed`, `summary`) | Yes (verify loop) |
| 16 | **Run-summary schema + redaction** | explicit field list (A in C3); include `pipelineSha`, `blockVersions`, `rerunOf`, `rerunReason` | Yes |
| 17 | **Jira specifics** | Cloud vs Server/DC auth differs (Basic email:token vs PAT); label naming collisions; transitions optional; comment markup (ADF vs wiki); pagination/`updated` cursor with clock skew (use `>=` + dedupe set); deleted/moved tickets | Yes (Cloud only; state it) |
| 18 | **Notifications** | `Notification` + click-to-focus delivery; Windows needs AUMID (set `app.setAppUserModelId('…')` — currently `appId com.company.axon`, change it) | Nice |
| 19 | **Auto-update** | stub (`system.ts:14`); org rollout needs signed installers (no code-signing config in `electron-builder.config.js`) → SmartScreen warnings on Windows | Defer, but note |
| 20 | **Prompt-mode runner policy** | `claude.ts` Prompt mode has no timeout/abort; decide whether Prompt blocks survive in v1 | Decide |
| 21 | **Offline behaviour spec** | Which screens work offline (everything local ✔), what shows when registry unreachable (banner + queued count) | Yes |
| 22 | **Telemetry/privacy statement** | `activity.log` contains email+machine; document it in onboarding (consent) | Yes (enterprise) |

---
## E. Session plan (minimum = 6)

Ordering follows dependencies. "Demo" = must-have for an S3-potential demo; "Defer" = can slip.

| # | Goal | Files touched (main) | Schema changes | Acceptance criteria (testable) | Defers | Demo? |
|---|---|---|---|---|---|---|
| **S1 — Local-first core (remove API)** | Introduce `shared/` types + zod schemas, `Store` interface + `FileStore` (JSON/atomic/one-file-per-delivery) + `EventBus`; rewire executor and renderer services/hooks to Store+IPC; delete apiClient/api.ts/SignalR/auth/JWT/`rejectUnauthorized` Agent; gate approve/reject as IPC (records approver = local identity); boot-time orphan reconciliation (`Interrupted`); fix git-token key mismatch; fix `.axon` DS1 location (`userData/runs/{id}`); `.gitignore` + `git rm --cached` junk; remove dead settings/files; add test runner (vitest) with engine unit tests | `electron/ipc/executor.ts` (split → `engine/`, `runners/`, `store/`), `preload.ts`, `main.ts`, `src/services/*`, `src/hooks/*`, `Setup.tsx`, `Settings.tsx`, `package.json`, `.gitignore` | New: `Delivery`, `Pipeline`, `Block` docs with `id`,`schemaVersion`,`createdAt/updatedAt`; `Delivery.localSeq` (replaces jobNumber); `DeliveryEvent` union; remove `autonomy/confidence` settings | App runs with **no network**: create/list/run/pause/approve/cancel delivery; kill -9 mid-run → on restart status `Interrupted`, Resume works; **no file under repo worktree contains DS1 output** (`git status` clean after run); `grep -r "api/" src electron` empty; ≥ 25 engine unit tests (start, gate, cancel, resume, crash-reconcile, double-start) green; renderer receives the same events through one channel | Registry, Jira, provisioning, loops | **Yes** |
| **S2 — Security hardening of the shell** (fold into S1 only if S1 stays small; otherwise standalone) | Path-guarded workspace IPC, remove generic secret oracle → named APIs, IPC schema validation, `sandbox:true`, nav/window-open guards, `openExternal` allow-list, CSP meta + bundled fonts, preload shrink, agent env scrubbing, drop `settingSources:'project'`, path-scoped PreToolUse, bounded 429 retry, redaction logger | `main.ts`, `preload.ts`, `auth.ts`, `workspace.ts`, `settings.ts`, `claudeAgentic.ts`, `claude.ts`, `index.html` | Typed settings schema | Pen-style tests: renderer `readFile('../../…')`/`clear('C:\\')`/`getSecure('../x')` rejected; agent attempting `Write` outside worktree is denied & recorded in `toolsDenied`; packaged build shows effective CSP (devtools); `npm audit`/lint clean | Full OS sandbox | **Yes** (enterprise ask) |
| **S3 — Registry + identity + sync** | `GitRepoStore` adapter (mirror clone of registry, cache, write queue, scheduled sync, PR for promotion, `derivedFrom`+SHA), registry layout + `catalog/repositories.yaml`, Settings (URL/branch/Test connection, default URL via build-time constant), onboarding (Jira `/myself` match), `profile.yaml`, batched `activity.log`, run-summary redaction + secret scan, seed bundle for Axon blocks (immutable), schema versioning + migrations | new `electron/store/gitRepoStore.ts`, `identity.ts`, `seed/`, `Setup.tsx`→onboarding, `Settings.tsx` | Registry file schemas (`schemaVersion`); `Run summary` schema; `profile.yaml` | Fresh machine: onboard → seeded blocks visible; create Personal pipeline → appears in registry after sync (offline: queued, syncs on reconnect, survives crash); promote → PR URL; two clients editing same shared file → conflict surfaced, no data loss; run summary file contains **only whitelisted fields** (contract test) | `ApiStore`; Marketplace/CDF | **Yes** |
| **S4 — Workspace & PR as explicit blocks** | `workspace-provisioner` (catalog check, bare mirror, worktree per `deliveryId`, default-branch detection), multi-repo `pr-creator` (find-or-create PR, linked, provider by URL parse), **delete PR tail from `runStepLoop`**, validator rule (agentic/pr-creator after provisioner), Manual Delivery pre-fills `repositories`, workspace root default off OneDrive, git credentials via helper not URL | `engine/native/*`, `git.ts` (rewrite), `NewDeliveryModal.tsx`, shared validator, `PipelineCreator.tsx` | Block: `contextMode`; `repositories` input schema; delivery `repos[]` with `{url, branch, worktreePath, prUrl}` | 2-repo delivery produces 2 linked PRs; non-catalog repo rejected with clear error; rerun same ticket doesn't collide; ticketId `../x` rejected; Windows long path & spaces-in-username OK; mirror shared across deliveries (second delivery faster); completed ≠ shown if push/PR failed | Marketplace repos; shallow clone tuning | **Yes** |
| **S5 — Jira watcher + rules + notifications** | Delivery Rules (CRUD in `users/{email}`), poller (JQL `assignee = currentUser()`, `updated` cursor, jitter), `activeMachine` lease + heartbeat takeover, claim by label swap, write-back + idempotent comments (marker), rerun via re-adding label, OS notification on gate, concurrency cap | `electron/jira/*`, `engine` (queue), `Settings` (Rules UI), `main.ts` (Notification, AUMID) | `DeliveryRule`, `profile.activeMachine{id,heartbeatAt}` | Mock Jira server tests: ticket labelled → exactly one delivery (restart mid-poll doesn't duplicate); non-assigned ticket ignored; done/failed labels + one comment each; second machine does not poll; kill machine A → B takes over after TTL; gate → notification fires | Webhooks; Jira DC | Demo if scoped to "label → run → comment"; polling UI polish **Defer** |
| **S6 — Conditional edges + verify loop + `test-runner`** | Condition grammar/evaluator, iteration-keyed steps (`nodeId#n`), cycle-aware validator & resume, `previousAttempt` injection, budget (`maxIterations`, tokens), `onExhausted` (failed\|route-to-gate), native `test-runner` (scrubbed env, timeout, structured result), Live View iteration display, Intelligence page → real local summaries or hidden | `engine/graph.ts`, `PipelineCreator.tsx`, `DeliveryLiveView.tsx`, `types` | `Edge.condition` grammar; `Edge.loop{exitWhen,maxIterations,budget,onExhausted}`; `Step.iteration` | Unit tests: back-edge loops N times then exits on `passed=true`; exhausted → Failed or HumanGate; resume mid-loop continues at correct iteration (no infinite walk); flatResults overwrite collision test; previous attempt visible to block | Nested loops; parallel branches | Optional for demo; **Defer if schedule slips** |

**Dependency graph:** S1 → (S2 ∥ S3) → S4 → S5; S6 after S1 (needs only engine) but best after S4 so the loop wraps real provision/test blocks. If you must drop to 5 sessions, merge **S2 into S1** (enterprise fixes in the code S1 already rewrites: executor/auth/workspace/preload) — recommended; the stand-alone S2 above is only to keep S1 reviewable.

---
## Top 5 risks
1. **Executor rewrite without tests (S1).** 1192-line state machine with resume/cancel/gate semantics and zero tests; the API currently hides several races (step upsert, duplicate step entries). Mitigation: build the pure engine + test harness first, in the same session.
2. **Agent containment.** `bypassPermissions` + unscoped `Bash` + full env + repo-supplied `.claude` settings + ticket-sourced prompt, now running *unattended* from a Jira watcher. This is the biggest security exposure of v1 as proposed; the watcher should not ship before S2's agent controls.
3. **Git-as-database semantics.** Sync conflicts, non-fast-forward, queue durability, and registry PR flows are the hardest part of S3 and are under-specified; a data-loss bug here is user-visible and hard to repair. Keep per-user files single-writer to bound it.
4. **Workspace provisioning (mirror + worktree + multi-repo) on Windows.** OneDrive-synced Documents default, long paths, credential flows, worktree locks, disk growth. Current code is a naive clone; S4 is essentially greenfield.
5. **Hidden API-owned behaviour** (`jobNumber`, snapshot building, approver identity, validation, upsert semantics) — each is a small, easily forgotten feature whose absence breaks branch naming, audit trail, or reruns.

## Decisions I need from Kranthi
| # | Question | My recommendation |
|---|---|---|
| D1 | `jobNumber`/branch name once the global counter is gone: per-user counter in `profile.yaml`, short delivery id, or Jira-key only? | `axon/{user}/{jira-key}-{shortid}`; counter only for display |
| D2 | Event naming: keep IPC `snake_case`, adopt the PascalCase list, or define a new union (+ adapter for the future API relay)? Plan text assumes the latter already exists | New typed union; relay adapter maps to PascalCase later |
| D3 | Users on **Claude subscription login** (no `primaryApiKey`): supported in v1? Agentic runner currently requires an API key | Require API key for v1; document |
| D4 | Do **Prompt-mode** blocks and the **Codex** runtime survive v1? (Prompt mode has no timeout/abort; Codex is a throwing stub with no key UI) | Keep Prompt (fix abort/timeout); hide Codex |
| D5 | Is `confidence` kept as optional display only? (Settings slider "Minimum confidence for autonomous actions" contradicts settled principles) | Remove the slider and setting; keep optional display |
| D6 | Intelligence page: hide for v1, or feed from local run summaries? Today it is 100% static demo data | Hide behind flag; revisit post-S3 |
| D7 | Default `workspaceRoot` (currently Documents, often OneDrive-synced): change default? | `%LOCALAPPDATA%/AXON/work` (mac: `~/Library/Application Support/AXON/work`) |
| D8 | Jira: Cloud only for v1? Which auth (email+API token per plan)? Required Jira write-back permissions (labels/comments)? | Cloud only |
| D9 | Registry write model for Personal "direct commit": to `main` of the shared registry (needs write access for everyone) or to a per-user branch/fork? Org access policy likely forbids broad write | Per-user branch merged by bot, or `users/{email}` path-restricted via CODEOWNERS/ruleset |
| D10 | `activeMachine` takeover: manual only ("Use this machine") or automatic after heartbeat TTL? | Manual + visible warning when stale (avoids double-run) |
| D11 | Should project `.claude/` settings in customer repos ever apply to agent runs (today they do: `settingSources:['project']`)? | No for v1 |
| D12 | Is the S6 loop in scope for the S3 demo? | Defer unless demo script needs it |

