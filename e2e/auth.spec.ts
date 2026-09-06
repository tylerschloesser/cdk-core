import { expect, test, TARGET } from './fixtures.js'

test('a fresh page is anonymous', async ({ page }) => {
  await page.goto('/')

  // `/api/me` returns 401 with no token, and the app renders that as
  // 'anonymous'. Assert this before any login happens in this test file —
  // each test gets its own browser context, so there is nothing to log out
  // of, but it's the baseline every other assertion here builds on.
  await expect(page.getByTestId('user')).toHaveText('anonymous')
})

// The dev-login box only renders in `mode: 'local'`, because `dev:` tokens
// are only trusted by a backend running with `AUTH=local`. Everywhere else the
// same round trip is proven by the machine-auth fixture below.
test.describe(() => {
  test.skip(TARGET !== 'local', 'the dev-login box only exists in local mode')

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

// Local and preview run the identical assertion: the fixture seeds
// `dev:claude` in one and a real Cognito token in the other, and the app
// renders 'claude@local' or 'claude@<site>'. No branching — the fixture is
// where the difference lives (plan.md D6). Production is skipped because it
// has no machine user at all, which is the point of A7.
test('a machine-authed page reads back the signed-in user', async ({ authedPage, machineAuth }) => {
  test.skip(TARGET === 'prod', 'production has no machine user — that is A7, not a gap')
  await authedPage.goto('/')

  await expect(authedPage.getByTestId('user')).toHaveText(machineAuth.email)
})

// Preview-only: this is the assertion that proves the two Cognito pools are
// actually isolated. A preview token sent to *production* must be rejected —
// it is signed by a different issuer than the prod verifier trusts, so no
// flag or config anywhere makes it work. `request` (not the page) so the
// call never goes through the preview's own origin.
test('a preview token is rejected by production', async ({ machineAuth, request }) => {
  test.skip(TARGET !== 'preview', 'needs a preview token and a live production API')

  const res = await request.get('https://cdk-core.ty.ler.dev/api/me', {
    headers: { 'x-id-token': machineAuth.idToken },
  })
  expect(res.status()).toBe(401)
})
