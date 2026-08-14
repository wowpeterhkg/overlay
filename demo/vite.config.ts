import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import overlay from '@idnerd/overlay/vite'

export default defineConfig({
  plugins: [react(), overlay({ storageKey: 'demo_tags' })],
})
