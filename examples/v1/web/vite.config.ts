// Consumer configuration reference for apps/web; dependencies are selected in G01/T33.
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/api/auth': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
