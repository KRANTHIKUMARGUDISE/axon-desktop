# Dependency audit

Tracks `npm audit` findings for AXON Desktop, where each one lives (does it ship in the installed
app?), and what was done. Updated per step of session v1-S2b. Baseline taken 2026-10-13 on
`chore/v1-s2b-dependency-hardening` right after the S2 commit (Electron 31.7.7, electron-builder
24.13.3, simple-git 3.36.0, Node 24.16, installs done with `--legacy-peer-deps`).

## Baseline numbers

| Command | moderate | high | critical | total |
|---|---|---|---|---|
| `npm audit --omit=dev` | 5 | 18 | 3 | **26** |
| `npm audit` (everything) | 11 | 29 | 7 | **47** |

`--omit=dev` is **not** the same as "ships in the app": `shadcn` (a CLI) sits in `dependencies`,
which drags in ts-morph, fast-glob, dotenvx/undici, etc., and Electron itself (the runtime we ship) is a
devDependency, so its advisories only show in the full audit. The "Ships?" column below is the real answer.

Ships? legend:
- **runtime** — code in the installed app's `node_modules` (inside `app.asar`) or the Electron runtime, executed by the main process.
- **renderer bundle** — bundled by Vite into `dist/` and executed in the renderer.
- **runtime (dormant)** — present in the asar but AXON never starts the vulnerable component (e.g. an HTTP/MCP server).
- **CLI** — a developer CLI that is not needed to run or build the app.
- **build** — used only by `vite build` / `electron-builder` on the developer or CI machine.
- **test/dev** — vitest, dev server, `concurrently`.

## Findings (baseline)

### Runtime / renderer bundle (must be fixed or justified)

| Package | Sev | Introduced by | Ships? | Planned action |
|---|---|---|---|---|
| `simple-git` (3 advisories) + `@simple-git/argv-parser` (<2.0.1, `VISUAL` env not treated as an unsafe editor) | critical | direct dep | runtime (main runs git) | Step 3: upgrade to simple-git 4.x |
| `electron` 31.7.7 (37 advisories, EOL line) | high | direct devDep, **is the shipped runtime** | runtime | Step 4: upgrade to 44.x |
| `react-router`, `react-router-dom` (RSC-mode CSRF bypass; AXON uses declarative `HashRouter`, not RSC mode) | high | direct dep | renderer bundle | Step 2: `npm audit fix` |
| `fast-uri` (8 advisories) | high | `electron-store` → `ajv` | runtime | Step 2: `npm audit fix` |
| `@modelcontextprotocol/sdk`, `hono`, `@hono/node-server`, `express` chain: `qs`, `proxy-addr` (critical, IP spoofing via trust-proxy), `ip-address` | critical / high / moderate | `@anthropic-ai/claude-agent-sdk` | runtime (dormant: AXON never starts an MCP or HTTP server) | Step 2: `npm audit fix`; justify any that remain |

### CLI-only (not needed at runtime or to build)

| Package | Sev | Ships? | Planned action |
|---|---|---|---|
| `shadcn` → `ts-morph`, `@ts-morph/common`, `fast-glob`, `micromatch`, `braces`, `@dotenvx/dotenvx` → `undici` (15 advisories), `@modelcontextprotocol/sdk`, `js-yaml`, `nanoid`, `postcss-selector-parser`, `baseline-browser-mapping`, `browserslist` | high / moderate | CLI (its `tailwind.css` is inlined by Vite at build time) | Step 6: move `shadcn` to devDependencies |

### Build-time only (developer machine)

| Package | Sev | Introduced by | Planned action |
|---|---|---|---|
| `postcss`, `source-map-js`, `nanoid`, `browserslist` | high | `vite`, `@tailwindcss/vite`, `@vitejs/plugin-react` | Step 2 (`audit fix`) |
| `electron-builder`, `app-builder-lib`, `builder-util(-runtime)`, `dmg-builder`, `electron-publish`, `tar` (critical, 12 advisories), `@xmldom/xmldom` (13), `brace-expansion`, `js-yaml` | critical / high | `electron-builder` 24.13.3 | Step 2 (`xmldom`, `brace-expansion`), Step 5 (electron-builder 26) |
| `@electron/get`, `extract-zip`, `http-cache-semantics`, `global-agent`, `roarr`, `sprintf-js` | high / moderate | `electron` install-time downloader | Step 4 (Electron 44) |

### Test / dev only

| Package | Sev | Introduced by | Planned action |
|---|---|---|---|
| `vitest`, `@vitest/mocker`, `tinypool` | critical / moderate | `vitest` 3.x | Step 8: defer (vitest 5 needs Vite ≥ 6) |
| `vite`, `esbuild` (dev-server request/CORS issues) | high / moderate | `vite` 5.4 | Step 8: defer; dev server binds to localhost only |
| `shell-quote` | critical | `concurrently` (dev script only) | Step 2 / document |

## Status log

_(each step appends below)_

- **Step 1** — baseline recorded (this document).
- **Step 2** — `npm audit fix` (no `--force`): `npm audit --omit=dev` 26 → **9** (2 critical, 7 high); full audit 47 → **28**. Remaining prod findings: `simple-git`/`@simple-git/argv-parser` (step 3) and the `shadcn` chain (`shadcn`, `@shadcn/registry`, `ts-morph`, `@ts-morph/common`, `fast-glob`, `micromatch`, `braces`; step 6). Checks: typecheck, 107 tests, build, `npm run build:win`, and `node scripts/smoke-packaged.js release/win-unpacked/AXON.exe` (packaged prod path: file:// load, prod CSP meta, no Node globals, IPC works, traversal/bad setting/`file:` openExternal rejected, `window.open` null, navigation to https blocked, no remote font requests, Claude binary unpacked).
- **Step 3** — `simple-git` 3.36 → **4.0.2** (`@simple-git/argv-parser` 2.0.1): both criticals cleared; `npm audit --omit=dev` now 7 high, all in the `shadcn` CLI chain (step 6). Changes: named import `{ simpleGit }` (default export removed); simple-git 4 also guards the *environment* — it refuses to spawn git while `EDITOR`/`VISUAL`/`PAGER`/`GIT_SSH_COMMAND`/`GIT_CONFIG_*`/… are set and blocks `GIT_*` keys passed via `.env()` unless listed in `allowEnvironment`. Without a fix this would have made every git operation fail for any user with `EDITOR` set, so `buildGitEnv` now drops those inherited keys and `makeGit` sets `allowEnvironment: ['GIT_ASKPASS','GIT_TERMINAL_PROMPT']`. Side effect: a user's own `GIT_SSH_COMMAND`/`GIT_SSH` is not honoured for AXON's git calls (ssh-agent via `SSH_AUTH_SOCK` and `~/.ssh/config` still work). New tests: local git works with `EDITOR`/`VISUAL`/`GIT_PAGER` set; `file` transport clone refused; `ext::` never executes; askpass wiring accepted. Manual check: real `cloneOrOpen` of a public https repo + `createDeliveryBranch` with `EDITOR` set. Packaged smoke passes.
- **Step 4** — `electron` 31.7.7 → **44.7.0** (`>=22.12` Node for the npm package; Chromium/Node bundled with it). Full audit 28 → **20** (all 37 Electron advisories and the `@electron/get`/`extract-zip`/`global-agent`/`roarr`/`sprintf-js`/`http-cache-semantics` chain gone). Required changes: none in application code (`electron/main.ts`, preload, guards compiled and ran unchanged); SETUP.md/CLAUDE.md Node + Electron notes updated (_correction made in step 7_: Electron 44's npm package has **no postinstall** — the binary downloads on first run or via `npx install-electron`; the `allowScripts` Electron entry I bumped here is irrelevant and was removed) (Node 24 now works, Node 20 no longer does). Verified on the **packaged** build (`scripts/smoke-packaged.js`): sandbox/contextIsolation (no `require`/`process`/`module` in the renderer), prod CSP meta present and no CSP violations in the console, `window.open` → null, in-page navigation to https blocked (`will-navigate`), renderer permission requests denied (Notification → `denied`, geolocation → error 1), IPC sender check passes for the packaged `file://` index (IPC calls succeed) while traversal/bad setting/`file:` openExternal are rejected, no remote font requests, Claude binary present in `app.asar.unpacked`, no deprecation warnings on startup. Not verifiable from the renderer: rejection of IPC from a foreign frame (covered by unit tests of `guard.ts`; iframes are blocked by CSP). I did not read the full 32–44 breaking-changes list line by line — the check is behavioural.
- **Step 5** — `electron-builder` 24.13.3 → **26.17.0** (no changes needed in `electron-builder.config.js`; `asarUnpack` for the Claude binary, NSIS options and the `mac` conditional all work). Clears `tar` (critical), `@xmldom/xmldom`, `brace-expansion`, `builder-util*`, `dmg-builder`, `electron-publish` highs. `npm run build:win` produces `AXON Setup 0.1.0.exe` (≈196 MB). **Installer verification**: the NSIS payload was extracted with the bundled `7za` and the extracted `AXON.exe` passed `scripts/smoke-packaged.js` on Electron 44.7.0 (same checks as step 4). **Not done**: a real silent install/uninstall — an AXON 0.1.0 install is already registered on this machine (`HKLM\...\Uninstall\AXON`, `%LOCALAPPDATA%\Programs\AXON`) and running a second installer would touch that registration, so it needs the owner's go-ahead. Remaining from this chain (moderate, **build-time only**): `app-builder-lib` → `@electron/get@3.1.0` → `global-agent` → `roarr` → `sprintf-js` ("DoS through unbounded precision specifiers"). It only runs inside the build machine's Electron download proxy support, never in the shipped app; the audit's suggested fix is a *downgrade* (`electron-builder@26.5.0`), so it is accepted. npm also warns that `electron-winstaller`'s install script is not approved (`allow-scripts`); it is only used for Squirrel targets, which AXON does not build.
- **Step 6** — `shadcn` (CLI; its `shadcn/tailwind.css` is inlined by Vite at build time) and `tw-animate-css` (CSS import) moved to `devDependencies`. **`npm audit --omit=dev`: 0 vulnerabilities.** The packaged `app.asar` no longer contains `shadcn`, `ts-morph`, `@dotenvx/dotenvx`/`undici` etc. (installer 196 MB → 189 MB); typecheck, 111 tests, build, `build:win` and the packaged smoke all pass. Considered and kept in `dependencies`: the renderer libraries Vite bundles into `dist/` (react, react-router-dom, radix, recharts, …) — their code does ship, so their advisories must stay visible to `--omit=dev` audits; `@fontsource-variable/*` are bundled the same way. No other CLI-only packages are in `dependencies`.
- **Step 7** — `--legacy-peer-deps` is **no longer needed**. Evidence: from a cold `rm -rf node_modules`, `npm ci` (lockfile regenerated with `--package-lock-only`, flag off) installs with no ERESOLVE, `npm ls` reports no invalid/missing/extraneous packages, and typecheck, 111 tests, `build:win` and the packaged smoke all pass. Root cause of the old need: an old peer conflict on `react-is` (recharts peer; the project did not declare it, and a legacy install pruned it — it is now a direct dependency) plus peer ranges in the vite 5 / `@tailwindcss/vite` / agent-SDK toolchain that newer versions of those packages satisfy. No `.npmrc` or docs relied on the flag. The earlier `picomatch@2.3.2 invalid "^3 || ^4"` from `fdir` seen in `npm ls` is gone after the fresh resolve. Also: stale `allowScripts` entries removed (`electron@…` — Electron 44 has no postinstall — and an `esbuild@0.25.12` that is no longer installed); only `esbuild@0.21.5` remains. npm still prints a notice for `electron-winstaller@5.4.0`'s install script; it is only used for Squirrel targets, which AXON does not build, so it is deliberately not approved.
- **Step 8** — turned out to be trivial, so done: `vite` 5.4 → **6.4.4**, `vitest` 3.2 → **5.0.4** (vitest 5 requires Vite ≥ 6.4; `@vitejs/plugin-react` 4.7 and `@tailwindcss/vite` already support Vite 6). No config or test changes needed: typecheck, 111 tests, `vite build`, dev server (200 + CSP meta), `build:win` and the packaged smoke all pass. Clears `vitest`, `tinypool` (critical), `@vitest/mocker`, `vite`, `esbuild` (dev-server advisories). Vite 7/8 were deliberately not taken (no advisory requires them). `allowScripts` esbuild entry moved to `esbuild@0.25.12`.

## Final state (after step 8)

| Command | moderate | high | critical | total |
|---|---|---|---|---|
| `npm audit --omit=dev` | 0 | 0 | 0 | **0** (was 26) |
| `npm audit` (everything) | 8 | 7 | 0 | **15** (was 47) |

### Every remaining finding (all dev/build-time; none ships in the installed app)

| Package(s) | Sev | Why it remains | Ships? |
|---|---|---|---|
| `shadcn`, `@shadcn/registry`, `ts-morph`, `@ts-morph/common`, `fast-glob`, `micromatch`, `braces` (braces: stack exhaustion on deeply nested glob patterns) | high ×7 | `shadcn` is a developer CLI used by hand to add UI components; it only globs the developer's own project files, and only `shadcn/tailwind.css` (static CSS) is read at build time. The advisory's suggested fix is `shadcn@1.0.0`, a **major downgrade** that would drop the 4.x component registry format. Re-check when shadcn ships a release depending on patched `fast-glob`/`micromatch`/`braces`. | no — devDependency, absent from `app.asar` (verified) |
| `electron-builder`, `app-builder-lib`, `dmg-builder`, `electron-builder-squirrel-windows`, `@electron/get` (3.1.0), `global-agent`, `roarr`, `sprintf-js` (DoS via unbounded precision specifiers) | moderate ×8 | One chain inside electron-builder 26.17.0: its Electron-download helper `@electron/get@3.1.0` → `global-agent` → `roarr` → `sprintf-js`. Only exercised on the build machine while downloading Electron, with no attacker-controlled format strings. `npm audit` offers only `electron-builder@26.5.0` (a downgrade that reintroduces the older findings). Re-check on each electron-builder release. | no — build tool |

### Other accepted notes
- Renderer libraries bundled into `dist/` and the main-process runtime deps (`simple-git`, `electron-store`, `@anthropic-ai/claude-agent-sdk`, `zod`) are all clean as of this audit, so there is nothing accepted on the shipped side.
- npm notices for `electron-winstaller@5.4.0` install script are intentionally unapproved (Squirrel only; AXON builds NSIS/DMG).
- Re-run `npm audit` and `npm audit --omit=dev` before each release; CI should fail on any high/critical in `--omit=dev`.
