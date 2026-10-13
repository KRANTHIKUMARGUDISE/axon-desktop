import { loadCatalog, registryHead } from '../registry/catalog'
import os from 'os'
import { app, clipboard } from 'electron'
import { z } from 'zod'
import { buildDiagnostics } from '../diagnostics'
import { claudeKeyMode } from './claudeKeyStore'
import { SETTING_VALIDATORS } from '../../shared'
import type { RegistryStatus } from '../../shared'
import { handle } from './guard'
import { applySetting, setVerifiedIdentity, setJiraVerifiedAt, readJiraIdentity, isOnboarded, store as settingsStore } from './settings'
import { writeSecure, getJiraToken, SECRET_KEYS } from './secrets'
import { setGitTokenSuffix } from './settings'
import { registerSecret, log } from '../log'
import type { IdentityProvider } from '../identity'
import type { RegistryService } from '../registry/service'
import type { RegistryDefaults } from '../registry/config'
import { testRegistryConnection } from '../registry/sync'
import type { GitFactory } from '../registry/sync'
import { verifyGithubToken } from '../registry/onboarding'
import { JiraAccount } from '../registry/jiraAccount'
import type { Store } from '../store/types'
import { validateRepoUrl } from '../security/gitAuth'

const Kind = z.enum(['block', 'pipeline'])
const Id = z.string().min(1).max(128)
const Meta = z.object({ versionLabel: z.string().max(60).optional(), changeNote: z.string().max(500).optional() }).optional()
const Target = z.union([
  z.object({ scope: z.literal('Org') }),
  z.object({ scope: z.literal('Team'), team: z.string().min(1).max(60) }),
])

export interface RegistryIpcDeps {
  service: RegistryService
  store: Store
  identity: IdentityProvider
  defaults: RegistryDefaults
  makeGit: GitFactory
  /** The local registry clone (read-only source of catalog/repositories.yaml). */
  registryDir: string
  /** Starts the sync scheduler and records the launch once onboarding finishes. */
  onOnboarded: () => void
  /** The verified Jira email changed (Settings → Jira → change account): re-point sync, profile and backfill at the new folder. */
  onIdentityChanged: () => void
}

// Registry, identity, onboarding and versioning channels. Everything that proves identity (Jira
// /myself) or writes secrets happens here in main; the renderer only sees ok/error results.
export function registerRegistryHandlers(deps: RegistryIpcDeps): void {
  const { service, store, identity, defaults } = deps
  // The Jira account is the AXON identity. All changes to it (token, account, site) go through JiraAccount: a new
  // account is verified and held in memory, and only persisted (token + identity together) on commit.
  const jira = new JiraAccount({
    getIdentity: readJiraIdentity,
    readToken: getJiraToken,
    writeToken: async (token) => {
      await writeSecure(SECRET_KEYS.jiraToken, token)
      registerSecret(token)
    },
    saveIdentity: (r) => setVerifiedIdentity({ userEmail: r.email, userName: r.displayName, jiraSite: r.site, jiraVerifiedAt: r.verifiedAt, setupComplete: true }),
    markVerified: setJiraVerifiedAt,
  })

  const effective = () => ({
    url: (settingsStore.get('registryUrl') as string) || defaults.url,
    branch: (settingsStore.get('registryBranch') as string) || defaults.branch || 'main',
  })

  // ---- identity
  handle('identity:get', z.tuple([]), () => {
    const id = identity.get()
    return {
      onboarded: !!id && isOnboarded(),
      email: id?.email ?? '', displayName: id?.displayName ?? '', team: id?.team ?? '', machineName: id?.machineName ?? '',
    }
  })

  // ---- onboarding
  handle('onboarding:defaults', z.tuple([]), () => ({ registryUrl: effective().url, branch: effective().branch, jiraSite: settingsStore.get('jiraSite') || '' }))

  handle('onboarding:testRegistry', z.tuple([z.string().max(2048), z.string().max(120)]), async ([url, branch]) =>
    testRegistryConnection(deps.makeGit, url.trim() || effective().url, branch.trim() || effective().branch, validateRepoUrl))

  handle('onboarding:verifyJira', z.tuple([z.string().max(200), z.string().max(254), z.string().max(1024)]), async ([site, email, token]) => {
    const res = await jira.stage(site, email, token)
    return res.ok ? { ok: true, email: res.email, displayName: res.displayName } : { ok: false, error: res.error }
  })

  handle('onboarding:verifyGithub', z.tuple([z.string().max(1024)]), async ([token]) => {
    const res = await verifyGithubToken(token)
    if (!res.ok) return { ok: false, error: res.error }
    await writeSecure(SECRET_KEYS.gitToken, token.trim())
    registerSecret(token.trim())
    setGitTokenSuffix(token.trim().slice(-4))
    return { ok: true, login: res.login }
  })

  handle(
    'onboarding:complete',
    z.tuple([z.object({
      registryUrl: z.string().max(2048).default(''), registryBranch: z.string().max(120).default(''),
      team: z.string().max(60).default(''), activityConsent: z.boolean(),
    })]),
    async ([input]) => {
      if (!jira.hasStaged()) throw new Error('Verify your Jira account first')
      if (!input.activityConsent) throw new Error('Please accept the activity log notice to continue')
      // Validate through the same per-key validators the Settings screen uses.
      SETTING_VALIDATORS.registryUrl.parse(input.registryUrl)
      SETTING_VALIDATORS.registryBranch.parse(input.registryBranch)
      SETTING_VALIDATORS.team.parse(input.team)
      applySetting('registryUrl', input.registryUrl)
      applySetting('registryBranch', input.registryBranch)
      applySetting('team', input.team)
      applySetting('activityConsent', true)
      await jira.commit()
      log.info('[onboarding] complete')
      deps.onOnboarded()
      return { success: true }
    },
  )

  // ---- Settings → Jira (read-only identity, token replacement, connection test, change account)
  handle('jira:status', z.tuple([]), () => jira.status())
  handle('jira:replaceToken', z.tuple([z.string().max(1024)]), ([token]) => jira.replaceToken(token))
  handle('jira:test', z.tuple([]), () => jira.test())
  handle('jira:stageChange', z.tuple([z.string().max(200), z.string().max(254), z.string().max(1024)]), ([site, email, token]) => jira.stage(site, email, token))
  handle('jira:cancelChange', z.tuple([]), () => jira.cancel())
  handle('jira:commitChange', z.tuple([]), async () => {
    const res = await jira.commit()
    log.info(`[jira] account changed (identityChanged=${res.identityChanged})`)
    if (res.identityChanged) deps.onIdentityChanged()
    return { success: true, identityChanged: res.identityChanged, email: res.email }
  })

  // ---- support: "Copy diagnostics" (allow-listed facts only — see electron/diagnostics.ts)
  handle('system:copyDiagnostics', z.tuple([]), async () => {
    const s = service.status()
    const text = buildDiagnostics({
      claudeKeyMode: claudeKeyMode(),
      catalogVersion: (await registryHead(deps.registryDir)) ?? '',
      appVersion: app.getVersion(), electronVersion: process.versions.electron, nodeVersion: process.versions.node,
      platform: process.platform, arch: process.arch, osRelease: os.release(),
      registry: { url: s.registryUrl, state: s.state, lastSyncAt: s.lastSyncAt, queued: s.queued },
    })
    clipboard.writeText(text)
    return text
  })

  // ---- sync
  handle('registry:status', z.tuple([]), (): RegistryStatus => service.status())

  // Settings -> Registry -> Repository catalog: what the Workspace Provisioner will accept, and why anything was dropped.
  handle('registry:catalog', z.tuple([]), async () => {
    const c = await loadCatalog(deps.registryDir)
    return { ...c, lastSyncAt: service.status().lastSyncAt }
  })
  handle('registry:syncNow', z.tuple([]), () => service.syncNow())

  // ---- D13 versioning + promotion
  handle('versions:list', z.tuple([Kind, Id]), ([kind, id]) => store.listVersions(kind, id))
  handle('versions:publish', z.tuple([Kind, Id, Meta]), ([kind, id, meta]) => store.publish(kind, id, meta ?? {}))
  handle('versions:deprecate', z.tuple([Kind, Id]), ([kind, id]) => store.deprecate(kind, id))
  handle('versions:duplicate', z.tuple([Kind, Id]), ([kind, id]) => store.duplicate(kind, id))
  handle('versions:promote', z.tuple([Kind, Id, Target, z.string().max(1000).optional()]), async ([kind, id, target, note]) => {
    const res = await service.promote(kind, id, target, note)
    return { prUrl: res.prUrl, branch: res.branch, version: res.version }
  })
}
