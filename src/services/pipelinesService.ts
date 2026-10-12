import type { Pipeline as StoredPipeline } from '@shared'
import type { Pipeline } from '../types'

export interface PipelineFilter {
  search?: string
  isActive?: boolean
}

export interface CreatePipelineRequest {
  name: string
  description: string
  nodes: unknown[]
  edges: unknown[]
}

function toPipeline(p: StoredPipeline): Pipeline {
  return { ...(p as unknown as Pipeline), nodeCount: p.nodes.length }
}

export const getPipelines = async (filter?: PipelineFilter): Promise<Pipeline[]> => {
  let all = (await window.axon.pipelines.list()) as StoredPipeline[]
  if (filter?.search) {
    const q = filter.search.toLowerCase()
    all = all.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
  }
  if (filter?.isActive !== undefined) all = all.filter((p) => (p.isActive ?? true) === filter.isActive)
  return all.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(toPipeline)
}

export const getPipeline = async (id: string): Promise<Pipeline> => {
  const p = (await window.axon.pipelines.get(id)) as StoredPipeline | null
  if (!p) throw new Error('Pipeline not found')
  return toPipeline(p)
}

export const createPipeline = async (req: CreatePipelineRequest): Promise<Pipeline> =>
  toPipeline((await window.axon.pipelines.create(req)) as StoredPipeline)

export const updatePipeline = async (id: string, req: Partial<CreatePipelineRequest>): Promise<Pipeline> =>
  toPipeline((await window.axon.pipelines.update(id, req)) as StoredPipeline)

export const deletePipeline = (id: string): Promise<void> => window.axon.pipelines.delete(id)
