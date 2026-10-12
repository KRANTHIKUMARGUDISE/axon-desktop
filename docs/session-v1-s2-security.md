# Session v1-S2 — Security Hardening (shell + agent containment)

Read first: `CLAUDE.md`, `docs/v1-review.md` (C1, C2, C3), `docs/v1-decisions.md`, `docs/v1-progress.md`.
Start in plan mode.

## Goal
Make the app safe to run agents unattended. This must land before the Jira watcher (S5).

## Scope

**Electron shell (C1)**
- `sandbox: true`, `setWindowOpenHandler` deny, `will-navigate` guard, `openExternal` allow-list
  (`https:` only; add `vscode:` only if it's used).
- CSP via `<meta>` in `index.html` (works for `file://`); remove `'unsafe-inline'` from script-src;
  bundle fonts locally (no Google Fonts); `connect-src` limited to Anthropic, Jira (configured
  host), GitHub API, and the registry host.
- Remove the generic secret oracle (`auth:getSecure(key)` etc.). Replace it with named main-side
  APIs (`setJiraToken`, `hasJiraToken`, `setClaudeKey`, `hasClaudeKey`…). The renderer never
  receives secret values.
- Workspace IPC: every path is resolved and must sit under `workspaceRoot`, `{userData}`, or the
  registry cache. Delete `workspace:clear`, or restrict it to a delivery's own directory.
- Schema-validate every `ipcMain.handle` input (zod, from `shared/`) and check `senderFrame` origin.
  Typed per-key settings setters; URL settings validate scheme and host.
- Shrink `preload.ts` to the methods the renderer actually calls.
- `openInVSCode`: reject args starting with `-`; restrict to workspace paths.

**Agent containment (C2)**
- Keep `settingSources: ['project']` with `cwd` = repo worktree (D11). Verify with a test repo
  whose `.claude/settings.json` tries to allow extra tools or paths: AXON's `tools` ceiling and
  PreToolUse path check must still deny. Record the finding in progress.md.
- Agent env allow-list: PATH, HOME/USERPROFILE, TEMP/TMP, ANTHROPIC_API_KEY. No Git/Jira tokens,
  nothing else from `process.env`.
- Path-scoped `PreToolUse`: deny Read/Write/Edit/Glob/Grep whose path resolves outside the
  delivery worktree. For Bash, deny network tools (curl, wget, Invoke-WebRequest, ssh, scp, nc)
  and `git push`/`git remote`. Every denial is recorded in `toolsDenied`. Check the Agent SDK docs
  for a native sandbox option and use it if available (note the finding in progress.md).
- Ticket-derived text is fenced in the prompt as untrusted data.
- Agent JSON output is validated against the block's `outputSchema`. A raw-text fallback is
  never persisted beyond the local step record.

**Secrets and logging (C3)**
- Structured logger (levels, file rotation in `{userData}/logs`, redaction of tokens, keys, emails
  in URLs). Replace all `console.*` in `electron/`.
- Git credentials never in URLs: use `GIT_ASKPASS` or a credential helper via env.
  `git clone`/`fetch` run with `-c protocol.ext.allow=never -c protocol.file.allow=never`.
- Claude key from `~/.claude.json` requires explicit confirmation (D3).

## Acceptance criteria (as tests where possible)
- Renderer calls `readFile('../../…')`, `getSecure` (gone), and out-of-root writes → rejected.
- An agent block scoped to `[Read]` asked to edit a file → denial recorded in `toolsDenied`.
- An agent attempting `Write` outside the worktree → denied and recorded.
- An agent running `curl` → denied and recorded.
- Packaged build: CSP visible in devtools; no remote font requests.
- Logs contain no API key or PAT (test with seeded fake secrets).
- typecheck, tests, build all pass.

## Out of scope
OS-level sandboxing, code signing, auto-update.
