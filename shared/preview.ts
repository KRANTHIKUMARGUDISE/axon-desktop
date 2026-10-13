export interface ResumePreview {
  resumeNodeId: string
  resumeNodeLabel: string
  resumeNodeRole?: string
  lastCompletedNodeLabel?: string
  // True when the resume node already has a step record (never Completed, else the walk
  // would have passed it). It may have left partial changes in the workspace that resuming
  // does NOT roll back.
  hasPriorAttempt: boolean
  reconstructedContextKeys: string[]
  workspacePath?: string
  branch?: string
  allNodesCompleted: boolean
  /** The step Resume will run again (the failed/stopped one) and why it stopped. */
  stepLabel?: string
  failureReason?: string
  /** Where that step ran. */
  folder?: string
  /** restore: its folder is a git repo with a snapshot; plain: nothing to warn about; warn: may have left unrestorable changes. */
  resumeMode?: ResumeMode
}

export type ResumeMode = 'restore' | 'plain' | 'warn'

/** The Resume dialog text, chosen by case (see ResumeMode). */
export function describeResume(p: ResumePreview): { title: string; lines: string[]; warning?: string } {
  const title = 'Resume delivery'
  if (p.allNodesCompleted) {
    return { title, lines: ['Every step already has a completed record — resuming will just mark this delivery Completed, nothing will run.'] }
  }
  const step = p.stepLabel ?? p.resumeNodeLabel
  const lines: string[] = []
  if (p.resumeMode === 'restore') lines.push(`AXON will restore ${p.folder ?? 'the step folder'} to its state before ${step}, then run it again.`)
  else lines.push(`Resume from ${step}?`)
  if (p.resumeMode === 'warn') {
    return {
      title, lines,
      warning: `"${step}" was already attempted once and didn't finish cleanly — it may have left partial, uncommitted changes in ${p.folder ?? p.workspacePath ?? 'the workspace'}${p.branch ? ` on branch ${p.branch}` : ''}. AXON cannot roll those back (this folder is not a git repo with a snapshot); resuming runs the step again on top of what is there. Review the folder first if you are unsure.`,
    }
  }
  return { title, lines }
}

export interface ActionResult {
  success: boolean
  error?: string
}
