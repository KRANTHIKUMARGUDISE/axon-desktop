# Session v1-S5b — Pipeline Action Blocks and Staged Workflows

Read first: `CLAUDE.md`, `docs/v1-decisions.md`, `docs/agent-standard.md`, `docs/v1-progress.md`.
Start in plan mode. Prerequisite: Session 5 committed; live containment tests and the real-Jira
identity check from "Pending verification" have passed.

## Goal
Teams compose their own staged workflows (e.g. spec → code → review, possibly on different
engineers' machines) by placing AXON action blocks in their pipelines. Rules only decide when a
pipeline starts; pipelines decide what changes in Jira and GitHub.

## Principles
- **Rule = trigger only.** Project, ready label/status, pinned pipeline version, default
  Workspace path, enabled, priority.
- **Pipeline = what happens**, including outside actions, placed where the team wants them
  (before/after a Human Gate, after PR Creator, …).
- **AXON system markers = bookkeeping**, not editable, never in the way of the next stage.
- Action blocks are AXON native code: no AI, no tokens, engineer's own credentials, never
  available to agents.
- Stages hand over through Jira (description, comments) and GitHub (branches, PRs) — never
  through AXON-local state — so the next stage can run on another engineer's machine.

## Scope

### 1. System markers per rule (fixes a staged-workflow blocker)
- Today status-based rules skip tickets labelled `axon-running`/`axon-done`/`axon-failed`.
  With staged workflows, `axon-done` from the spec stage would block the coding stage.
- Replace global done/failed labels with a Jira issue property `axon.runs`:
  `{ <ruleId>: { deliveryId, status, at, statusAtStart } }`. A rule skips a ticket only if it
  already has a run for this rule that started from the ticket's current status/label state.
- Keep the `axon-running` label (visible "AXON is working on this"), removed on finish.
- Idempotency markers for AXON comments move to issue properties too
  (`axon.comments: [marker…]`), so no grey marker text in comments.
- Rule option "Post AXON outcome comment" (default on): one comment per outcome with links.

### 2. Native block "Jira Update" (role IO)
Node config: `transition` (status name), `addLabels`, `removeLabels`, `assign`
(user | reporter | user field), `comment` template with `{{output.<field>}}`, `{{prUrls}}`,
`{{deliveryLink}}`, `{{failureReason}}`, `{{ticketKey}}`. Idempotent: label no-ops, transition
skipped if already in status, comments deduplicated by marker. Long content posted as an
attachment.

### 3. Native block "PR Update" (role IO)
Node config: `addLabels`, `reviewers`, `readyForReview`, `comment` template. Operates on PRs
from PR Creator or Find PRs output. Idempotent.

### 4. Native block "Find PRs" (role IO)
For the ticket key, find open PRs in catalog repos whose branch contains the key. Output a
WorkItemList `{ key: repo, task, repo, branch, prUrl }`, `itemFields: [repo, branch, prUrl]`.
Workspace Provisioner checks out `branch` when an item has it; PR Creator on an existing
branch pushes and reuses the existing PR.

### 5. Ticket Fetcher (still a stub — implement)
Summary, description (ADF → markdown), acceptance criteria if present, labels, status, last 20
comments (author, date, text), all fenced as data.

### 6. "On failure" actions (pipeline setting)
Ordered list of Jira Update / PR Update configs that run only when the delivery fails, after
the failure is recorded (e.g. label `code-failed`, comment with `{{failureReason}}`). Shown as a
separate section in the Creator. Also run once on Cancel only if the user ticks it.

### 7. Pre-flight
At delivery start, before any agent runs: validate every configured action — transitions
reachable from the ticket's current status, labels allowed, permissions (Jira and GitHub).
Fail with a clear message and no tokens spent.

### 8. Creator, Live View, Rules UI
- Creator: action blocks in the palette under "Actions"; node panels for their config with
  template field hints; validator checks templates reference declared outputs.
- Live View: each action's effect in plain words ("Moved PAY-12 to In Review; added
  pr-ready"); counted as built-in steps.
- Rules UI: show which labels/statuses each rule triggers on, and (from pipelines) which
  labels/statuses its pipeline sets — so chains spec → code → review are visible; warn on a
  chain cycle with no Human Gate.

### 8b. Automation page (replaces the "Jira watcher" page)
- Nav item and page renamed **Automation**. Subtitle: "Rules start a pipeline when something
  happens in Jira." Rules are the main content; the machine block becomes a status strip.
- Rule schema gets `source: 'jira'` (only value in v1) so a future GitHub PR source is an
  additive change. Do not show unbuilt sources in the UI.
- Status strip, one line:
  - This machine is active: "Rules run on this machine (KGUDISE)" + "Pause all" toggle.
  - Another machine is active: "Rules run on LAPTOP-2 (last seen 3 min ago)" +
    "Run rules on this machine" (stale warning per D10).
  - No active machine: "Rules aren't running on any machine" + "Run rules on this machine".
  - No rules: strip shows "Add a rule to start" and the machine button is disabled.
- **Pause all** is the master switch (stored on the profile, syncs); it is separate from
  which machine is active. Paused → no polling anywhere; banner on the page.
- Remove the global "Poll now". Each rule row gets "Check now" (runs that rule's query once)
  and shows last checked time, last match and next check.
- "Write-backs waiting for Jira" shown only when > 0, as a warning with "Retry now".

### 9. Migration from Session 5 write-back
- Existing rules keep working: their fixed write-back becomes the rule's "Post AXON outcome
  comment" option; `axon-done`/`axon-failed` labels stop being added (tickets that already have
  them are not touched).
- Cancel of a watcher delivery: remove `axon-running` and record the cancel in `axon.runs`; do
  not re-add the ready label (the engineer re-labels to rerun). Show this in the cancel dialog.
- Remove the grey hidden-marker text from new comments (markers now live in issue properties).

### 10. Smaller items from Session 5 review
- Cost for Prompt steps: model price table in Settings (per model, per million tokens) so
  Prompt steps get a cost; Agentic steps keep SDK-reported cost.
- Docs: staged workflow guide (spec → code → review on different machines; reassign the
  ticket to the reviewer, then add the review label).

## Acceptance criteria (mock Jira + local bare repos)
- Spec pipeline with Jira Update (comment `{{output.spec}}`, add `spec-ready`) → coding rule
  picks the ticket up; its planner sees the spec via Ticket Fetcher comments.
- Coding stage is not blocked by the spec stage's markers; the same rule doesn't re-run on
  the same state.
- Review rule on another machine profile with no local history: Find PRs → Workspace
  Provisioner checks out the PR branch → review agent → PR Update + Jira Update.
- Resume/Rerun never double-applies actions.
- Pre-flight failure (unreachable transition) stops before any agent.
- On-failure actions run only on failure.
- Jira Update after a Human Gate runs only after approval.
- Automation page: no rules → machine button disabled; Pause all stops polling on every
  machine; per-rule "Check now" polls only that rule; existing rules load with `source: jira`.
- typecheck, tests, build pass; CLAUDE.md and v1-progress.md updated.

## Out of scope
Conditional edges/conditional actions (post-v1), webhooks, Jira Server/DC.
