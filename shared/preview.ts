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
}

export interface ActionResult {
  success: boolean
  error?: string
}
