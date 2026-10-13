# Session v1-S4b — Agent Standard, Resume Safety, Handoff Contracts, Repo Catalog for Agents

Read first: `CLAUDE.md`, `docs/v1-decisions.md`, `docs/agent-standard.md`, `docs/v1-progress.md`.
Start in plan mode. Prerequisite: Session 4 is tested and committed.

## Goal
Every agent in a pipeline follows the AXON Agent Standard; every handoff between blocks is an
explicit, checked contract; retry/resume is safe for any agent; planners can choose repos from
the governed catalog — all before the watcher (Session 5) runs agents unattended.

## Scope

### 1. Fencing (standard rule 7)
Every context field produced by an upstream agent or by AXON from external data (`task`,
`shared`, `item`, `completedItems`, `repoCatalog`, any declared upstream output, ticket text)
is placed in the prompt as fenced untrusted data.

### 2. Output validation (rules 2–4)
Validate every declared `outputSchema` field of a successful step (present; of the declared
type when typed), not only WorkItemLists. Missing/invalid field → step fails with a clear
message naming the field.

### 3. Handoff contracts — WorkItemList item fields (maturity Q14)
- A `WorkItemList` output may declare `itemFields: string[]` — the extra per-item fields it
  provides beyond `key`, `task`, `workspacePath` (e.g. `["repo"]`).
- A block may declare `requiredItemFields: string[]` — item fields it needs from the list it
  consumes. Seed Workspace Provisioner: `["repo"]` (publish a new seed version).
- Validator: error when a consumer's `requiredItemFields` are not in its predecessor's
  `itemFields`.
- Runtime: a missing required item field fails the producing step, naming the item and field.
- Create Block form: `itemFields` input next to the WorkItemList type.
- Pipeline page: show each handoff's contract, e.g.
  "Demo Planner → Workspace Provisioner: WorkItemList (key, task, repo)".

### 4. Summary cap (rule 8)
`completedItems` summaries capped at 500 chars each; full outputs are never passed between
ForEach items.

### 5. Workspace snapshots (rule 9)
- Agents never commit. Before each agent step and each ForEach item, snapshot the step's
  working folder including uncommitted and untracked (non-ignored) files: temporary
  `GIT_INDEX_FILE`, `git add -A`, `git write-tree`, `git commit-tree`, stored under
  `refs/axon/<deliveryId>/<stepId>` — never on the branch.
- On retry/resume of that step, restore the snapshot (check out its files, remove files not in
  it) before re-running.
- Delete the delivery's `refs/axon/...` when it ends. Non-git folders (Delivery Folder) skipped.
- PR Creator makes the only commit, per repo.

### 6. Repo catalog for agents (opt-in)
- Catalog entry schema: `name, url, defaultBranch?, description? (max 200 chars), tags?
  (string[])`. Over-long descriptions are truncated on read with a warning.
- AXON-provided context field `repoCatalog`, injected **only** when a block declares it in
  `contextRequirements`. Content: compact lines, one per repo:
  `<name>: <description> [<tags>]` — **no URLs, no credentials**. Fenced as data.
- Optional node setting `catalogTags: string[]` on a block that declares `repoCatalog`: inject
  only repos with at least one of those tags.
- Record the catalog version (registry commit) used by the delivery in the run record.
- Live View step details show the injected catalog size (repos, approx. tokens).
- Settings → Registry → Repository catalog list (added in Session 4) also shows description
  and tags.

### 7. Create Block
- Show the short version of the standard (from docs/agent-standard.md) next to the artifact
  attach step.
- Warn when an Agentic block with role Decision requests Edit/Write/Bash.

### 8. Samples
Update docs/samples so every sample follows the standard:
- Planner: Prompt mode (no tools), declares `repoCatalog`; output `workItems` typed
  WorkItemList with `itemFields: ["repo"]`; returns `{ items: [{ key, task, repo }], shared }`
  choosing repos from the catalog.
- Coder: Agentic, tools Read + Edit (+ Write only if it may create files), declares
  `task, shared, item, itemKey`.

## Acceptance criteria
- Coder edits files, reviewer fails halfway and is resumed → coder's edits kept, reviewer's
  partial edit gone, PR has one commit with both.
- Item that appends a line, fails and is resumed → the line appears once.
- No `refs/axon/` left after a delivery ends.
- Missing declared output field → step fails naming the field.
- Planner without `itemFields: ["repo"]` feeding a Workspace Provisioner → validator error;
  item missing `repo` at runtime → producing step fails naming item and field.
- Pipeline page shows the handoff contract for each edge.
- Upstream agent output and `repoCatalog` appear fenced in the next agent's prompt (unit test).
- `repoCatalog` present only when declared; contains no URLs; `catalogTags` filters correctly;
  description over 200 chars truncated with a warning.
- typecheck, tests, build all pass. Update CLAUDE.md and v1-progress.md.
