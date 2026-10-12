import simpleGit from 'simple-git'
import type { SimpleGit } from 'simple-git'
import path from 'path'
import fs from 'fs/promises'
import { app } from 'electron'
import { log, redact, registerSecret } from '../log'
import { GIT_NET_CONFIG, GIT_UNSAFE_ALLOW, buildGitEnv, ensureAskpassScript, validateRepoUrl } from '../security/gitAuth'

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

// One git client per operation: protocol hardening on every call, and the token (if any) is
// supplied through GIT_ASKPASS env — never in a URL, argv, or .git/config.
export async function makeGit(baseDir: string | undefined, token: string): Promise<SimpleGit> {
  registerSecret(token)
  const askpassPath = token ? await ensureAskpassScript(path.join(app.getPath('userData'), 'bin')) : undefined
  const git = simpleGit({
    ...(baseDir ? { baseDir } : {}),
    config: [...GIT_NET_CONFIG, ...(token ? ['credential.helper='] : [])],
    unsafe: { ...GIT_UNSAFE_ALLOW },
  })
  return git.env(buildGitEnv(process.env, { token, askpassPath }))
}

export async function cloneOrOpen(repoUrl: string, workspacePath: string, token: string): Promise<CloneOrOpenResult> {
  try {
    try {
      await fs.stat(path.join(workspacePath, '.git'))
      return { success: true } // already cloned
    } catch {
      // not cloned yet
    }
    const url = validateRepoUrl(repoUrl)
    await fs.mkdir(path.dirname(workspacePath), { recursive: true })
    // Without a token, clone the plain URL and trust local git credentials (SSH key,
    // Windows/Git Credential Manager).
    const git = await makeGit(undefined, token)
    await git.clone(url, workspacePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: redact(String(err)) }
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
export async function createDeliveryBranch(workspacePath: string, branchName: string, token = ''): Promise<void> {
  const git = await makeGit(workspacePath, token)
  try {
    await git.fetch()
  } catch (err) {
    log.warn('Fetch failed', err)
  }
  const base = await getDefaultBranch(workspacePath)
  await git.checkout(base)
  try {
    await git.pull()
  } catch (err) {
    log.warn('Pull failed', err)
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
  const git = await makeGit(workspacePath, token)
  // Plain (credential-free) URL; the token, when configured, is supplied via GIT_ASKPASS.
  await git.raw(['push', '-u', validateRepoUrl(repoUrl), `HEAD:${branch}`])
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
  if (!response.ok) throw new Error(redact(`GitHub PR creation failed: ${response.status} — ${await response.text()}`))
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
  if (!response.ok) throw new Error(redact(`Azure DevOps PR creation failed: ${response.status} — ${await response.text()}`))
  return ((await response.json()) as { url: string }).url
}
