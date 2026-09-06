/**
 * SHA-256 of a request body, lowercase hex.
 *
 * Not a convenience: under CloudFront origin access control the origin request
 * is signed with SigV4, and SigV4 signs a payload hash that CloudFront cannot
 * compute for a streaming viewer body. A POST with a body therefore 403s at the
 * Lambda function URL unless the *viewer* sends `x-amz-content-sha256` itself.
 * `apiFetch` computes it here for every request that has a body.
 */

/** SigV4's hash of the empty payload. Sent when a request has no body. */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export async function sha256Hex(body: string | ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes =
    typeof body === 'string'
      ? new TextEncoder().encode(body)
      : ArrayBuffer.isView(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : new Uint8Array(body)

  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
