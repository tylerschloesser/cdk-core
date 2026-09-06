import { describe, expect, it } from 'vitest'
import { readSse } from '../src/sse.js'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = []
  for await (const event of readSse(body)) out.push(event)
  return out
}

describe('readSse', () => {
  it('defaults the event name to message when none is given', async () => {
    const events = await collect(streamOf(['data: hello\n\n']))
    expect(events).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('parses event, id and data, omitting id when absent', async () => {
    const withId = await collect(streamOf(['event: ping\nid: 1\ndata: hi\n\n']))
    expect(withId).toEqual([{ event: 'ping', id: '1', data: 'hi' }])

    const withoutId = await collect(streamOf(['event: ping\ndata: hi\n\n']))
    expect(withoutId[0]).not.toHaveProperty('id')
  })

  it('joins multiple data lines with a newline', async () => {
    const events = await collect(streamOf(['data: line1\ndata: line2\n\n']))
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }])
  })

  it('drops a comment frame without disturbing surrounding frames', async () => {
    const events = await collect(
      streamOf(['data: first\n\n', ': keepalive\n\n', 'data: second\n\n']),
    )
    expect(events).toEqual([
      { event: 'message', data: 'first' },
      { event: 'message', data: 'second' },
    ])
  })

  it('reassembles a frame split across chunk boundaries', async () => {
    // This is the case that matters: a real network delivers chunks that
    // split mid-frame, not one frame per chunk.
    const events = await collect(streamOf(['data: he', 'llo\n\n']))
    expect(events).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('reassembles a multi-byte UTF-8 character split across chunks', async () => {
    const encoded = new TextEncoder().encode('data: héllo\n\n')
    // Split inside the two-byte encoding of 'é' so neither half decodes alone.
    const splitAt = encoded.indexOf(0xc3) + 1
    const first = encoded.slice(0, splitAt)
    const second = encoded.slice(splitAt)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(first)
        c.enqueue(second)
        c.close()
      },
    })
    const events = await collect(body)
    expect(events).toEqual([{ event: 'message', data: 'héllo' }])
  })

  it('accepts both \\n\\n and \\r\\n\\r\\n as frame separators', async () => {
    const events = await collect(streamOf(['data: a\n\ndata: b\r\n\r\n']))
    expect(events).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ])
  })

  it('yields a final frame with no trailing blank line', async () => {
    const events = await collect(streamOf(['data: last']))
    expect(events).toEqual([{ event: 'message', data: 'last' }])
  })

  it('yields nothing for a frame with no data line', async () => {
    const events = await collect(streamOf(['event: ping\n\n']))
    expect(events).toEqual([])
  })

  it('strips a single leading space after the colon but keeps a second one', async () => {
    const events = await collect(streamOf(['data:  x\n\n']))
    expect(events).toEqual([{ event: 'message', data: ' x' }])
  })
})
