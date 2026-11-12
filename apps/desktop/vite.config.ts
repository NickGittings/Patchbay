/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri expects a fixed port and must not have Vite watching the Rust side.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rolldownOptions: {
      output: {
        // Shared application modules contain cycles; preserve their initialization order.
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'flow', test: /node_modules[\\/]@xyflow[\\/]/ },
            { name: 'terminal', test: /node_modules[\\/]@xterm[\\/]/ },
            // Sizes are measured before minification; leave room below Vite's 500 kB limit.
            { name: 'app', test: /[\\/]src[\\/]/, maxSize: 450_000 },
          ],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Unit tests for pure modules sit beside them; the app itself is covered by `npm run smoke*`.
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
