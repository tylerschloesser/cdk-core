/**
 * Generates the Google-sign-in gate as a *fragment* of CloudFront Function
 * (`cloudfront-js-2.0`) source — constants, two crypto helpers, and
 * `async function gate(request, pr)`. It is not a complete function source:
 * the caller (`render.ts`'s router, `spa.ts`'s prod function) must already
 * have emitted `import cf from 'cloudfront'`, `import crypto from 'crypto'`
 * and `var kvs = cf.kvs()` before splicing this in, and must call
 * `gate(request, pr)` itself from its own `handler`.
 *
 * Contract: `gate(request, pr)` returns a **response object** — the caller
 * must `return` it immediately to short-circuit the request — or `null` to
 * mean "let the request continue". `pr` is the preview's PR number as a
 * string (or `''` when there is none, e.g. on prod); it is only read when
 * this fragment was rendered with `preview: true`.
 *
 * The constant names (`SESSION_COOKIE`, `RETURN_COOKIE`, `SECRET_KEY`) are
 * fixed and shared with the Node half in `src/auth/session.ts`, which signs
 * and reads the same cookie value out of band (in a Lambda, not at the edge).
 */

export interface GateSourceProps {
  /** Cognito hosted-UI domain, e.g. 'cdk-core.auth.us-east-1.amazoncognito.com'. No scheme. */
  readonly hostedUiDomain: string
  /**
   * The app client id. This is the existing public `browser` client, not a
   * new confidential one: the gate derives a PKCE verifier from the KVS
   * session secret (see the 302 branch below) instead of needing a client
   * secret, so no new Cognito client is required.
   */
  readonly clientId: string
  /** The redirect_uri registered on that client. Prod: `https://<domain>/auth/callback`. Preview: `https://oauth.preview.<domain>/`. */
  readonly redirectUri: string
  /** True on the preview router: the caller passes a PR number and it is appended to `state`. */
  readonly preview?: boolean
  /**
   * Extra paths the gate lets through unauthenticated, checked exactly the
   * way `/auth` is: an exact match, or the path followed by `/`. `/auth` is
   * always in the list and must not be repeated here.
   *
   * An ungated path is reachable by anyone, on prod *and* on every preview
   * host — see `.claude/rules/edge-gate.md`, "What an ungated path leaks".
   */
  readonly ungatedPaths?: readonly string[]
}

/**
 * Builds the ungated list — `/auth` first, so the default emission is
 * byte-identical to what it was before this was configurable — and rejects
 * anything whose emitted check would not mean what the caller thinks.
 *
 * Manual throws rather than a schema: this is the house style at synth
 * (`site.ts`, `preview-site.ts`, `define-site-stacks.ts`) and there is no
 * validation library in this package.
 */
function ungatedList(ungatedPaths: readonly string[] | undefined): readonly string[] {
  const list = ['/auth']
  for (const path of ungatedPaths ?? []) {
    if (!path.startsWith('/')) {
      throw new Error(`ungatedPaths: ${JSON.stringify(path)} must start with '/'`)
    }
    if (path === '/') {
      throw new Error(`ungatedPaths: '/' would ungate the whole site`)
    }
    if (path.endsWith('/')) {
      throw new Error(`ungatedPaths: ${JSON.stringify(path)} must not end with '/'`)
    }
    // `*` and `?` would suggest CloudFront path-pattern semantics, which this
    // check does not have; `#` never reaches the origin; whitespace and the
    // quote characters would break the single-quoted literal this is emitted
    // into. All of them are a mistake, so none of them are silently accepted.
    if (/[*?#'\\\s]/.test(path)) {
      throw new Error(
        `ungatedPaths: ${JSON.stringify(path)} must not contain '*', '?', '#', a quote or whitespace — this is an exact path, not a CloudFront path pattern`,
      )
    }
    if (path === '/auth' || path.startsWith('/auth/')) {
      throw new Error(`ungatedPaths: ${JSON.stringify(path)} is already ungated — /auth/* is always exempt`)
    }
    if (list.includes(path)) {
      throw new Error(`ungatedPaths: ${JSON.stringify(path)} is listed twice`)
    }
    list.push(path)
  }
  return list
}

/**
 * Renders the gate fragment — see the module comment for the contract.
 */
export function renderGateSource(props: GateSourceProps): string {
  const authorizeUrl =
    `https://${props.hostedUiDomain}/oauth2/authorize?client_id=${props.clientId}` +
    `&response_type=code&scope=openid+email&identity_provider=Google` +
    `&redirect_uri=${encodeURIComponent(props.redirectUri)}&state=`

  // Unrolled rather than an array plus a loop: a loop costs ~160 bytes of
  // fixed overhead against a measured 40 + 2×len per extra entry, so unrolled is
  // cheaper for the one-to-three paths this is for — and with `/auth` first
  // the default output is byte-identical to the pre-`ungatedPaths` line.
  // Single quotes, not `JSON.stringify`: same byte count, same characters.
  const ungatedCheck = ungatedList(props.ungatedPaths)
    .map((path) => `uri === '${path}' || uri.indexOf('${path}/') === 0`)
    .join(' || ')

  const stateBlock = props.preview
    ? `  var body
  var state
  if (pr) {
    body = iat + '~' + pr
    state = iat + '.' + gateHmac(secret, body) + '~' + pr
  } else {
    body = '' + iat
    state = iat + '.' + gateHmac(secret, body)
  }`
    : `  var body = '' + iat
  var state = iat + '.' + gateHmac(secret, body)`

  return `var SESSION_COOKIE = '__Host-cdkcore-session'
var RETURN_COOKIE = '__Host-cdkcore-return'
var SECRET_KEY = '__cdkcore-session-secret'
var AUTHORIZE = ${JSON.stringify(authorizeUrl)}

function gateEq(a, b) {
  if (a.length !== b.length) return false
  var d = 0
  for (var i = 0; i < a.length; i++) {
    d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return d === 0
}

function gateHmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex')
}

async function gate(request, pr) {
  var uri = request.uri
  // /auth/* is its own behavior and carries no function of its own, but the
  // gate's contract should be legible without reading the distribution. Any
  // \`ungatedPaths\` the consumer configured are checked here too, before the
  // KVS read — so an ungated path costs one fewer KVS read than a gated one.
  if (${ungatedCheck}) return null

  // \`kvs.get\` must not be awaited inside its own argument list (a syntax
  // error in cloudfront-js-2.0) -- bind the awaited value to a variable first.
  var secret
  try {
    secret = await kvs.get(SECRET_KEY)
  } catch (e) {
    secret = ''
  }

  if (secret) {
    var cookie = request.cookies[SESSION_COOKIE]
    var value = cookie ? cookie.value : ''
    var dot = value ? value.lastIndexOf('.') : -1
    if (dot > 0) {
      var payload = value.slice(0, dot)
      var sig = value.slice(dot + 1)
      if (gateEq(gateHmac(secret, payload), sig)) {
        var bar = payload.lastIndexOf('|')
        var exp = parseInt(payload.slice(bar + 1), 10)
        if (exp * 1000 > Date.now()) return null
      }
    }
  }

  // A browser subresource fetch (fetch/XHR/img/script/etc.) must not be
  // answered with a redirect to Google -- only a top-level navigation gets
  // bounced. curl sends no sec-fetch-mode, so it falls through to the 302
  // below; that is deliberate and is what the project's one-line
  // verification checks.
  var sfm = request.headers['sec-fetch-mode']
  if (sfm && sfm.value !== 'navigate') {
    return {
      statusCode: 401,
      statusDescription: 'Unauthorized',
      headers: {
        'content-type': { value: 'text/plain' },
        'cache-control': { value: 'no-store' },
      },
      body: 'sign in required',
    }
  }

  if (!secret) {
    // The ~30s window after a first deploy while a new KVS key propagates to
    // the edge. Fail closed with an honest status rather than an infinite
    // redirect loop through Cognito.
    return {
      statusCode: 503,
      statusDescription: 'Service Unavailable',
      headers: {
        'content-type': { value: 'text/plain' },
        'cache-control': { value: 'no-store' },
      },
      body: 'auth unavailable',
    }
  }

  var iat = Math.floor(Date.now() / 1000)
${stateBlock}

  // The edge has no CSPRNG, but it already holds an unpredictable value: the
  // KVS session secret. Deriving the PKCE verifier from it (keyed to the
  // exact string signed into \`state\`) means no new Cognito client and no
  // client secret -- the gate reuses the existing public \`browser\` client,
  // and the callback Lambda re-derives the same verifier from the same
  // secret and \`state\` to call \`exchangeCode\` unchanged.
  var verifier = gateHmac(secret, 'pkce|' + body)
  // \`crypto.createHash('sha256').update(verifier).digest('base64')\` is the
  // one edge crypto call whose behavior AWS's cloudfront-js-2.0 docs don't
  // spell out -- \`aws cloudfront test-function\` against the DEVELOPMENT
  // stage is what confirms it before a first publish.
  var challengeRaw = crypto.createHash('sha256').update(verifier).digest('base64')
  var challenge = challengeRaw.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')

  // The return cookie carries the path only, not the query string.
  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: {
      location: {
        value: AUTHORIZE + state + '&code_challenge_method=S256&code_challenge=' + challenge,
      },
      'cache-control': { value: 'no-store' },
    },
    cookies: {
      '__Host-cdkcore-return': { value: uri, attributes: 'Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600' },
    },
  }
}
`
}
