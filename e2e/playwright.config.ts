import { defineConfig, devices } from '@playwright/test'

/**
 * One config, two targets.
 *
 * Unset `PLAYWRIGHT_BASE_URL` and Playwright boots `pnpm dev` itself — Vite on
 * :5173 proxying to the two Hono servers on :3001 and :3002 — and tests that,
 * with no credentials and nothing mocked between the specs and the code that
 * ships. Set it to a deployed URL (`https://pr-12.preview.cdk-core.ty.ler.dev`)
 * and the identical specs run against real infrastructure with no server of
 * their own. That is the whole point of the suite: the thing that proves a
 * preview is a preview is that the *same* assertions pass against it.
 *
 * The readiness URL is `/api/ping` rather than `/`, and it is deliberate: it
 * goes through Vite's proxy to the API server, so one poll proves the whole
 * local stack is up rather than just the static server.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'
const isLocal = !process.env.PLAYWRIGHT_BASE_URL
const CI = !!process.env.CI

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  // A preview's Lambdas can be cold on the first request of a suite.
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(isLocal
    ? {
        webServer: {
          command: 'pnpm dev',
          cwd: '..',
          url: 'http://localhost:5173/api/ping',
          reuseExistingServer: !CI,
          timeout: 120_000,
        },
      }
    : {}),
})
