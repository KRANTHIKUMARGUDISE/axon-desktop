# Session v1-S3 — Registry, Identity, Sync

Read first: `CLAUDE.md`, `docs/v1-review.md` (C3, C5, D3, D5–D9, D16, D21–D22), `docs/v1-decisions.md`
(especially D9), `docs/v1-progress.md`. Start in plan mode.

## Goal
Shared `axon-registry` repo is the team standard for definitions, and each engineer's data syncs to
it. Engineers are identified via Jira. The Store interface stays swappable for a future `ApiStore`.

## Registry layout (D9)

```
main (single branch; folder = future DB collection)
  registry.yaml                      schemaVersion, minAppVersion
  catalog/repositories.yaml          ← PR only
  org/pipelines/  org/blocks/        ← PR only
  teams/{team}/pipelines/ blocks/    ← PR only
  users/{email}/profile.yaml         ← direct commit by that user only
  users/{email}/pipelines/ blocks/ rules/
  users/{email}/runs/{yyyy-mm}/{deliveryId}.json
  users/{email}/activity.log
```

`{email}` is lowercased. Blocks are folders (`block.yaml` + skill files), not embedded content.
Every document carries `id`, `schemaVersion`, `scope`, `owner` so a later DB import is a straight
folder → collection load.

## Scope
1. **`GitRepoStore`** implementing `Store` plus a definitions reader:
   - Local clone in `{userData}/registry/`.
   - Read-through cache that works offline.
   - Durable on-disk write queue (atomic, survives crash).
   - Scheduled sync, default 5 min, plus "Sync now".
   - Sync = fetch → rebase own `users/{email}` changes → push to `main`. The write path refuses
     any direct commit outside `users/{email}/`.
   - Non-fast-forward → retry with backoff → if still failing, show "needs attention".
   - Never lose queued writes.
2. **Visibility and promotion:**
   - Personal = `users/{email}/`.
   - Team/Org = `teams/{team}/`, `org/`.
   - "Promote" opens a PR to `main` via the GitHub API with the engineer's token.
   - Versioning per D13: one file per version, Draft → Published (immutable) → Deprecated,
     Publish increments `version`, nodes pin `{blockId, blockVersion}`.
   - "Duplicate to…" writes `derivedFrom: {pipelineId, version}`.
   - Deliveries record `pipelineId`, `pipelineVersion`, and pinned block versions.
   - Pipeline/Block screens: version history list, "Publish", "newer version available".
3. **Seed bundle:** `resources/seed/blocks/*` (`human-gate`, plus stubs registered for the S4/S5
   native blocks), versioned and checksummed. Loaded as `sourceType: Axon`; immutability is
   enforced in main, not only hidden in the UI.
4. **Schema versioning:**
   - Every file has `schemaVersion`.
   - The reader tolerates N-1 and runs migrations.
   - The app refuses to write if `registry.yaml.minAppVersion` is greater than the app version.
5. **Onboarding** (replaces temporary Setup):
   - Registry URL + branch: default from a build-time constant, overridable; "Test connection"
     checks read and push access.
   - Jira site + email + API token → `/myself` email must match.
   - GitHub credential check.
   - Claude key detect/confirm (D3).
   - Workspace root (D7).
   - Consent text for `activity.log` (email + machine name).
6. **Identity:**
   - `profile.yaml`: email, displayName (from Jira), team, machines `[{id, name, lastSeen}]`.
   - Stable machine id: random UUID stored in `{userData}`, plus hostname for display.
   - Replace the S1 `local-user` placeholder everywhere: approver, createdBy.
7. **Activity log:** login and launch entries appended locally, pushed with the next sync. No
   commit per login.
8. **Run summary:** explicit whitelisted fields only — status, timings, gate outcomes (who/when),
   rerunOf/rerunReason, pipelineId + pipelineVersion, blockVersions, prUrls, tokens/cost, repo URLs. Never output,
   context or summaries of code. Free-text fields are size-capped. Add a pre-push secret scan on
   registry commits (simple regex set for keys/PATs).
9. **Settings:** registry URL/branch override, sync interval, last sync status, queued-write count,
   offline banner.

## Acceptance criteria
- Fresh machine: onboard → seeded and org blocks visible.
- Create a Personal pipeline → appears under `users/{email}/` after sync. Offline: it queues, survives a crash,
  and syncs on reconnect.
- Promote → PR URL shown.
- Two clients pushing concurrently → both succeed via rebase, nothing lost.
- Mismatched Jira email → onboarding blocked.
- Contract test: a run summary contains only whitelisted keys; seeded fake secrets are rejected by
  the pre-push scan.
- Store tests run against a local bare repo fixture (no network).
- typecheck, tests, build all pass.

## Out of scope
`ApiStore`, Marketplace/CDF sources, metrics UI.
