import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { seoPlugin } from './scripts/seo.mjs'

export default defineConfig({
  plugins: [react(), seoPlugin()],
})
