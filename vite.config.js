import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Split each module into its own chunk so lazy loading works properly
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Vendor chunk for the markdown editor (largest dep)
            if (id.includes('@uiw/react-md-editor')) return 'vendor-mdeditor'
            if (id.includes('recharts'))              return 'vendor-recharts'
            if (id.includes('@nostr-dev-kit'))        return 'vendor-ndk'
            return 'vendor'
          }
          // Each module gets its own async chunk
          const match = id.match(/src\/modules\/([^/]+)/)
          if (match) return `module-${match[1]}`
        },
      },
    },
  },
})
