import { app, BrowserWindow, session, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { atomicWrite } from './store/atomic'
import { pathToFileURL } from 'url'
import { registerSecretHandlers, getGitToken, purgeLegacyAuthFiles } from './ipc/secrets'
import { registerSettingsHandlers, getWorkspaceRoot, getDS1ThresholdBytes, store as settingsStore, readIdentitySettings, isOnboarded } from './ipc/settings'
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
import { GitRepoStore } from './store/gitRepoStore'
import { seedBuiltIns, builtInBlocks } from './store/seed'
import { loadMachineId, createIdentityProvider } from './identity'
import { WriteQueue } from './registry/queue'
import { RegistrySync } from './registry/sync'
import { RegistryReader } from './registry/reader'
import { RegistryService } from './registry/service'
import { loadRegistryDefaults, resolveSyncConfig } from './registry/config'
import { registerRegistryHandlers } from './ipc/registry'
import { makeGit } from './ipc/git'
import { validateRepoUrl } from './security/gitAuth'
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
let registrySync: RegistrySync | null = null

const REGISTRY_STATUS_CHANNEL = 'registry:status'

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  initLogger({ dir: path.join(userData, 'logs'), level: isDev ? 'debug' : 'info', mirror: isDev })
  log.info(`AXON ${app.getVersion()} starting (electron ${process.versions.electron})`)
  // Deny every renderer permission request (camera, geolocation, notifications, …).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  // ---- identity + registry stack (S3). FileStore is the offline cache/working copy; GitRepoStore mirrors the
  // engineer's own documents into the registry layout and queues them for sync.
  const machineId = await loadMachineId(userData)
  const identity = createIdentityProvider({ readSettings: readIdentitySettings, machineId })
  const registryDir = path.join(userData, 'registry')
  const seedIds = new Set(builtInBlocks().map((b) => b.id))
  const resourceDirs = [
    ...((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ? [(process as NodeJS.Process & { resourcesPath: string }).resourcesPath] : []),
    path.join(__dirname, '..', '..', 'resources'),
    path.join(__dirname, '..', '..', '..', 'resources'),
  ]
  const registryDefaults = loadRegistryDefaults(resourceDirs)
  const queue = new WriteQueue(path.join(userData, 'registry-queue'), () => identity.get()?.email ?? '')
  await queue.init()
  const reader = new RegistryReader(registryDir, (id) => seedIds.has(id))
  const local = new FileStore({
    dir: path.join(userData, 'store'),
    getOwner: () => identity.get()?.email ?? '',
    definitions: reader,
  })
  const gitFactory = async (dir?: string) => makeGit(dir, (await getGitToken()) ?? '')
  let service: RegistryService
  const sync = new RegistrySync({
    registryDir,
    getConfig: () => resolveSyncConfig({
      registryUrl: settingsStore.get('registryUrl') || '', registryBranch: settingsStore.get('registryBranch') || '',
      syncIntervalMinutes: settingsStore.get('syncIntervalMinutes') || 5,
    }, registryDefaults),
    getUser: () => {
      const id = identity.get()
      return id && isOnboarded() ? { email: id.email, name: id.displayName } : null
    },
    makeGit: gitFactory,
    validateUrl: validateRepoUrl,
    queue,
    appVersion: app.getVersion(),
    machineName: identity.get()?.machineName,
    onStatus: (status) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(REGISTRY_STATUS_CHANNEL, status)
    },
    onSynced: () => service.onSynced(),
  })
  registrySync = sync
  const store = new GitRepoStore({
    local,
    getEmail: () => identity.get()?.email ?? '',
    enqueue: async (op) => {
      await queue.enqueue(op)
      sync.notify()
    },
  })
  service = new RegistryService({
    sync, queue, reader, local, registryDir, identity, appVersion: app.getVersion(),
    consent: () => settingsStore.get('activityConsent') === true,
    getGitToken,
    isReserved: (id) => seedIds.has(id),
  })
  const runsDir = path.join(userData, 'runs')
  const bus = createBus()
  const grants = createGrants()

  registerSecretHandlers()
  registerSettingsHandlers()
  registerSystemHandlers()
  registerClaudeKeyHandlers()
  await initClaudeKey()
  await purgeLegacyAuthFiles()
  await seedBuiltIns(local)

  engine = createEngine({
    store,
    bus,
    runsDir,
    identity: () => identity.actor(),
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
  registerDataHandlers(store, runsDir, identity)
  registerDeliveryHandlers(engine, bus)
  const startRegistry = (firstLogin = false) => {
    void service.onLaunch()
    if (firstLogin) void service.logActivity('login')
    // Catch up once per engineer so pre-registry work is pushed without having to edit it first.
    const marker = path.join(userData, 'registry-backfill.json')
    void (async () => {
      const email = identity.get()?.email
      if (!email) return
      const done = await fs.readFile(marker, 'utf-8').then((t) => (JSON.parse(t) as { email?: string }).email === email, () => false)
      if (done) return
      const n = await store.backfill()
      await atomicWrite(marker, JSON.stringify({ email, at: new Date().toISOString(), documents: n }))
    })().catch((err) => log.warn('[registry] backfill failed', err))
    sync.start()
  }
  registerRegistryHandlers({ service, store, identity, defaults: registryDefaults, makeGit: gitFactory, onOnboarded: () => startRegistry(true), onIdentityChanged: () => startRegistry(true) })
  // A whitelisted run summary (never output/context) is queued for the registry when a delivery ends.
  bus.subscribe((event) => {
    if (event.type !== 'completed' && event.type !== 'failed' && event.type !== 'cancelled') return
    void store.getDelivery(event.deliveryId)
      .then((d) => (d ? service.recordRun(d) : undefined))
      .catch((err) => log.warn('[registry] run summary failed', err))
  })
  if (identity.get() && isOnboarded()) startRegistry()
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
  registrySync?.stop()
  engine.shutdown()
    .catch((err) => log.warn('shutdown failed', err))
    // Best-effort final push (bounded); anything unsent stays in the durable queue for next launch.
    .then(() => registrySync?.flush(4000))
    .catch((err) => log.warn('registry flush failed', err))
    .finally(() => app.quit())
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
