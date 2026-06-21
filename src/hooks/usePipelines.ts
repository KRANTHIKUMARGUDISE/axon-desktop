import { useQuery } from '@tanstack/react-query'
import { getPipelines } from '../services/pipelinesService'
import type { PipelineFilter } from '../services/pipelinesService'

export function usePipelines(filter?: PipelineFilter, enabled = true) {
  const { data: pipelines = [], isLoading, error } = useQuery({
    queryKey: ['pipelines', filter],
    queryFn: () => getPipelines(filter),
    enabled,
  })
  return { data: pipelines, isLoading, isError: !!error }
}
