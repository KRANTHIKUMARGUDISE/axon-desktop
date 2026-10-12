import { dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { z } from 'zod'
import { handle, on } from './guard'
import { resolveInside } from '../security/paths'
import { isAllowedExternalUrl, isSafeCliPathArg, buildVSCodeUri } from '../security/shell'
import { log } from '../log'
import type { Store } from '../store/types'

export interface ShellDeps {
  getWindow(): BrowserWindow | null
  store: Store
  getWorkspaceRoot(): string
  grants: { grant(p: string): void; isGranted(p: string): boolean }
}

type Result = { success: boolean; error?: string }

export function registerShellHandlers(deps: ShellDeps) {
  // openPath / openInVSCode: only the workspace root, a folder the user picked this session,
  // or a workspace path recorded on one of AXON's own deliveries (e.g. a Browse workspace).
  async function allowedFolder(p: string): Promise<string | null> {
    const inRoot = resolveInside(p, [deps.getWorkspaceRoot()])
    if (inRoot) return inRoot
    if (!p || p.startsWith('-')) return null
    const deliveries = await deps.store.listDeliveries()
    const known = deliveries.map((d) => d.workspacePath).filter((x): x is string => !!x)
    const hit = resolveInside(p, known)
    if (hit) return hit
    return deps.grants.isGranted(p) ? resolveInside(p, [p]) : null
  }

  handle('dialog:openDirectory', z.tuple([]), async () => {
    const win = deps.getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    deps.grants.grant(result.filePaths[0])
    return result.filePaths[0]
  })

  handle('dialog:openFile', z.tuple([]), async () => {
    const win = deps.getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    if (result.canceled || !result.filePaths[0]) return null
    deps.grants.grant(result.filePaths[0])
    return result.filePaths[0]
  })

  handle('shell:openExternal', z.tuple([z.string().max(2048)]), async ([url]): Promise<Result> => {
    if (!isAllowedExternalUrl(url)) {
      log.warn('[shell] openExternal rejected', url)
      return { success: false, error: 'Only https:// links can be opened' }
    }
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  handle('shell:openPath', z.tuple([z.string().min(1).max(4096)]), async ([p]): Promise<Result> => {
    const target = await allowedFolder(p)
    if (!target) return { success: false, error: 'Path is outside the AXON workspace' }
    // shell.openPath resolves to an error STRING on failure, not a rejected promise.
    const error = await shell.openPath(target)
    return error ? { success: false, error } : { success: true }
  })

  handle('shell:openInVSCode', z.tuple([z.string().min(1).max(4096)]), async ([p]): Promise<Result> => {
    const target = await allowedFolder(p)
    if (!target || !isSafeCliPathArg(target)) return { success: false, error: 'Path is outside the AXON workspace' }
    try {
      // -n: always a new window; `--` ends option parsing so the path can never be a flag.
      await new Promise<void>((resolve, reject) => {
        execFile('code', ['-n', '--', target], { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
      })
      return { success: true }
    } catch {
      // `code` is a .cmd shim on Windows and can't be execFile'd; fall back to the URI handler
      // with a URI main builds itself from the validated path.
      try {
        await shell.openExternal(buildVSCodeUri(target))
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  })

  on('window:setTitle', z.tuple([z.string().max(200)]), ([title]) => {
    deps.getWindow()?.setTitle(title)
  })
}
