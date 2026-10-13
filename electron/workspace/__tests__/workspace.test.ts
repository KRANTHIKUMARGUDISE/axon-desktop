import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { testGit } from '../../registry/__tests__/fixtures'
import type { GitFactory, CatalogRepo } from '../provisioner'
import { provisionWorkspace, removeDeliveryWorkspace, directorySize, TICKET_KEY, deliveryBranchName } from '../provisioner'
import { createPullRequests, changedPaths, reposFromCwds } from '../prCreator'
import { parseCatalog, parseCatalogDetailed, loadCatalog } from '../../registry/catalog'
import { runNativeBlock } from '../../runners/native/registry'
import type { RunnerInput } from '../../runners/types'
import type { Block } from '../../../shared'

let root: string
let cloneCalls = 0

// Counts mirror clones so reuse (fetch only) can be asserted.
const factory: GitFactory = async (dir) => {
  const g = testGit(dir)
  const raw = g.raw.bind(g)
  g.raw = ((args: string[]) => {
    if (Array.isArray(args) && args.includes('clone')) cloneCalls++
    return raw(args)
  }) as typeof g.raw
  return g
}

const ident = ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com']

async function makeRemote(name: string, defaultBranch = 'trunk', files: Record<string, string> = { 'README.md': 'hi\n' }): Promise<CatalogRepo> {
  const bare = path.join(root, 'remotes', `${name}.git`)
  const seed = path.join(root, 'seeds', name)
  await fs.mkdir(bare, { recursive: true })
  await fs.mkdir(seed, { recursive: true })
  await testGit(bare).raw(['init', '--bare', '-b', defaultBranch])
  const g = testGit(seed)
  await g.raw(['init', '-b', defaultBranch])
  await g.raw(['config', 'core.longpaths', 'true'])
  await g.raw(['config', 'core.autocrlf', 'false'])
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seed, rel)), { recursive: true })
    await fs.writeFile(path.join(seed, rel), content)
  }
  await g.raw(['add', '-A'])
  await g.raw([...ident, 'commit', '-m', 'init'])
  await g.raw(['remote', 'add', 'origin', bare])
  await g.raw(['push', 'origin', defaultBranch])
  return { name, url: bare }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'axon ws test-')) // a space in the path on purpose
  cloneCalls = 0
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })

const deps = (catalog: CatalogRepo[], workspaceRoot = path.join(root, 'work')) => ({ makeGit: factory, workspaceRoot, catalog })

describe('workspace-provisioner', () => {
  it('provisions two repos: bare mirrors, a worktree per delivery, default branch detected (not main/master)', async () => {
    const api = await makeRemote('api')
    const web = await makeRemote('web', 'develop')
    const out = await provisionWorkspace(deps([api, web]), {
      deliveryId: 'aaaaaaaa-1111', ticketId: 'PROJ-12', username: 'Dev User', repositories: [{ url: api.url }, { url: web.url }],
    })
    expect(out.provisionedRepos.map((r) => [r.name, r.baseBranch])).toEqual([['api', 'trunk'], ['web', 'develop']])
    expect(out.workspacePath).toBe(path.join(root, 'work', 'deliveries', 'aaaaaaaa-1111'))
    for (const r of out.provisionedRepos) {
      expect(r.worktreePath).toBe(path.join(out.workspacePath, r.name))
      expect((await testGit(r.worktreePath).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(r.branch)
      expect((await fs.readFile(path.join(r.worktreePath, 'README.md'), 'utf8')).trim()).toBe('hi')
      expect(r.branch).toMatch(/^axon\/dev-user\/PROJ-12-[a-z2-7]{6}$/)
    }
    await fs.stat(path.join(root, 'work', 'mirrors', 'api.git', 'HEAD'))
    expect(cloneCalls).toBe(2)
  })

  it('a second delivery reuses the mirror (fetch only) and gets its own worktree + branch', async () => {
    const api = await makeRemote('api')
    const d = deps([api])
    const one = await provisionWorkspace(d, { deliveryId: 'aaaaaaaa-1', ticketId: 'PROJ-1', username: 'u', repositories: [{ url: api.url }] })
    // the remote moves on; the second delivery must see it via fetch
    const seed = path.join(root, 'seeds', 'api')
    await fs.writeFile(path.join(seed, 'new.txt'), 'later\n')
    await testGit(seed).raw(['add', '-A'])
    await testGit(seed).raw([...ident, 'commit', '-m', 'later'])
    await testGit(seed).raw(['push', 'origin', 'trunk'])
    const two = await provisionWorkspace(d, { deliveryId: 'bbbbbbbb-2', ticketId: 'PROJ-1', username: 'u', repositories: [{ url: api.url }] })
    expect(cloneCalls).toBe(1)
    expect(two.provisionedRepos[0].branch).not.toBe(one.provisionedRepos[0].branch) // rerun of the same ticket: no collision
    expect(two.provisionedRepos[0].worktreePath).not.toBe(one.provisionedRepos[0].worktreePath)
    expect((await fs.readFile(path.join(two.provisionedRepos[0].worktreePath, 'new.txt'), 'utf8')).trim()).toBe('later')
    await expect(fs.stat(path.join(one.provisionedRepos[0].worktreePath, 'new.txt'))).rejects.toThrow()
  })

  it('re-provisioning the same delivery is idempotent (resume after a failed step)', async () => {
    const api = await makeRemote('api')
    const input = { deliveryId: 'cccccccc-3', ticketId: 'PROJ-3', username: 'u', repositories: [{ url: api.url }] }
    const a = await provisionWorkspace(deps([api]), input)
    const b = await provisionWorkspace(deps([api]), input)
    expect(b.provisionedRepos[0].worktreePath).toBe(a.provisionedRepos[0].worktreePath)
  })

  it('rejects a repository that is not in the catalog, before touching the disk', async () => {
    const api = await makeRemote('api')
    const rogue = await makeRemote('rogue')
    await expect(provisionWorkspace(deps([api]), {
      deliveryId: 'dddddddd-4', ticketId: 'PROJ-4', username: 'u', repositories: [{ url: api.url }, { url: rogue.url }],
    })).rejects.toThrow(/not in the catalog/)
    await expect(fs.stat(path.join(root, 'work'))).rejects.toThrow()
  })

  it('validates the ticket key (rejects ../x and lowercase)', async () => {
    const api = await makeRemote('api')
    for (const bad of ['../x', 'proj-1', 'PROJ-', 'A-1', 'PROJ-1/../..']) {
      await expect(provisionWorkspace(deps([api]), { deliveryId: 'eeeeeeee-5', ticketId: bad, username: 'u', repositories: [{ url: api.url }] }))
        .rejects.toThrow(/Invalid ticket key/)
    }
    expect(TICKET_KEY.test('AB1-100')).toBe(true)
  })

  it('works with spaces in the workspace root and with paths beyond 260 characters', async () => {
    const deep = Array.from({ length: 12 }, (_, i) => `directory-segment-number-${i}`).join('/') + '/file.txt'
    const api = await makeRemote('api', 'trunk', { 'README.md': 'x', [deep]: 'deep\n' })
    const longRoot = path.join(root, 'a folder with spaces', 'x'.repeat(35), 'y'.repeat(35))
    const out = await provisionWorkspace(deps([api], longRoot), { deliveryId: 'ffffffff-6', ticketId: 'PROJ-6', username: 'u', repositories: [{ url: api.url }] })
    const full = path.join(out.provisionedRepos[0].worktreePath, deep)
    expect(full.length).toBeGreaterThan(260)
    expect((await fs.readFile(full, 'utf8')).trim()).toBe('deep')
  })

  it('removes a delivery workspace (worktrees pruned), keeps the mirror, and reports size', async () => {
    const api = await makeRemote('api')
    const out = await provisionWorkspace(deps([api]), { deliveryId: 'gggggggg-7', ticketId: 'PROJ-7', username: 'u', repositories: [{ url: api.url }] })
    expect(await directorySize(out.workspacePath)).toBeGreaterThan(0)
    await removeDeliveryWorkspace({ makeGit: factory, workspaceRoot: path.join(root, 'work') }, 'gggggggg-7')
    await expect(fs.stat(out.workspacePath)).rejects.toThrow()
    await fs.stat(path.join(root, 'work', 'mirrors', 'api.git', 'HEAD'))
    const list = await testGit(path.join(root, 'work', 'mirrors', 'api.git')).raw(['worktree', 'list'])
    expect(list).not.toMatch(/gggggggg/)
  })

  it('branch names follow D1', () => {
    expect(deliveryBranchName('0123abcd-ef', 'PROJ-9', 'Ann Lee')).toMatch(/^axon\/ann-lee\/PROJ-9-[a-z2-7]{6}$/)
  })
})

describe('catalog', () => {
  it('parses valid entries and drops malformed ones', () => {
    const text = 'repositories:\n  - name: api\n    url: https://github.com/acme/api.git\n  - name: ../evil\n    url: https://x/y\n  - name: bad\n    url: file:///etc\n  - name: api\n    url: https://github.com/acme/dup\n'
    expect(parseCatalog(text).map((r) => r.name)).toEqual(['api'])
    expect(parseCatalog('not: yaml: [')).toEqual([])
  })
})

describe('catalog visibility', () => {
  it('reports dropped entries with the reason instead of dropping them silently', () => {
    const text = [
      'repositories:',
      '  - name: api', '    url: https://github.com/acme/api.git',
      '  - name: ../evil', '    url: https://github.com/acme/evil',
      '  - name: local', '    url: file:///etc/passwd',
      '  - name: nourl',
      '  - name: API', '    url: https://github.com/acme/other',
      '  - just-a-string',
    ].join('\n')
    const r = parseCatalogDetailed(text)
    expect(r.entries.map((e) => e.name)).toEqual(['api'])
    expect(r.dropped.map((d) => [d.index, d.name])).toEqual([[2, '../evil'], [3, 'local'], [4, 'nourl'], [5, 'API'], [6, undefined]])
    expect(r.dropped[0].reason).toMatch(/folder-safe/)
    expect(r.dropped[1].reason).toMatch(/https:\/\/, ssh:\/\/ or git@host:path/)
    expect(r.dropped[2].reason).toMatch(/url/)
    expect(r.dropped[3].reason).toMatch(/duplicate name/)
  })

  it('explains an unusable file and a missing file; exposes the registry file path', async () => {
    expect(parseCatalogDetailed('repositories: nope').error).toMatch(/"repositories:" list/)
    expect(parseCatalogDetailed('a: [').error).toMatch(/not valid YAML/)
    const missing = await loadCatalog(path.join(root, 'registry'))
    expect(missing).toMatchObject({ exists: false, entries: [], registryPath: 'catalog/repositories.yaml' })
    expect(missing.filePath).toBe(path.join(root, 'registry', 'catalog', 'repositories.yaml'))
    await fs.mkdir(path.join(root, 'registry', 'catalog'), { recursive: true })
    await fs.writeFile(missing.filePath, 'repositories:\n  - name: api\n    url: https://github.com/acme/api.git\n')
    expect(await loadCatalog(path.join(root, 'registry'))).toMatchObject({ exists: true, entries: [{ name: 'api' }], dropped: [] })
  })

  it('the not-in-the-catalog error says how many repos the catalog has and when it was last synced', async () => {
    const api = await makeRemote('api')
    const services = {
      getCatalog: async () => [api], lastCatalogSyncAt: () => '2026-10-13T10:00:00.000Z',
      getWorkspaceRoot: () => path.join(root, 'work'), username: () => 'dev', makeGit: factory,
    } as never
    const input: RunnerInput = {
      deliveryId: 'kkkkkkkk-1', block: { artifactName: 'workspace-provisioner', agentRuntime: 'Axon' } as unknown as Block, nodeLabel: 'prov', instructions: '',
      deliveryContext: { ticketId: 'PROJ-1', previousStepsResults: {}, currentInputs: { workItemList: { items: [{ key: 'a', task: 't', repo: 'ghost' }] } } },
      workspacePath: root, effectiveTools: [], timeoutSeconds: 5, signal: new AbortController().signal,
    }
    await expect(runNativeBlock(input, services)).rejects.toThrow(/is not in the catalog: 1 repos in catalog; last synced .*2026.*; Settings → Registry to check/)
    const never = { ...(services as object), lastCatalogSyncAt: () => null } as never
    await expect(runNativeBlock(input, never)).rejects.toThrow(/last synced never; Settings → Registry to check/)
  })
})

describe('pr-creator', () => {
  async function setup(names: string[]) {
    const remotes = await Promise.all(names.map((n) => makeRemote(n)))
    const out = await provisionWorkspace(deps(remotes), {
      deliveryId: 'hhhhhhhh-8', ticketId: 'PROJ-8', username: 'u', repositories: remotes.map((r) => ({ url: r.url })),
    })
    // PR provider/URL is what GitHub would see; pushes still go to the local bare repo.
    const repos = out.provisionedRepos.map((r) => ({ ...r, url: `https://github.com/acme/${r.name}` }))
    const pushUrl = (r: { name: string }) => remotes.find((x) => x.name === r.name)!.url
    return { remotes, repos, pushUrl }
  }

  const ghFetch = (existing: Record<string, { html_url: string; number: number }> = {}) => {
    const calls: { method: string; url: string; body?: { title?: string; body?: string } }[] = []
    const fn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const repo = /repos\/acme\/([^/]+)\//.exec(url)![1]
      const json = method === 'GET'
        ? (existing[repo] ? [existing[repo]] : [])
        : { html_url: `https://github.com/acme/${repo}/pull/${repo === 'api' ? 1 : 2}`, number: repo === 'api' ? 1 : 2 }
      return { ok: true, status: 200, json: async () => json, text: async () => '' } as Response
    })
    return { fn: fn as unknown as typeof fetch, calls }
  }

  const write = (repo: { worktreePath: string }, rel: string, content = 'change\n') =>
    fs.mkdir(path.dirname(path.join(repo.worktreePath, rel)), { recursive: true }).then(() => fs.writeFile(path.join(repo.worktreePath, rel), content))

  it('2 repos with changes -> 2 linked PRs; explicit paths only, no AXON files; pushed to the branch', async () => {
    const { remotes, repos, pushUrl } = await setup(['api', 'web'])
    await write(repos[0], 'src/feature.ts')
    await write(repos[0], '.axon/scratch.json')
    await write(repos[1], 'docs/change.md')
    expect(await changedPaths(testGit(repos[0].worktreePath))).toEqual(['src/feature.ts'])

    const gh = ghFetch()
    const res = await createPullRequests(
      { makeGit: factory, getToken: async () => 'tok', fetchFn: gh.fn, pushUrl, committer: { name: 'T', email: 't@example.com' } },
      { ticketId: 'PROJ-8', title: 'Do it', acceptanceCriteria: ['works', 'tested'], repos },
    )
    expect(res.prUrls).toEqual([
      { repo: 'api', url: 'https://github.com/acme/api/pull/1' },
      { repo: 'web', url: 'https://github.com/acme/web/pull/2' },
    ])
    const posts = gh.calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0].body).toMatchObject({ title: 'PROJ-8: Do it', head: repos[0].branch, base: 'trunk' })
    expect(posts[0].body?.body).toContain('- works')
    // sibling links are added in a second pass
    const patches = gh.calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(2)
    expect(patches[0].body?.body).toContain('web: https://github.com/acme/web/pull/2')
    expect(patches[1].body?.body).toContain('api: https://github.com/acme/api/pull/1')
    // the branch exists on the remote with exactly the staged file
    const files = (await testGit(remotes[0].url).raw(['ls-tree', '-r', '--name-only', repos[0].branch])).split('\n')
    expect(files).toContain('src/feature.ts')
    expect(files.some((f) => f.startsWith('.axon'))).toBe(false)
  })

  it('finds an existing PR for the head branch instead of creating a second one', async () => {
    const { repos, pushUrl } = await setup(['api'])
    await write(repos[0], 'a.txt')
    const gh = ghFetch({ api: { html_url: 'https://github.com/acme/api/pull/77', number: 77 } })
    const res = await createPullRequests({ makeGit: factory, getToken: async () => 'tok', fetchFn: gh.fn, pushUrl, committer: { name: 'T', email: 't@example.com' } }, { ticketId: 'PROJ-8', title: 't', repos })
    expect(res.prUrls[0].url).toBe('https://github.com/acme/api/pull/77')
    expect(gh.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(gh.calls[0].url).toContain('head=acme%3A')
  })

  it('skips repos without changes', async () => {
    const { repos, pushUrl } = await setup(['api', 'web'])
    await write(repos[1], 'only-web.txt')
    const gh = ghFetch()
    const res = await createPullRequests({ makeGit: factory, getToken: async () => 'tok', fetchFn: gh.fn, pushUrl, committer: { name: 'T', email: 't@example.com' } }, { ticketId: 'PROJ-8', title: 't', repos })
    expect(res.prUrls.map((p) => p.repo)).toEqual(['web'])
    expect(res.skipped).toEqual([{ repo: 'api', reason: 'no changes' }])
  })

  it('a push failure throws with a reason (so the delivery fails, never completes)', async () => {
    const { repos } = await setup(['api'])
    await write(repos[0], 'a.txt')
    const gh = ghFetch()
    await expect(createPullRequests(
      { makeGit: factory, getToken: async () => 'tok', fetchFn: gh.fn, pushUrl: () => path.join(root, 'missing.git'), committer: { name: 'T', email: 't@example.com' } },
      { ticketId: 'PROJ-8', title: 't', repos },
    )).rejects.toThrow(/Push failed for api/)
    expect(gh.calls).toHaveLength(0)
  })

  it('a 403 from GitHub explains what the token needs and that the branch was already pushed', async () => {
    const { remotes, repos, pushUrl } = await setup(['api'])
    await write(repos[0], 'a.txt')
    const forbidden = (async () => ({
      ok: false, status: 403, text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token', documentation_url: 'https://docs.github.com/rest/pulls/pulls' }),
    })) as unknown as typeof fetch
    await expect(createPullRequests(
      { makeGit: factory, getToken: async () => 'tok', fetchFn: forbidden, pushUrl, committer: { name: 'T', email: 't@example.com' } },
      { ticketId: 'PROJ-8', title: 't', repos },
    )).rejects.toThrow(/GitHub refused access to acme\/api \(HTTP 403: Resource not accessible by personal access token\).*Pull requests: Read and write.*already pushed/)
    expect((await testGit(remotes[0].url).raw(['branch', '--list', repos[0].branch])).trim()).toContain(repos[0].branch)
  })

  it('a non-GitHub provider fails with a clear message before pushing', async () => {
    const { repos, pushUrl } = await setup(['api'])
    await write(repos[0], 'a.txt')
    const gh = ghFetch()
    await expect(createPullRequests(
      { makeGit: factory, getToken: async () => 'tok', fetchFn: gh.fn, pushUrl },
      { ticketId: 'PROJ-8', title: 't', repos: [{ ...repos[0], url: 'https://dev.azure.com/org/proj/_git/api' }] },
    )).rejects.toThrow(/only supported for GitHub/)
  })

  it('fails clearly when no git token is configured for the PR call', async () => {
    const { repos, pushUrl } = await setup(['api'])
    await write(repos[0], 'a.txt')
    await expect(createPullRequests(
      { makeGit: factory, getToken: async () => null, fetchFn: ghFetch().fn, pushUrl, committer: { name: 'T', email: 't@example.com' } },
      { ticketId: 'PROJ-8', title: 't', repos },
    )).rejects.toThrow(/no Git token/)
  })
})

describe('workspace-provisioner block (D16)', () => {
  const run = async (catalog: CatalogRepo[], workItemList: unknown) => {
    const services = {
      getCatalog: async () => catalog, getWorkspaceRoot: () => path.join(root, 'work'), username: () => 'dev', makeGit: factory,
    } as never
    const input: RunnerInput = {
      deliveryId: 'iiiiiiii-9', block: { artifactName: 'workspace-provisioner', agentRuntime: 'Axon' } as unknown as Block, nodeLabel: 'prov', instructions: '',
      deliveryContext: { ticketId: 'PROJ-9', previousStepsResults: {}, currentInputs: { workItemList } },
      workspacePath: root, effectiveTools: [], timeoutSeconds: 5, signal: new AbortController().signal,
    }
    return runNativeBlock(input, services)
  }

  it('returns the same list with every field and shared preserved and workspacePath set to each repo worktree', async () => {
    const api = await makeRemote('api')
    const web = await makeRemote('web', 'develop')
    const list = {
      items: [
        { key: 'b', task: 'second', repo: 'web', extra: { n: 1 } },
        { key: 'a', task: 'first', repo: api.url },
        { key: 'c', task: 'third', repo: 'api' },
      ],
      shared: { contract: 'v1' },
    }
    const out = await run([api, web], list)
    expect(out.status).toBe('success')
    const wi = out.result.workItems as { items: Record<string, unknown>[]; shared: unknown }
    expect(wi.shared).toEqual({ contract: 'v1' })
    expect(wi.items.map((i) => [i.key, i.task, i.repo])).toEqual([['b', 'second', 'web'], ['a', 'first', api.url], ['c', 'third', 'api']])
    expect(wi.items[0].extra).toEqual({ n: 1 })
    const dir = path.join(root, 'work', 'deliveries', 'iiiiiiii-9')
    expect(wi.items.map((i) => i.workspacePath)).toEqual([path.join(dir, 'web'), path.join(dir, 'api'), path.join(dir, 'api')])
    for (const i of wi.items) await fs.stat(path.join(i.workspacePath as string, 'README.md'))
    expect((out.result.provisionedRepos as unknown[]).length).toBe(2) // one worktree per distinct repo
  })

  it('fails with the repo name for an unknown repo, and clearly for an item without one', async () => {
    const api = await makeRemote('api')
    await expect(run([api], { items: [{ key: 'a', task: 't', repo: 'ghost' }] })).rejects.toThrow(/Repository "ghost" \(work item "a"\) is not in the catalog/)
    await expect(run([api], { items: [{ key: 'a', task: 't' }] })).rejects.toThrow(/Work item "a" has no "repo"/)
    await expect(run([api], { items: [{ key: 'a' }] })).rejects.toThrow(/no "task"/)
  })
})

describe('pr-creator repos come from recorded step cwds (D17)', () => {
  const ghFetch = () => {
    const calls: { method: string; url: string }[] = []
    const fn = (async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      const repo = /repos\/acme\/([^/]+)\//.exec(url)![1]
      const json = method === 'GET' ? [] : { html_url: `https://github.com/acme/${repo}/pull/1`, number: 1 }
      return { ok: true, status: 200, json: async () => json, text: async () => '' } as Response
    }) as unknown as typeof fetch
    return { fn, calls }
  }
  const input = (cwds: string[]): RunnerInput => ({
    deliveryId: 'jjjjjjjj-1', block: { artifactName: 'pr-creator', agentRuntime: 'Axon' } as unknown as Block, nodeLabel: 'pr', instructions: '',
    deliveryContext: { ticketId: 'PROJ-1', ticketTitle: 'T', previousStepsResults: {}, currentInputs: { stepCwds: cwds } },
    workspacePath: root, effectiveTools: [], timeoutSeconds: 5, signal: new AbortController().signal,
  })
  // worktree of a catalog repo whose origin looks like GitHub (pushes still go to the local bare repo)
  async function worktree(name: string) {
    const remote = await makeRemote(name)
    const out = await provisionWorkspace(deps([remote]), { deliveryId: 'jjjjjjjj-1', ticketId: 'PROJ-1', username: 'u', repositories: [{ url: remote.url }] })
    const wt = out.provisionedRepos[0].worktreePath
    await testGit(wt).raw(['remote', 'set-url', 'origin', `https://github.com/acme/${name}`])
    return { remote, wt }
  }

  it('one PR per distinct git repo with changes; non-git folders, subfolders and repos without changes add nothing', async () => {
    const a = await worktree('api')
    const b = await worktree('web')
    await fs.mkdir(path.join(a.wt, 'src'), { recursive: true })
    await fs.writeFile(path.join(a.wt, 'src', 'x.ts'), 'x')
    const plain = path.join(root, 'plain')
    await fs.mkdir(plain)
    const gh = ghFetch()
    const services = {
      getWorkspaceRoot: () => path.join(root, 'work'), makeGit: factory, getGitToken: async () => 'tok', fetchFn: gh.fn,
      pushUrl: (r: { name: string }) => (r.name === 'api' ? a.remote.url : b.remote.url),
      committer: () => ({ name: 'T', email: 't@example.com' }),
    } as never
    const out = await runNativeBlock(input([a.wt, path.join(a.wt, 'src'), plain, b.wt]), services)
    expect(out.status).toBe('success')
    expect(out.result.prUrls).toEqual([{ repo: 'api', url: 'https://github.com/acme/api/pull/1' }]) // web had no changes
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('reposFromCwds dedupes by repo, ignores non-repos and reads the base branch from the remote (trunk, not main)', async () => {
    const a = await worktree('api')
    const repos = await reposFromCwds(factory, [a.wt, path.join(a.wt), path.join(root, 'nowhere'), root])
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({ name: 'api', url: 'https://github.com/acme/api', baseBranch: 'trunk' })
  })

  it('fails with "No repository to create a PR from" when no recorded folder is a git repo', async () => {
    const plain = path.join(root, 'plain')
    await fs.mkdir(plain)
    await expect(runNativeBlock(input([plain]), { makeGit: factory } as never)).rejects.toThrow('No repository to create a PR from')
    await expect(runNativeBlock(input([]), { makeGit: factory } as never)).rejects.toThrow('No repository to create a PR from')
  })
})
