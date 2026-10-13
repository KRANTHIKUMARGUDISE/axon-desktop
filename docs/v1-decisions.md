# AXON v1 — Locked Decisions

Companion to `docs/v1-review.md`. Every v1 session reads both files first.
These answer the review's D1–D12 and fix the session order. Do not reopen them inside a session —
if code contradicts a decision, stop and report.

## Decisions

| # | Decision |
|---|---|
| D1 | Branch name `axon/{userSlug}/{JIRA-KEY}-{shortId}` (shortId = 6-char base32 of deliveryId). `Delivery.localSeq` is a per-machine display counter only — never used in refs or registry paths. |
| D2 | New typed `DeliveryEvent` discriminated union in `shared/`, single IPC channel. SignalR deleted. A future API relay maps the union to PascalCase names — not built in v1. |
| D3 | Agent runs require an Anthropic Console API key. Claude subscription/OAuth login is not supported in v1; onboarding says so plainly. Key harvesting from `~/.claude.json` needs an explicit "Use this key?" confirmation. |
| D4 | Prompt-mode blocks stay (add timeout + abort + bounded 429 retry). Codex hidden in UI (enum kept). |
| D5 | Confidence is optional, display-only. Delete `confidenceThreshold` and `defaultAutonomyLevel` settings and UI. Pausing only via Control/HumanGate nodes. |
| D6 | Intelligence page hidden behind a feature flag in v1 (static data must not be demoed as real). |
| D7 | Default `workspaceRoot`: Windows `%LOCALAPPDATA%\AXON\work`, macOS `~/Library/Application Support/AXON/work`. Never Documents/OneDrive. |
| D8 | Jira Cloud only. Auth = email + API token (Basic). Needs label edit + comment permissions; onboarding checks them. |
| D9 | **Single branch, path = collection.** Everything lives on `main`; each top-level folder maps 1:1 to a future DB collection (`org/pipelines` → `pipelines` where `scope=Org`, `users/*/runs` → `runs`, etc.). AXON writes directly only under the user's own `users/{email}/`; changes to `org/`, `teams/`, `catalog/` are opened as PRs by AXON (soft governance enforced by the app). Hard enforcement (server-side permissions) arrives with the DB/API store; it isn't a v1 concern. |
| D10 | `activeMachine` takeover is manual ("Run watcher on this machine"), with a visible warning when the other machine's heartbeat is stale (> 15 min). Never automatic. |
| D11 | **Repo `.claude/` is the agent's capability layer — keep it.** Agents run with `settingSources: ['project']` and `cwd` = the repo worktree, so each repo's CLAUDE.md, skills, hooks and MCP config (e.g. CDF) load as the team intended. For multi-repo work, AXON (orchestration) invokes the agent once per repo with that repo as `cwd` rather than relying on one agent hopping folders. Guardrails that stay with AXON: only catalog repos are provisioned; AXON's `tools` ceiling and PreToolUse path check apply regardless of repo settings (verify repo settings cannot widen them). |
| D13 | **Versioning is app-managed, not git.** Pipelines and Local blocks each have `{id, version:int, status: Draft \| Published \| Deprecated, versionLabel?, changeNote?}`. Stored one file per version: `…/pipelines/{pipelineId}/v{n}.yaml` (+ `draft.yaml`). Published versions are immutable; editing one creates the next draft; Publish increments `version`. Pipeline nodes pin `{blockId, blockVersion}`. Deliveries record `{pipelineId, pipelineVersion}` + snapshot. Delivery Rules pin an explicit pipeline version; the UI shows "newer version available". "Duplicate to…" records `derivedFrom: {pipelineId, version}`. Git history is transport/audit only — never the version source. Maps 1:1 to a DB `(id, version)` unique index, matching the existing `(artifactName, version)` index on blocks. |
| D14 | **Multi-repo = orchestrator fan-out via ForEach.** A planner block outputs a `WorkItemList` (D16) whose items name a repo, plus `shared` (the cross-repo contract). AXON provisions those repos, then a **ForEach** (with `repoField` set) runs its body once per item, with `cwd` = that item's repo worktree, sequentially in v1. Agents never spawn per-repo agents themselves. **ForEach is a pipeline node type that exists only in the Pipeline Creator and the executor — it is not a block.** Blocks are unchanged (no new field); any block can be placed inside a ForEach or used standalone. A block inside a ForEach receives per-item fields only if it declares them in its own `contextRequirements`. |
| D12 | **No back-edge loops in v1.** Pipelines stay acyclic; the only repetition is ForEach. A body is a straight chain, e.g. coding agent → review agent. Retry-until-green belongs inside the agent (agent capability). Session 6 is deferred post-v1. |
| D16 | **ForEach contract: Agent/Block → WorkItemList → ForEach → Agent.** A ForEach iterates over the `WorkItemList` returned by its single direct predecessor — no "Iterate over" picker. A block declares at most one `WorkItemList` output. List shape: `{ items: [{ key, task, workspacePath? }], shared? }`. `key` (unique, rerun-stable) and `task` (string handed to the body) are required; `workspacePath` is optional; extra fields pass through untouched. Items run sequentially in list order — the producing agent orders the list (no `dependsOn` in v1; it returns with parallel execution, DS3). Each body node receives `task`, `shared`, `item`, `itemKey`, `completedItems` if it declares them. The Workspace Provisioner accepts a WorkItemList whose items name a catalog `repo`, and returns the same items with `workspacePath` set to each repo's worktree. ForEach settings: Name; Advanced: max items, if-empty (default Fail). |
| D17 | **Workspace naming and where agents run.** *Workspace Root* (Settings) holds everything AXON creates. Each delivery gets a *Delivery Folder* `{root}/deliveries/{deliveryId}/` at start; any node without a workspace runs there (e.g. a planner). Repo clones are cached in `{root}/mirrors/`. An item's *workspacePath* is where its body runs, whoever set it (Workspace Provisioner or an agent). **workspacePath is only honoured if it resolves inside the Workspace Root**; anything else fails the item. Engineers who always work on fixed repos clone them under the Workspace Root (e.g. `{root}/repos/<name>`) and have their agents return that path. AXON uses such a folder directly, but only if its git tree is clean at start, and locks it so only one delivery uses it at a time. No separate "Local Folders" setting. |
| D18 | **New Delivery standard (manual and watcher).** Fields: Ticket ID (required), Pipeline (required), **Workspace path (optional, one folder)**, and an Advanced section with ad-hoc JSON inputs. No repository URL list. If a Workspace path is given, it must be a git repo folder inside the Workspace Root, with a clean tree; it is locked for the delivery and becomes the default `workspacePath` for every node that has no item-level `workspacePath`. AXON creates the delivery branch there and switches back to the original branch when the delivery ends. If no path is given, nodes run in the Delivery Folder, and multi-repo work comes from agents returning `workspacePath` per item (or items naming catalog repos for the Workspace Provisioner). A Delivery Rule (watcher) can set the same optional default Workspace path. |
| D19 | **Block contract lives in the artifact.** A block's inputs and outputs are declared in the artifact's frontmatter (`axon:` key with `inputs` and `outputs`), versioned with the prompt that fulfils them. `item.<field>` in inputs replaces `requiredItemFields`; a list output's `itemFields` replaces the separate checkbox. Only two output kinds: text (default) and list (WorkItemList, max one). The Create/Edit Block form shows the contract read-only when the artifact declares it; otherwise a minimal editor with autocomplete (no predefined tag rows). AXON appends the output contract to the agent prompt automatically. |
| D15 | **AXON does not create Jira sub-tasks in v1.** Rerun reconciliation (reuse, update, close what's no longer needed) is non-trivial and deferred. Teams that want sub-tasks can build it into their own pipelines, e.g. a spec pipeline whose agent creates sub-tasks, and a delivery pipeline whose planner reads them and outputs the array a ForEach iterates. Reconciling sub-tasks on rerun is then the owning block's responsibility. A native AXON sub-task block can be revisited after v1. |

## Session order

"Session 1–6" are **build sessions**, not AI maturity stages (S1–S4 in the maturity framework).

| Build session | File | Demo-critical |
|---|---|---|
| Session 1 Local-first core | `session-v1-s1-local-core.md` | Yes |
| Session 2 Security hardening | `session-v1-s2-security.md` | Yes (before watcher) |
| Session 3 Registry + identity + sync | `session-v1-s3-registry.md` | Yes |
| Session 4 Workspace + PR blocks | `session-v1-s4-workspace-pr.md` | Yes |
| Session 4b Agent standard + resume safety | `session-v1-s4b-agent-standard.md` | Yes (before watcher) |
| Session 5 Jira watcher | `session-v1-s5-watcher.md` | Yes |
| Session 5b Action blocks + staged workflows | `session-v1-s5b-actions.md` | Yes |
| Session 6 Conditional edges + verify loop | `session-v1-s6-loops.md` | Deferred post-v1 (D12) |

Session 2 must land before Session 5: the watcher must never run unattended agents without
Session 2's containment.

## Orchestration vs agent capability (scope boundary)

| Layer | Owner | Examples |
|---|---|---|
| Agent capability | Teams (repo `.claude/`, CDF, skills) | Coding in a repo, conventions, writing tests, inner self-verify loop, repo detection logic |
| Orchestration | AXON | Triggers, sequencing, contracts, workspace provisioning, ForEach fan-out, gates, audit, run records |
| Platform prerequisites | Platform/process | Structured tickets, ≥80% coverage in CI, observability |

AXON's own unit tests (vitest) are about AXON's code quality, not the maturity coverage gate.

## Rules for every session

- Read `CLAUDE.md`, `docs/v1-review.md`, `docs/v1-decisions.md` first.
- Keep settled principles: only Control nodes pause; agents return success|partial|failed;
  contextRequirements names are the contract; Axon blocks seeded + immutable; "Skill" not "ClaudeSkill".
- Tests ship in the same session as the code (vitest). No session ends with failing tests or type errors.
- End of session: update `CLAUDE.md` (schema, conventions, what changed), append a short entry to
  `docs/v1-progress.md` (done / deferred / surprises), list any decision you had to assume.
