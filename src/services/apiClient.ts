import axios from 'axios'
import type { InternalAxiosRequestConfig, AxiosResponse } from 'axios'

let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

const client = axios.create({
  headers: { 'Content-Type': 'application/json' },
})

client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const [baseUrl, token] = await Promise.all([
    window.axon.settings.get('backendUrl') as Promise<string | null>,
    window.axon.auth.getSecure('axon-access-token') as Promise<string | null>,
  ])
  if (!baseUrl) throw new Error('Backend URL not configured — go to Settings')
  config.baseURL = baseUrl
  if (token) config.headers['Authorization'] = `Bearer ${token}`
  return config
})

client.interceptors.response.use(
  (res: AxiosResponse) => res,
  async (error) => {
    const original = error.config
    if (error.response?.status !== 401 || original._retry) {
      return Promise.reject(error)
    }
    original._retry = true

    if (isRefreshing) {
      return new Promise<string>((resolve) => {
        refreshQueue.push(resolve)
      }).then((token) => {
        original.headers['Authorization'] = `Bearer ${token}`
        return client(original)
      })
    }

    isRefreshing = true
    try {
      const [baseUrl, refreshToken] = await Promise.all([
        window.axon.settings.get('backendUrl') as Promise<string | null>,
        window.axon.auth.getSecure('axon-refresh-token') as Promise<string | null>,
      ])
      const res = await axios.post(
        `${baseUrl ?? ''}/api/auth/refresh`,
        { refreshToken },
        { headers: { 'Content-Type': 'application/json' } },
      )
      const newToken: string = res.data.accessToken ?? res.data.token
      await window.axon.auth.storeSecure('axon-access-token', newToken)
      refreshQueue.forEach((cb) => cb(newToken))
      refreshQueue = []
      original.headers['Authorization'] = `Bearer ${newToken}`
      return client(original)
    } catch {
      refreshQueue = []
      window.dispatchEvent(new CustomEvent('axon:auth:expired'))
      return Promise.reject(error)
    } finally {
      isRefreshing = false
    }
  },
)

export default client
