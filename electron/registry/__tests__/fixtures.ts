import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { simpleGit } from 'simple-git'
import type { SimpleGit } from 'simple-git'
import { buildGitEnv } from '../../security/gitAuth'
import { WriteQueue } from '../queue'
import { RegistrySync } from '../sync'
import type { GitFactory, SyncConfig } from '../sync'
import type { RegistryStatus } from '../../../shared'

// Local bare-repo fixtures: no network, no credentials.

export const noSleep = async () => {}

export function testGit(dir?: string): SimpleGit {
  return simpleGit({ ...(dir ? { baseDir: dir } : {}), allowEnvironment: ['GIT_TERMINAL_PROMPT'] }).env(buildGitEnv(process.env, {}))
}

export const plainFactory: GitFactory = async (dir) => testGit(dir)

export async function makeTmp(prefix = 'axon-reg-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** A bare "remote" with one commit on `main` (registry.yaml + an org block), like a real axon-registry. */
export async function createRemote(root: string, opts: { empty?: boolean; manifest?: string; files?: Record<string, string> } = {}): Promise<string> {
  const remote = path.join(root, 'remote.git')
  await fs.mkdir(remote, { recursive: true })
  await testGit(remote).raw(['init', '--bare', '-b', 'main'])
  if (opts.empty) return remote
  const seed = path.join(root, 'seed-clone')
  await fs.mkdir(seed, { recursive: true })
  const g = testGit(seed)
  await g.raw(['init', '-b', 'main'])
  await fs.writeFile(path.join(seed, 'registry.yaml'), opts.manifest ?? 'schemaVersion: 2\nminAppVersion: 0.0.0\n')
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(seed, rel)), { recursive: true })
    await fs.writeFile(path.join(seed, rel), content)
  }
  await g.raw(['add', '-A'])
  await g.raw(['-c', 'user.name=admin', '-c', 'user.email=admin@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
  await g.raw(['push', remote, 'HEAD:refs/heads/main'])
  return remote
}

export interface Client {
  email: string
  sync: RegistrySync
  queue: WriteQueue
  registryDir: string
  queueDir: string
  statuses: RegistryStatus[]
}

export async function createClient(
  root: string,
  name: string,
  remote: string,
  over: { email?: string; makeGit?: GitFactory; appVersion?: string; maxAttempts?: number; url?: () => string; onSynced?: () => Promise<void> } = {},
): Promise<Client> {
  const email = over.email ?? `${name}@example.com`
  const registryDir = path.join(root, name, 'registry')
  const queueDir = path.join(root, name, 'queue')
  const queue = new WriteQueue(queueDir, () => email)
  await queue.init()
  const statuses: RegistryStatus[] = []
  const cfg = (): SyncConfig => ({ url: over.url?.() ?? remote, branch: 'main', intervalMinutes: 5 })
  const sync = new RegistrySync({
    registryDir,
    getConfig: cfg,
    getUser: () => ({ email, name }),
    makeGit: over.makeGit ?? plainFactory,
    queue,
    appVersion: over.appVersion ?? '0.1.0',
    machineName: `${name}-pc`,
    sleep: noSleep,
    maxAttempts: over.maxAttempts ?? 5,
    onStatus: (s) => statuses.push(s),
    onSynced: () => over.onSynced?.() ?? Promise.resolve(),
  })
  return { email, sync, queue, registryDir, queueDir, statuses }
}

/** Contents of a file on the remote's `main` (null if absent), read via a throwaway clone. */
export async function remoteFile(root: string, remote: string, rel: string): Promise<string | null> {
  void root
  try {
    return await testGit(remote).raw(['show', `main:${rel}`])
  } catch {
    return null
  }
}

export async function remoteFiles(remote: string): Promise<string[]> {
  try {
    return (await testGit(remote).raw(['ls-tree', '-r', '--name-only', 'main'])).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- a whole "machine": store + registry stack

import { FileStore } from '../../store/fileStore'
import { GitRepoStore } from '../../store/gitRepoStore'
import { RegistryReader } from '../reader'
import { RuleStore } from '../../rules/ruleStore'
import { RegistryService } from '../service'
import { createIdentityProvider } from '../../identity'
import { seedBuiltIns } from '../../store/seed'

export async function createMachine(
  root: string,
  name: string,
  remote: string,
  over: Parameters<typeof createClient>[3] & { team?: string; consent?: boolean; token?: string | null; fetchImpl?: typeof fetch; watcherHere?: boolean } = {},
) {
  const hooks: { onSynced?: () => Promise<void>; service?: RegistryService } = {}
  const flags = { watcherHere: over.watcherHere ?? false }
  const client = await createClient(root, name, remote, { ...over, onSynced: () => hooks.onSynced?.() ?? Promise.resolve() })
  const identity = createIdentityProvider({
    readSettings: () => ({ userEmail: client.email, userName: `${name} Dev`, team: over.team ?? 'core' }),
    machineId: `00000000-0000-4000-8000-00000000000${name.length}`,
    machineName: `${name}-pc`,
  })
  const reader = new RegistryReader(client.registryDir, (id) => id.startsWith('axon-'))
  const local = new FileStore({ dir: path.join(root, name, 'store'), getOwner: () => client.email, definitions: reader })
  await seedBuiltIns(local)
  const store = new GitRepoStore({
    local,
    getEmail: () => client.email,
    enqueue: async (op) => { await client.queue.enqueue(op) },
  })
  const rules = new RuleStore({
    dir: path.join(root, name, 'rules'),
    getOwner: () => client.email,
    onSaved: (r) => hooks.service?.mirrorRule(r),
    onDeleted: (id) => hooks.service?.mirrorRuleDelete(id),
  })
  const service = new RegistryService({
    sync: client.sync, queue: client.queue, reader, local, registryDir: client.registryDir, identity, appVersion: '0.1.0',
    consent: () => over.consent ?? true, getGitToken: async () => (over.token === undefined ? 'ghp_fake' : over.token),
    isReserved: (id) => id.startsWith('axon-'), fetchImpl: over.fetchImpl,
    repoFromUrl: () => ({ owner: 'acme', repo: 'axon-registry' }),
    rules, isWatcherHere: () => flags.watcherHere, onWatcherYield: () => { flags.watcherHere = false },
  })
  hooks.service = service
  hooks.onSynced = () => service.onSynced()
  return { ...client, local, store, reader, service, identity, rules, flags }
}
export type Machine = Awaited<ReturnType<typeof createMachine>>
