import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { app } from 'electron'
import { z } from 'zod'
import { readSecure, writeSecure, deleteSecure, SECRET_KEYS } from './secrets'
import { atomicWrite } from '../store/atomic'
import { handle } from './guard'
import { registerSecret, log } from '../log'

// Two ways to provide the Anthropic Console API key (D3: no subscription login), exactly one active at a time:
//
//  1. "linked"  — Linked to Claude Code config. After the user confirms "Use this key" for a key found in
//     ~/.claude.json or ~/.claude/config.json, AXON stores ONLY the consent + which file + a SHA-256 fingerprint of
//     the key (claude-key-link.json) — never the key. The key is read fresh from that file every time it is needed
//     (startup, Settings, every run). Missing key -> red status; a different key -> confirm once before it is used.
//  2. "entered" — Entered in AXON. Encrypted with the OS keychain (safeStorage, axon-claude-key.enc).
//
// Switching modes deletes the other mode's stored data. getClaudeKey() is the single accessor: the runner and the
// Settings status both go through resolve(). The renderer never receives a key value, only a masked one.

export type LinkSource = 'claudeJson' | 'configJson'
interface LinkRecord { source: LinkSource; fingerprint: string; consentAt: string }

const LINK_FILE = 'claude-key-link.json'
const SOURCE_FILES: Record<LinkSource, { rel: string[]; label: string }> = {
  claudeJson: { rel: ['.claude.json'], label: '~/.claude.json' },
  configJson: { rel: ['.claude', 'config.json'], label: '~/.claude/config.json' },
}
const sourcePath = (s: LinkSource): string => path.join(os.homedir(), ...SOURCE_FILES[s].rel)
const linkPath = (): string => path.join(app.getPath('userData'), LINK_FILE)

export const fingerprint = (key: string): string => crypto.createHash('sha256').update(key).digest('hex')

function mask(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 7)}...${key.slice(-4)}`
}

function readPrimaryApiKey(source: LinkSource): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath(source), 'utf-8')) as { primaryApiKey?: unknown }
    return typeof parsed.primaryApiKey === 'string' && parsed.primaryApiKey ? parsed.primaryApiKey : null
  } catch {
    return null
  }
}

interface Detected {
  key: string | null
  source: LinkSource | null
  conflict: { claudeJson: string; configJson: string } | null
}

function detectFromConfigFiles(): Detected {
  const a = readPrimaryApiKey('claudeJson')
  const b = readPrimaryApiKey('configJson')
  if (a && b) {
    return a === b ? { key: a, source: 'claudeJson', conflict: null } : { key: null, source: null, conflict: { claudeJson: mask(a), configJson: mask(b) } }
  }
  if (a) return { key: a, source: 'claudeJson', conflict: null }
  if (b) return { key: b, source: 'configJson', conflict: null }
  return { key: null, source: null, conflict: null }
}

type Mode = 'linked' | 'entered'
interface Problem { kind: 'missing' | 'changed'; message: string }

// What is stored (memory mirror of the two on-disk records) + this session's choices.
let entered: string | null = null
let link: LinkRecord | null = null
let rejectedDetected = false

interface Resolved {
  key: string | null
  mode: Mode | null
  source: string | null
  problem: Problem | null
  /** Linked key changed in the file: masked new value, waiting for the user's confirmation. */
  changed: { masked: string; source: string } | null
}

/** The one place a key is resolved. Linked mode re-reads the file every call; nothing but the fingerprint is kept. */
function resolve(): Resolved {
  if (link) {
    const label = SOURCE_FILES[link.source].label
    const current = readPrimaryApiKey(link.source)
    if (!current) {
      return { key: null, mode: 'linked', source: `Linked to Claude Code config (${label})`, problem: { kind: 'missing', message: `Linked key no longer found in ${label}. Re-link or enter a key.` }, changed: null }
    }
    registerSecret(current)
    if (fingerprint(current) !== link.fingerprint) {
      return {
        key: null, mode: 'linked', source: `Linked to Claude Code config (${label})`,
        problem: { kind: 'changed', message: `The key in ${label} has changed. Confirm the new key before AXON uses it.` },
        changed: { masked: mask(current), source: label },
      }
    }
    return { key: current, mode: 'linked', source: `Linked to Claude Code config (${label})`, problem: null, changed: null }
  }
  if (entered) return { key: entered, mode: 'entered', source: 'Entered in AXON', problem: null, changed: null }
  return { key: null, mode: null, source: null, problem: null, changed: null }
}

/** Which mode is active ('none' when no key source is set up). Never the key. */
export function claudeKeyMode(): 'linked' | 'entered' | 'none' {
  return resolve().mode ?? 'none'
}

/** Used by the runner. Returns '' when there is no usable key (never a candidate, never an unconfirmed changed key). */
export function getClaudeKey(): string {
  return resolve().key ?? ''
}

async function saveLink(record: LinkRecord | null): Promise<void> {
  try {
    if (record) await atomicWrite(linkPath(), JSON.stringify(record, null, 2))
    else await fs.promises.unlink(linkPath()).catch(() => {})
  } catch (err) {
    log.warn('[claudeKey] could not save the link record', err)
  }
}

async function saveEntered(value: string | null): Promise<void> {
  try {
    if (value) await writeSecure(SECRET_KEYS.claudeKey, value)
    else await deleteSecure(SECRET_KEYS.claudeKey)
  } catch (err) {
    // Encryption unavailable: the key still works for this session, it just cannot be remembered.
    log.warn('[claudeKey] could not save the key for the next launch', err)
  }
}

export async function initClaudeKey(): Promise<void> {
  rejectedDetected = false
  entered = null
  link = null
  try {
    const parsed = JSON.parse(await fs.promises.readFile(linkPath(), 'utf-8')) as Partial<LinkRecord>
    if ((parsed.source === 'claudeJson' || parsed.source === 'configJson') && typeof parsed.fingerprint === 'string') {
      link = { source: parsed.source, fingerprint: parsed.fingerprint, consentAt: String(parsed.consentAt ?? '') }
    }
  } catch { /* no link */ }
  if (link) {
    // Exactly one mode: a stray entered key from before is dropped.
    await saveEntered(null)
    return
  }
  entered = await readSecure(SECRET_KEYS.claudeKey)
  if (entered) registerSecret(entered)
}

function status() {
  const r = resolve()
  // Offer a key from Claude's own config unless a linked key is already working (so it can also be used to re-link,
  // or to switch from an entered key). It stays unused until the user confirms it.
  const looking = !(r.mode === 'linked' && r.key) && !r.changed && !rejectedDetected
  const detected = looking ? detectFromConfigFiles() : { key: null, source: null, conflict: null }
  const conflict = looking ? detected.conflict : null
  if (detected.key) registerSecret(detected.key)
  return {
    hasKey: !!r.key,
    masked: r.key ? mask(r.key) : null,
    mode: r.mode,
    source: r.source,
    problem: r.problem,
    changed: r.changed,
    conflict,
    // A key found in Claude's own config files is unused until the user confirms it (D3).
    candidate: detected.key && detected.source ? { masked: mask(detected.key), source: SOURCE_FILES[detected.source].label } : null,
  }
}

export function registerClaudeKeyHandlers(): void {
  handle('claudeKey:status', z.tuple([]), () => status())

  // Mode 2: entered in AXON. Removes any link record. An empty value clears everything.
  handle('claudeKey:set', z.tuple([z.string().max(512)]), async ([value]) => {
    const trimmed = value.trim()
    if (trimmed) registerSecret(trimmed)
    entered = trimmed || null
    link = null
    await saveLink(null)
    await saveEntered(entered)
    return status()
  })

  // Mode 1: link to the key found in Claude Code's config. Stores consent + file + fingerprint, never the key.
  handle('claudeKey:confirmDetected', z.tuple([]), async () => {
    const d = detectFromConfigFiles()
    if (d.key && d.source) {
      link = { source: d.source, fingerprint: fingerprint(d.key), consentAt: new Date().toISOString() }
      entered = null
      registerSecret(d.key)
      await saveLink(link)
      await saveEntered(null)
    }
    return status()
  })
  handle('claudeKey:rejectDetected', z.tuple([]), () => {
    rejectedDetected = true
    return status()
  })

  // The linked file now holds a different key: use it only after the user confirms.
  handle('claudeKey:confirmChanged', z.tuple([]), async () => {
    if (link) {
      const current = readPrimaryApiKey(link.source)
      if (current) {
        link = { ...link, fingerprint: fingerprint(current), consentAt: new Date().toISOString() }
        registerSecret(current)
        await saveLink(link)
      }
    }
    return status()
  })
}
