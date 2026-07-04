import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.js',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['uiohook-napi'], // native module — must not be bundled
            },
          },
        },
      },
      {
        // Preload must land in dist-electron next to main.js — main.js loads it
        // from there at runtime. Must be CJS (.cjs): Electron preloads can't run
        // ESM, and rollupOptions.output.format gets overridden by the plugin —
        // lib.formats is the setting it respects.
        entry: 'electron/preload.js',
        onstart({ reload }) { reload(); },
        vite: {
          build: {
            outDir: 'dist-electron',
            lib: {
              entry: 'electron/preload.js',
              formats: ['cjs'],
              fileName: () => 'preload.cjs',
            },
          },
        },
      },
    ]),
    renderer(),
  ],
})
