import { expect, test } from '@playwright/test'

test('a fresh page is anonymous', async ({ page }) => {
  await page.goto('/')

  // `/api/me` returns 401 with no token, and the app renders that as
  // 'anonymous'. Assert this before any login happens in this test file —
  // each test gets its own browser context, so there is nothing to log out
  // of, but it's the baseline every other assertion here builds on.
  await expect(page.getByTestId('user')).toHaveText('anonymous')
})

// `dev:` tokens only exist when the backend runs with AUTH=local. Cognito /
// machine auth against a deployed preview is Epoch 4 — replace this skip with
// a machine-auth fixture then, don't delete these tests.
test.describe(() => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, 'dev login is local-mode only; preview auth lands in Epoch 4')

  test('dev login round-trips through localStorage, and logout clears it', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('dev-login-name').fill('alice')
    await page.getByTestId('dev-login').click()
    // The round trip matters: this proves the token is read back from
    // localStorage and sent on the next /api/me call, not just held in React
    // state that a reload (below) would lose.
    await expect(page.getByTestId('user')).toHaveText('alice@local')

    await page.getByTestId('logout').click()
    await expect(page.getByTestId('user')).toHaveText('anonymous')
  })

  test('the token survives a reload', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('dev-login-name').fill('alice')
    await page.getByTestId('dev-login').click()
    await expect(page.getByTestId('user')).toHaveText('alice@local')

    // Proves `localStorage['cdkcore:auth']` is the source of truth, not
    // component state: a reload wipes React state but not storage, so the
    // user should still read as logged in on the other side.
    await page.reload()
    await expect(page.getByTestId('user')).toHaveText('alice@local')
  })
})
