import type { Pipeline, DeliverySummary, PagedResponse, Delivery, DeliveryStep } from '../types'

export const delay = (ms = 400): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const now = new Date()
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()

export const mockPipelines: Pipeline[] = [
  {
    id: 'pipe-sdlc',
    name: 'SDLC Delivery',
    description: 'Full software delivery lifecycle — ticket to PR',
    tags: ['sdlc', 'code-gen', 'pr'],
    isActive: true,
    version: '2.1',
    createdByName: 'Arun Kumar',
    nodes: [
      { id: 'n1', type: 'IO', name: 'Ticket Fetch', blockId: 'blk-6', label: 'Ticket Fetch', positionX: 0, positionY: 0, position: { x: 0, y: 0 }, config: {} },
      { id: 'n2', type: 'Decision', name: 'RRA Assessment', blockId: 'blk-1', label: 'RRA Assessment', positionX: 200, positionY: 0, position: { x: 200, y: 0 }, config: {} },
      { id: 'n3', type: 'Knowledge', name: 'Context Fetcher', blockId: 'blk-3', label: 'Context Fetcher', positionX: 400, positionY: 0, position: { x: 400, y: 0 }, config: {} },
      { id: 'n4', type: 'Execution', name: 'Coding Agent', blockId: 'blk-2', label: 'Coding Agent', positionX: 600, positionY: 0, position: { x: 600, y: 0 }, config: {} },
      { id: 'n5', type: 'Control', name: 'Human Approval Gate', blockId: 'blk-4', label: 'Human Approval Gate', positionX: 800, positionY: 0, position: { x: 800, y: 0 }, config: {} },
      { id: 'n6', type: 'Execution', name: 'PR Creation', blockId: 'blk-2', label: 'PR Creation', positionX: 1000, positionY: 0, position: { x: 1000, y: 0 }, config: {} },
      { id: 'n7', type: 'Utility', name: 'Slack Notifier', blockId: 'blk-5', label: 'Slack Notifier', positionX: 1200, positionY: 0, position: { x: 1200, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', isDefault: true },
      { id: 'e2', sourceNodeId: 'n2', targetNodeId: 'n3', isDefault: true },
      { id: 'e3', sourceNodeId: 'n3', targetNodeId: 'n4', isDefault: true },
      { id: 'e4', sourceNodeId: 'n4', targetNodeId: 'n5', isDefault: true },
      { id: 'e5', sourceNodeId: 'n5', targetNodeId: 'n6', isDefault: true },
      { id: 'e6', sourceNodeId: 'n6', targetNodeId: 'n7', isDefault: true },
    ],
    createdAt: ago(10080), updatedAt: ago(60),
  },
  {
    id: 'pipe-rra',
    name: 'RRA Assessment',
    description: 'Requirement readiness assessment pipeline',
    tags: ['rra', 'assessment'],
    isActive: true,
    version: '1.0',
    createdByName: 'Arun Kumar',
    nodes: [
      { id: 'n1', type: 'IO', name: 'Ticket Fetch', blockId: 'blk-6', label: 'Ticket Fetch', positionX: 0, positionY: 0, position: { x: 0, y: 0 }, config: {} },
      { id: 'n2', type: 'Decision', name: 'RRA Assessment', blockId: 'blk-1', label: 'RRA Assessment', positionX: 200, positionY: 0, position: { x: 200, y: 0 }, config: {} },
      { id: 'n3', type: 'Execution', name: 'Report Generation', blockId: 'blk-2', label: 'Report Generation', positionX: 400, positionY: 0, position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', isDefault: true },
      { id: 'e2', sourceNodeId: 'n2', targetNodeId: 'n3', isDefault: true },
    ],
    createdAt: ago(10080), updatedAt: ago(120),
  },
  {
    id: 'pipe-qa',
    name: 'QA Automation',
    description: 'Automated test generation and execution',
    tags: ['testing', 'coverage', 'ai'],
    isActive: false,
    version: '1.8',
    createdByName: 'Sarah M',
    nodes: [
      { id: 'n1', type: 'IO', name: 'Ticket Fetch', blockId: 'blk-6', label: 'Ticket Fetch', positionX: 0, positionY: 0, position: { x: 0, y: 0 }, config: {} },
      { id: 'n2', type: 'Knowledge', name: 'Context Fetcher', blockId: 'blk-3', label: 'Context Fetcher', positionX: 200, positionY: 0, position: { x: 200, y: 0 }, config: {} },
      { id: 'n3', type: 'Execution', name: 'Test Generator', blockId: 'blk-7', label: 'Test Generator', positionX: 400, positionY: 0, position: { x: 400, y: 0 }, config: {} },
      { id: 'n4', type: 'Execution', name: 'Test Runner', blockId: 'blk-7', label: 'Test Runner', positionX: 600, positionY: 0, position: { x: 600, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', isDefault: true },
      { id: 'e2', sourceNodeId: 'n2', targetNodeId: 'n3', isDefault: true },
      { id: 'e3', sourceNodeId: 'n3', targetNodeId: 'n4', isDefault: true },
    ],
    createdAt: ago(10080), updatedAt: ago(240),
  },
]

export const mockDeliverySummaries: DeliverySummary[] = [
  {
    id: 'del-1', ticketId: 'PROJ-2341', title: 'Payment API refactor',
    pipelineId: 'pipe-sdlc', pipelineName: 'SDLC Delivery',
    status: 'Running', progress: 66, startedAt: ago(18),
    createdByName: 'Arun Kumar', duration: '18m 24s',
  },
  {
    id: 'del-2', ticketId: 'PROJ-2338', title: 'Auth service tests',
    pipelineId: 'pipe-sdlc', pipelineName: 'SDLC Delivery',
    status: 'Paused', progress: 72, startedAt: ago(35),
    createdByName: 'Sarah M', duration: '12m 11s',
  },
  {
    id: 'del-3', ticketId: 'PROJ-2335', title: 'Sprint RRA batch',
    pipelineId: 'pipe-rra', pipelineName: 'RRA Assessment',
    status: 'Pending', progress: 0, startedAt: ago(47),
    createdByName: 'Arun Kumar',
  },
  {
    id: 'del-4', ticketId: 'PROJ-2329', title: 'Docs automation',
    pipelineId: 'pipe-qa', pipelineName: 'QA Automation',
    status: 'Completed', progress: 100,
    startedAt: ago(75), completedAt: ago(68),
    createdByName: 'Sarah M', duration: '7m 32s',
  },
  {
    id: 'del-5', ticketId: 'PROJ-2318', title: 'Security scan fix',
    pipelineId: 'pipe-sdlc', pipelineName: 'Security Pipeline',
    status: 'Failed', progress: 55,
    startedAt: ago(120), createdByName: 'Raj S', duration: '6m 21s',
  },
]

export const mockPagedDeliveries: PagedResponse<DeliverySummary> = {
  items: mockDeliverySummaries,
  total: 42, page: 1, pageSize: 5,
}

export function mockCreateDelivery(req: {
  ticketId: string
  pipelineId: string
  repository?: string
}): Delivery {
  const pipe = mockPipelines.find(p => p.id === req.pipelineId) ?? mockPipelines[0]
  return {
    id: `del-${Date.now()}`,
    ticketId: req.ticketId,
    title: req.ticketId,
    pipelineId: pipe.id,
    pipelineName: pipe.name,
    status: 'Pending',
    steps: [],
    progress: 0,
    startedAt: new Date().toISOString(),
    ownerId: 'user-1',
    createdByName: 'Arun Kumar',
    repository: req.repository,
  }
}

function steps(...defs: [string, DeliveryStep['status']][]): DeliveryStep[] {
  return defs.map(([name, status], i) => ({
    id: `step-${i + 1}`,
    name,
    status,
    startedAt: status !== 'Pending' ? ago(20 - i * 4) : undefined,
    completedAt: status === 'Completed' ? ago(15 - i * 3) : undefined,
  }))
}

export const mockDeliveries: Record<string, Delivery> = {
  'del-1': {
    id: 'del-1', ticketId: 'PROJ-2341', title: 'Payment API refactor',
    pipelineId: 'pipe-sdlc', pipelineName: 'SDLC Delivery',
    pipelineSnapshot: { name: 'SDLC Delivery' },
    status: 'Running', progress: 66,
    startedAt: ago(18), createdByName: 'Arun Kumar',
    workspacePath: '/workspaces/job-8821',
    repository: 'github.com/org/payments-service',
    branch: 'feat/proj-2341',
    steps: [
      {
        id: 'step-1', name: 'Ticket Fetch', status: 'Completed',
        nodeName: 'Ticket Fetch', nodeType: 'IO',
        startedAt: ago(18), completedAt: ago(17),
        duration: '12s', tokenCount: 1200,
        agentOutput: {
          summary: 'Fetched PROJ-2341 — Payment API refactor. Priority: High. Assignee: Arun Kumar.',
          confidence: 0.98,
        },
      },
      {
        id: 'step-2', name: 'RRA Assessment', status: 'Completed',
        nodeName: 'RRA Assessment', nodeType: 'Decision',
        startedAt: ago(17), completedAt: ago(16),
        duration: '22s', tokenCount: 4100,
        agentOutput: {
          summary: 'Score 89/100 — passed. Proceeding with autonomous delivery.',
          confidence: 0.95,
          result: { score: 89 },
          missingFields: [],
        },
      },
      {
        id: 'step-3', name: 'Code Generation', status: 'Running',
        nodeName: 'Coding Agent', nodeType: 'Execution',
        startedAt: ago(6),
        tokenCount: 12400,
      },
      {
        id: 'step-4', name: 'PR Review Gate', status: 'Pending',
        nodeName: 'PR Review Gate', nodeType: 'Decision',
      },
      {
        id: 'step-5', name: 'PR Creation', status: 'Pending',
        nodeName: 'PR Creation Agent', nodeType: 'Execution',
      },
    ],
  },
  'del-2': {
    id: 'del-2', ticketId: 'PROJ-2338', title: 'Auth service tests',
    pipelineId: 'pipe-sdlc', pipelineName: 'SDLC Delivery',
    pipelineSnapshot: { name: 'SDLC Delivery' },
    status: 'Paused', progress: 72,
    startedAt: ago(35), createdByName: 'Sarah M',
    workspacePath: '/workspaces/job-8822',
    steps: [
      {
        id: 'step-1', name: 'Ticket Fetch', status: 'Completed',
        nodeName: 'Ticket Fetch', nodeType: 'IO',
        startedAt: ago(35), completedAt: ago(34),
        duration: '10s', tokenCount: 900,
        agentOutput: { summary: 'Fetched PROJ-2338 — Auth service tests.', confidence: 0.99 },
      },
      {
        id: 'step-2', name: 'RRA Assessment', status: 'Completed',
        nodeName: 'RRA Assessment', nodeType: 'Decision',
        startedAt: ago(34), completedAt: ago(33),
        duration: '18s', tokenCount: 3600,
        agentOutput: {
          summary: 'Score 74/100 — needs review. Proceeding under guided mode.',
          confidence: 0.88,
          result: { score: 74 },
          missingFields: ['acceptance criteria incomplete'],
        },
      },
      {
        id: 'step-3', name: 'Code Generation', status: 'Completed',
        nodeName: 'Coding Agent', nodeType: 'Execution',
        startedAt: ago(33), completedAt: ago(20),
        duration: '13m 4s', tokenCount: 18200,
        agentOutput: {
          summary: 'Generated AuthService.test.ts with 14 test cases. Coverage: 82%.',
          confidence: 0.82,
        },
      },
      {
        id: 'step-4', name: 'PR Review Gate', status: 'AwaitingApproval',
        nodeName: 'Human Approval', nodeType: 'Decision',
        startedAt: ago(20),
        agentOutput: {
          humanGateReason: 'Coding Agent completed with confidence 0.82. 3 files modified. Test coverage on AdcAuthHandler is 0% — new file with no tests yet. Review changes before PR is raised.',
        },
      },
      {
        id: 'step-5', name: 'PR Creation', status: 'Pending',
        nodeName: 'PR Creation Agent', nodeType: 'Execution',
      },
    ],
  },
  'del-3': {
    id: 'del-3', ticketId: 'PROJ-2335', title: 'Sprint RRA batch',
    pipelineId: 'pipe-rra', pipelineName: 'RRA Assessment',
    pipelineSnapshot: { name: 'RRA Assessment' },
    status: 'Pending', progress: 0,
    startedAt: ago(47), createdByName: 'Arun Kumar',
    workspacePath: '/workspaces/job-8823',
    steps: steps(
      ['Ticket Fetch', 'Pending'],
      ['RRA Assessment', 'Pending'],
      ['Report Generation', 'Pending'],
    ),
  },
  'del-4': {
    id: 'del-4', ticketId: 'PROJ-2329', title: 'Docs automation',
    pipelineId: 'pipe-qa', pipelineName: 'QA Automation',
    pipelineSnapshot: { name: 'QA Automation' },
    status: 'Completed', progress: 100,
    startedAt: ago(75), completedAt: ago(68), createdByName: 'Sarah M',
    workspacePath: '/workspaces/job-8820',
    repository: 'github.com/org/docs-service',
    branch: 'feat/proj-2329',
    steps: steps(
      ['Ticket Fetch', 'Completed'],
      ['Test Generation', 'Completed'],
      ['Test Execution', 'Completed'],
      ['Report Generation', 'Completed'],
    ),
  },
  'del-5': {
    id: 'del-5', ticketId: 'PROJ-2318', title: 'Security scan fix',
    pipelineId: 'pipe-sdlc', pipelineName: 'Security Pipeline',
    pipelineSnapshot: { name: 'Security Pipeline' },
    status: 'Failed', progress: 55,
    startedAt: ago(120), createdByName: 'Raj S',
    workspacePath: '/workspaces/job-8819',
    steps: [
      {
        id: 'step-1', name: 'Ticket Fetch', status: 'Completed',
        nodeName: 'Ticket Fetch', nodeType: 'IO',
        startedAt: ago(120), completedAt: ago(119),
        duration: '9s', tokenCount: 800,
        agentOutput: { summary: 'Fetched PROJ-2318 — Security scan fix.', confidence: 0.99 },
      },
      {
        id: 'step-2', name: 'Security Scan', status: 'Completed',
        nodeName: 'Security Scan', nodeType: 'Execution',
        startedAt: ago(119), completedAt: ago(117),
        duration: '2m 11s', tokenCount: 5200,
        agentOutput: { summary: '3 vulnerabilities found — CVE-2024-1234 (high), 2 medium. Proceeding with fix.', confidence: 0.91 },
      },
      {
        id: 'step-3', name: 'Code Generation', status: 'Failed',
        nodeName: 'Coding Agent', nodeType: 'Execution',
        startedAt: ago(117), completedAt: ago(114),
        duration: '3m 17s', tokenCount: 7100,
        errorMessage: 'Build failed on step 3/4. NullReferenceException in SecurityPatchHandler.cs line 42. Retry limit reached (3×).',
      },
      {
        id: 'step-4', name: 'PR Creation', status: 'Pending',
        nodeName: 'PR Creation Agent', nodeType: 'Execution',
      },
    ],
  },
}

export const mockBlocks: import('../types').BuildingBlock[] = [
  {
    id: 'blk-1', name: 'RRA Assessment', type: 'Decision',
    description: 'Evaluates requirement readiness and scores tickets against acceptance criteria. Routes flow based on score threshold.',
    version: '1.3.0', verified: true, usageCount: 284,
    tags: ['rra', 'assessment', 'routing'],
    createdAt: ago(20160), updatedAt: ago(1440),
    createdByName: 'Arun Kumar',
    usedInPipelineIds: ['pipe-sdlc', 'pipe-rra'],
    adapterType: 'claude-skill',
    syncStatus: 'Synced',
    executorType: 'claude-haiku-4-5',
    contextRequirements: ['ticket.description', 'ticket.acceptanceCriteria', 'project.definition'],
    outputSchema: ['score', 'passed', 'missingFields'],
    marketplaceSource: 'axon-marketplace',
    marketplacePath: 'axon/rra-assessment',
    marketplaceVersion: '1.3.0',
    cachedAt: ago(1440),
    inputs: [
      { name: 'ticketId', type: 'IO', required: true, description: 'Jira ticket identifier' },
      { name: 'threshold', type: 'Control', required: false, description: 'Score threshold (default 80)' },
    ],
    outputs: [
      { name: 'score', type: 'Execution', required: true, description: 'RRA score 0–100' },
      { name: 'passed', type: 'Decision', required: true, description: 'Boolean — passed threshold' },
      { name: 'missingFields', type: 'Knowledge', required: false, description: 'List of missing acceptance criteria' },
    ],
  },
  {
    id: 'blk-2', name: 'Coding Agent', type: 'Execution',
    description: 'Generates production-ready code changes from a ticket and context. Commits to a feature branch and reports coverage.',
    version: '2.4.1', verified: true, usageCount: 512,
    tags: ['code-gen', 'ai', 'git'],
    createdAt: ago(30240), updatedAt: ago(720),
    createdByName: 'Sarah M',
    usedInPipelineIds: ['pipe-sdlc'],
    adapterType: 'claude-skill',
    syncStatus: 'Stale',
    executorType: 'claude-sonnet-4-6',
    contextRequirements: ['ticket.description', 'repo.recentCommits', 'context.codebase', 'context.docs', 'project.conventions'],
    outputSchema: ['branch', 'filesChanged', 'coverage', 'commitSha'],
    marketplaceSource: 'axon-marketplace',
    marketplacePath: 'axon/coding-agent',
    marketplaceVersion: '2.3.0',
    cachedAt: ago(720),
    inputs: [
      { name: 'ticketId', type: 'IO', required: true, description: 'Ticket to implement' },
      { name: 'repository', type: 'IO', required: true, description: 'Git repository URL' },
      { name: 'baseBranch', type: 'IO', required: false, description: 'Branch to branch from' },
    ],
    outputs: [
      { name: 'branch', type: 'IO', required: true, description: 'Created feature branch name' },
      { name: 'filesChanged', type: 'Execution', required: true, description: 'Number of files modified' },
      { name: 'coverage', type: 'Execution', required: false, description: 'Test coverage percentage' },
    ],
  },
  {
    id: 'blk-3', name: 'Context Fetcher', type: 'Knowledge',
    description: 'Retrieves and injects relevant codebase context, docs, and prior decisions into the execution pipeline.',
    version: '1.1.0', verified: true, usageCount: 198,
    tags: ['rag', 'context', 'embeddings'],
    createdAt: ago(15000), updatedAt: ago(2880),
    createdByName: 'Raj S',
    usedInPipelineIds: ['pipe-sdlc', 'pipe-qa'],
    adapterType: 'native',
    syncStatus: 'Unavailable',
    executorType: 'axon-rag-v2',
    contextRequirements: [],
    outputSchema: ['context', 'sources'],
    marketplaceSource: 'axon-marketplace',
    marketplacePath: 'axon/context-fetcher',
    marketplaceVersion: '1.1.0',
    cachedAt: ago(2880),
    inputs: [
      { name: 'query', type: 'Knowledge', required: true, description: 'Search query or ticket description' },
      { name: 'topK', type: 'Control', required: false, description: 'Number of results to retrieve' },
    ],
    outputs: [
      { name: 'context', type: 'Knowledge', required: true, description: 'Retrieved context chunks' },
      { name: 'sources', type: 'Knowledge', required: false, description: 'Source document references' },
    ],
  },
  {
    id: 'blk-4', name: 'Human Approval Gate', type: 'Control',
    description: 'Pauses the pipeline and waits for a human reviewer to approve or reject before continuing execution.',
    version: '1.0.2', verified: true, usageCount: 341,
    tags: ['gate', 'approval', 'human-in-loop'],
    createdAt: ago(18000), updatedAt: ago(4320),
    createdBy: 'Arun Kumar',
    usedInPipelineIds: ['pipe-sdlc'],
    adapterType: 'mock',
    syncStatus: 'Missing',
    executorType: 'axon-gate',
    contextRequirements: ['ticket.id', 'delivery.status'],
    outputSchema: ['approved', 'comment'],
    marketplaceSource: 'axon-marketplace',
    marketplacePath: 'axon/human-gate',
    marketplaceVersion: '1.0.0',
    cachedAt: ago(4320),
    inputs: [
      { name: 'reason', type: 'Control', required: true, description: 'Why approval is needed' },
      { name: 'reviewUrl', type: 'IO', required: false, description: 'Link to review artifact' },
    ],
    outputs: [
      { name: 'approved', type: 'Decision', required: true, description: 'True if approved' },
      { name: 'comment', type: 'Knowledge', required: false, description: 'Reviewer comment' },
    ],
  },
  {
    id: 'blk-5', name: 'Slack Notifier', type: 'Utility',
    description: 'Sends pipeline status updates and alerts to configured Slack channels with rich message formatting.',
    version: '2.0.0', verified: false, usageCount: 89,
    tags: ['slack', 'notification', 'webhook'],
    createdAt: ago(8640), updatedAt: ago(1440),
    createdByName: 'Sarah M',
    usedInPipelineIds: [],
    adapterType: 'legacy-json',
    syncStatus: 'Local',
    executorType: 'webhook-runner',
    contextRequirements: ['delivery.id', 'delivery.status'],
    outputSchema: ['messageId'],
    inputs: [
      { name: 'channel', type: 'Utility', required: true, description: 'Slack channel ID or name' },
      { name: 'message', type: 'Utility', required: true, description: 'Message content (supports markdown)' },
    ],
    outputs: [
      { name: 'messageId', type: 'Utility', required: false, description: 'Sent message timestamp' },
    ],
  },
  {
    id: 'blk-6', name: 'Ticket Fetch', type: 'IO',
    description: 'Fetches ticket details from Jira or Linear and normalises the response into a standard pipeline payload.',
    version: '1.2.0', verified: true, usageCount: 607,
    tags: ['jira', 'linear', 'input'],
    createdAt: ago(25000), updatedAt: ago(3600),
    createdByName: 'Arun Kumar',
    usedInPipelineIds: ['pipe-sdlc', 'pipe-rra', 'pipe-qa'],
    adapterType: 'claude-skill',
    syncStatus: 'NeverSynced',
    executorType: 'claude-haiku-4-5',
    contextRequirements: [],
    outputSchema: ['ticket', 'attachments'],
    inputs: [
      { name: 'ticketId', type: 'IO', required: true, description: 'Ticket identifier e.g. PROJ-1234' },
      { name: 'provider', type: 'IO', required: false, description: 'jira | linear (auto-detected if omitted)' },
    ],
    outputs: [
      { name: 'ticket', type: 'IO', required: true, description: 'Normalised ticket object' },
      { name: 'attachments', type: 'IO', required: false, description: 'List of ticket attachments' },
    ],
  },
  {
    id: 'blk-7', name: 'Test Generator', type: 'Execution',
    description: 'Generates unit and integration tests for new or modified code files, targeting coverage gaps.',
    version: '1.8.3', verified: true, usageCount: 223,
    tags: ['testing', 'coverage', 'ai'],
    createdAt: ago(22000), updatedAt: ago(720),
    createdByName: 'Raj S',
    usedInPipelineIds: ['pipe-qa'],
    adapterType: 'claude-skill',
    syncStatus: 'Synced',
    executorType: 'claude-sonnet-4-6',
    contextRequirements: ['repo.testFramework', 'context.codebase'],
    outputSchema: ['testFiles', 'coverageReport'],
    marketplaceSource: 'axon-marketplace',
    marketplacePath: 'axon/test-generator',
    marketplaceVersion: '1.8.3',
    cachedAt: ago(720),
    inputs: [
      { name: 'filesChanged', type: 'Execution', required: true, description: 'List of changed file paths' },
      { name: 'framework', type: 'Control', required: false, description: 'Test framework: jest | pytest | nunit' },
    ],
    outputs: [
      { name: 'testFiles', type: 'Execution', required: true, description: 'Generated test file paths' },
      { name: 'coverageReport', type: 'Execution', required: false, description: 'Coverage summary' },
    ],
  },
  {
    id: 'blk-8', name: 'PR Branch Router', type: 'Decision',
    description: 'Routes the pipeline to the PR creation step or back to code gen based on confidence score and review policy.',
    version: '1.0.1', verified: false, usageCount: 47,
    tags: ['routing', 'pr', 'branch'],
    createdAt: ago(5000), updatedAt: ago(500),
    createdByName: 'Sarah M',
    usedInPipelineIds: ['pipe-sdlc'],
    adapterType: 'mock',
    syncStatus: 'Stale',
    executorType: 'axon-router',
    contextRequirements: ['delivery.confidence'],
    outputSchema: ['route'],
    marketplaceSource: 'axon-marketplace',
    marketplacePath: 'axon/pr-router',
    marketplaceVersion: '1.0.0',
    cachedAt: ago(500),
    inputs: [
      { name: 'confidence', type: 'Decision', required: true, description: 'Agent confidence 0.0–1.0' },
      { name: 'policy', type: 'Control', required: false, description: 'Review policy: strict | standard | lenient' },
    ],
    outputs: [
      { name: 'route', type: 'Decision', required: true, description: 'Next step: create-pr | review | retry' },
    ],
  },
]

export const mockHealth = { status: 'ok', version: '1.0.0' }

export const mockMarketplaceAgents = [
  { id: 'mp-1', name: 'Coding Agent v2.3', type: 'Execution', version: '2.3' },
  { id: 'mp-2', name: 'Test Agent v1.9', type: 'Execution', version: '1.9' },
  { id: 'mp-3', name: 'RRA Assessment v1.3', type: 'Decision', version: '1.3' },
]
