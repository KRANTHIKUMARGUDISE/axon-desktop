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

## Session 2 — Security hardening (2026-10-12)

### Done
- **Shell (C1)**: `sandbox: true`, `webSecurity`, no webview; `setWindowOpenHandler` → deny (https links go through the same allow-list), `will-navigate`/`will-redirect` blocked unless the app's own origin, all renderer permission requests denied. `openExternal` = `https:` only (no embedded credentials). `openPath`/`openInVSCode` only accept the workspace root, a folder picked in a native dialog this session, or a workspace path recorded on one of AXON's own deliveries; `code -n -- <path>` (no option injection). CSP is a `<meta>` injected by a Vite plugin (prod: `script-src 'self'`, no inline script, `connect-src` = Anthropic/GitHub/Azure DevOps APIs; dev keeps HMR allowances). Google Fonts removed; Inter + JetBrains Mono bundled via `@fontsource-variable/*`.
- **IPC**: every channel goes through `electron/ipc/guard.ts` (`handle`/`on`): top-frame `senderFrame` URL must be the Vite origin (dev) or the packaged `index.html`, and args are parsed with a zod tuple. Settings writes dispatch through per-key validators (`SETTING_VALIDATORS` in `shared/schemas.ts`); `gitTokenSuffix` is now derived in main, not renderer-writable. Added `parseHttpsUrl(url, hosts?)` for the S5 Jira URL setting.
- **Workspace IPC**: reduced to `workspace:readFile` + `workspace:listFilesRecursive` (the only calls the renderer made). Paths must resolve (realpath, case-insensitive on Windows) inside `workspaceRoot`, `{userData}` or `{userData}/registry`, or inside a folder/file the user picked in a native dialog this session (read-only grant — Create Block needs this). `listDirs/exists/writeFile/createDir/clear` deleted; "Clear workspace" is now `delivery:clearWorkspace(deliveryId)` which only removes a Default-type delivery clone that is a direct child of `workspaceRoot` and is not Running/Paused.
- **Secrets**: named APIs only — `secrets:{set,has,clear}GitToken` and `{set,has,clear}JiraToken` (stub storage for S5), `claudeKey:*`. `clearGitToken` removed from the bridge (unused).
- **D3**: a key found in `~/.claude.json` / `~/.claude/config.json` is only a *candidate* (`ClaudeKeyStatus.candidate`) until the user clicks "Use this key" in Setup/Settings (`claudeKey:confirmDetected`); `getClaudeKey()` never returns a candidate.
- **Logger (C3)**: `electron/log.ts` — JSON lines in `{userData}/logs/axon.log`, size rotation (1 MB x 3), levels, redaction of Anthropic keys, GitHub PATs, Bearer/Basic/token headers, `user:pass@` in URLs, emails, `key=value` secrets, plus exact-value redaction of registered secrets. All `console.*` in `electron/` replaced.
- **Git credentials**: no token in URLs/argv/`.git/config`. Token reaches git via env (`GIT_ASKPASS` -> `{userData}/bin/askpass.sh`, `AXON_GIT_PASSWORD`), set only on that git child. Every network git client gets `-c protocol.ext.allow=never -c protocol.file.allow=never` (+ `credential.helper=` when a token is used). Repo URL must be `https://` / `ssh://` / `git@host:path` with no embedded credentials. `fetch`/`pull` now receive the token too (previously relied on the token embedded in the clone URL).
- **Agent containment (C2)**: `electron/security/agentPolicy.ts` — `decideToolUse` (tool list ceiling; any `file_path/path/notebook_path/directory/cwd` and Glob/`glob` patterns must stay in the worktree; Bash denies network tools incl. obfuscated forms, `git push/remote/clone/fetch/pull/ls-remote/submodule`, `cd` out of the worktree). Wired as `createToolPolicyHook`; every denial adds the tool to `toolsDenied` and a reason to the new `AgentOutput.denials`. Agent env is an allow-list (`buildAgentEnv`). Ticket-derived text is fenced in `<untrusted_ticket_data>` for both Prompt and Agentic runners. `outputSchema` fields are required on `success` outputs (missing -> `failed`); the raw-text parse fallback is capped (8 KB), redacted, and only appears on a failed output (a failed step halts the delivery, so it never enters the context pool).
- **Tests**: +25 (`electron/security/__tests__/security.test.ts`) — path guard incl. junction escape, workspace IPC, channel list (no write/clear/getSecure), IPC guard, settings validators, URL helpers, agent policy matrix, hook -> `toolsDenied` for the three acceptance scenarios, env allow-list, git askpass (incl. a real `git credential fill` through the helper), logger redaction with seeded fake secrets + rotation, prompt fencing, outputSchema validation. Total 107.
- **Verified live** (real Electron app + Vite dev server, driven over CDP): sandboxed preload works; `readFile('../../etc/passwd')` and an absolute out-of-root read are rejected; `settings.set('workspaceRoot','relative')` and `settings.set('gitTokenSuffix', ...)` rejected; `openExternal('file:///...')` rejected; `openPath('C:/Windows')` and `openInVSCode('--help')` rejected; `window.require`/`process` undefined in the renderer; CSP meta present; no font requests to Google; log file written with the rejections; the real `~/.claude.json` key was surfaced as a candidate and not used.

### Findings
- **Repo `.claude/settings.json` cannot widen AXON's limits (D11)** — by construction, not yet by a live run: (1) the `tools` option is the ceiling; (2) our PreToolUse hook denies regardless of allow rules / `bypassPermissions`; (3) new — we pass `managedSettings.permissions.deny` (policy tier; SDK docs: restrictive keys only, not overridable by project settings) with `WebFetch`, `WebSearch`, `Bash(curl:*)`, `git push`, etc. **Not live-verified**: a run with a fixture repo whose `.claude/settings.json` allows `Bash(curl:*)`/extra directories needs a real Anthropic key and spends tokens; the hook/policy layer is unit-tested instead. Do this once with the user's key.
- **Native SDK sandbox**: `options.sandbox` exists (`enabled`, `failIfUnavailable`, network/filesystem config) but relies on OS facilities (bubblewrap on Linux, Seatbelt on macOS) — not available on Windows, the primary target (D7), and untestable here. Not enabled; OS-level sandboxing is out of scope for S2. The hook + managed deny rules are the containment on all platforms and are best-effort (a determined agent can still reach the network via e.g. `node -e`).
- simple-git blocks `protocol.*.allow` overrides, `GIT_ASKPASS` env and `credential.helper` unless the matching `unsafe.allowUnsafe*` flags are set; we enable exactly those three because the values are AXON-authored constants (the repo URL is validated separately).

### Deferred / deviations
- `vscode://` fallback kept **internal only** (URI built by main from an already-validated path) because `code` is a `.cmd` shim on Windows and `execFile` can't run it; the renderer can never pass a `vscode:` URL.
- Jira/registry hosts are not in `connect-src` yet (the renderer makes no direct network calls; S3/S5 add them in `vite.config.mts`).
- The GitHub REST PR call still sends the PAT in an `Authorization` header from main (never logged; redacted if it appears in an error).
- Packaged-build check was done on the built `dist/index.html` (meta present, no inline script, no Google hosts), not by launching an installer build.

## Session 2b — Dependency hardening (2026-10-13)

Branch `chore/v1-s2b-dependency-hardening`, one commit per step. Full record in `docs/security/dependency-audit.md`.
- `npm audit --omit=dev`: **26 → 0**; full audit **47 → 15** (remaining: shadcn CLI chain ×7 high, electron-builder download-helper chain ×8 moderate — all dev/build-time, justified in the audit doc).
- `npm audit fix`; **simple-git 3.36 → 4.0.2** (named export; its environment guard blocks git when `EDITOR`/`VISUAL`/`GIT_SSH_COMMAND`/… are inherited, so `buildGitEnv` strips them and `makeGit` passes `allowEnvironment` — would otherwise have broken git for users with `EDITOR` set); **Electron 31 → 44.7.0** (no app code changes; S2 hardening re-verified on the packaged build); **electron-builder 24 → 26.17.0**; `shadcn`/`tw-animate-css` → devDependencies; **vite 5 → 6.4.4, vitest 3 → 5.0.4**; `--legacy-peer-deps` no longer needed (clean `npm ci` resolves).
- New: `scripts/smoke-packaged.js <AXON.exe>` — launches a packaged build with a debug port and checks the S2 hardening over CDP (prod CSP, no Node globals, IPC works, traversal/bad-setting/`file:` rejected, window.open/navigation guards, permission denials, no remote fonts, Claude binary unpacked). First time the **production** (file://) path was exercised.
- Tests: 111 (+4 real-git tests: protocol.file refused, ext:: never executes, EDITOR/VISUAL/PAGER set, askpass wiring).

### Not done / caveats
- **Installer not actually installed**: an AXON 0.1.0 install is registered on this machine (`HKLM…\Uninstall\AXON`), so I did not run a second silent install/uninstall. The NSIS payload was extracted with 7za and the extracted app passed the smoke test. Run `release\AXON Setup 0.1.0.exe` yourself (or tell me to) for the install-and-launch check.
- Electron 32–44 breaking-change list not read line by line; verification is behavioural (smoke + tests). IPC-from-foreign-frame rejection is covered by unit tests only (iframes are blocked by CSP so it can't be exercised from the page).
- The opt-in live agent tests (`live.agent.test.ts`, needs `AXON_LIVE_API_KEY`) were not run after the SDK/Electron bumps.
- I mistakenly claimed in the step 4 commit message/doc that `allowScripts` gates Electron's binary download; Electron 44 has no postinstall. Corrected in step 7 (docs + package.json).

## Session 3 — Registry, identity, sync (2026-10-13)

### Done
- **Registry layout + write guard (D9)**: `electron/registry/layout.ts`. Direct writes only under `users/{email}/` (lowercased, path-safe email); the guard runs at enqueue, again at replay, and the staged file list is re-checked before every commit. Org/team/catalog only via PR.
- **`GitRepoStore`** (`electron/store/gitRepoStore.ts`) wraps `FileStore` (the offline cache/working copy) and mirrors the engineer's own blocks/pipelines into the registry layout (pipelines: one YAML per version + `draft.yaml`; blocks: folder with `block.yaml` + `files/…`). `FileStore` gained a read-only `definitions` fallback (`RegistryReader`: org + teams from the clone), so engine/`createDelivery` see shared docs transparently. Hydration imports your own docs on a fresh machine; a one-time backfill queues pre-S3 local docs.
- **Durable queue + sync** (`registry/queue.ts`, `registry/sync.ts`): one atomic file per op, coalesced by path, removed only after a successful push. Sync = fetch → reset clone to `origin/{branch}` → replay ops → secret scan → commit → push; non-fast-forward → re-fetch + replay with backoff (5 tries) → `NeedsAttention`; unreachable → `Offline`; `registry.yaml.minAppVersion`/schema newer than the app → `ReadOnly`. Scheduler (default 5 min, setting) + "Sync now" + bounded flush on quit. States pushed on `registry:status`.
- **Versioning (D13)**: `status Draft|Published|Deprecated`, immutable `versions/…/v{n}.json`, publish (pipelines pin `blockVersion`), deprecate, duplicate (`derivedFrom`), version history, "newer block version available". Deliveries record `pipelineId/pipelineVersion/blockVersions` and **the engine now runs the pinned block versions**.
- **Promotion**: `registry/promote.ts` — dedicated branch + GitHub REST find-or-create PR with the engineer's token; PR URL shown in the dialog.
- **Seed bundle**: `resources/seed` (human-gate + 4 stubs), versioned + sha256-checked (`scripts/build-seed-manifest.js`), loaded as `Axon`/`Org`/immutable; immutability enforced in the store. Shipped via `extraResources`.
- **Schema versioning**: `SCHEMA_VERSION` 2, `shared/migrations.ts` (N-1 upgraded on read, newer refused).
- **Onboarding** (`Setup.tsx` rewritten): registry URL/branch + Test connection (read + push dry-run), Jira site/email/token with `/myself` email match (blocks on mismatch), GitHub token check, Claude key (D3), workspace root (D7), activity-log consent.
- **Identity**: `profile.yaml` (email, displayName, team, machines), stable machine UUID, `activity.log` (launch/login, appended and pushed with the next sync). The `local-user` placeholder is gone from approver/createdBy/agreement-accepted-by. **`userEmail/userName/jiraSite/setupComplete` are no longer renderer-writable** — only `onboarding:complete` (after the Jira check) sets them.
- **Run summary** (`registry/runSummary.ts`): explicit whitelist + strict schema + 200-char caps; secret scan on every registry write (Anthropic/GitHub/AWS/Atlassian/Slack keys, private keys, bearer/basic, generic assignments).
- **UI**: offline/attention banner in the app shell, Settings → Registry (URL/branch override, interval, last sync, queued count, rejected writes, Sync now), scope/status badges, `VersionDialog` (history, publish, deprecate, duplicate, promote) from pipeline cards and the block detail panel.
- **Tests**: 111 → 183 (+72). Store/sync tests run against local bare repos (no network): two clients concurrently (and a deterministic non-ff race), offline → crash → reconnect, secret refusal, read-only registry, tamper → path guard, hydration, backfill, promotion (mocked GitHub), run-summary contract, Jira (mocked fetch), seed checksum/tamper, migrations, validators.
- **Verified**: `npm run typecheck`, `npm test`, `npm run build` pass. Live (real Electron over CDP): onboarding screen renders for a fresh profile; 5 seeded blocks visible; identity settings/`file:`/`ext::`/credentialed URLs rejected; `onboarding:complete` refused without a verified Jira identity; seeded block update/duplicate/promote refused.

### Deviations / decisions I had to assume
- **"Publish increments version"**: a Draft's `version` is the number it *will become*; editing a Draft edits in place (no bump); editing a Published doc creates Draft `version+1`. Net effect is the same numbering as increment-on-publish, but the existing "version bumps on every update" behaviour and its tests changed.
- **"Rebase own changes"** is implemented as reset-to-remote + replay of the queue (equivalent for single-writer folders and cannot conflict).
- **Default registry URL** ships as `resources/registry-default.json` (`url` is empty in this repo — set it per org/release) plus `AXON_REGISTRY_URL`/`AXON_REGISTRY_BRANCH` env overrides, instead of a compiled constant.
- Pipelines can only be published when every referenced block has a published version; a pipeline can only be promoted if its blocks are Team/Org/built-in.
- `team` is a free-text onboarding/Settings value (Jira has no team field).
- Seed stubs (provisioner, pr-creator, ticket-fetcher, test-runner) are registered but have no native handler — running one fails with "No native handler" until S4/S5.

### Not done / caveats
- **No live run against a real remote.** Production git hardening (`protocol.file.allow=never`, https/ssh URL validator) means a local bare repo can't be used through the real app, so the full onboarding → sync → promote path was verified only through the unit/integration tests (real git, bare-repo fixture) and the live IPC checks above — not with a real Jira site, GitHub registry or token. Worth one pass with the real registry.
- Production `makeGit` with a real https/ssh remote (askpass token path, `-c core.autocrlf=false` on clone) is untested end-to-end; a test confirms simple-git accepts the flags and git refuses only the `file` transport.
- Deletes don't propagate to the same engineer's other machines (hydration only imports missing docs); no Azure DevOps registry PRs; Jira write-permission checks (label/comment) are S5.
- Registry docs from a *newer* schema are skipped and listed (`RegistryReader.skipped()`), not shown in the UI yet.
- No manual click-through of the new React screens beyond the Welcome step; visual pass recommended (onboarding steps, Settings → Registry, VersionDialog, banner).
- Nothing committed — the work is in the working tree for review.

### Session 3 follow-up — Settings rework + Jira section (2026-10-13)
- **Settings rebuilt with shadcn only** (Tabs, Card, Dialog, Alert, Select, Input, Label, Badge, Separator; new `ui/label|alert|separator`): tabs Accounts / Registry / Workspace / Preferences / About, one card per concern with a consistent header (title, description, status badge), labelled fields in a grid, and right-aligned footer actions (fixes the misaligned "Save registry settings"). Saves report through toasts. Azure DevOps removed from Git settings (GitHub only); the dead "Documentation/Feedback" links and the hard-coded "AXON 1.0.0" are gone (About reads `system:getInfo`).
- **Settings → Jira**: read-only site + verified email + last verified; Replace API token (must resolve to the registered email, else rejected and old token kept); Test connection; Change Jira account or site (stage → explicit confirmation → commit; never edits the email in place; a different email = new identity/folder). Site validated as https + `*.atlassian.net`. Logic in `registry/jiraAccount.ts` (20 tests: token replace with matching email, mismatched email → rejected + old token kept, invalid sites rejected without calling Jira, change-account staging/commit/cancel).
- **Onboarding gate fixed**: "onboarded" now requires a Jira-verified identity (email + Jira site + setup flag), so profiles left over from pre-S3 builds (free-typed `admin@axon.local`, no Jira) are sent through onboarding again. Registry copies of personal docs are always owned by the current verified email. Jira tokens are persisted only when onboarding completes / a change is confirmed.
- **Incident (mine)**: while taking Settings screenshots I launched the app with a throw-away profile whose identity was `dev@example.com`, and the app pushed `users/dev@example.com/{profile.yaml,activity.log}` (commit 47fa32c) to the real registry using ambient git credentials. Needs removing (revert commit); future UI test runs must point `registryUrl` at something unreachable.

### Session 3 follow-up — About split, diagnostics, licenses, Intelligence flag (2026-10-13)
- **Sidebar About = product page** (what AXON does / what teams build with it / how it works / where your data lives); static copy, existing logo assets, no external links, no personal data (the old page's user card, "Documentation"/"Report Issue" links and local-mode box are gone). **Settings → About = build info**: version, platform, Electron, Node + **Copy diagnostics** + **Third-party licenses**.
- **Copy diagnostics**: allow-list only (versions, OS, registry host only, sync state/last sync, queued count), strict per-field shapes + logger redaction; 8 tests incl. seeded secrets/emails/paths/URL credentials never appearing.
- **Third-party licenses**: `scripts/generate-licenses.js` runs in `npm run build`; 271 packages (production closure + Electron + the Agent SDK's bundled Claude Code binary package for the build platform) → `resources/licenses.json` (gitignored, `extraResources`). Tests cover inclusion/exclusion of dev dependencies. Note: only the Claude binary package for the *build machine's* platform is installed, so a Mac build must be produced on a Mac (or with its optional dependency installed) for its binary to be listed; Claude's own license file is a one-line pointer to Anthropic's terms.
- Sidebar About also has an "AI only where it's needed" section (built-in steps are plain code: ForEach, workspace/repo prep, PRs, human gates, Jira read/update, readiness checks). Note: that copy describes the v1 design — ForEach, workspace/PR blocks and the Jira steps land in S4/S5, so keep it in step with what actually ships.
- **Intelligence hidden (D6)** behind `AXON_FEATURE_INTELLIGENCE=1` / main-only `featureIntelligence` setting (default off): removed from the sidebar and the route redirects to the dashboard.

### Known issues for Session 4
- The pipeline editor drops `blockVersion` pins when saving a Draft. Drafts must keep their pins, with an explicit "Update block versions" action instead of re-applying the pins at publish time.

## Pending verification

Real-world checks deferred so the sessions can move on. Each must be done before the stage in the right-hand column.

| Check | Must be done before |
|---|---|
| Live agent containment tests (S2's 5 cases: repo settings widening tools, Write outside worktree, Read-only block editing, prompt injection in ticket text, repo hook execution) | Session 5 (watcher runs agents unattended) |
| Jira identity in onboarding against a real Jira Cloud site (matching email passes, mismatched email blocked) | Session 5 |
| Promote → PR → merge → item appears as org/team after sync | Demo |
| Second user (different email) sees org items but not my personal items | Demo |
| Offline queue + banner, Settings → Registry screen, version history dialog clicked through | Demo |
| Production https git path exercised end to end (sync verified manually: pipeline creation + sync to the real registry works) | Done ✓ |

## Session 4 — Workspace provisioning, PR creation, ForEach (2026-10-13)

### Done
- **No hidden git**: `WorkspacePort` now only resolves the delivery root; `finalize` and the clone/branch step are gone. A delivery completes when its terminal node succeeds. Existing pipelines are not migrated — add a Workspace Provisioner first and a PR Creator last.
- **Native block registry** (`electron/runners/native/`): `human-gate`, `workspace-provisioner`, `pr-creator`, each with zod input/output.
- **workspace-provisioner**: catalog-only repos (`catalog/repositories.yaml`), bare mirror per repo (per-repo lock, fetch only on reuse), per-delivery worktree on a D1 branch off the detected default branch, ticket-key validation, long-path/space-safe (Windows path ≤ 200 chars guard).
- **pr-creator**: explicit-path staging (no AXON files), commit, push via askpass env, find-or-create PR by head branch, sibling links; GitHub only (clear error otherwise); push failure fails the delivery.
- **Validator** shared by the Creator and `engine.start`; `contextMode` Selective|Full (default Selective) — **behaviour change**: a prompt block that declares no `contextRequirements` now receives no fields (it used to get the whole pool). Pick Full explicitly to keep the old behaviour.
- **ForEach** as a pipeline node (schema, validator, executor, item events, deterministic resume via `itemPlan`), typed `outputSchema`, WorkItemList parsing (missing/duplicate key, unknown dependsOn, cycle, `keyField`), per-item context + cwd, `itemResults`.
- **UI**: Creator Flow palette + container (drop in / drag out / cross-border edges refused / Iterate-over picker / validator panel / pins preserved + "Update block versions"), Create Block (WorkItemList marker, hint, Full context toggle), Manual Delivery (ticket key + catalog repos), Live View lanes + counter, Deliveries counter, multi-PR card, Remove workspace + size.
- **Tests**: 211 → 254 (+43): work-item list + validator matrix; engine ForEach (dependsOn order, per-repo cwd, resume of item 2 only, non-repo list, keyField, malformed lists, standalone vs ForEach use, Agentic-before-provisioner); provisioner/pr-creator against local bare repos (mirror reuse, default branch not main, non-catalog, `../x`, rerun no collision, spaces + >260-char paths, worktree removal) with mocked GitHub; native registry.
- **Verified**: `npm run typecheck`, `npm test`, `npm run build`. Creator and Live View were exercised in the browser pane against a stubbed `window.axon` (container render, drag a block out → detaches + border edges removed + validator errors, drag back in → `parentId` + relative position, save payload parents-first; lanes/counter from a stored delivery; New Delivery modal).

### Deviations / assumptions
- `catalog/repositories.yaml` format was undefined → `{repositories:[{name,url,defaultBranch?}]}`.
- Children of a ForEach do **not** use `extent: 'parent'` (xyflow would then forbid dragging out); membership is set/cleared in `onNodeDragStop`.
- Pipeline node schema is one object (`type: 'forEach'` vs block nodes, ForEach fields optional with defaults applied in code) instead of a strict discriminated union, to avoid touching every block-node consumer.
- Event names stay snake_case (`item_started`/`item_completed`/`item_failed`).
- Resume is allowed from `Failed` only when a ForEach item failed (other Failed deliveries are still rerun, as before). Resume restarts that item at its failing body node.
- A bare mirror (`clone --bare` + fetch refspec into `refs/remotes/origin/*`) is used instead of `--mirror` so fetch can never prune/overwrite worktree branches.
- Mirrors are kept on Remove workspace; no size cap/GC for mirrors.

### Not done / caveats
- **No live run in real Electron** (a real run clones from github.com with the user's profile; per the S3 incident I did not launch the app against the real registry). Provisioner/PR paths were verified with local bare repos + mocked GitHub only; the production `makeGit` (hardened protocols, askpass) path for `clone --bare`/`worktree add`/push is untested end to end — worth one real run with a catalog repo.
- Dragging a *new* ForEach from the palette (HTML5 drop) and dropping a palette block onto a container were not exercised in the browser pane (only existing nodes dragged); logic is in `onNewNode`.
- Live View lane text/visual polish only checked via DOM text + a small screenshot.
- Pending-verification table: add "real provision → ForEach → PR run" before Session 5.

## Session 4 follow-up — D16/D17/D18 (2026-10-13)

### Changed
- **ForEach contract (D16)**: iterates its single direct predecessor WorkItemList. **Removed** from the node and the panel: Iterate over, Key field, Repo field, Order (and `dependsOn`). Panel = Name + collapsed Advanced (Max items 10, If empty **Fail** by default; it used to be Skip). Header shows "Runs once per item from <predecessor>". Old saved `over/keyField/repoField/order` values are ignored.
- **WorkItemList**: `{ items: [{ key, task, workspacePath? }], shared? }`, `key` + `task` required, extras pass through, list order only. Validated when the producing step completes (step Failed, message names the item). A block may declare at most one WorkItemList output. Body gets `task, shared, item, itemKey, completedItems`; `repoPath`/`repoField` are gone.
- **Validator**: ForEach needs exactly one predecessor that declares a WorkItemList ("Connect a block that returns a work-item list."); per-item fields (`item, itemKey, task, completedItems`) outside a ForEach are errors; gate / PR Creator inside a ForEach are errors. **Removed** the "Agentic block / PR Creator must follow a Workspace Provisioner" rule (D17/D18 let planners and agents run in the Delivery Folder). Say if you want it back.
- **Where nodes run (D17)**: Delivery Folder per delivery; cwd = item.workspacePath -> delivery Workspace path -> Delivery Folder; paths must be inside the Workspace Root; other git folders must be clean and are locked per delivery. New errors: "Workspace path must be inside the Workspace Root: <path>", "Workspace path does not exist", "... has uncommitted changes", "... is in use by another delivery", "... is not a git repository".
- **New Delivery (D18)**: Ticket ID, Pipeline, optional Workspace path (picker at the root, pre-checked), Advanced JSON inputs. Repositories/catalog section and Browse working directory removed from the modal; the `catalog:repositories` IPC is gone. The delivery branch is created in the Workspace path and the original branch restored on Completed/Failed/Cancelled (locks released); Resume re-locks.
- **Workspace Provisioner**: input is the predecessor list (items name a catalog repo in `repo`), output is the same list with `workspacePath` per item (+ `provisionedRepos`); the `repositories` input and top-level `workspacePath` output are gone (seed block v3). **PR Creator** falls back to the Workspace path repo when there is no `provisionedRepos`.
- **Edge panel**: condition field/operator/value and "Sync from Marketplace" removed.
- **Loose ends (verified)**: Draft saves keep `blockVersion` pins (now unit-tested through `shared/pipelineGraph.ts`) + explicit "Update block versions"; Settings -> About (build info, Copy diagnostics, licenses), the sidebar About product page and the Intelligence flag (default off) were already in from S3 and are unchanged.
- **Samples**: planner returns `{items:[{key,task,repo}], shared}`, coder sample declares `task, shared, item, itemKey`, epic analyzer uses `task`.

### Tests
Validator matrix, WorkItemList (missing key/task, duplicate, extras preserved, empty Fail/Skip, max items), cwd order, outside-root / dirty / locked / stale-lock, branch restored after Completed / Failed / Cancelled (real git), provisioner field preservation + unknown repo, engine ForEach (list order, context, resume item 2, producer-step failure), pin preservation.

### Caveats
- Still no live run in real Electron against a real remote; the New Delivery picker and lane visuals were not re-checked in a browser after this change.
- A non-git folder inside the root is used without a lock; a git folder that is a subfolder of a repo locks the top level of that repo.
- If restoring the original branch fails (e.g. conflicting uncommitted changes) it is only logged; locks are still released.

### D16-D18 adjustments (2026-10-13)
- **PR Creator** now derives its repos from the **recorded cwd of every step** (`DeliveryStep.cwd`, set as soon as the folder is resolved): distinct git top levels, one PR per repo with changes; none -> "No repository to create a PR from". The `provisionedRepos` input is gone (seed PR Creator v3). Validator: **warning** (not error) when a PR Creator has no Workspace Provisioner upstream.
- **Branch restore** on Completed/Failed/Cancelled: if the checkout is blocked by leftovers they are stashed as `axon/<deliveryId>` (including untracked files), then the branch is restored. A Live View notice (and `workspace_notice` event + log) says what was stashed, the stash name and how to recover; if the restore still fails the notice gives the exact commands. Locks are always released.
- **Lock behaviour kept**: an Interrupted delivery keeps its lock and branch until resumed or cancelled (tested).
- Tests: cwd recording, PR repos from cwds (dedupe, subfolders, non-git, no changes, none), stash path for Completed/Failed/Cancelled, not-restored notice, Interrupted keeps lock until cancel, validator warning.
- Caveat: stash entries are not cleaned up by AXON; a stash that cannot be applied cleanly later is the user to resolve. Leftovers that do not conflict are carried onto the original branch (no stash, no notice), as plain git does.

### Fixes from the first real run (2026-10-13)
- **Catalog visibility**: Settings -> Registry -> Repository catalog lists name / url / default branch, the registry file path, last synced, and every dropped or malformed entry with its reason (also a missing or unreadable file). The "not in the catalog" error now adds "N repos in catalog; last synced <time>; Settings → Registry to check".
- **Confidence (D5)**: the "Below threshold (70%)" warning and the green/amber colouring are gone (also the demo "Confidence below threshold" rework row). Confidence is hidden for native Axon blocks and when absent; the engine no longer stores a synthetic 0.
- **"+2 undeclared fields also sent"**: cause = the engine computed the snapshot/availability from the whole pool while the block (native blocks have no prompt filter at all) had declared nothing, so every pool field showed as extra and native handlers actually received the whole pool. Now every block receives only its declared fields (Selective) and the chips/snapshot describe that view. Provisioner v4 declares `workItemList`, PR Creator v4 declares `stepCwds, acceptanceCriteria`. Behaviour change: engine/test blocks that rely on the whole pool must set contextMode Full.
- Tests: catalog dropped reasons / missing file / error hint, confidence rules, declared-inputs-only for Selective, Full and native blocks.

### Live View for ForEach (2026-10-13)
- Canvas: the ForEach container keeps its designed size; header shows the counter ("2 of 3 · web"); the expanding lanes are replaced by a compact chip row (key + status icon, scrolls horizontally).
- Chip click -> item panel: status, timings, workspace path, branch, tokens/cost and the item's body steps, each with View context / View full output (read by nodeId + itemKey: `deliveries:stepData` takes an optional itemKey).
- A node inside a ForEach: item switcher tabs on top (running item by default, else the last); context, output, timings and tools are for that item only — nothing is merged.
- ForEach header click -> items table (status, duration, tokens/cost, View output).
- Job Details: Repo / Branch / Workspace replaced by "Delivery folder" + a "Repos" list (one row per repo from the recorded step cwds, with branch and PR link; new `delivery:repos` IPC runs git on those folders only). Explorer / VS Code / Remove workspace open the Delivery Folder.
- Timeline keeps [itemKey] labels; clicking an entry selects that node + item (item events open the item panel).
- Usage (tokens/cost) is read from `AgentOutput.usage` when a runner reports it; otherwise shown as "—".

## Session 4b — Agent Standard (2026-10-13)

### Changed
- **Fencing**: every context field is its own `<untrusted_field>` (task, shared, item, completedItems, repoCatalog, upstream outputs); forged closing tags neutralised.
- **Output validation**: declared outputSchema fields checked for presence and type, for all steps incl. native blocks, naming the field.
- **Handoff contracts**: `itemFields` on a WorkItemList output, `requiredItemFields` on a block; validator error + runtime failure of the producing step (names item + field); seed Workspace Provisioner v5; Create Block inputs; edge contract text on the Pipeline page.
- **Summary cap**: `completedItems` summaries ≤ 500 chars.
- **Snapshots**: `electron/workspace/snapshots.ts`, `refs/axon/<delivery>/<step>`; rollback on step failure/cancel, restore on retry/resume, refs deleted when the delivery ends.
- **Repo catalog for agents**: `description`/`tags` (Settings shows them + truncation warnings), opt-in `repoCatalog` field, `catalogTags`, `catalogVersion` on delivery + run summary, catalog size in Live View step details.
- **Create Block**: Agent Standard text next to the artifact step; warning for Decision + Edit/Write/Bash. **Samples** updated.

### Tests
`engine/__tests__/s4b.test.ts` (real git: coder kept / reviewer partial gone on resume, appended line once, crash-restore, non-git skipped, no refs left; missing/mistyped field; missing item field; 500 cap; repoCatalog opt-in, no URLs, catalogTags), `shared/__tests__/s4b.test.ts`, `registry/__tests__/catalog.test.ts`, security fencing/type tests. typecheck, tests (311 pass), build pass.

### Deviations / caveats
- S4 itself was still uncommitted when this session started; built on top of the working tree.
- Rollback happens when a step *fails* (and on cancel), not only on retry, so a resumable Failed/Cancelled delivery can have its refs deleted at the end: the working tree is already clean. Only an Interrupted delivery (crash/quit) keeps refs and restores them when the step reruns.
- A failure raised after a step succeeded (invalid WorkItemList, missing required item field) fails the delivery but does not roll the folder back (producers are planners).
- Snapshots use plain `git` via execFile (no credentials needed). Core `autocrlf` of the user's git applies on restore.
- Handoff contract is checked against the *direct* predecessor/successor only. No live run in real Electron; Create Block / Pipeline page / Settings UI not exercised in the browser pane.

### S4b adjustments (2026-10-13)
- **Snapshot timing**: no rollback on failure any more. The failed attempt stays in the folder, refs are kept; Resume restores the pre-step state before re-running. Refs deleted on Completed, Cancelled, workspace clear (discard) and by a boot-time cleanup of Failed/Superseded deliveries older than 14 days. Live View note on failed agent steps.
- **Provisioner pass-through**: effective itemFields = input's itemFields + workspacePath; seed Workspace Provisioner v6 (static itemFields removed). ForEach body `requiredItemFields` are validated against it, and checked at runtime on the provisioner's output.
- **Resume / Rerun**: Resume (same delivery, from the failed step/item) on Failed, Cancelled, Interrupted; Rerun (renamed Retry) asks a reason, links `rerunOf`, sets attempt number and marks the old delivery Superseded (new status); link both ways in Live View; Superseded tab on the Deliveries page. `buildStories/storyCounts` for chain metrics; run summary has `attemptNumber`/`supersededBy` (the superseded delivery's summary is re-queued).
- Tests: `engine/__tests__/rerun.test.ts` (resume from a failed top-level step with restore, Interrupted, rejected gate refused, Superseded refused, rerun linking + attempt numbers + default reason, Run again of Completed, reason validation, summary fields, 14-day cleanup, story metrics), snapshot lifetime tests in `s4b.test.ts`, pass-through validator tests.
- Caveat: Resume of a Failed delivery whose workspace was cleared fails with the existing "No workspace folder" error; Rerun is then the way forward. The Intelligence page still uses static demo data, so story metrics are exposed as helpers only.
