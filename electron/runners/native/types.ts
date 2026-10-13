import type { z } from 'zod'
import type { GitFactory, CatalogRepo } from '../../workspace/provisioner'
import type { RunnerInput } from '../types'

// Services native (Axon-runtime) blocks may use. Injected by main.ts; tests pass fakes/local-repo git.
export interface NativeServices {
  getWorkspaceRoot(): string
  getGitToken(): Promise<string | null>
  getCatalog(): Promise<CatalogRepo[]>
  /** When the registry clone (and so the catalog) was last synced; used in the not-in-the-catalog error. */
  lastCatalogSyncAt?(): string | null
  makeGit: GitFactory
  /** Repo URL validation applied before network git (production: https/ssh only). */
  validateUrl?: (url: string) => string
  /** Test seam: where `pr-creator` pushes (default = the repo URL). */
  pushUrl?: (repo: { url: string; name: string }) => string
  fetchFn?: typeof fetch
  username(): string
  committer?(): { name: string; email: string } | undefined
  redact?(s: string): string
}

export interface NativeContext {
  input: RunnerInput
  services: NativeServices
}

// One entry per `artifactName`. `input` parses the step's context pool (unknown keys are dropped);
// `output` validates the handler's result before it reaches the engine.
export interface NativeBlock<I = unknown, O = Record<string, unknown>> {
  name: string
  input: z.ZodType<I>
  output: z.ZodType<O>
  run(input: I, ctx: NativeContext): Promise<{ summary: string; result: O }>
}
