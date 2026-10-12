import { describe, it, expect, afterEach } from 'vitest'
import path from 'path'
import { buildDiagnostics, registryHost } from '../diagnostics'
import type { DiagnosticsInput } from '../diagnostics'
import { registerSecret, clearRegisteredSecrets } from '../log'
// build-time script (CommonJS)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectLicenses } = require('../../scripts/generate-licenses.js') as { collectLicenses: (root?: string) => { name: string; version: string; license: string; text: string }[] }

afterEach(() => clearRegisteredSecrets())

const base = (over: Partial<DiagnosticsInput['registry']> = {}): DiagnosticsInput => ({
  appVersion: '0.1.0', electronVersion: '44.7.0', nodeVersion: '24.21.0', platform: 'win32', arch: 'x64', osRelease: '10.0.26200',
  registry: { url: 'https://github.com/acme/axon-registry.git', state: 'Idle', lastSyncAt: '2026-10-13T08:30:00.000Z', queued: 3, ...over },
})

describe('registry host', () => {
  it('keeps the host only — no scheme, credentials, port, path or query', () => {
    expect(registryHost('https://github.com/acme/axon-registry.git')).toBe('github.com')
    expect(registryHost('https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@GitHub.com:8443/acme/r.git?x=1')).toBe('github.com')
    expect(registryHost('git@github.com:acme/axon-registry.git')).toBe('github.com')
    expect(registryHost('ssh://git@git.example.org/acme/r.git')).toBe('git.example.org')
    expect(registryHost('')).toBe('')
    expect(registryHost('not a url')).toBe('')
    expect(registryHost('C:\\Users\\kranthi\\registry')).toBe('')
  })
})

describe('copy diagnostics', () => {
  it('contains exactly the supported facts', () => {
    expect(buildDiagnostics(base())).toBe([
      'AXON diagnostics', 'AXON: 0.1.0', 'Electron: 44.7.0', 'Node: 24.21.0', 'OS: win32 x64 (10.0.26200)',
      'Registry host: github.com', 'Registry sync: Idle, last sync 2026-10-13T08:30:00.000Z', 'Queued writes: 3',
    ].join('\n'))
  })

  it('handles an unconfigured registry that never synced', () => {
    const t = buildDiagnostics(base({ url: '', state: 'Unconfigured', lastSyncAt: null, queued: 0 }))
    expect(t).toContain('Registry host: not configured')
    expect(t).toContain('Registry sync: Unconfigured, never synced')
  })

  it('never leaks seeded secrets, emails, user names, paths or URL credentials', () => {
    const secrets = [
      'sk-ant-api03-SEEDEDSECRETabcdefghijklmnopqrstuvwxyz', 'ghp_SEEDEDabcdefghijklmnopqrstuvwxyz0123456789',
      'jira-api-token-SEEDED-1234567890', 'hunter2-SEEDED-password',
    ]
    for (const s of secrets) registerSecret(s)
    const hostile = base({
      // credentials + path + email smuggled into every free-form field
      url: `https://kranthi.gudise@example.com:${secrets[1]}@github.com/KRANTHIKUMARGUDISE/axon-registry.git`,
      state: `Idle ${secrets[0]} C:\\Users\\Kranthi\\AppData\\Roaming\\axon-desktop dev@example.com`,
      lastSyncAt: `2026-10-13T08:30:00.000Z ${secrets[2]}`,
    })
    hostile.appVersion = `0.1.0 ${secrets[3]}`
    hostile.osRelease = 'C:\\Users\\Kranthi\\x /home/kranthi/.ssh/id_rsa'
    const text = buildDiagnostics(hostile)
    for (const s of secrets) expect(text).not.toContain(s)
    for (const leak of ['dev@example.com', 'kranthi', 'Kranthi', 'KRANTHI', 'gudise', 'AppData', 'C:\\', '/home/', 'axon-registry', 'id_rsa', '@', 'ghp_', 'sk-ant']) {
      expect(text, leak).not.toContain(leak)
    }
    expect(text).toContain('Registry host: github.com')
  })

  it('also scrubs unregistered secret shapes via the logger redaction rules', () => {
    const t = buildDiagnostics(base({ state: 'Idle token=abcdefghijklmnop' }))
    expect(t).not.toContain('abcdefghijklmnop')
  })
})

describe('third-party licenses (build-time)', () => {
  const packages = collectLicenses(path.join(__dirname, '..', '..'))
  const names = new Set(packages.map((p) => p.name))

  it('covers production dependencies including the Agent SDK and its bundled Claude Code binary package', () => {
    for (const n of ['react', 'zod', 'simple-git', 'yaml', 'electron-store', '@anthropic-ai/claude-agent-sdk']) expect(names.has(n), n).toBe(true)
    expect([...names].some((n) => /^@anthropic-ai\/claude-agent-sdk-(win32|darwin|linux)/.test(n))).toBe(true)
    expect(names.has('electron')).toBe(true) // the runtime ships in the installer
  })

  it('excludes devDependencies', () => {
    for (const n of ['vitest', 'typescript', 'electron-builder', 'vite', 'shadcn']) expect(names.has(n), n).toBe(false)
  })

  it('has a license id for everything and license text for nearly everything', () => {
    expect(packages.filter((p) => !p.license || p.license === 'UNKNOWN')).toEqual([])
    expect(packages.filter((p) => !p.text).length).toBeLessThan(packages.length * 0.05)
    expect(packages.find((p) => p.name === 'zod')?.text).toMatch(/MIT/)
  })
})
