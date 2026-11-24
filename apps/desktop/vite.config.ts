/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { DEFAULT_DEV_PORT, DEV_PORT_ENV } from './scripts/dev-port.mjs'

// Vite must not watch the Rust side. `scripts/tauri.mjs` picks the port when 1420 is taken.
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
    port: Number(process.env[DEV_PORT_ENV]) || DEFAULT_DEV_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Unit tests for pure modules sit beside them; the app itself is covered by `npm run smoke*`.
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
