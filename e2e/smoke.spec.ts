import { expect, test } from '@playwright/test'

/**
 * The one test that proves the bundle boots and learns its environment at
 * runtime (plan.md D11: the same bundle ships everywhere and fetches
 * `__config.json` to find out which mode it's in). Everything else in this
 * suite assumes the page gets this far.
 */
test('the page loads and reads its config', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('h1')).toBeVisible()

  // `mode` starts as '…' until `loadConfig()` resolves `__config.json`. Once
  // it settles, it must be one of the three real modes — not a hard-coded
  // 'local', because this exact spec also runs against a preview, where the
  // mode is 'preview'.
  const mode = page.getByTestId('mode')
  await expect(mode).not.toHaveText('…')
  expect(['local', 'preview', 'prod']).toContain(await mode.textContent())

  const site = page.getByTestId('site')
  await expect(site).not.toHaveText('…')
  expect(await site.textContent()).not.toBe('')

  // No error surfaced while config and the initial /api/me check settled.
  await expect(page.getByTestId('error')).not.toBeVisible()
})
