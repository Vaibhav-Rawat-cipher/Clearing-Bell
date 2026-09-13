import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { seoPlugin } from './scripts/seo.mjs'

export default defineConfig({
  plugins: [react(), seoPlugin()],
  server: {
    proxy: {
      '/rpc': {
        target: 'https://testnet.hashio.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rpc/, '/api'),
        secure: true,
      },
    },
  },
})
