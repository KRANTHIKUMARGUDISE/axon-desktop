import { useQuery } from '@tanstack/react-query'
import { getBlocks } from '../services/blocksService'
import type { BlockFilter } from '../services/blocksService'

export function useBlocks(filter?: BlockFilter) {
  const { data: blocks = [], isLoading, error, refetch } = useQuery({
    queryKey: ['blocks', filter],
    queryFn: () => getBlocks(filter),
  })
  return { blocks, loading: isLoading, error, refetch }
}
