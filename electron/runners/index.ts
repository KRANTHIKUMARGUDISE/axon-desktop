import type { AgentOutput } from '../../shared'
import { createClaudePromptRunner } from './claudePrompt'
import { runAgenticBlock } from './claudeAgentic'
import { createAxonNativeRunner } from './axonNative'
import type { NativeServices } from './native/types'
import { runCodex } from './codex'
import type { Runner, RunnerInput } from './types'

export function createRunner(getClaudeKey: () => string, native?: NativeServices): Runner {
  const prompt = createClaudePromptRunner(getClaudeKey)
  const axon = createAxonNativeRunner(native)
  return async (input: RunnerInput): Promise<AgentOutput> => {
    switch (input.block.agentRuntime) {
      case 'Axon':
        return axon(input)
      case 'Claude':
        return input.block.executionType === 'Agentic'
          ? runAgenticBlock(input, getClaudeKey())
          : prompt(input)
      case 'Codex':
        return runCodex(input)
      default:
        throw new Error(`Unsupported agent runtime: ${String(input.block.agentRuntime)}`)
    }
  }
}
