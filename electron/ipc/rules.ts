import { z } from 'zod'
import { SaveRuleInputSchema, pipelineEffects, ruleChains, validatePipeline, unprovidedInputs, diffPipelines } from '../../shared'
import type { PipelineDiff } from '../../shared'
import type { ValidatorBlock } from '../../shared'
import type { ChainBlock, ChainRule, PipelineEffects } from '../../shared'
import type { DeliveryRule, WatcherInfo } from '../../shared'
import { handle } from './guard'
import { resolveInside } from '../security/paths'
import type { RuleStore } from '../rules/ruleStore'
import type { Watcher } from '../watcher/watcher'
import type { Store } from '../store/types'
import type { RegistryService } from '../registry/service'
import type { JiraClient, PermissionReport } from '../jira/client'
import { JiraError } from '../jira/client'
import { log } from '../log'

const Id = z.string().min(1).max(128)
const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9_]+$/)

export interface RulesIpcDeps {
  rules: RuleStore
  watcher: Watcher
  store: Store
  service: RegistryService
  makeClient: () => Promise<JiraClient | null>
  getWorkspaceRoot: () => string
  isWatcherHere: () => boolean
  setWatcherHere: (v: boolean) => void
}

/** Missing-permission messages, or the reason Jira could not be asked at all. */
export async function permissionReport(makeClient: RulesIpcDeps['makeClient'], projectKey: string): Promise<PermissionReport> {
  const client = await makeClient()
  if (!client) return { ok: false, missing: ['Jira is not connected: add your Jira API token in Settings → Accounts → Jira.'] }
  try {
    return await client.checkPermissions(projectKey)
  } catch (err) {
    if (err instanceof JiraError && err.status === 404) return { ok: false, missing: [`Jira project ${projectKey} was not found (or you cannot see it).`] }
    return { ok: false, missing: [err instanceof Error ? err.message : 'Could not check Jira permissions.'] }
  }
}

// Watcher rules, the active-machine switch and the Jira permission check. Everything that talks to Jira stays in main.
export function registerRulesHandlers(deps: RulesIpcDeps): { info: () => Promise<WatcherInfo> } {
  const { rules, watcher, store, service } = deps

  /** What each rule triggers on and what its pinned pipeline sets in Jira. */
  async function chainInfo(): Promise<WatcherInfo['chains']> {
    const all = await rules.list()
    const blockCache = new Map<string, ChainBlock | undefined>()
    const effects: Record<string, PipelineEffects> = {}
    const chainRules: ChainRule[] = []
    for (const r of all) {
      const p = await store.getPipelineVersion(r.pipelineId, r.pipelineVersion).catch(() => null)
      const blocks = new Map<string, ChainBlock>()
      for (const n of p?.nodes ?? []) {
        if (n.type === 'forEach' || blocks.has(n.blockId)) continue
        if (!blockCache.has(n.blockId)) blockCache.set(n.blockId, (await store.getBlock(n.blockId).catch(() => null)) ?? undefined)
        const b = blockCache.get(n.blockId)
        if (b) blocks.set(n.blockId, { id: b.id, role: b.role, artifactName: b.artifactName })
      }
      effects[r.id] = pipelineEffects(p?.nodes ?? [], blocks)
      chainRules.push({ id: r.id, name: r.name, jiraProjectKey: r.jiraProjectKey, readyLabel: r.readyLabel, readyStatus: r.readyStatus, effects: effects[r.id] })
    }
    const { rules: info, warnings } = ruleChains(chainRules.filter((c) => all.find((r) => r.id === c.id)?.enabled !== false))
    return { rules: info, warnings, effects }
  }

  async function info(): Promise<WatcherInfo> {
    const [role, status, paused, chains] = await Promise.all([service.watcherStatus(), watcher.status(), service.isPaused(), chainInfo()])
    return {
      paused,
      chains,
      role: {
        thisMachineName: role.thisMachineName,
        activeHere: role.activeHere,
        claimedHere: role.claimedHere,
        other: role.other ? { name: role.other.name, heartbeatAt: role.other.heartbeatAt, stale: role.other.stale } : null,
      },
      rules: status.rules,
      orphans: status.orphans,
      pendingWritebacks: status.pendingWritebacks,
    }
  }

  /** The pinned pipeline version must exist and be published; a default Workspace path must sit inside the Workspace Root (D18). */
  async function validate(rule: Pick<DeliveryRule, 'pipelineId' | 'pipelineVersion' | 'defaultWorkspacePath'>): Promise<void> {
    const pipeline = await store.getPipelineVersion(rule.pipelineId, rule.pipelineVersion)
    if (!pipeline) throw new Error(`Pipeline version v${rule.pipelineVersion} was not found. Publish the pipeline first, then pin that version.`)
    if (pipeline.status === 'Draft') throw new Error(`Pipeline v${rule.pipelineVersion} is a draft. Rules pin a published version.`)
    // The pinned version must be able to run on its own: valid, and every input it needs provided (a rule starts it with no manual inputs).
    const blocks = new Map<string, ValidatorBlock>()
    for (const n of pipeline.nodes) {
      if (n.type === 'forEach' || blocks.has(n.blockId)) continue
      const b = (n.blockVersion !== undefined ? await store.getBlockVersion(n.blockId, n.blockVersion) : null) ?? (await store.getBlock(n.blockId))
      if (b) blocks.set(n.blockId, b)
    }
    const check = validatePipeline(pipeline.nodes, pipeline.edges, blocks)
    const missing = unprovidedInputs(pipeline.nodes, pipeline.edges, blocks).map((u) => `"${u.node}" needs "${u.field}", which no earlier block returns`)
    const problems = [...check.errors, ...missing]
    if (problems.length) throw new Error(`Pipeline "${pipeline.name}" v${rule.pipelineVersion} cannot run from a rule yet: ${problems.join('; ')}. Fix the pipeline, publish a new version and pin it.`)
    if (rule.defaultWorkspacePath && !resolveInside(rule.defaultWorkspacePath, [deps.getWorkspaceRoot()])) {
      throw new Error(`Workspace path must be inside the Workspace Root: ${rule.defaultWorkspacePath}`)
    }
  }

  handle('rules:list', z.tuple([]), () => rules.list())

  handle('rules:save', z.tuple([z.unknown()]), async ([input]) => {
    const parsed = SaveRuleInputSchema.parse(input)
    await validate(parsed)
    // Enabled only when the engineer asks for it, and then only if Jira allows it (same check as the Enable button).
    if (parsed.enabled) {
      const report = await permissionReport(deps.makeClient, parsed.jiraProjectKey)
      if (!report.ok) throw new Error(report.missing.join(' '))
    }
    return rules.save(parsed)
  })

  handle('rules:setEnabled', z.tuple([Id, z.boolean()]), async ([id, enabled]) => {
    const rule = await rules.get(id)
    if (!rule) throw new Error('Rule not found')
    if (enabled) {
      await validate(rule)
      const report = await permissionReport(deps.makeClient, rule.jiraProjectKey)
      if (!report.ok) throw new Error(report.missing.join(' '))
    }
    return rules.setEnabled(id, enabled)
  })

  handle('rules:delete', z.tuple([Id]), ([id]) => rules.delete(id))

  // What changed between two published versions of a pipeline, in plain words (shown before a rule moves to a newer one).
  handle('rules:compareVersions', z.tuple([Id, z.number().int().min(1), z.number().int().min(1)]), async ([pipelineId, fromV, toV]): Promise<PipelineDiff> => {
    const [a, b] = await Promise.all([store.getPipelineVersion(pipelineId, fromV), store.getPipelineVersion(pipelineId, toV)])
    if (!a || !b) throw new Error('One of the pipeline versions was not found')
    const names = new Map<string, string>()
    const blocksFor = async (nodes: typeof a.nodes) => {
      const map = new Map<string, ChainBlock>()
      for (const n of nodes) {
        if (n.type === 'forEach' || map.has(n.blockId)) continue
        const blk = (n.blockVersion !== undefined ? await store.getBlockVersion(n.blockId, n.blockVersion) : null) ?? (await store.getBlock(n.blockId))
        if (blk) { map.set(n.blockId, { id: blk.id, role: blk.role, artifactName: blk.artifactName }); names.set(blk.id, blk.name) }
      }
      return map
    }
    const [ba, bb] = [await blocksFor(a.nodes), await blocksFor(b.nodes)]
    const side = (p: typeof a) => ({ version: p.version, versionLabel: p.versionLabel, changeNote: p.changeNote, nodes: p.nodes, edges: p.edges, onFailure: p.onFailure, onFailureOnCancel: p.onFailureOnCancel })
    return diffPipelines(side(a), side(b), {
      blockName: (id) => names.get(id) ?? id,
      effects: { from: pipelineEffects(a.nodes, ba), to: pipelineEffects(b.nodes, bb) },
    })
  })

  handle('jira:checkPermissions', z.tuple([ProjectKey]), ([projectKey]) => permissionReport(deps.makeClient, projectKey))

  handle('watcher:status', z.tuple([]), () => info())

  handle('watcher:setActiveHere', z.tuple([z.boolean()]), async ([active]) => {
    deps.setWatcherHere(active)
    // The profile carries the heartbeat (or clears it on release); sync pushes it to the other machines.
    await service.updateProfile({ takeover: active }).catch((err) => log.warn('[watcher] profile update failed', err))
    if (active) void watcher.reconcile().catch((err) => log.warn('[watcher] reconcile failed', err))
    return info()
  })

  handle('watcher:setPaused', z.tuple([z.boolean()]), async ([paused]) => {
    await service.setPaused(paused)
    return info()
  })

  handle('watcher:checkNow', z.tuple([Id]), async ([ruleId]) => {
    await watcher.checkRule(ruleId)
    return info()
  })

  handle('watcher:retryWritebacks', z.tuple([]), async () => {
    await watcher.retryWritebacks()
    return info()
  })

  handle('watcher:resolveOrphan', z.tuple([z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/), z.enum(['resume', 'release'])]), async ([key, choice]) => {
    await watcher.resolveOrphan(key, choice)
    return info()
  })

  return { info }
}
