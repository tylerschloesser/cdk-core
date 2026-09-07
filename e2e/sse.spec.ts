import { expect, test, TARGET } from './fixtures.js'

/**
 * The load-bearing streaming test.
 *
 * Asserting that five events *arrive* proves nothing: a proxy that buffers the
 * whole response and flushes it at the end delivers exactly the same five
 * events, and that is the failure mode this stack is most exposed to —
 * CloudFront compressing `text/event-stream`, a behavior with the wrong cache
 * policy, `compress: true` on the backend, or a Lambda URL created without
 * `RESPONSE_STREAM`. Every one of those turns a stream into a batch while
 * leaving the payload identical.
 *
 * So the assertions are on *inter-arrival timing*, measured in the browser at
 * the moment each frame is yielded by `readSse` (`data-received-at`), not on
 * content. The producer emits one event every 500 ms with the first immediate,
 * so five events span ~2000 ms:
 *
 *   - 1st → 5th at least 400 ms apart. A buffered response collapses this to
 *     roughly zero; the bound is a fifth of the expected 2000 ms so that a slow
 *     CI runner or a cold Lambda cannot make it flaky in the other direction.
 *   - 2nd within 1500 ms of the 1st. This is the other half: it fails if the
 *     stream is delivered incrementally but far slower than it was produced.
 *
 * Together they bracket "incremental, and roughly at the rate the server sent".
 *
 * `/events/tick` requires auth, so this runs against `authedPage` — a plain
 * `page` would 401 before any of this timing matters. That also puts it out of
 * reach against production, which has no machine user by design (A7); the
 * production streaming path was measured unauthenticated in Epoch 3 and is
 * re-checked by hand after a Google login.
 */
// Declaration scope, not inside the body: fixtures are resolved before a test
// body runs, and `machineAuth` throws against prod rather than yielding a
// token that would 401 later.
test.describe(() => {
  test.skip(TARGET === 'prod', 'production has no machine user — that is A7, not a gap')

  test('sse events arrive incrementally, not in one buffered flush', async ({ authedPage }) => {
    await authedPage.goto('/')

    await authedPage.getByTestId('stream').click()

    const events = authedPage.getByTestId('stream-event')
    await expect(events).toHaveCount(5, { timeout: 20_000 })

    expect(await events.allTextContents()).toEqual(['1', '2', '3', '4', '5'])

    const receivedAt = await events.evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute('data-received-at'))),
    )
    expect(receivedAt.every((t) => Number.isFinite(t) && t > 0)).toBe(true)

    const spread = receivedAt[4]! - receivedAt[0]!
    const secondGap = receivedAt[1]! - receivedAt[0]!

    expect(spread, `1st→5th spread was ${spread}ms; a buffered response collapses this to ~0`).toBeGreaterThanOrEqual(400)
    expect(secondGap, `1st→2nd gap was ${secondGap}ms`).toBeLessThanOrEqual(1500)

    // Arrival order must match emission order, or the parser is reordering frames.
    for (let i = 1; i < receivedAt.length; i++) {
      expect(receivedAt[i]!).toBeGreaterThanOrEqual(receivedAt[i - 1]!)
    }
  })
})

// Proves the endpoint is actually protected, not merely reachable: no token
// at all must 401, the same way `/api/me` does.
test('sse stream 401s with no token', async ({ request }) => {
  const res = await request.get('/events/tick?n=5')
  expect(res.status()).toBe(401)
})
