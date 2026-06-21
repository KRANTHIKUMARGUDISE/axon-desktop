import { ipcMain } from 'electron'
import simpleGit, { SimpleGit } from 'simple-git'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'

export interface CloneOrOpenResult {
  success: boolean
  workspacePath?: string
  error?: string
}

export interface WorkspaceStatus {
  modified: string[]
  added: string[]
  deleted: string[]
  untracked: string[]
  summary: string
}

export interface PRConfig {
  provider: 'github' | 'azuredevops'
  repoUrl: string
  token: string
  branch: string
  baseBranch: string
  title: string
  body: string
  ticketId: string
}

function injectTokenIntoUrl(repoUrl: string, token: string): string {
  const url = new URL(repoUrl)
  url.username = 'git'
  url.password = token
  return url.toString()
}

export async function cloneOrOpen(
  repoUrl: string,
  workspacePath: string,
  token: string,
): Promise<CloneOrOpenResult> {
  try {
    // Check if path exists and has .git
    try {
      await fs.stat(workspacePath)
      const gitPath = path.join(workspacePath, '.git')
      await fs.stat(gitPath)
      // Already cloned
      return { success: true }
    } catch {
      // Directory doesn't exist or no .git — clone it
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(workspacePath)
    await fs.mkdir(parentDir, { recursive: true })

    // With a token configured, inject it into the URL. Without one, clone the plain
    // repoUrl and trust whatever the local machine already has set up (SSH key,
    // Windows/Git Credential Manager, etc.) — don't force a token requirement.
    const git = simpleGit()
    const cloneUrl = token ? injectTokenIntoUrl(repoUrl, token) : repoUrl
    await git.clone(cloneUrl, workspacePath)

    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// Git ref names can't contain spaces or most special characters — sanitize the
// OS login username (e.g. "Kranthi Kumar" -> "kranthi-kumar") before using it in a branch name.
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export async function createDeliveryBranch(
  workspacePath: string,
  ticketId: string,
  jobNumber?: number,
): Promise<string> {
  const git = simpleGit(workspacePath)
  const username = slugify(os.userInfo().username || 'unknown')
  const branchName = jobNumber != null
    ? `axon/${username}/${jobNumber}/${ticketId}`
    : `axon/delivery-${ticketId}-${Date.now()}`

  try {
    // Fetch latest from origin to ensure we have the latest main
    await git.fetch()
  } catch (err) {
    console.warn(`Fetch failed: ${err}`)
  }

  // Try to checkout and reset to origin/main
  try {
    await git.checkout('main')
  } catch {
    // Fallback to master if main doesn't exist
    await git.checkout('master')
  }

  // Pull latest changes
  try {
    await git.pull()
  } catch (err) {
    console.warn(`Pull failed: ${err}`)
  }

  // Create and checkout new branch
  await git.checkoutLocalBranch(branchName)

  return branchName
}

export async function getChangedFiles(workspacePath: string): Promise<string[]> {
  const git = simpleGit(workspacePath)
  const status = await git.status()

  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.not_added,
  ]
}

export async function getWorkspaceStatus(workspacePath: string): Promise<WorkspaceStatus> {
  const git = simpleGit(workspacePath)
  const status = await git.status()

  return {
    modified: status.modified,
    added: status.created,
    deleted: status.deleted,
    untracked: status.not_added,
    summary: `${status.modified.length} modified, ${status.created.length} added, ${status.deleted.length} deleted`,
  }
}

export async function commitChanges(workspacePath: string, message: string): Promise<string> {
  const git = simpleGit(workspacePath)

  // Stage all changes
  await git.add('.')

  // Commit
  const result = await git.commit(message)

  return result.commit
}

export async function pushBranch(
  workspacePath: string,
  branch: string,
  repoUrl: string,
  token: string,
): Promise<void> {
  const git = simpleGit(workspacePath)

  // Same fallback as cloneOrOpen — only inject a token into the URL if one's
  // configured; otherwise push to the plain repoUrl and trust local git credentials.
  const pushUrl = token ? injectTokenIntoUrl(repoUrl, token) : repoUrl

  await git.raw(['push', '-u', pushUrl, `HEAD:${branch}`])
}

export async function createPullRequest(config: PRConfig): Promise<string> {
  if (config.provider === 'github') {
    return createGitHubPR(config)
  } else if (config.provider === 'azuredevops') {
    return createAzureDevOpsPR(config)
  }
  throw new Error(`Unsupported provider: ${config.provider}`)
}

async function createGitHubPR(config: PRConfig): Promise<string> {
  const { repoUrl, token, branch, baseBranch, title, body } = config

  // Parse owner/repo from URL
  const urlObj = new URL(repoUrl)
  const pathParts = urlObj.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
  const owner = pathParts[pathParts.length - 2]
  const repo = pathParts[pathParts.length - 1]

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      title,
      body,
      head: branch,
      base: baseBranch,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`GitHub PR creation failed: ${response.status} — ${err}`)
  }

  const data = (await response.json()) as { html_url: string }
  return data.html_url
}

async function createAzureDevOpsPR(config: PRConfig): Promise<string> {
  const { repoUrl, token, branch, baseBranch, title, body } = config

  // Parse organization, project, and repository from URL
  // Format: https://dev.azure.com/{org}/{project}/_git/{repo}
  const urlObj = new URL(repoUrl)
  const pathParts = urlObj.pathname.split('/').filter(Boolean)
  const org = pathParts[0]
  const project = pathParts[1]
  const repo = pathParts[pathParts.length - 1]

  // Base64 encode token for Basic auth (PAT:empty)
  const auth = Buffer.from(`:${token}`).toString('base64')

  const response = await fetch(
    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullrequests?api-version=6.0`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${branch}`,
        targetRefName: `refs/heads/${baseBranch}`,
        title,
        description: body,
      }),
    },
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Azure DevOps PR creation failed: ${response.status} — ${err}`)
  }

  const data = (await response.json()) as { url: string }
  return data.url
}

export function registerGitHandlers() {
  ipcMain.handle('git:clone', async (_event, repoUrl: string, workspacePath: string, token: string) => {
    return cloneOrOpen(repoUrl, workspacePath, token)
  })

  ipcMain.handle('git:status', async (_event, workspacePath: string) => {
    try {
      const status = await getWorkspaceStatus(workspacePath)
      return { success: true, data: status }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('git:createBranch', async (_event, workspacePath: string, ticketId: string) => {
    try {
      const branch = await createDeliveryBranch(workspacePath, ticketId)
      return { success: true, branch }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(
    'git:addAndCommit',
    async (_event, workspacePath: string, message: string) => {
      try {
        const commitSha = await commitChanges(workspacePath, message)
        return { success: true, commitSha }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  ipcMain.handle(
    'git:push',
    async (
      _event,
      workspacePath: string,
      branch: string,
      repoUrl: string,
      token: string,
    ) => {
      try {
        await pushBranch(workspacePath, branch, repoUrl, token)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  ipcMain.handle('git:createPR', async (_event, config: PRConfig) => {
    try {
      const prUrl = await createPullRequest(config)
      return { success: true, prUrl }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
