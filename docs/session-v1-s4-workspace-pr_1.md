# Session v1-S4 — Workspace Provisioning + PR Creation as Explicit Blocks

Read first: `CLAUDE.md`, `docs/v1-review.md` (A4, C2, C4, D4, D8, D13–D14), `docs/v1-decisions.md`,
`docs/v1-progress.md`. Start in plan mode.

## Goal
No hidden git in the executor. Workspaces and PRs come only from explicit Axon-native pipeline
nodes, and both work across multiple repos.

## Scope
1. **Native block registry** keyed by `artifactName`, each entry with zod input/output schemas.
   `human-gate` moves into it.
2. **`workspace-provisioner`** (role IO, seeded):
   - contextRequirements `["repositories"]` (`[{url, branch?}]`).
   - outputSchema `["workspacePath", "provisionedRepos"]` (`[{url, branch, worktreePath}]`).
   - Rejects any repo not in `catalog/repositories.yaml`.
   - Per-repo bare mirror in `{workspaceRoot}/mirrors/` with a per-repo lock; `git worktree add`
     per delivery at `{workspaceRoot}/deliveries/{deliveryId}/{repoName}`.
   - Detects the default branch (no hardcoded main/master).
   - Branch per D1.
   - Validates the ticket key `^[A-Z][A-Z0-9]+-\d+$`.
   - Long-path safe on Windows (`core.longpaths true`).
3. **`pr-creator`** (role Execution, seeded): for each provisioned repo with changes:
   - Stage explicit paths only (no AXON files).
   - Commit, then push with credentials via env.
   - Find-or-create the PR (search by head branch first).
   - Provider parsed from the URL host (GitHub only in v1; others fail with a clear message).
   - PR body templated from ticket key/title + acceptance criteria + links to sibling PRs.
   - Output `prUrls` (`[{repo, url}]`).
4. **Delete the PR tail in `runStepLoop`.** A delivery completes only when its terminal node
   succeeds. Existing pipelines get no migration; document adding a `pr-creator` node.
5. **Pipeline validator** (shared, used by the Creator and at run start):
   - Any Agentic block or `pr-creator` must be downstream of `workspace-provisioner`.
   - Agentic blocks must declare contextRequirements, or the run fails.
   - Add `BuildingBlock.contextMode: Selective | Full`, default Selective (review B1). `Full`
     must be chosen explicitly.
6. **Manual Delivery** screen: ticket key + pipeline + repos picked from the catalog. Repos
   pre-fill `repositories` context; there is no other provisioning path.
7. **ForEach** (D14, D12) — a pipeline node type, not a block. Blocks are not changed.
   - **Pipeline schema (`shared/`):** a pipeline node is either a block node
     (`type: 'block'`, `blockId`, `blockVersion`) or a ForEach node
     (`type: 'forEach'`, `over`, `keyField` (default `key`), `repoField?`,
     `order: listOrder | dependsOn` (default listOrder), `maxItems`, `onEmpty`, `size`).
     Any node may carry `parentId` pointing at a ForEach. Saved as one flat node list.
   - **Pipeline Creator:** ForEach lives in a "Flow" section of the palette, never in Building
     Blocks. It renders as a resizable container (XYFlow sub-flow: children get `parentId` +
     `extent: 'parent'`, positions relative to the container; parent precedes children in the
     array). Drop a block inside → it becomes a child; drag it out → `parentId` removed and
     position converted back to absolute (`getIntersectingNodes` in `onNodeDragStop`).
     `isValidConnection` only allows edges between nodes with the same `parentId`, so edges never
     cross the border; the container's own handles connect it to the outside. The "Iterate over"
     picker lists only array fields from upstream `outputSchema`s.
   - **Body shape:** a straight acyclic chain, e.g. coding agent → review agent. Entry = the only
     child with no incoming child edge; exit = the only child with no outgoing child edge. No
     back-edges anywhere in v1.
   - **WorkItemList contract (D16)** — minimal on purpose:
     `{ items: [ { key, ...anything } ], shared?: any }`.
     The only required field is a unique, rerun-stable key per item (the field named by
     `keyField`, default `key`). AXON does not interpret the rest of the item; the **whole item
     object** is passed to the body. Validated with zod at runtime: missing/duplicate keys or an
     empty list (with `onEmpty: fail`) fail the upstream step with a clear message before any
     item runs. `maxItems` (default 10) caps cost.
   - **Optional, only when the pipeline uses them:**
     - `repoField` (e.g. `repo`): set it when a `workspace-provisioner` precedes the ForEach.
       AXON maps `item[repoField]` to that repo's worktree and runs the item with `cwd` there, so
       the repo's `.claude/` loads. Not set → `cwd` = workspace root (e.g. epic → stories).
     - `order: dependsOn`: AXON reads `item.dependsOn` (array of keys) and runs items in
       dependency order; a cycle or unknown key fails before any item runs. Default
       `listOrder` ignores `dependsOn` and runs items as listed.
   - **Executor:** body = nodes whose `parentId` is the ForEach. For each item, in `order`, run
     entry → exit, then follow the ForEach's outgoing edge.
   - **Per-item context**, available to every node in the body that declares it in
     `contextRequirements`: `item` (the whole object), `itemKey`, `shared` (passed unchanged to
     every item), `completedItems` (key + status + summary of earlier items), and `repoPath`
     when `repoField` is set. Later body nodes also receive earlier body nodes' outputs for the
     same item, as in any pipeline.
   - **Typed outputSchema:** `outputSchema` entries may be `{ name, type }` objects in addition to
     plain strings (plain strings stay valid, untyped). A field typed `WorkItemList` is what the
     "Iterate over" picker offers.
   - **ForEach output:** `itemResults: [{ key, status, summary, result }]`, available to
     downstream nodes (Human Gate review, PR Creator, a summary agent).
   - **Step identity** `(nodeId, itemKey)`; the snapshot records items and their order at start,
     so resume is deterministic. One item fails → stop and fail the delivery; Resume restarts
     at the failed item, keeping completed ones.
   - **Live View:** the ForEach renders as a container with one lane per item showing item key,
     state (pending / running / done / failed), its own step statuses, timings and outputs,
     plus a header counter ("2 of 4 · refunds-api"). The current item is highlighted; finished
     lanes collapse to a one-line summary. The Deliveries list shows the same counter.
     Events: add `ItemStarted` / `ItemCompleted` / `ItemFailed` to the `DeliveryEvent` union.
   - **Validator:** `over` must be a `WorkItemList` field in an upstream `outputSchema` (an untyped
     field is allowed with a warning); the body must have exactly one entry and one exit and no
     cycles; `repoField` set → a `workspace-provisioner` must precede the ForEach; `pr-creator`
     and Human Gate must sit outside it; a block that requires a per-item field (`item`,
     `repoPath`…) outside any ForEach is an error.
   - **Samples for the demo** (team-supplied in real use): a Local planner skill returning
     `{ items: [{ key, repo, task, dependsOn }], shared }`, and a Create Block hint: "To feed a
     ForEach, return `{ items: [{ key, … }] }`." `workspace-provisioner` also accepts a
     `WorkItemList` plus the ForEach's `repoField` and provisions the distinct repo values.
8. **Cleanup:** "Remove workspace" per finished delivery (worktree prune) and a size display.
   Mirrors are kept.

## Acceptance criteria
- 2-repo delivery → 2 linked PRs, delivery Completed.
- Planner → provisioner → ForEach(coding agent → review agent) → Human Gate → pr-creator:
  each item runs in its own repo cwd (verify via a per-repo `CLAUDE.md` marker), in dependsOn
  order. Failure on item 2 → Resume restarts item 2 only.
- Live View shows the ForEach counter and per-item lanes updating live; reopening the delivery
  after an app restart shows the same lanes from stored steps.
- Creator: a block dropped into the container becomes a child; dragged out it detaches; an edge
  from inside to outside is refused; saving and reopening preserves the layout.
- The same block used standalone in one pipeline and inside a ForEach in another runs correctly
  in both.
- A non-repo list (epic analyzer → 3 story items → ForEach(story-creator)) runs 3 items at the
  workspace root with no provisioner.
- A malformed list (missing or duplicate key; with `order: dependsOn`, an unknown key or a cycle)
  fails the upstream step with a clear message before any item runs. `keyField: repo` makes a
  list without a `key` field work. Every body node receives the full item object and `shared`.
- Push failure → delivery Failed with a reason (never Completed).
- Non-catalog repo → step fails with a clear error.
- Rerunning the same ticket → new worktree and branch, no collision.
- Ticket key `../x` rejected.
- Second delivery on the same repo reuses the mirror (fetch only).
- Validator blocks a pipeline with an Agentic block before the provisioner.
- Windows path with spaces + long path OK.
- Git tests use local bare repos; the PR API is mocked.
- typecheck, tests, build all pass.

## Out of scope
Agent-based repo detection (any upstream block that outputs `repositories` already works),
non-GitHub providers, shallow-clone tuning, back-edge loops (D12), parallel items, nested
ForEach, AXON-created Jira sub-tasks (D15).
