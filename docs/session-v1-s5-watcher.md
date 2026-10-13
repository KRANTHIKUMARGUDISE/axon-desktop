# Session v1-S5 — Jira Watcher, Gates for S3, and Run Metrics

Read first: `CLAUDE.md`, `docs/v1-decisions.md` (D8, D10, D16–D18), `docs/agent-standard.md`,
`docs/v1-progress.md`. Start in plan mode. Prerequisites: Session 2 and Session 4b are merged,
and the live containment tests listed under "Pending verification" in v1-progress.md have passed.

## Goal
An engineer opts in; when a ticket assigned to them becomes ready, AXON runs the chosen pipeline on
their active machine and reports back in Jira. Every run records the evidence needed for the S3
maturity questions (trigger, interventions, gates, failures).

## Part A — Jira watcher

1. **`DeliveryRule`** stored in `users/{email}/rules/`:
   - Fields: `id, name, enabled (default false), jiraProjectKey, readyLabel (default axon-ready)
     | readyStatus, pipelineId, pipelineVersion (pinned), defaultWorkspacePath? (D18: optional,
     must be inside the Workspace Root), pollIntervalMinutes (min 2)`.
   - Rules UI (own page or Settings), showing "newer pipeline version available".
2. **Jira permissions check** in Settings → Jira and when enabling a rule: can read the project,
   edit labels and add comments. Clear message per missing permission.
3. **Poller** in main, only on `profile.activeMachine`:
   - JQL `project = X AND assignee = currentUser() AND (labels = <readyLabel> | status = …)
     AND updated >= cursor`.
   - Cursor overlaps by 1 min, with a dedupe set. Jitter; honour 429 and Retry-After; paginate.
4. **Claim:** a single `PUT /issue` removes the ready label and adds `axon-running`, then creates
   the delivery (same path as Manual New Delivery: ticketKey + pinned pipeline + optional
   default Workspace path). Dedupe key `jiraKey + ruleId + rerunSeq`. If the delivery can't be
   created, roll the label back.
5. **Write-back:**
   - Completed → `axon-done` + one comment with PR links.
   - Failed → `axon-failed` + one comment with the failure category and reason (see Part C).
   - Comments carry a hidden marker `axon:{deliveryId}:{event}`; search for it before posting
     (idempotent). ADF comment format.
6. **Rerun:** re-adding the ready label → new delivery with `rerunOf` and `rerunReason`
   (default `RequirementUpdated`; engineer can change it in the UI).
7. **Active machine (D10):** "Run watcher on this machine" sets `activeMachine {id, heartbeatAt}`
   in `profile.yaml`; heartbeat syncs with the registry; other machines see a stale-heartbeat
   warning; takeover is manual only.
8. **Boot reconcile:** scan this user's `axon-running` tickets, match them to local deliveries;
   for an orphan offer "Resume" or "Release" (back to the ready label).
9. **Concurrency:** global cap of 1 running delivery by default (configurable); others queue as
   Pending.
10. **Notifications:** OS notification on gate reached, completed and failed; click opens the
    Live View. Set `app.setAppUserModelId`.

## Part B — Human Gate for S3 (maturity Q7, Q13, Q15)

11. **Gate reason (Q15):** Human Gate node gets a required "Why a human decides here" text and an
    optional "What to check" checklist. Validator: gate without a reason is an error. The gate
    card shows both to the reviewer. The pipeline page lists "Human decisions in this pipeline"
    (all gate reasons).
12. **Gate mode (Q13):** `Pause` (default, current behaviour) or `Notify only` — records that a
    review is due, sends the notification, does not pause; the human reviews the PR instead.
    Mode is part of the published pipeline version (no per-run bypass).
13. **Gate review view (Q7):** the gate card shows, per repo: files changed, test results if a
    test step ran, and each preceding agent's summary — so the reviewer checks outcomes, not
    lines. Approve/Reject unchanged (reject needs a comment).

## Part C — Run record and metrics (maturity Q9, Q11, Q13)

14. **Failure classification (Q9):** every failed delivery records
    `failureCategory: Requirement | Agent | Platform`:
    - Requirement — a readiness/requirement block failed, or the agent output declared the
      requirement unclear.
    - Agent — an agent step failed, produced invalid output, or the output was rejected at a gate.
    - Platform — AXON/infrastructure error (git, network, crash).
    Shown in Live View, the Jira failure comment and the run summary.
15. **Rerun link (Q9):** already built in Session 4b (Resume vs Rerun, Superseded, attempt
    numbers, story chains). Session 5 only adds: a watcher-triggered rerun (ready label re-added)
    uses the same Rerun path with reason `RequirementUpdated`.
15b. **Automatic retry for Platform failures only:** git push/fetch, Jira/GitHub HTTP and
    network errors are retried up to 2 times with backoff inside the same step before the step
    fails. Agent and Requirement failures never auto-retry. Each retry is logged on the step.
16. **Interventions (Q13), defined as:**
    - Not an intervention: the trigger (ready label or manual start of a watcher-eligible
      ticket is still recorded as `trigger`), and approving a gate unchanged.
    - Intervention: gate rejection, rerun after failure, a manual edit in the workspace before
      approving (detected as changes between the gate's snapshot and approval), manual start of
      a delivery the watcher could have run.
17. **Run summary** (registry, whitelisted) adds: `trigger: Manual | Watcher`, `ruleId`,
    `gateCount`, `gatesPaused`, `interventions`, `aiSteps`, `builtInSteps`, `failureCategory`,
    `rerunReason`, `totalTokens`, `costUsd`.
18. **Live View:** show total tokens/cost for the delivery, and "AI steps vs built-in steps".
19. **Autonomy metric:** `% of deliveries completed with zero interventions` — computed from run
    summaries; shown on the Deliveries page header (per user) for now.

## Acceptance criteria (mock Jira server; local bare repos)
- Ticket labelled → exactly one delivery, also across a restart mid-poll.
- Ticket assigned to someone else → ignored. Watcher disabled or not the active machine → no polling.
- Completed and failed paths each produce one label + exactly one comment, even after retries;
  the failure comment names the category.
- Re-label → rerun linked to the previous delivery with a reason.
- Missing Jira permission → clear message, rule can't be enabled.
- Gate without a reason → validator error; Notify-only gate does not pause and is recorded.
- Gate card shows files changed per repo and agent summaries.
- Run summary contains the new fields; interventions counted per the definition (unit tests for
  each intervention type).
- typecheck, tests, build all pass.

## Out of scope
Webhooks, Jira Server/DC, transitions, auto-takeover, PR outcome tracking (Q8/Q10, post-v1),
team-level maturity scorecard (post-v1).
