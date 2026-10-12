import path from 'path'
import os from 'os'
import { safeSegment, shortId, slugify } from '../../shared'
import type { WorkspacePort } from '../engine/engine'
import {
  cloneOrOpen, createDeliveryBranch, getDefaultBranch, commitChanges, pushBranch, createPullRequest,
} from '../ipc/git'

export interface GitWorkspaceDeps {
  getWorkspaceRoot(): string
  getGitToken(): Promise<string | null>
  /** Opens a folder picker for workspaceType 'Browse'; null when cancelled. */
  pickDirectory(): Promise<string | null>
}

// D1: axon/{userSlug}/{ticket}-{shortId}. No type prefix — the ticket type isn't known yet.
export function deliveryBranchName(deliveryId: string, ticketId: string, username: string): string {
  return `axon/${slugify(username) || 'unknown'}/${safeSegment(ticketId)}-${shortId(deliveryId)}`
}

// Real WorkspacePort backed by local git. The default workspace dir is keyed by ticket AND
// delivery so reruns of one ticket never collide, and a hostile ticket id can't escape the root.
export function createGitWorkspace(deps: GitWorkspaceDeps): WorkspacePort {
  return {
    async prepare(delivery) {
      let workspacePath: string
      if (delivery.workspaceType === 'Browse') {
        const picked = await deps.pickDirectory()
        if (!picked) throw new Error('No workspace folder selected')
        workspacePath = picked
      } else {
        const root = path.resolve(deps.getWorkspaceRoot())
        workspacePath = path.join(root, `${safeSegment(delivery.ticketId)}-${shortId(delivery.id)}`)
        if (!workspacePath.startsWith(root + path.sep)) throw new Error('Workspace path escapes the workspace root')
      }

      if (!delivery.repoUrl) return { workspacePath }

      const token = (await deps.getGitToken()) ?? ''
      const cloned = await cloneOrOpen(delivery.repoUrl, workspacePath, token)
      if (!cloned.success) throw new Error(`Git setup failed: ${cloned.error}`)

      const branch = deliveryBranchName(delivery.id, delivery.ticketId, os.userInfo().username)
      await createDeliveryBranch(workspacePath, branch)
      return { workspacePath, branch }
    },

    async finalize({ delivery, workspacePath, branch, stepCount }) {
      const token = (await deps.getGitToken()) ?? ''
      const pipelineName = delivery.pipelineSnapshot.name
      await commitChanges(
        workspacePath,
        `axon: ${delivery.title || delivery.ticketId} [${delivery.ticketId}]\n\nDelivered by AXON pipeline: ${pipelineName}`,
      )
      await pushBranch(workspacePath, branch, delivery.repoUrl, token)

      // PR creation is a REST call, not a git operation — local git credentials don't help,
      // so without a token it is skipped (not a failure).
      if (!token) return {}
      const prUrl = await createPullRequest({
        provider: delivery.repoUrl.includes('github.com') ? 'github' : 'azuredevops',
        repoUrl: delivery.repoUrl,
        token,
        branch,
        baseBranch: await getDefaultBranch(workspacePath),
        title: `${delivery.ticketId}: ${delivery.title || 'Delivery'}`,
        body: `## AXON Delivery\n\nPipeline: ${pipelineName}\n\nTicket: ${delivery.ticketId}\n\nCompleted steps: ${stepCount}`,
      })
      return { prUrl }
    },
  }
}
