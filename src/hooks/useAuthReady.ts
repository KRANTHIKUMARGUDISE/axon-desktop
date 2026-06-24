import { useEffect, useState } from 'react'

// Retried rather than one-shot: on a cold app start, the very first IPC round-trip
// can occasionally be slow/transiently fail (disk/safeStorage hiccup). A single
// failed attempt here used to leave isReady stuck at false for the rest of the
// renderer's lifetime — every auth-gated query (`enabled: authReady`) would then sit
// in `isLoading` forever with no error and no retry, only fixed by restarting the app.
const MAX_ATTEMPTS = 5
const RETRY_DELAY_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useAuthReady() {
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function checkAuth() {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          const [backendUrl, token] = await Promise.all([
            window.axon.settings.get('backendUrl'),
            window.axon.auth.getSecure('axon-access-token'),
          ])
          if (backendUrl && token) {
            if (!cancelled) setIsReady(true)
            return
          }
          // Missing config/token isn't a transient failure — no point retrying it.
          if (!cancelled) setIsReady(false)
          return
        } catch {
          if (attempt === MAX_ATTEMPTS) {
            if (!cancelled) setIsReady(false)
            return
          }
          await sleep(RETRY_DELAY_MS)
        }
      }
    }

    checkAuth()
    return () => { cancelled = true }
  }, [])

  return isReady
}
