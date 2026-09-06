/**
 * A minimal server-sent-events parser over a `fetch` response body.
 *
 * Not `EventSource`: it cannot be pointed at a `fetch` `Response` (it only ever
 * makes its own GET, with no way to add a header) and it has no
 * `AbortController` hook. Both matter here — the ID token travels in
 * `x-id-token`, so the request must be a `fetch`, and a stream must stop the
 * moment a reader navigates away.
 */

export interface SseEvent {
  /** `event:` field, or `message` when the frame names none. */
  readonly event: string
  /** `data:` lines joined with `\n`. */
  readonly data: string
  /** `id:` field when the frame carries one. */
  readonly id?: string
}

/**
 * Yields one `SseEvent` per frame. Frames are separated by a blank line; a line
 * starting with `:` is a comment (that is what a `: keepalive` is) and is
 * dropped, and a frame with no `data:` line yields nothing.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Both separators are legal frame terminators; a producer behind a proxy
      // that rewrites newlines can emit either.
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (!match) break
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const parsed = parseFrame(frame)
        if (parsed) yield parsed
      }
    }

    // The socket can close right after the last frame with no trailing blank
    // line — don't drop it.
    const last = parseFrame(buffer)
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(frame: string): SseEvent | null {
  let event = 'message'
  let id: string | undefined
  const dataLines: string[] = []

  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // Per the spec a single leading space after the colon is part of the
    // delimiter, not the value.
    const raw = colon === -1 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw

    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0) return null
  const data = dataLines.join('\n')
  return id === undefined ? { event, data } : { event, data, id }
}
