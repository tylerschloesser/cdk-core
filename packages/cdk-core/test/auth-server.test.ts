import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf123'
const CLIENT_ID = 'test-client-id'

// `CognitoJwtVerifier.create` is the one call in `createVerifier` that
// reaches out (JWKS fetch, lazily, on first `verify`). Stubbing it here keeps
// this whole file network-free while still exercising the real mapping and
// caching logic in `server.ts`.
const verify = vi.fn()
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: vi.fn(() => ({ verify })),
  },
}))

const {
  authMode,
  createVerifier,
  getUser,
  parseDevToken,
  resetVerifierCache,
} = await import('../src/auth/server.js')

describe('authMode', () => {
  const ORIGINAL = process.env.AUTH

  afterEach(() => {
    process.env.AUTH = ORIGINAL
  })

  it('is "none" when AUTH is unset', () => {
    delete process.env.AUTH
    expect(authMode()).toBe('none')
  })

  it('is "local" for AUTH=local', () => {
    process.env.AUTH = 'local'
    expect(authMode()).toBe('local')
  })

  it('is "cognito" for AUTH=cognito', () => {
    process.env.AUTH = 'cognito'
    expect(authMode()).toBe('cognito')
  })

  it('is "none" for garbage', () => {
    process.env.AUTH = 'wat'
    expect(authMode()).toBe('none')
  })
})

describe('parseDevToken', () => {
  it('rejects "dev:" with no name', () => {
    expect(parseDevToken('dev:')).toBeNull()
  })

  it('rejects "dev: " (whitespace-only name)', () => {
    expect(parseDevToken('dev: ')).toBeNull()
  })

  it('rejects a token with no "dev:" prefix', () => {
    expect(parseDevToken('nope')).toBeNull()
  })

  it('accepts "dev:alice"', () => {
    expect(parseDevToken('dev:alice')).toEqual({
      sub: 'dev:alice',
      email: 'alice@local',
    })
  })
})

describe('createVerifier', () => {
  it('throws on a malformed issuer ("not-a-url")', () => {
    expect(() => createVerifier({ issuer: 'not-a-url', clientId: CLIENT_ID })).toThrow(
      /invalid Cognito issuer/,
    )
  })

  it('throws on an issuer with the wrong host', () => {
    expect(() =>
      createVerifier({ issuer: 'https://example.com/pool', clientId: CLIENT_ID }),
    ).toThrow(/invalid Cognito issuer/)
  })

  it('accepts a well-formed Cognito issuer', () => {
    expect(() => createVerifier({ issuer: ISSUER, clientId: CLIENT_ID })).not.toThrow()
  })
})

describe('getUser', () => {
  const ORIGINAL = {
    AUTH: process.env.AUTH,
    AUTH_ISSUER: process.env.AUTH_ISSUER,
    AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID,
  }

  beforeEach(() => {
    resetVerifierCache()
    verify.mockReset()
  })

  afterEach(() => {
    process.env.AUTH = ORIGINAL.AUTH
    process.env.AUTH_ISSUER = ORIGINAL.AUTH_ISSUER
    process.env.AUTH_CLIENT_ID = ORIGINAL.AUTH_CLIENT_ID
  })

  function req(header?: string) {
    return {
      req: {
        header: (name: string) => (name === 'x-id-token' ? header : undefined),
      },
    }
  }

  describe('local mode', () => {
    beforeEach(() => {
      process.env.AUTH = 'local'
    })

    it('returns the fake user for a dev token', async () => {
      await expect(getUser(req('dev:alice'))).resolves.toEqual({
        sub: 'dev:alice',
        email: 'alice@local',
      })
    })

    it('returns null with no header', async () => {
      await expect(getUser(req(undefined))).resolves.toBeNull()
    })
  })

  it('returns null with no header and AUTH unset', async () => {
    delete process.env.AUTH
    await expect(getUser(req(undefined))).resolves.toBeNull()
  })

  describe('cognito mode', () => {
    beforeEach(() => {
      process.env.AUTH = 'cognito'
    })

    it('throws when AUTH_ISSUER/AUTH_CLIENT_ID are unset', async () => {
      delete process.env.AUTH_ISSUER
      delete process.env.AUTH_CLIENT_ID
      await expect(getUser(req('some-token'))).rejects.toThrow(
        /AUTH_ISSUER and AUTH_CLIENT_ID/,
      )
    })

    it('returns null for a token that fails verification', async () => {
      process.env.AUTH_ISSUER = ISSUER
      process.env.AUTH_CLIENT_ID = CLIENT_ID
      verify.mockRejectedValueOnce(new Error('invalid signature'))
      await expect(getUser(req('bad-token'))).resolves.toBeNull()
    })

    it('maps a verified payload to sub/email', async () => {
      process.env.AUTH_ISSUER = ISSUER
      process.env.AUTH_CLIENT_ID = CLIENT_ID
      verify.mockResolvedValueOnce({ sub: 'abc-123', email: 'alice@example.com' })
      await expect(getUser(req('good-token'))).resolves.toEqual({
        sub: 'abc-123',
        email: 'alice@example.com',
      })
    })
  })
})
