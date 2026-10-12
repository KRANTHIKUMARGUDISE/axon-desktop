import { describe, it, expect } from 'vitest'
import { migrateDoc, SchemaVersionError, BlockSchema, SCHEMA_VERSION, compareVersions, newerBlockVersion, latestPublishedVersion, SETTING_VALIDATORS, JiraSiteSchema, parseRepoUrl, parseGitHubRepo } from '..'

describe('schema versioning', () => {
  const v1Block = { id: 'b', schemaVersion: 1, name: 'B', role: 'Execution', sourceType: 'Local', agentRuntime: 'Claude', artifactFormat: 'Skill', version: 3, createdAt: 't', updatedAt: 't' }

  it('upgrades N-1 documents in memory (v1 local docs become Published personal docs)', () => {
    const doc = BlockSchema.parse(migrateDoc(v1Block, 'block'))
    expect(doc).toMatchObject({ schemaVersion: SCHEMA_VERSION, scope: 'Personal', status: 'Published', version: 3 })
  })

  it('keeps unrelated documents (deliveries, profiles) intact when upgrading', () => {
    expect(migrateDoc({ id: 'd', schemaVersion: 1, x: 1 }, 'other')).toEqual({ id: 'd', schemaVersion: SCHEMA_VERSION, x: 1 })
    expect(migrateDoc({ id: 'd', x: 1 })).toMatchObject({ schemaVersion: SCHEMA_VERSION })
  })

  it('refuses documents newer than the app understands or older than N-1', () => {
    expect(() => migrateDoc({ id: 'x', schemaVersion: SCHEMA_VERSION + 1 })).toThrow(SchemaVersionError)
    expect(() => migrateDoc({ id: 'x', schemaVersion: 0 })).toThrow(SchemaVersionError)
    expect(() => migrateDoc('nope')).toThrow()
  })
})

describe('versions', () => {
  it('compares dotted versions', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('1.0', '1.0.1')).toBe(-1)
    expect(compareVersions('10.0.0', '9.9.9')).toBe(1)
  })

  it('flags "newer version available" for a pinned node', () => {
    expect(latestPublishedVersion({ version: 3, status: 'Draft' })).toBe(2)
    expect(latestPublishedVersion({ version: 3, status: 'Published' })).toBe(3)
    expect(newerBlockVersion({ blockVersion: 1 }, { version: 3, status: 'Published' })).toBe(3)
    expect(newerBlockVersion({ blockVersion: 2 }, { version: 3, status: 'Draft' })).toBeNull()
    expect(newerBlockVersion({ blockVersion: 3 }, { version: 3, status: 'Published' })).toBeNull()
    expect(newerBlockVersion({}, { version: 3, status: 'Published' })).toBeNull()
  })
})

describe('registry settings validators', () => {
  it('accepts https/ssh registry URLs and rejects credentials, file: and ext::', () => {
    for (const ok of ['', 'https://github.com/acme/axon-registry.git', 'git@github.com:acme/axon-registry.git', 'ssh://git@host/acme/r.git']) expect(SETTING_VALIDATORS.registryUrl.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['https://user:tok@github.com/a/b.git', 'file:///etc', 'ext::sh -c id', '--upload-pack=x', 'C:\repo', 'http://github.com/a/b']) expect(SETTING_VALIDATORS.registryUrl.safeParse(bad).success, bad).toBe(false)
    expect(parseRepoUrl('https://github.com/a/b.git')).toBeTruthy()
  })

  it('validates branch, interval and Jira site', () => {
    expect(SETTING_VALIDATORS.registryBranch.safeParse('main').success).toBe(true)
    expect(SETTING_VALIDATORS.registryBranch.safeParse('release/1.0').success).toBe(true)
    expect(SETTING_VALIDATORS.registryBranch.safeParse('--force').success).toBe(false)
    expect(SETTING_VALIDATORS.registryBranch.safeParse('a..b').success).toBe(false)
    expect(SETTING_VALIDATORS.syncIntervalMinutes.safeParse(5).success).toBe(true)
    expect(SETTING_VALIDATORS.syncIntervalMinutes.safeParse(0).success).toBe(false)
    expect(JiraSiteSchema.safeParse('acme.atlassian.net').success).toBe(true)
    expect(JiraSiteSchema.safeParse('evil.com').success).toBe(false)
    expect(JiraSiteSchema.safeParse('acme.atlassian.net.evil.com').success).toBe(false)
    expect(JiraSiteSchema.safeParse('acmeXatlassianYnet').success).toBe(false)
    // identity settings are written by onboarding in main only
    for (const key of ['setupComplete', 'userEmail', 'userName', 'jiraSite']) expect(Object.keys(SETTING_VALIDATORS)).not.toContain(key)
  })

  it('parses GitHub owner/repo from the supported URL shapes', () => {
    for (const u of ['https://github.com/acme/axon-registry.git', 'https://github.com/acme/axon-registry', 'git@github.com:acme/axon-registry.git']) expect(parseGitHubRepo(u)).toEqual({ owner: 'acme', repo: 'axon-registry' })
    expect(parseGitHubRepo('https://gitlab.com/a/b.git')).toBeNull()
  })
})
