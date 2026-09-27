import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { verifyEmail } from '../lib/api.js'

/**
 * The page a confirmation link lands on.
 *
 * The token is spent the moment the page opens, and the request is guarded so a
 * re-render or a double effect cannot redeem it twice — it is single use, and
 * the second attempt would say the link had expired.
 */
export function VerifyEmailPage(): ReactNode {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed')
  const [error, setError] = useState<string | null>(
    token ? null : 'This link is missing its code. Open the most recent one from your email.',
  )
  const spent = useRef(false)

  useEffect(() => {
    if (!token || spent.current) return
    spent.current = true
    verifyEmail(token)
      .then(() => setState('done'))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Could not confirm that address just now')
        setState('failed')
      })
  }, [token])

  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <h1 style={{ margin: 0, fontSize: 22 }}>Email address</h1>

        <div style={{ marginTop: 14 }}>
          {state === 'working' && <p>Confirming your address…</p>}

          {state === 'done' && (
            <>
              <div className="notice good">
                <span>Thanks — your email address is confirmed.</span>
              </div>
              <p>
                <Link className="primary" to="/signin">
                  Sign in
                </Link>
              </p>
            </>
          )}

          {state === 'failed' && (
            <>
              <div className="notice stop">{error}</div>
              <p>You can ask for a new confirmation link from the sign-in page.</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
