import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { consumeSecureFile } from './secrets'

// Claude API key is resolved fresh on every launch (auto-detect, then manual
// override) and lives only in this module's memory for the lifetime of the
// process — never written to disk. See CLAUDE.md "BUILD — Claude key
// resolution" for the rationale.
interface ClaudeKeyConflict {
  claudeJson: string
  configJson: string
}

interface ClaudeKeyState {
  key: string | null
  source: string | null
  conflict: ClaudeKeyConflict | null
}

let state: ClaudeKeyState = { key: null, source: null, conflict: null }

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
    state = { key: detected.key, source: detected.source, conflict: null }
  } else if (detected.conflict) {
    state = { key: null, source: null, conflict: detected.conflict }
  } else if (migratedValue) {
    state = { key: migratedValue, source: 'migrated from prior manual entry', conflict: null }
  } else {
    state = { key: null, source: null, conflict: null }
  }
}

export function getClaudeKey(): string {
  return state.key ?? ''
}

export function registerClaudeKeyHandlers(): void {
  ipcMain.handle('claudeKey:status', () => ({
    hasKey: !!state.key,
    masked: state.key ? mask(state.key) : null,
    source: state.source,
    conflict: state.conflict,
  }))

  ipcMain.handle('claudeKey:set', (_event, value: string) => {
    const trimmed = value.trim()
    state = { key: trimmed || null, source: trimmed ? 'manual' : null, conflict: null }
    return {
      hasKey: !!state.key,
      masked: state.key ? mask(state.key) : null,
      source: state.source,
      conflict: state.conflict,
    }
  })
}
