import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { consumeSecureFile } from './secrets'
import { handle } from './guard'
import { registerSecret } from '../log'

// Claude API key lives only in this module's memory for the lifetime of the process — never
// written to disk. A key harvested from ~/.claude.json / ~/.claude/config.json is only a
// *candidate* until the user explicitly confirms it (D3); getClaudeKey() never returns a
// candidate. A manually entered key is the user's own act and needs no confirmation.
interface ClaudeKeyConflict {
  claudeJson: string
  configJson: string
}

interface ClaudeKeyState {
  key: string | null
  candidate: { key: string; source: string } | null
  source: string | null
  conflict: ClaudeKeyConflict | null
}

let state: ClaudeKeyState = { key: null, candidate: null, source: null, conflict: null }

function mask(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 7)}...${key.slice(-4)}`
}

async function readPrimaryApiKey(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { primaryApiKey?: unknown }
    return typeof parsed.primaryApiKey === 'string' && parsed.primaryApiKey ? parsed.primaryApiKey : null
  } catch {
    return null
  }
}

async function detectFromConfigFiles(): Promise<{
  key: string | null
  source: string | null
  conflict: ClaudeKeyConflict | null
}> {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json')
  const configJsonPath = path.join(os.homedir(), '.claude', 'config.json')
  const [fromClaudeJson, fromConfigJson] = await Promise.all([
    readPrimaryApiKey(claudeJsonPath),
    readPrimaryApiKey(configJsonPath),
  ])

  if (fromClaudeJson && fromConfigJson) {
    if (fromClaudeJson === fromConfigJson) {
      return { key: fromClaudeJson, source: '~/.claude.json and ~/.claude/config.json (matching)', conflict: null }
    }
    return {
      key: null,
      source: null,
      conflict: { claudeJson: mask(fromClaudeJson), configJson: mask(fromConfigJson) },
    }
  }
  if (fromClaudeJson) return { key: fromClaudeJson, source: '~/.claude.json', conflict: null }
  if (fromConfigJson) return { key: fromConfigJson, source: '~/.claude/config.json', conflict: null }
  return { key: null, source: null, conflict: null }
}

export async function initClaudeKey(): Promise<void> {
  const detected = await detectFromConfigFiles()

  // Always consume (read + delete) the legacy encrypted file from before this
  // build, whether or not its value ends up used — this build retires Claude-key
  // disk persistence entirely, so the old file shouldn't survive past one launch.
  const migratedValue = await consumeSecureFile('axon-claude-key')

  if (detected.key) {
    state = { key: null, candidate: { key: detected.key, source: detected.source ?? '~/.claude.json' }, source: null, conflict: null }
    registerSecret(detected.key)
  } else if (detected.conflict) {
    state = { key: null, candidate: null, source: null, conflict: detected.conflict }
  } else if (migratedValue) {
    state = { key: migratedValue, candidate: null, source: 'migrated from prior manual entry', conflict: null }
    registerSecret(migratedValue)
  } else {
    state = { key: null, candidate: null, source: null, conflict: null }
  }
}

export function getClaudeKey(): string {
  return state.key ?? ''
}

function status() {
  return {
    hasKey: !!state.key,
    masked: state.key ? mask(state.key) : null,
    source: state.source,
    conflict: state.conflict,
    candidate: state.candidate ? { masked: mask(state.candidate.key), source: state.candidate.source } : null,
  }
}

export function registerClaudeKeyHandlers(): void {
  handle('claudeKey:status', z.tuple([]), () => status())

  handle('claudeKey:set', z.tuple([z.string().max(512)]), ([value]) => {
    const trimmed = value.trim()
    registerSecret(trimmed)
    state = { key: trimmed || null, candidate: null, source: trimmed ? 'manual' : null, conflict: null }
    return status()
  })

  // D3: explicit "Use this key?" confirmation for a key found in Claude's own config files.
  handle('claudeKey:confirmDetected', z.tuple([]), () => {
    if (state.candidate) {
      state = { key: state.candidate.key, candidate: null, source: state.candidate.source, conflict: null }
    }
    return status()
  })
  handle('claudeKey:rejectDetected', z.tuple([]), () => {
    state = { ...state, candidate: null }
    return status()
  })
}
