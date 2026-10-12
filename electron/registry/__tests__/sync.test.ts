import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import type { GitFactory } from '../sync'
import { WriteQueue } from '../queue'
import { assertWritable, assertPromotable, normalizeEmail } from '../layout'
import { createClient, createRemote, makeTmp, plainFactory, remoteFile, remoteFiles } from './fixtures'

let root: string
beforeEach(async () => {
  root = await makeTmp()
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

const put = (email: string, rel: string, content: string) => ({ op: 'put' as const, path: `users/${email}/${rel}`, content })

describe('registry layout guard', () => {
  it('only allows writes inside users/{email}/', () => {
    expect(assertWritable('users/a@example.com/pipelines/x/draft.yaml', 'A@Example.com')).toBe('users/a@example.com/pipelines/x/draft.yaml')
    for (const bad of [
      'org/pipelines/x/v1.yaml', 'teams/t/blocks/x', 'catalog/repositories.yaml', 'registry.yaml',
      'users/b@example.com/profile.yaml', 'users/a@example.com', 'users/a@example.com/', '../users/a@example.com/x',
      'users/a@example.com/../b@example.com/x', '/users/a@example.com/x', 'users\\a@example.com\\x', 'users/a@example.com/.git/config',
      'users/A@example.com/x',
    ]) {
      expect(() => assertWritable(bad, 'a@example.com'), bad).toThrow()
    }
  })

  it('promotion targets are org/ or teams/{team}/ only', () => {
    expect(assertPromotable('org/blocks/x/v1/block.yaml')).toBeTruthy()
    expect(assertPromotable('teams/core/pipelines/x/v1.yaml')).toBeTruthy()
    for (const bad of ['users/a@example.com/x', 'catalog/repositories.yaml', 'org', 'teams/core', '../org/x']) expect(() => assertPromotable(bad), bad).toThrow()
  })

  it('lowercases emails and rejects path-unsafe ones', () => {
    expect(normalizeEmail(' Dev@Example.COM ')).toBe('dev@example.com')
    expect(() => normalizeEmail('a/b@example.com')).toThrow()
    expect(() => normalizeEmail('a:b@example.com')).toThrow()
    expect(() => normalizeEmail('..@example.com')).toThrow()
  })
})

describe('write queue', () => {
  it('refuses writes outside the user folder at enqueue time', async () => {
    const q = new WriteQueue(path.join(root, 'q'), () => 'a@example.com')
    await q.init()
    await expect(q.enqueue({ op: 'put', path: 'org/blocks/x/v1/block.yaml', content: 'x' })).rejects.toThrow(/outside/)
    expect(q.count()).toBe(0)
  })

  it('survives a crash: a new instance reloads what was on disk, in order', async () => {
    const dir = path.join(root, 'q')
    const q1 = new WriteQueue(dir, () => 'a@example.com')
    await q1.init()
    await q1.enqueue(put('a@example.com', 'one.txt', '1'))
    await q1.enqueue({ op: 'append', path: 'users/a@example.com/activity.log', line: 'x' })
    await fs.writeFile(path.join(dir, 'pending', '0000000099-half.json.tmp'), '{"half":') // crash mid-write leftover
    const q2 = new WriteQueue(dir, () => 'a@example.com')
    await q2.init()
    expect(q2.list().map((o) => o.path)).toEqual(['users/a@example.com/one.txt', 'users/a@example.com/activity.log'])
    const next = await q2.enqueue(put('a@example.com', 'two.txt', '2'))
    expect(next.seq).toBeGreaterThan(q2.list()[1].seq)
  })

  it('coalesces by path but never drops appends', async () => {
    const q = new WriteQueue(path.join(root, 'q'), () => 'a@example.com')
    await q.init()
    await q.enqueue(put('a@example.com', 'f.txt', 'v1'))
    await q.enqueue(put('a@example.com', 'f.txt', 'v2'))
    await q.enqueue({ op: 'append', path: 'users/a@example.com/activity.log', line: 'a' })
    await q.enqueue({ op: 'append', path: 'users/a@example.com/activity.log', line: 'b' })
    expect(q.list().filter((o) => o.path.endsWith('f.txt'))).toHaveLength(1)
    expect(q.list().filter((o) => o.op === 'append')).toHaveLength(2)
    await q.enqueue({ op: 'delete', path: 'users/a@example.com/d' })
    await q.enqueue(put('a@example.com', 'd/x.txt', 'x'))
    await q.enqueue({ op: 'delete', path: 'users/a@example.com/d' })
    expect(q.list().filter((o) => o.path.includes('/d'))).toHaveLength(1)
  })
})

describe('registry sync (local bare repo)', () => {
  it('pushes queued writes to users/{email}/ and clears the queue', async () => {
    const remote = await createRemote(root, { files: { 'org/blocks/b1/v1/block.yaml': 'id: b1\n' } })
    const a = await createClient(root, 'alice', remote)
    await a.queue.enqueue(put(a.email, 'pipelines/p1/draft.yaml', 'id: p1\n'))
    const status = await a.sync.syncNow()
    expect(status).toMatchObject({ state: 'Idle', queued: 0, lastError: null })
    expect(await remoteFile(root, remote, 'users/alice@example.com/pipelines/p1/draft.yaml')).toBe('id: p1\n')
    // read-through cache: org content is in the clone
    expect(await fs.readFile(path.join(a.registryDir, 'org/blocks/b1/v1/block.yaml'), 'utf-8')).toBe('id: b1\n')
  })

  it('works against an empty remote (first push creates the branch)', async () => {
    const remote = await createRemote(root, { empty: true })
    const a = await createClient(root, 'alice', remote)
    await a.queue.enqueue(put(a.email, 'profile.yaml', 'email: alice@example.com\n'))
    expect((await a.sync.syncNow()).state).toBe('Idle')
    expect(await remoteFiles(remote)).toEqual(['users/alice@example.com/profile.yaml'])
  })

  it('two clients pushing concurrently both succeed and nothing is lost', async () => {
    const remote = await createRemote(root)
    const a = await createClient(root, 'alice', remote)
    const b = await createClient(root, 'bob', remote)
    for (let i = 0; i < 3; i++) {
      await a.queue.enqueue(put(a.email, `pipelines/p${i}/draft.yaml`, `a${i}\n`))
      await b.queue.enqueue(put(b.email, `pipelines/p${i}/draft.yaml`, `b${i}\n`))
    }
    const [sa, sb] = await Promise.all([a.sync.syncNow(), b.sync.syncNow()])
    expect(sa.state).toBe('Idle')
    expect(sb.state).toBe('Idle')
    const files = await remoteFiles(remote)
    for (let i = 0; i < 3; i++) {
      expect(files).toContain(`users/alice@example.com/pipelines/p${i}/draft.yaml`)
      expect(files).toContain(`users/bob@example.com/pipelines/p${i}/draft.yaml`)
    }
  })

  it('recovers from a non-fast-forward rejection by re-fetching and replaying (deterministic race)', async () => {
    const remote = await createRemote(root)
    const a = await createClient(root, 'alice', remote)
    let raced = 0
    const racing: GitFactory = async (dir) => {
      const git = await plainFactory(dir)
      const raw = git.raw.bind(git)
      git.raw = ((args: string[], cb?: never) => {
        if (Array.isArray(args) && args[0] === 'push' && raced === 0) {
          raced++
          // Alice sneaks a push in between Bob's fetch and Bob's push.
          return a.sync.syncNow().then(() => raw(args, cb))
        }
        return raw(args, cb)
      }) as typeof git.raw
      return git
    }
    const b = await createClient(root, 'bob', remote, { makeGit: racing })
    await a.queue.enqueue(put(a.email, 'x.txt', 'alice\n'))
    await b.queue.enqueue(put(b.email, 'y.txt', 'bob\n'))
    const status = await b.sync.syncNow()
    expect(raced).toBe(1)
    expect(status.state).toBe('Idle')
    const files = await remoteFiles(remote)
    expect(files).toEqual(expect.arrayContaining(['users/alice@example.com/x.txt', 'users/bob@example.com/y.txt']))
  })

  it('goes "needs attention" after bounded retries but keeps every queued write', async () => {
    const remote = await createRemote(root)
    let pushes = 0
    const alwaysRejected: GitFactory = async (dir) => {
      const git = await plainFactory(dir)
      const raw = git.raw.bind(git)
      git.raw = ((args: string[], cb?: never) => {
        if (Array.isArray(args) && args[0] === 'push') {
          pushes++
          return Promise.reject(new Error('! [rejected] HEAD -> main (fetch first)'))
        }
        return raw(args, cb)
      }) as typeof git.raw
      return git
    }
    const a = await createClient(root, 'alice', remote, { makeGit: alwaysRejected, maxAttempts: 3 })
    await a.queue.enqueue(put(a.email, 'keep.txt', 'precious\n'))
    const status = await a.sync.syncNow()
    expect(pushes).toBe(3)
    expect(status.state).toBe('NeedsAttention')
    expect(status.queued).toBe(1)
    expect(await remoteFile(root, remote, 'users/alice@example.com/keep.txt')).toBeNull()
  })

  it('offline: writes queue, survive a restart, and sync on reconnect', async () => {
    const remote = await createRemote(root)
    const gone = path.join(root, 'remote-offline.git')
    let url = gone // unreachable
    const a = await createClient(root, 'alice', remote, { url: () => url })
    await a.queue.enqueue(put(a.email, 'pipelines/p1/draft.yaml', 'offline pipeline\n'))
    const off = await a.sync.syncNow()
    expect(off.state).toBe('Offline')
    expect(off.queued).toBe(1)

    // "crash": brand-new objects over the same on-disk queue + clone dir
    const reborn = await createClient(root, 'alice', remote, { url: () => url })
    expect(reborn.queue.count()).toBe(1)

    url = remote // network is back
    const on = await reborn.sync.syncNow()
    expect(on).toMatchObject({ state: 'Idle', queued: 0 })
    expect(await remoteFile(root, remote, 'users/alice@example.com/pipelines/p1/draft.yaml')).toBe('offline pipeline\n')
  })

  it('refuses a secret: the op is rejected and kept on disk, other writes still go out', async () => {
    const remote = await createRemote(root)
    const a = await createClient(root, 'alice', remote)
    await a.queue.enqueue(put(a.email, 'blocks/b/draft/files/skill.md', 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'))
    await a.queue.enqueue(put(a.email, 'pipelines/ok/draft.yaml', 'fine\n'))
    const status = await a.sync.syncNow()
    expect(status.state).toBe('Idle')
    expect(status.rejected).toEqual([{ path: 'users/alice@example.com/blocks/b/draft/files/skill.md', rule: 'anthropic-api-key' }])
    const files = await remoteFiles(remote)
    expect(files).toContain('users/alice@example.com/pipelines/ok/draft.yaml')
    expect(files.some((f) => f.includes('skill.md'))).toBe(false)
    const rejectedOnDisk = await fs.readdir(path.join(a.queueDir, 'rejected'))
    expect(rejectedOnDisk).toHaveLength(1)
  })

  it('goes read-only (writes stay queued) when registry.yaml needs a newer app', async () => {
    const remote = await createRemote(root, { manifest: 'schemaVersion: 2\nminAppVersion: 9.0.0\n' })
    const a = await createClient(root, 'alice', remote, { appVersion: '0.1.0' })
    await a.queue.enqueue(put(a.email, 'x.txt', 'x\n'))
    const status = await a.sync.syncNow()
    expect(status.state).toBe('ReadOnly')
    expect(status.lastError).toMatch(/9\.0\.0/)
    expect(status.queued).toBe(1)
    expect(await remoteFile(root, remote, 'users/alice@example.com/x.txt')).toBeNull()
  })

  it('goes read-only when the registry schema is newer than the app supports', async () => {
    const remote = await createRemote(root, { manifest: 'schemaVersion: 99\nminAppVersion: 0.0.0\n' })
    const a = await createClient(root, 'alice', remote)
    await a.queue.enqueue(put(a.email, 'x.txt', 'x\n'))
    expect((await a.sync.syncNow()).state).toBe('ReadOnly')
  })

  it('never commits outside users/{email}/ even if a queue file was tampered with', async () => {
    const remote = await createRemote(root)
    const a = await createClient(root, 'alice', remote)
    const op = await a.queue.enqueue(put(a.email, 'x.txt', 'x\n'))
    const file = path.join(a.queueDir, 'pending', (await fs.readdir(path.join(a.queueDir, 'pending')))[0])
    await fs.writeFile(file, JSON.stringify({ ...op, path: 'org/blocks/evil/v1/block.yaml' }))
    const reborn = await createClient(root, 'alice', remote)
    const status = await reborn.sync.syncNow()
    expect(status.state).toBe('Idle')
    expect(status.rejected[0]).toMatchObject({ path: 'org/blocks/evil/v1/block.yaml', rule: 'path-not-allowed' })
    expect((await remoteFiles(remote)).some((f) => f.startsWith('org/'))).toBe(false)
  })

  it('applies deletes and appends (activity log) in order', async () => {
    const remote = await createRemote(root)
    const a = await createClient(root, 'alice', remote)
    await a.queue.enqueue(put(a.email, 'blocks/b/draft/block.yaml', 'id: b\n'))
    await a.queue.enqueue({ op: 'append', path: `users/${a.email}/activity.log`, line: '{"event":"launch"}' })
    await a.sync.syncNow()
    await a.queue.enqueue({ op: 'append', path: `users/${a.email}/activity.log`, line: '{"event":"login"}' })
    await a.queue.enqueue({ op: 'delete', path: `users/${a.email}/blocks/b/draft` })
    await a.sync.syncNow()
    expect(await remoteFile(root, remote, `users/${a.email}/activity.log`)).toBe('{"event":"launch"}\n{"event":"login"}\n')
    expect(await remoteFiles(remote)).not.toContain(`users/${a.email}/blocks/b/draft/block.yaml`)
  })
})
