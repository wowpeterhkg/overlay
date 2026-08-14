import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  workers: 1,
  use: { headless: false },
  webServer: {
    command: 'npm run dev --prefix ../demo',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
