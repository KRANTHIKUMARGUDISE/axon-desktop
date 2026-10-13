import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-claudekey-'))
const home = path.join(root, 'home')
const userData = path.join(root, 'userData')

// In-memory stand-in for the encrypted secret files.
const disk = new Map<string, string>()
const handlers = new Map<string, (args: unknown[]) => unknown>()
const registered: string[] = []
const logged: unknown[][] = []

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../secrets', () => ({
  SECRET_KEYS: { claudeKey: 'axon-claude-key' },
  readSecure: async (k: string) => disk.get(k) ?? null,
  writeSecure: async (k: string, v: string) => { disk.set(k, v) },
  deleteSecure: async (k: string) => { disk.delete(k) },
}))
vi.mock('../guard', () => ({
  handle: (channel: string, _schema: unknown, fn: (args: unknown[]) => unknown) => { handlers.set(channel, fn) },
}))
vi.mock('../../log', () => ({
  registerSecret: (s: string | null | undefined) => { if (s) registered.push(s) },
  log: { warn: (...a: unknown[]) => logged.push(a), info: (...a: unknown[]) => logged.push(a), error: (...a: unknown[]) => logged.push(a) },
}))
vi.spyOn(os, 'homedir').mockReturnValue(home)

import { initClaudeKey, getClaudeKey, registerClaudeKeyHandlers, fingerprint } from '../claudeKeyStore'
import type { ClaudeKeyStatus } from '../../../shared'

const KEY_A = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA1111'
const KEY_B = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBB2222'
const CLAUDE_JSON = path.join(home, '.claude.json')
const LINK = path.join(userData, 'claude-key-link.json')

const writeClaudeJson = (key: string | null) => fs.writeFileSync(CLAUDE_JSON, JSON.stringify(key ? { primaryApiKey: key } : {}))
const call = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!(args)) as Promise<ClaudeKeyStatus>
const restart = () => initClaudeKey() // "restart": rebuild everything from what is on disk

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  disk.clear(); handlers.clear(); registered.length = 0; logged.length = 0
  registerClaudeKeyHandlers()
  await restart()
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('mode 2: entered in AXON', () => {
  it('survives a restart, stored encrypted, and clearing removes it', async () => {
    const st = await call('claudeKey:set', `  ${KEY_A}  `)
    expect(st).toMatchObject({ hasKey: true, mode: 'entered', source: 'Entered in AXON' })
    expect(getClaudeKey()).toBe(KEY_A)
    expect(disk.get('axon-claude-key')).toBe(KEY_A)
    await restart()
    expect(getClaudeKey()).toBe(KEY_A)
    expect((await call('claudeKey:status')).masked).toBe('sk-ant-...1111') // never the full key
    await call('claudeKey:set', '  ')
    expect(getClaudeKey()).toBe('')
    expect(disk.has('axon-claude-key')).toBe(false)
  })
})

describe('mode 1: linked to Claude Code config', () => {
  async function link(key = KEY_A) {
    writeClaudeJson(key)
    const before = await call('claudeKey:status')
    expect(getClaudeKey()).not.toBe(key) // a found key is only a candidate until confirmed (D3)
    expect(before.candidate).toMatchObject({ source: '~/.claude.json' })
    return call('claudeKey:confirmDetected')
  }

  it('after "Use this key" the key survives a restart without any copy on disk', async () => {
    const st = await link()
    expect(st).toMatchObject({ hasKey: true, mode: 'linked', source: 'Linked to Claude Code config (~/.claude.json)', problem: null })
    // only consent + file id + fingerprint are stored
    const record = JSON.parse(fs.readFileSync(LINK, 'utf8'))
    expect(Object.keys(record).sort()).toEqual(['consentAt', 'fingerprint', 'source'])
    expect(record).toMatchObject({ source: 'claudeJson', fingerprint: fingerprint(KEY_A) })
    expect(disk.size).toBe(0) // nothing in the encrypted store either
    for (const f of fs.readdirSync(userData)) expect(fs.readFileSync(path.join(userData, f), 'utf8')).not.toContain(KEY_A)

    await restart()
    expect(getClaudeKey()).toBe(KEY_A)
    expect((await call('claudeKey:status')).mode).toBe('linked')
  })

  it('reads the key fresh from the file every time (no cached copy)', async () => {
    await link()
    expect(getClaudeKey()).toBe(KEY_A)
    fs.rmSync(CLAUDE_JSON) // gone mid-session
    expect(getClaudeKey()).toBe('')
  })

  it('key missing from the file -> red status with a clear message, no key used', async () => {
    await link()
    await restart()
    writeClaudeJson(null)
    const st = await call('claudeKey:status')
    expect(st.hasKey).toBe(false)
    expect(st.problem).toEqual({ kind: 'missing', message: 'Linked key no longer found in ~/.claude.json. Re-link or enter a key.' })
    expect(getClaudeKey()).toBe('')
  })

  it('a different key in the file needs one confirmation before it is used', async () => {
    await link()
    writeClaudeJson(KEY_B)
    await restart()
    let st = await call('claudeKey:status')
    expect(st.hasKey).toBe(false)
    expect(getClaudeKey()).toBe('') // blocked until confirmed
    expect(st.problem?.kind).toBe('changed')
    expect(st.changed).toEqual({ masked: 'sk-ant-...2222', source: '~/.claude.json' })

    st = await call('claudeKey:confirmChanged')
    expect(st).toMatchObject({ hasKey: true, problem: null, changed: null })
    expect(getClaudeKey()).toBe(KEY_B)
    expect(JSON.parse(fs.readFileSync(LINK, 'utf8')).fingerprint).toBe(fingerprint(KEY_B))
    await restart()
    expect(getClaudeKey()).toBe(KEY_B) // asked once
  })

  it('switching modes removes the other mode\'s data', async () => {
    await call('claudeKey:set', KEY_B)
    expect(disk.has('axon-claude-key')).toBe(true)
    await link() // entered -> linked: the .enc is deleted
    expect(disk.has('axon-claude-key')).toBe(false)
    expect(fs.existsSync(LINK)).toBe(true)

    await call('claudeKey:set', KEY_B) // linked -> entered: the consent record is deleted
    expect(fs.existsSync(LINK)).toBe(false)
    expect(disk.get('axon-claude-key')).toBe(KEY_B)
    expect((await call('claudeKey:status')).mode).toBe('entered')
    await restart()
    expect(getClaudeKey()).toBe(KEY_B)
  })

  it('"Don\'t use" keeps the candidate unused', async () => {
    writeClaudeJson(KEY_A)
    await call('claudeKey:rejectDetected')
    expect((await call('claudeKey:status')).candidate).toBeNull()
    expect(getClaudeKey()).toBe('')
    expect(fs.existsSync(LINK)).toBe(false)
  })
})

describe('no key value leaks', () => {
  it('is registered for log redaction, absent from logs and from the status sent to the renderer', async () => {
    writeClaudeJson(KEY_A)
    await call('claudeKey:confirmDetected')
    const st = await call('claudeKey:status')
    getClaudeKey()
    expect(registered).toContain(KEY_A) // the logger redacts anything registered
    expect(JSON.stringify(st)).not.toContain(KEY_A)
    expect(JSON.stringify(logged)).not.toContain(KEY_A)
    await call('claudeKey:set', KEY_B)
    expect(JSON.stringify(await call('claudeKey:status'))).not.toContain(KEY_B)
  })

  it('the key never reaches a registry run summary (explicit field copy only)', async () => {
    const { toRunSummary } = await import('../../registry/runSummary')
    const delivery = {
      id: 'd', ticketId: 'T-1', status: 'Completed', startedAt: '2026-10-01T10:00:00.000Z', pipelineId: 'p', pipelineVersion: 1,
      pipelineSnapshot: { blockVersions: {}, nodes: [], edges: [], name: 'n' }, steps: [], inputs: { note: KEY_A },
    } as never
    expect(JSON.stringify(toRunSummary(delivery, 'dev@example.com'))).not.toContain(KEY_A)
  })
})
