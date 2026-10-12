# Session v1-S5 — Jira Watcher (Delivery Rules)

Read first: `CLAUDE.md`, `docs/v1-review.md` (C5, D11–D12, D17–D18), `docs/v1-decisions.md`
(D8, D10), `docs/v1-progress.md`. Start in plan mode. Prerequisite: S2 is merged.

## Goal
An engineer opts in; when a ticket assigned to them becomes ready, AXON runs the chosen pipeline on
their active machine and reports back in Jira.

## Scope
1. **`DeliveryRule`** stored in `users/{email}/rules/`:
   - Fields: `id, name, enabled (default false), jiraProjectKey, readyLabel (default axon-ready)
     | readyStatus, pipelineId, defaultRepositories? (catalog refs), pollIntervalMinutes (min 2)`.
   - Rules UI in Settings (or its own page).
2. **Poller** in main, only on `profile.activeMachine`:
   - JQL `project = X AND assignee = currentUser() AND (labels = axon-ready | status = …)
     AND updated >= cursor`.
   - Cursor overlaps by 1 min, with a dedupe set.
   - Jitter; honour 429 and Retry-After; paginate.
3. **Claim:** a single `PUT /issue` removes `axon-ready` and adds `axon-running`, then creates the
   delivery. Dedupe key `jiraKey + ruleId + rerunSeq`. If the delivery can't be created, roll the
   label back.
4. **Write-back:**
   - Completed → `axon-done` + one comment with PR links.
   - Failed → `axon-failed` + one comment with the reason (RRA/RCA issues, or step error).
   - Comments carry a hidden marker `axon:{deliveryId}:{event}`; search for it before posting
     (idempotent).
   - Use ADF comment format.
5. **Rerun:** re-adding `axon-ready` → new delivery with `rerunOf` and `rerunReason`. If not
   supplied, default `RequirementUpdated`; the engineer can change it in the UI.
6. **Active machine (D10):**
   - "Run watcher on this machine" sets `activeMachine {id, heartbeatAt}` in `profile.yaml`.
   - Heartbeat syncs with the registry.
   - Another machine sees a stale-heartbeat warning; takeover is manual only.
7. **Boot reconcile:** scan this user's `axon-running` tickets and match them to local deliveries.
   For an orphan, offer "Resume" or "Release" (sets back to `axon-ready`).
8. **Concurrency:** global cap of 1 running delivery by default (configurable); others queue as
   Pending.
9. **Notifications:** OS notification on gate reached, completed and failed; clicking opens the
   Live View. Set `app.setAppUserModelId`.
10. **Delivery source:** `trigger: Manual | Watcher` with `ruleId`, so you can measure
    auto-triggered vs manual (S3 metric).

## Acceptance criteria (against a mock Jira server)
- Ticket labelled → exactly one delivery, also across a restart mid-poll.
- Ticket assigned to someone else → ignored.
- Watcher disabled, or not the active machine → no polling.
- Completed and failed paths each produce one label + exactly one comment, even after retries.
- Re-label → rerun linked to the previous delivery.
- Gate → notification.
- typecheck, tests, build all pass.

## Out of scope
Webhooks, Jira Server/DC, transitions, auto-takeover.
