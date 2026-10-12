import { z } from 'zod'
import { JiraSiteSchema, SETTING_VALIDATORS } from '../../shared'
import type { RegistryStatus } from '../../shared'
import { handle } from './guard'
import { applySetting, setVerifiedIdentity, store as settingsStore } from './settings'
import { writeSecure, SECRET_KEYS } from './secrets'
import { setGitTokenSuffix } from './settings'
import { registerSecret, log } from '../log'
import type { IdentityProvider } from '../identity'
import type { RegistryService } from '../registry/service'
import type { RegistryDefaults } from '../registry/config'
import { testRegistryConnection } from '../registry/sync'
import type { GitFactory } from '../registry/sync'
import { verifyJiraIdentity, verifyGithubToken } from '../registry/onboarding'
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
  /** Starts the sync scheduler and records the launch once onboarding finishes. */
  onOnboarded: () => void
}

// Registry, identity, onboarding and versioning channels. Everything that proves identity (Jira
// /myself) or writes secrets happens here in main; the renderer only sees ok/error results.
export function registerRegistryHandlers(deps: RegistryIpcDeps): void {
  const { service, store, identity, defaults } = deps
  // Set by a successful Jira check; consumed by onboarding:complete. Never leaves main.
  let verified: { email: string; displayName: string; site: string } | null = null

  const effective = () => ({
    url: (settingsStore.get('registryUrl') as string) || defaults.url,
    branch: (settingsStore.get('registryBranch') as string) || defaults.branch || 'main',
  })

  // ---- identity
  handle('identity:get', z.tuple([]), () => {
    const id = identity.get()
    return {
      onboarded: !!id && settingsStore.get('setupComplete') === true,
      email: id?.email ?? '', displayName: id?.displayName ?? '', team: id?.team ?? '', machineName: id?.machineName ?? '',
    }
  })

  // ---- onboarding
  handle('onboarding:defaults', z.tuple([]), () => ({ registryUrl: effective().url, branch: effective().branch, jiraSite: settingsStore.get('jiraSite') || '' }))

  handle('onboarding:testRegistry', z.tuple([z.string().max(2048), z.string().max(120)]), async ([url, branch]) =>
    testRegistryConnection(deps.makeGit, url.trim() || effective().url, branch.trim() || effective().branch, validateRepoUrl))

  handle('onboarding:verifyJira', z.tuple([z.string().max(200), z.string().max(254), z.string().max(1024)]), async ([site, email, token]) => {
    const res = await verifyJiraIdentity({ site, email, token })
    if (!res.ok) return { ok: false, error: res.error }
    await writeSecure(SECRET_KEYS.jiraToken, token.trim())
    registerSecret(token.trim())
    const host = JiraSiteSchema.parse(site.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, ''))
    verified = { email: res.email as string, displayName: res.displayName ?? '', site: host }
    return { ok: true, email: res.email, displayName: res.displayName }
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
      const current = identity.get()
      if (!verified && !current) throw new Error('Verify your Jira account first')
      if (!input.activityConsent) throw new Error('Please accept the activity log notice to continue')
      // Validate through the same per-key validators the Settings screen uses.
      SETTING_VALIDATORS.registryUrl.parse(input.registryUrl)
      SETTING_VALIDATORS.registryBranch.parse(input.registryBranch)
      SETTING_VALIDATORS.team.parse(input.team)
      applySetting('registryUrl', input.registryUrl)
      applySetting('registryBranch', input.registryBranch)
      applySetting('team', input.team)
      applySetting('activityConsent', true)
      setVerifiedIdentity({
        userEmail: verified?.email ?? current!.email,
        userName: verified?.displayName ?? current!.displayName,
        jiraSite: verified?.site ?? ((settingsStore.get('jiraSite') as string) || ''),
        setupComplete: true,
      })
      verified = null
      log.info('[onboarding] complete')
      deps.onOnboarded()
      return { success: true }
    },
  )

  // ---- sync
  handle('registry:status', z.tuple([]), (): RegistryStatus => service.status())
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
