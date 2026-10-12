import { app, BrowserWindow, session, dialog, shell } from 'electron'
import path from 'path'
import { pathToFileURL } from 'url'
import { registerSecretHandlers, getGitToken, purgeLegacyAuthFiles } from './ipc/secrets'
import { registerSettingsHandlers, getWorkspaceRoot, getDS1ThresholdBytes } from './ipc/settings'
import { registerWorkspaceHandlers, createGrants } from './ipc/workspace'
import { registerShellHandlers } from './ipc/shell'
import { configureTrustedSender, makeTrustedUrlCheck } from './ipc/guard'
import { initLogger, log } from './log'
import { isAllowedExternalUrl } from './security/shell'
import { registerSystemHandlers } from './ipc/system'
import { registerDataHandlers } from './ipc/data'
import { registerDeliveryHandlers } from './ipc/delivery'
import { initClaudeKey, registerClaudeKeyHandlers, getClaudeKey } from './ipc/claudeKeyStore'
import { FileStore } from './store/fileStore'
import { seedBuiltIns } from './store/seed'
import { createEngine } from './engine/engine'
import type { Engine } from './engine/engine'
import { createBus } from './engine/bus'
import { createRunner } from './runners'
import { createGitWorkspace } from './workspace/gitWorkspace'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// The renderer's only legitimate origin: the Vite dev server, or the packaged index.html.
const DEV_ORIGIN = 'http://localhost:5173'
const PROD_INDEX = path.join(__dirname, '../../dist/index.html')
const isTrustedUrl = makeTrustedUrlCheck(isDev ? { devOrigin: DEV_ORIGIN } : { fileUrl: pathToFileURL(PROD_INDEX).href })
configureTrustedSender(isTrustedUrl)

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
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })

  const wc = mainWindow.webContents
  // No child windows ever; https links go to the OS browser through the same allow-list.
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const blockForeignNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault()
      log.warn('[window] blocked navigation', url)
    }
  }
  wc.on('will-navigate', blockForeignNavigation)
  wc.on('will-redirect', blockForeignNavigation)
  wc.on('will-attach-webview', (event) => event.preventDefault())

  if (isDev) {
    mainWindow.loadURL(DEV_ORIGIN)
  } else {
    mainWindow.webContents.session.clearCache().then(() => {
      mainWindow!.loadFile(PROD_INDEX)
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

let engine: Engine | null = null

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  initLogger({ dir: path.join(userData, 'logs'), level: isDev ? 'debug' : 'info', mirror: isDev })
  log.info(`AXON ${app.getVersion()} starting (electron ${process.versions.electron})`)
  // Deny every renderer permission request (camera, geolocation, notifications, …).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  const store = new FileStore({ dir: path.join(userData, 'store') })
  const runsDir = path.join(userData, 'runs')
  const bus = createBus()
  const grants = createGrants()

  registerSecretHandlers()
  registerSettingsHandlers()
  registerSystemHandlers()
  registerClaudeKeyHandlers()
  await initClaudeKey()
  await purgeLegacyAuthFiles()
  await seedBuiltIns(store)

  engine = createEngine({
    store,
    bus,
    runsDir,
    runner: createRunner(getClaudeKey),
    workspace: createGitWorkspace({
      getWorkspaceRoot,
      getGitToken,
      pickDirectory: async () => {
        if (!mainWindow) return null
        const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select workspace folder' })
        const picked = res.canceled ? null : res.filePaths[0] ?? null
        if (picked) grants.grant(picked)
        return picked
      },
    }),
    ds1ThresholdBytes: getDS1ThresholdBytes,
  })
  registerWorkspaceHandlers({
    store,
    getWorkspaceRoot,
    access: {
      getRoots: () => [getWorkspaceRoot(), userData, path.join(userData, 'registry')],
      isGranted: grants.isGranted,
    },
  })
  registerShellHandlers({ getWindow: () => mainWindow, store, getWorkspaceRoot, grants })
  registerDataHandlers(store, runsDir)
  registerDeliveryHandlers(engine, bus)
  // A delivery left Running by a crash/kill has no active run — make it resumable.
  await engine.reconcileOnBoot()

  createWindow()
})

// Abort in-flight agent runs and persist state before the process exits.
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown || !engine) return
  event.preventDefault()
  shuttingDown = true
  engine.shutdown().catch((err) => log.warn('shutdown failed', err)).finally(() => app.quit())
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

process.on('uncaughtException', (err) => log.error('uncaughtException', err))
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err))
