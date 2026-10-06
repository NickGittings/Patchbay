/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri expects a fixed port and must not have Vite watching the Rust side.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Unit tests for pure modules sit beside them; the app itself is covered by `npm run smoke*`.
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
