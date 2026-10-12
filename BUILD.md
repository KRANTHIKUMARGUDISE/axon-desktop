# AXON Desktop — Build Documentation

Covers the production build pipeline, configuration, and known issues when packaging AXON Desktop into a distributable installer.

## Overview

AXON Desktop has two build outputs that get combined by `electron-builder` into a platform installer:

| Output | Source | Built by |
|---|---|---|
| `dist/` | React renderer (`src/`) | `vite build` |
| `dist-electron/` | Electron main process (`electron/`) | `tsc -p tsconfig.electron.json` |

`electron-builder` packages both, plus `package.json`, into a platform-specific installer in `release/`.

## Build commands

```bash
npm run build       # builds dist/ + dist-electron/ only, no installer
npm run build:win   # build + NSIS installer for Windows x64
npm run build:mac   # build + DMG for macOS x64/arm64
npm run build:all   # build + both installers
```

## Configuration files

### `vite.config.mts`
- Renderer output: `build.outDir: 'dist'`
- Dev server `watch.ignored` excludes `dist/`, `dist-electron/`, `release/`, `.electron-cache/` so Vite's file watcher doesn't scan build artifacts during `npm run dev` (see [Known issues](#known-issues) below).

### `tsconfig.electron.json`
- Electron main process output: `outDir: 'dist-electron'`

### `electron-builder.config.js`
- `directories.output: 'release'` — where installers land
- `files` — only `dist/`, `dist-electron/`, and `package.json` get packaged (source `src/`/`electron/` are excluded)
- `extraMetadata.main: 'dist-electron/electron/main.js'` — overrides `package.json`'s `main` field for the packaged app
- `electronDownload.cache` — points to the OS temp directory (`os.tmpdir()/axon-electron-cache`), not inside the project folder (see [Known issues](#known-issues))
- `win.icon` / `mac.icon` / `nsis.installerIcon` / `nsis.uninstallerIcon` — all sourced from `build/icon.png` (auto-converted to `.ico`/`.icns` by electron-builder)
- `mac` target is conditional on `process.platform === 'darwin'` — building `--mac` from Windows isn't supported without a Mac

## Changing the app/installer icon

1. Replace `build/icon.png` with a new **512×512 PNG**.
2. Run `npm run build:win` (or `:mac`).

electron-builder auto-generates `.ico`/`.icns` from that single PNG — no need to create those manually. The same icon is used for the installed app, the installer `.exe`, and the uninstaller.

## Path handling for packaged app

- `electron/main.ts` loads `dist/index.html` relative to `dist-electron/electron/main.js` in production (`isDev` checks `!app.isPackaged`)
- `electron/ipc/settings.ts` — `electron-store` is rooted at `app.getPath('userData')`, not the project directory, so settings persist correctly once installed
- `electron/ipc/workspace.ts` — paths starting with `~` are expanded to `os.homedir()` for cross-platform workspace roots
- `electron/ipc/git.ts` — uses `path.join()` throughout for cross-platform compatibility

## Known issues

### Window/taskbar icon disappears after changing `dist-electron`'s folder depth

`electron/main.ts` resolves the window icon and `index.html` path relative to `__dirname` (i.e., relative to wherever `dist-electron/electron/main.js` ends up). These paths assume `dist-electron/` sits as a **sibling** of `dist/` and `build/` directly under the project root:

```
project-root/
├── dist/            (renderer build)
├── dist-electron/   (electron main build)  ← __dirname when main.js runs
└── build/icon.png
```

If `tsconfig.electron.json`'s `outDir` is ever changed (e.g. nested back under `dist/electron`), the relative `..` traversals in `main.ts` (`icon` path, `loadFile` path) must be updated to match, or the window icon silently fails to load and `loadFile` may point at the wrong `index.html` (e.g. the dev source template instead of the built one). `build/icon.png` must also stay listed in `electron-builder.config.js`'s `files` array so it's present in the packaged app's resources at runtime — it's not only needed by `win.icon`/`nsis.installerIcon` at build time.

### Windows: "Cannot create symbolic link" during `build:win`

electron-builder downloads `winCodeSign-2.6.0.7z`, which contains macOS code-signing libraries (`darwin/10.12/lib/*.dylib`) packaged as symlinks. Extracting symlinks on Windows requires either:
- **Developer Mode enabled** (Settings → System → For developers → Developer Mode), or
- Running the terminal **as Administrator**

Without one of these, 7-Zip fails to extract those two files and electron-builder retries 4 times before failing the whole build. This doesn't affect functionality (we don't code-sign) — it's purely an extraction permission issue.

**Fix:** enable Developer Mode or run as Administrator, then retry `npm run build:win`.

### Slow dev server startup after running a production build

**Symptom:** after running `npm run build:win`, the next `npx vite` + `npx electron .` session takes up to a minute to render (blank/white screen, DevTools Network tab shows source `.tsx` files stuck in `(pending)` indefinitely, no console errors).

**Cause:** `npm run build:win` writes a large number of new binaries into the project folder — `release/win-unpacked/` (a full unpacked Electron runtime: `electron.exe` + ~150 DLLs) and previously `.electron-cache/` (now relocated, see above). Windows Defender's real-time protection scans every new/modified executable as it's written, and that scan burst contends for disk I/O with Vite's dev server trying to read source files on the same drive.

**Mitigations applied:**
1. `electronDownload.cache` moved out of the project directory to `os.tmpdir()` — removes the single largest binary cache from the watched/scanned folder.
2. `vite.config.mts` dev server ignores `dist/`, `dist-electron/`, `release/`, `.electron-cache/` in its file watcher.

**Further mitigation (manual, no admin required):**
- Delete `release/win-unpacked/` after copying out the installer you need — reduces persistent binary clutter for *future* dev sessions. This does **not** prevent the scan burst during the *next* build itself, since the folder gets regenerated.
- Avoid running `build:win` immediately before a dev session — the scan burst settles after roughly a minute, so a short pause avoids the contention.

**Permanent fix (requires admin):**
Add a Windows Defender exclusion for the project folder:
```powershell
Add-MpPreference -ExclusionPath "D:\AXON\axon-desktop"
```
On a managed/office laptop without local admin rights, request this exclusion through IT — it's a standard ask for Node/Electron development and isn't AXON-specific.

## Verifying a production build works

1. `npm run build:win`
2. Either:
   - Run `release/win-unpacked/AXON.exe` directly (no install needed), or
   - Run the NSIS installer in `release/`, install, then launch from the Start Menu shortcut
3. Confirm: setup wizard runs, dashboard loads, `window.axon` is defined in DevTools console, settings persist across restarts (stored via `app.getPath('userData')`, not the project folder)
