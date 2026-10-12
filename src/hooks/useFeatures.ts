import { useQuery } from '@tanstack/react-query'

export interface Features {
  intelligence: boolean
}

const OFF: Features = { intelligence: false }

/** Feature flags (all default off; set in main via env / main-only settings). `loaded` is false until the first answer. */
export function useFeatures(): { features: Features; loaded: boolean } {
  const { data, isSuccess } = useQuery<Features>({
    queryKey: ['features'],
    queryFn: () => window.axon.system.getFeatures(),
    staleTime: Infinity,
  })
  return { features: data ?? OFF, loaded: isSuccess }
}
