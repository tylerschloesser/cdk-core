import { expect, test } from '@playwright/test'

test('ping round-trips through apiFetch', async ({ page }) => {
  await page.goto('/')

  await page.getByTestId('ping').click()
  await expect(page.getByTestId('ping-result')).toHaveText('pong!')

  await expect(page.getByTestId('error')).not.toBeVisible()
})

/**
 * `/api/echo` is a POST *with a body* on purpose. Under CloudFront's origin
 * access control the viewer's SigV4 signature covers a payload hash that
 * CloudFront itself cannot compute, so a body-carrying POST 403s at the
 * function URL unless the viewer sends `x-amz-content-sha256` itself.
 * `apiFetch` does that (see `hash.ts`), and this test is what proves that
 * whole path — hash computed in the browser, forwarded through the proxy or
 * CloudFront, accepted by the Lambda — works end to end. A test that only
 * exercised GETs would pass all the way to production and fail there.
 */
test('echo round-trips a multi-byte string through a signed POST body', async ({ page }) => {
  await page.goto('/')

  // A multi-byte character on purpose, and specifically one outside the BMP:
  // the server reports `.length` in UTF-16 code units, not code points, so
  // `value.length` (8, because 😀 is a surrogate pair) differs from
  // `[...value].length` (7, one entry per code point). Asserting against the
  // spread form here would be wrong — the server computes plain `.length`.
  const value = 'héllo 😀'

  await page.getByTestId('echo-input').fill(value)
  await page.getByTestId('echo').click()
  await expect(page.getByTestId('echo-result')).toHaveText(`${value} (${value.length})`)

  await expect(page.getByTestId('error')).not.toBeVisible()
})
