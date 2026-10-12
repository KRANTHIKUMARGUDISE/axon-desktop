import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RegistryStatus, IdentityInfo } from '@shared'

/** Live registry sync status: initial fetch + pushes from main. Refreshes the definition lists after each sync. */
export function useRegistryStatus(): RegistryStatus | null {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<RegistryStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    window.axon.registry.status().then((s) => { if (!cancelled) setStatus(s) }).catch(() => {})
    let lastSync: string | null = null
    const off = window.axon.registry.onStatus((s) => {
      setStatus(s)
      // A finished sync may have brought in org/team documents or hydrated your own.
      if (s.lastSyncAt !== lastSync) {
        lastSync = s.lastSyncAt
        queryClient.invalidateQueries({ queryKey: ['pipelines'] })
        queryClient.invalidateQueries({ queryKey: ['blocks'] })
      }
    })
    return () => { cancelled = true; off() }
  }, [queryClient])

  return status
}

export function useIdentity() {
  return useQuery<IdentityInfo>({ queryKey: ['identity'], queryFn: () => window.axon.identity.get(), staleTime: 60_000 })
}
