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
