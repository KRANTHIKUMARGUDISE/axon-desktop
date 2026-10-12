# AXON Desktop — Setup & Run Guide

## Prerequisites

Install these before anything else.

| Tool | Version | Download |
|------|---------|----------|
| Node.js | 22.12+ (22 LTS or 24) | https://nodejs.org |
| npm | comes with Node | — |
| Git | any recent | https://git-scm.com |

> **Node note:** Electron 44's npm package needs Node ≥ 22.12 (Node 20 no longer works). Node 24 is fine — the old Electron 31 / Node 24 download problem is gone.
>
> **Electron binary:** Electron 44's npm package has no postinstall script; the ~105 MB binary is downloaded the first time you run `npx electron .` (or eagerly with `npx install-electron`).

---

## 1. Clone the repo

```bash
git clone <repo-url>
cd axon-desktop
```

---

## 2. Install dependencies

```bash
npm install
```

This installs all packages. The Electron binary (~105 MB) downloads from GitHub on first run (or run `npx install-electron` to fetch it now).

**If `npx electron .` later throws "Electron failed to install correctly"**, the binary didn't download (network/proxy issue). Fix it manually:

```bash
# Download the binary zip
curl -L -o electron-win32.zip \
  https://github.com/electron/electron/releases/download/v44.7.0/electron-v44.7.0-win32-x64.zip

# Extract and register it (run in project root)
node -e "
const { execSync } = require('child_process');
const fs = require('fs');
execSync('powershell -Command \"Expand-Archive -Path electron-win32.zip -DestinationPath node_modules/electron/dist/ -Force\"');
fs.writeFileSync('node_modules/electron/path.txt', 'electron.exe');
console.log('done');
"
```

---

## 3. Compile the Electron main process

```bash
npx tsc -p tsconfig.electron.json
```

This compiles `electron/*.ts` → `dist/electron/*.js`. Must be run once before launching, and re-run after any changes to files in `electron/`.

---

## 4. Run in development

You need **two terminals** open at the same time.

**Terminal 1 — Vite dev server (React renderer):**
```bash
npx vite
```
Wait until you see:
```
  VITE ready in ...ms
  ➜  Local: http://localhost:5173/
```

**Terminal 2 — Electron:**
```bash
npx electron .
```

The AXON Desktop window opens loading `http://localhost:5173`.

---

## 5. Verify the IPC bridge

In the Electron window, open the **DevTools Console tab** (it opens automatically in dev) and type:

```js
window.axon
```

You should see an object with: `auth`, `settings`, `workspace`, `git`, `executor`, `claude`.

---

## Project structure

```
axon-desktop/
  electron/
    main.ts          # BrowserWindow, CSP, single-instance lock
    preload.ts       # contextBridge → window.axon
    types.d.ts       # TypeScript types for window.axon
    ipc/
      auth.ts        # OS-encrypted token storage (Electron safeStorage)
      settings.ts    # App settings (electron-store)
      workspace.ts   # File system helpers (fs/promises)
      git.ts         # Stub — implemented in D7
      executor.ts    # Stub — implemented in D5
      claude.ts      # Stub — implemented in D6
  src/
    main.tsx         # React entry point
    App.tsx          # Root component
  index.html         # Vite HTML entry
  dist/              # Compiled output (git-ignored)
    electron/        # Compiled Electron main process
    renderer/        # Built React app (production only)
  build/
    icon.png         # App icon placeholder
  package.json
  tsconfig.json            # Renderer (React/Vite)
  tsconfig.electron.json   # Main process (CommonJS/Node)
  vite.config.ts
  electron-builder.config.js
```

---

## Common issues

| Symptom | Fix |
|---------|-----|
| Blank white window | Make sure Vite is running in Terminal 1 before launching Electron |
| `window.axon is undefined` | Preload didn't load — check `dist/electron/preload.js` exists (rerun tsc) |
| `Electron failed to install` | Follow the manual binary download steps in section 2 |
| CSP warning in console | Expected in dev — disappears in production builds |
| `electron-store` ESM error | It is pinned to `8.1.0` (last CJS build) — do not upgrade |

---

## Build for production

```bash
# Windows installer (.exe via NSIS)
npm run build:win

# macOS disk image (.dmg)
npm run build:mac

# Output is in release/
```
