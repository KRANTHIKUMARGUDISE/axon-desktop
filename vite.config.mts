import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Content-Security-Policy is delivered via <meta> so it also applies to the packaged file://
// page. The renderer makes no network calls of its own (everything goes through IPC to main),
// so connect-src is only the hosts AXON legitimately talks to. Jira and registry hosts are
// user-configured; S3/S5 append them here when those features land.
const API_HOSTS = ['https://api.anthropic.com', 'https://api.github.com', 'https://dev.azure.com']
const CSP_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // React/xyflow set inline style attributes; no inline <script>
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${API_HOSTS.join(' ')}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')
const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173", // Vite HMR + refresh preamble
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' http://localhost:5173 ws://localhost:5173 ${API_HOSTS.join(' ')}`,
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'axon-csp-meta',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          const csp = ctx.server ? CSP_DEV : CSP_PROD
          return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
        },
      },
    },
    {
      name: 'strip-dev-refresh-preamble',
      apply: 'build',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replace(/<script type="module">[\s\S]*?@react-refresh[\s\S]*?<\/script>\s*/, '')
        },
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared/index.ts"),
    },
  },
  server: {
    port: 5173,
    watch: {
      ignored: ['**/dist/**', '**/dist-electron/**', '**/release/**', '**/.electron-cache/**'],
    },
  },
  build: {
    outDir: 'dist',
  },
})
