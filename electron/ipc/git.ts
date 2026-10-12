import simpleGit from 'simple-git'
import path from 'path'
import fs from 'fs/promises'

// Library of local git + hosting-API operations. Nothing here is exposed over IPC — the
// engine drives it through the WorkspacePort (electron/workspace/gitWorkspace.ts).

export interface CloneOrOpenResult {
  success: boolean
  error?: string
}

export interface PRConfig {
  provider: 'github' | 'azuredevops'
  repoUrl: string
  token: string
  branch: string
  baseBranch: string
  title: string
  body: string
}

function injectTokenIntoUrl(repoUrl: string, token: string): string {
  const url = new URL(repoUrl)
  url.username = 'git'
  url.password = token
  return url.toString()
}

export async function cloneOrOpen(repoUrl: string, workspacePath: string, token: string): Promise<CloneOrOpenResult> {
  try {
    try {
      await fs.stat(path.join(workspacePath, '.git'))
      return { success: true } // already cloned
    } catch {
      // not cloned yet
    }
    await fs.mkdir(path.dirname(workspacePath), { recursive: true })
    // Without a token, clone the plain URL and trust local git credentials (SSH key,
    // Windows/Git Credential Manager).
    const cloneUrl = token ? injectTokenIntoUrl(repoUrl, token) : repoUrl
    await simpleGit().clone(cloneUrl, workspacePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function getDefaultBranch(workspacePath: string): Promise<string> {
  const git = simpleGit(workspacePath)
  try {
    const ref = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length)
  } catch {
    // origin/HEAD not set — fall through to probing
  }
  const branches = await git.branchLocal()
  if (branches.all.includes('main')) return 'main'
  if (branches.all.includes('master')) return 'master'
  return branches.current
}

// Creates a fresh branch off the up-to-date default branch. Throws on failure — a delivery
// must not silently carry on from whatever happens to be checked out.
export async function createDeliveryBranch(workspacePath: string, branchName: string): Promise<void> {
  const git = simpleGit(workspacePath)
  try {
    await git.fetch()
  } catch (err) {
    console.warn(`Fetch failed: ${err}`)
  }
  const base = await getDefaultBranch(workspacePath)
  await git.checkout(base)
  try {
    await git.pull()
  } catch (err) {
    console.warn(`Pull failed: ${err}`)
  }
  await git.checkoutLocalBranch(branchName)
}

export async function commitChanges(workspacePath: string, message: string): Promise<string> {
  const git = simpleGit(workspacePath)
  await git.add(['-A'])
  const result = await git.commit(message)
  return result.commit
}

export async function pushBranch(workspacePath: string, branch: string, repoUrl: string, token: string): Promise<void> {
  const git = simpleGit(workspacePath)
  // Token only when configured; otherwise push to the plain URL via local credentials.
  const pushUrl = token ? injectTokenIntoUrl(repoUrl, token) : repoUrl
  await git.raw(['push', '-u', pushUrl, `HEAD:${branch}`])
}

export async function createPullRequest(config: PRConfig): Promise<string> {
  if (config.provider === 'github') return createGitHubPR(config)
  if (config.provider === 'azuredevops') return createAzureDevOpsPR(config)
  throw new Error(`Unsupported provider: ${config.provider}`)
}

async function createGitHubPR(config: PRConfig): Promise<string> {
  const { repoUrl, token, branch, baseBranch, title, body } = config
  const parts = new URL(repoUrl).pathname.replace(/\.git$/, '').split('/').filter(Boolean)
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ title, body, head: branch, base: baseBranch }),
  })
  if (!response.ok) throw new Error(`GitHub PR creation failed: ${response.status} — ${await response.text()}`)
  return ((await response.json()) as { html_url: string }).html_url
}

async function createAzureDevOpsPR(config: PRConfig): Promise<string> {
  const { repoUrl, token, branch, baseBranch, title, body } = config
  // https://dev.azure.com/{org}/{project}/_git/{repo}
  const parts = new URL(repoUrl).pathname.split('/').filter(Boolean)
  const [org, project] = parts
  const repo = parts[parts.length - 1]
  const auth = Buffer.from(`:${token}`).toString('base64')

  const response = await fetch(
    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullrequests?api-version=6.0`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${branch}`,
        targetRefName: `refs/heads/${baseBranch}`,
        title,
        description: body,
      }),
    },
  )
  if (!response.ok) throw new Error(`Azure DevOps PR creation failed: ${response.status} — ${await response.text()}`)
  return ((await response.json()) as { url: string }).url
}
