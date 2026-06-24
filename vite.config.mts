import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
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
