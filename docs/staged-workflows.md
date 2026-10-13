# Staged workflows: spec → code → review

A staged workflow is several small pipelines that hand a ticket from one stage to the next, possibly on different
engineers' machines. Nothing is shared through AXON-local state: stages hand over through **Jira** (description, comments,
labels, status) and **GitHub** (branches, pull requests).

## The idea in one paragraph

- A **rule** only decides *when a pipeline starts* (project, ready label or status, pinned pipeline version).
- The **pipeline** decides *what happens*, including what changes in Jira and GitHub, using the action blocks
  (**Jira Update**, **PR Update**, **Find PRs**, **Ticket Fetcher**) placed where you want them: before or after a Human Gate,
  after PR Creator, and so on.
- AXON's own bookkeeping (`axon-running`, the issue properties `axon.runs` / `axon.comments`) is not editable and never
  blocks the next stage: run records are kept **per rule**, so a finished spec stage does not stop the coding stage.

## Example: three stages

| Stage | Rule triggers on | Pipeline | Hands over by |
|---|---|---|---|
| **Spec** | label `spec-me` | Ticket Fetcher → Spec Agent → **Jira Update** (comment `{{output.spec}}`, add `code-me`) | the spec as a Jira comment + the `code-me` label |
| **Code** | label `code-me` | Ticket Fetcher → Planner → Workspace Provisioner → ForEach(Coder) → PR Creator → **Jira Update** (status *In Review*, add `review-me`) → | the pull request on GitHub (branch contains the ticket key) |
| **Review** | label `review-me` | **Find PRs** → Workspace Provisioner → ForEach(Reviewer) → **PR Update** (label, reviewers) → **Jira Update** (comment) | the review on the PR and in Jira |

Notes:

- The coding stage's planner sees the spec because **Ticket Fetcher** reads the ticket's comments (the last 20, with author
  and date) and returns them as data. No AXON-local state is involved, so the spec can have been written on another machine.
- The review stage on another machine needs no local history: **Find PRs** looks for open pull requests in the catalog
  repositories whose branch contains the ticket key; Workspace Provisioner then checks that branch out (items with a
  `branch` field), and PR Creator on that branch pushes and **reuses the existing PR**.
- **Reassign to the reviewer, then add the review label.** Rules only pick up tickets assigned to the engineer who runs
  them (`assignee = currentUser()`). To hand the review to a colleague: reassign the ticket to them (a Jira Update with
  *Assign to the reporter* or a person field, or by hand), then add `review-me`. Their machine's rule picks it up.
- The Automation page shows the chain: each rule's "Triggers on", what its pipeline sets in Jira ("adds code-me, status In
  Review") and "after X / then Y". A loop of rules with no Human Gate in it shows a warning.

## Rules of thumb

- **Status-based rules** run once each time the ticket *enters* the status. The run record in `axon.runs` stores the status
  the run started from; the rule skips the ticket until it enters that status again. Tickets that already carry the old
  `axon-done` / `axon-failed` labels (from before S5b) and have no run record are left alone.
- **Label-based rules**: the ready label is consumed when AXON claims the ticket; adding it again later runs the pipeline
  again (a Rerun).
- **Cancel** removes `axon-running`, records the cancel in `axon.runs` and does not put the ready label back. Add the label
  again to run it again.
- **Nothing is applied twice.** Labels and status changes check the current state first; comments carry a marker kept in the
  `axon.comments` issue property (the marker survives a Resume and a Rerun: it is built from the first attempt's delivery id,
  the node and the rendered text). A changed text posts again; the same text never does.
- **Pre-flight.** When a delivery starts, before any agent runs, AXON checks every configured action: Jira permissions
  (browse, edit, comment, plus transition/assign when used), that the first *Move ticket to status* is reachable from the
  ticket's current status, and that a GitHub token works when PR actions are present. A problem stops the start and costs
  no tokens; the delivery stays Pending.
- **On failure.** The pipeline's *On failure* section lists Jira Update / PR Update actions that run, in order, only when a
  delivery fails (a rejected Human Gate counts); tick *Also run when the delivery is cancelled* to include Cancel. They use
  `{{failureReason}}`, `{{ticketKey}}`, `{{prUrls}}`, `{{deliveryLink}}`. They never change the delivery's status; what they
  did is recorded on the delivery.
- **A Jira Update after a Human Gate runs only after approval**: it is an ordinary node, so a paused delivery has not reached
  it yet.

## Template fields

`{{output.<field>}}` (a field returned by a block *before* the action; the Creator and the validator reject others),
`{{prUrls}}`, `{{deliveryLink}}`, `{{failureReason}}`, `{{ticketKey}}`. Comments longer than 20,000 characters are attached
to the ticket as a file and the comment says so.

## Cost of Prompt steps

Prompt steps report tokens only. Settings → Preferences → **Model prices** takes dollars per million tokens per model; with a
price the step shows an estimated cost (marked "≈" in the Live View). Agentic steps keep the cost the Agent SDK reports.
