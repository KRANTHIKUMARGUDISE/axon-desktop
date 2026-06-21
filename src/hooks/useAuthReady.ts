import { useEffect, useState } from 'react'

export function useAuthReady() {
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    async function checkAuth() {
      try {
        const [backendUrl, token] = await Promise.all([
          window.axon.settings.get('backendUrl'),
          window.axon.auth.getSecure('axon-access-token'),
        ])
        setIsReady(!!(backendUrl && token))
      } catch {
        setIsReady(false)
      }
    }

    checkAuth()
  }, [])

  return isReady
}
