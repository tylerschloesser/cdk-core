import { useCallback, useEffect, useState } from 'react'
import {
  apiFetch,
  handleCallback,
  loadConfig,
  login,
  logout,
  readSse,
  type SiteConfig,
} from '@tylerschloesser/cdk-core/auth/browser'

/** No router library (plan.md D-scope: Epoch 1 has exactly two routes). */
export function App() {
  const path = window.location.pathname
  return path === '/auth/callback' ? <Callback /> : <Home />
}

function Callback() {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    // The `cancelled` guard (rather than setting state straight from the
    // promise) is what keeps oxlint's react/set-state-in-effect rule from
    // reading this as "derive during render instead" — a data fetch that
    // must run once on mount is exactly what effects are for.
    let cancelled = false
    handleCallback()
      .then((returnTo) => {
        if (cancelled) return
        // Land back on the pre-login path without a server round trip. The
        // path comes from `handleCallback`, which read it out of the
        // sessionStorage entry `login()` wrote — the query string here belongs
        // to Cognito, not to the app, and must not survive.
        history.replaceState(null, '', returnTo)
        setDone(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <p data-testid="callback-error">{error}</p>
  return done ? <Home /> : null
}

interface StreamEvent {
  readonly i: number
  readonly receivedAt: number
}

function Home() {
  const [config, setConfig] = useState<SiteConfig | null>(null)
  const [user, setUser] = useState<string | null>(null)
  const [devName, setDevName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pingResult, setPingResult] = useState('')
  const [echoInput, setEchoInput] = useState('')
  const [echoResult, setEchoResult] = useState('')
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([])

  // Returns the signed-in user's email, or 'anonymous' — no setState here, so
  // both the click handlers and the mount effect below can call it and apply
  // the result their own way (the effect needs a `cancelled` guard around its
  // setState; the handlers don't).
  const fetchUser = useCallback(async () => {
    const res = await apiFetch('/api/me')
    if (res.status === 401) return 'anonymous'
    if (!res.ok) throw new Error(`/api/me → ${res.status}`)
    const body = (await res.json()) as { email?: string }
    return body.email ?? 'anonymous'
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      setUser(await fetchUser())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [fetchUser])

  useEffect(() => {
    let cancelled = false

    loadConfig()
      .then((loaded) => {
        if (!cancelled) setConfig(loaded)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })

    fetchUser()
      .then((found) => {
        if (!cancelled) setUser(found)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [fetchUser])

  const onDevLogin = useCallback(async () => {
    try {
      await login(devName)
      await refreshUser()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [devName, refreshUser])

  // In prod and preview this navigates to Cognito and never returns; the
  // `catch` is for the configuration errors that happen before the redirect
  // (no `auth` in `__config.json`), which would otherwise be a dead button.
  const onLogin = useCallback(async () => {
    try {
      await login()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const onLogout = useCallback(async () => {
    try {
      logout()
      await refreshUser()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refreshUser])

  const onPing = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ping')
      if (!res.ok) throw new Error(`/api/ping → ${res.status}`)
      const body = (await res.json()) as { message: string }
      setPingResult(body.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const onEcho = useCallback(async () => {
    try {
      const text = echoInput
      const res = await apiFetch('/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`/api/echo → ${res.status}`)
      const body = (await res.json()) as { text: string; length: number }
      setEchoResult(`${body.text} (${body.length})`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [echoInput])

  const onStream = useCallback(async () => {
    setStreamEvents([])
    try {
      const res = await apiFetch('/events/tick?n=5')
      if (!res.body) throw new Error('/events/tick: no response body')
      for await (const frame of readSse(res.body)) {
        if (frame.event !== 'tick') continue
        // Captured now, not after `setState` — the e2e suite asserts on
        // inter-arrival timing, and batching this into the render would blur it.
        const receivedAt = Date.now()
        const { i } = JSON.parse(frame.data) as { i: number }
        setStreamEvents((prev) => [...prev, { i, receivedAt }])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  return (
    <main>
      <h1>cdk-core reference</h1>

      <section>
        <p>
          mode: <span data-testid="mode">{config?.mode ?? '…'}</span>
        </p>
        <p>
          site: <span data-testid="site">{config?.site ?? '…'}</span>
        </p>
        <p>
          user: <span data-testid="user">{user ?? '…'}</span>
        </p>

        {config?.mode === 'local' && (
          <p>
            <input
              data-testid="dev-login-name"
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              placeholder="dev user name"
            />
            <button data-testid="dev-login" onClick={() => void onDevLogin()}>
              dev login
            </button>
          </p>
        )}

        {config && config.mode !== 'local' && config.auth && (
          <p>
            <button data-testid="login" onClick={() => void onLogin()}>
              sign in with Google
            </button>
          </p>
        )}

        <p>
          <button data-testid="logout" onClick={() => void onLogout()}>
            logout
          </button>
        </p>
      </section>

      <section>
        <h2>ping</h2>
        <button data-testid="ping" onClick={() => void onPing()}>
          ping
        </button>
        <span data-testid="ping-result">{pingResult}</span>
      </section>

      <section>
        <h2>echo</h2>
        <input data-testid="echo-input" value={echoInput} onChange={(e) => setEchoInput(e.target.value)} />
        <button data-testid="echo" onClick={() => void onEcho()}>
          echo
        </button>
        <span data-testid="echo-result">{echoResult}</span>
      </section>

      <section>
        <h2>stream</h2>
        <button data-testid="stream" onClick={() => void onStream()}>
          stream
        </button>
        <ul data-testid="stream-events">
          {streamEvents.map((event, index) => (
            <li key={index} data-testid="stream-event" data-received-at={String(event.receivedAt)}>
              {event.i}
            </li>
          ))}
        </ul>
      </section>

      {error && <p data-testid="error">{error}</p>}
    </main>
  )
}
