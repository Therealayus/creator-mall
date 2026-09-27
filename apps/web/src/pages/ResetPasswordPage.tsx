import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { confirmPasswordReset } from '../lib/api.js'
import { PASSWORD_HELP, passwordProblems } from '../lib/view-models.js'

/**
 * The page a reset link lands on.
 *
 * The token arrives in the query string, is spent exactly once, and is never
 * written anywhere but the request that redeems it. On success every session
 * the account had is gone, so the only honest next step is signing in again
 * with the new password.
 */
export function ResetPasswordPage(): ReactNode {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [done, setDone] = useState(false)

  if (!token) {
    return (
      <Shell title="Reset your password">
        <p>
          This link is missing its code. Reset links look like{' '}
          <code>/reset-password?token=…</code> — open the most recent one from your email.
        </p>
        <p>
          <Link className="ghost" to="/">
            Back to Creator Mall
          </Link>
        </p>
      </Shell>
    )
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    const found = passwordProblems(password)
    if (found.length > 0) {
      setProblems(found)
      setError(null)
      return
    }

    setBusy(true)
    setError(null)
    setProblems([])
    try {
      await confirmPasswordReset(token, password)
      setDone(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the password just now')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Shell title="Password changed">
        <div className="notice good">
          <span>Your password has been changed and every other session has been signed out.</span>
        </div>
        <p>
          <Link className="primary" to="/signin">
            Sign in with your new password
          </Link>
        </p>
      </Shell>
    )
  }

  return (
    <Shell title="Choose a new password">
      {error && <div className="notice stop">{error}</div>}
      {problems.length > 0 && (
        <ul style={{ color: 'var(--text-soft)' }}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              setProblems([])
              setError(null)
            }}
          />
          <span className="help">{PASSWORD_HELP}</span>
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : 'Change my password'}
        </button>
      </form>
    </Shell>
  )
}

function Shell(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <h1 style={{ margin: 0, fontSize: 22 }}>{props.title}</h1>
        <div style={{ marginTop: 14 }}>{props.children}</div>
      </div>
    </div>
  )
}
