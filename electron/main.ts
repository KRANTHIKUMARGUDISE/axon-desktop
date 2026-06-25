import { app, BrowserWindow, session, dialog, ipcMain, shell } from 'electron'
import path from 'path'
import { execFile } from 'child_process'
import { registerAuthHandlers } from './ipc/auth'
import { registerSettingsHandlers } from './ipc/settings'
import { registerWorkspaceHandlers } from './ipc/workspace'
import { registerGitHandlers } from './ipc/git'
import { registerExecutorHandlers } from './ipc/executor'
import { registerClaudeHandlers } from './ipc/claude'
import { registerSystemHandlers } from './ipc/system'
import { initClaudeKey, registerClaudeKeyHandlers } from './ipc/claudeKeyStore'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow() {
  const isWin = process.platform === 'win32'

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1280,
    minHeight: 800,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    ...(isWin
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#0c0f1a',
            symbolColor: '#f1f5f9',
            height: 44,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? "default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' http://localhost:* ws://localhost:* https:; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:;"
      : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; connect-src 'self' https:; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com;"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.webContents.session.clearCache().then(() => {
      mainWindow!.loadFile(path.join(__dirname, '../dist/index.html'))
    })
  }

  // Set default window title
  mainWindow.setTitle('AXON')

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  registerAuthHandlers()
  registerSettingsHandlers()
  registerWorkspaceHandlers()
  registerGitHandlers()
  registerExecutorHandlers()
  registerClaudeHandlers()
  registerSystemHandlers()
  registerClaudeKeyHandlers()
  await initClaudeKey()

  ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:openFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('shell:openPath', async (_event, path: string) => {
    try {
      // shell.openPath resolves to an error STRING on failure (e.g. path doesn't exist),
      // not a rejected promise — unlike most Electron APIs.
      const error = await shell.openPath(path)
      return error ? { success: false, error } : { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('shell:openInVSCode', async (_event, path: string) => {
    try {
      // Prefer the `code` CLI (correctly opens the folder as a VS Code *workspace*,
      // not a single-file view) — falls back to the vscode:// URI handler, which VS
      // Code's installer registers by default, if the CLI isn't on PATH.
      // -n/--new-window: without this, `code <path>` reuses whatever VS Code window is
      // already open and replaces ITS folder — e.g. opening a delivery's workspace while
      // editing axon-desktop itself would swap that window away from axon-desktop
      // entirely. A delivery's workspace must always open as its own separate window.
      await new Promise<void>((resolve, reject) => {
        execFile('code', ['-n', path], (err) => (err ? reject(err) : resolve()))
      })
      return { success: true }
    } catch {
      try {
        await shell.openExternal(`vscode://file/${path.replace(/\\/g, '/')}`)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  })

  ipcMain.on('window:setTitle', (_event, title: string) => {
    console.log('[IPC] window:setTitle received:', title)
    if (mainWindow) {
      mainWindow.setTitle(title)
      console.log('[Electron] Window title set to:', title)
    } else {
      console.log('[Electron] mainWindow not available')
    }
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})
