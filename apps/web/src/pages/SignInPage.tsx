import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { signIn, signUp } from '../lib/auth.js'
import {
  PLATFORM_CHOICES,
  clearFeedback,
  initialForm,
  problemsFrom,
  togglePlatform,
  validateForm,
  withField,
  withMode,
} from '../lib/auth-view.js'
import type { AuthFormState, AuthMode } from '../lib/auth-view.js'

/** Sign in, or create an account. The form explains its own rules. */
export function SignInPage(props: { onAuthenticated: () => void; initialMode?: AuthMode }): ReactNode {
  const [form, setForm] = useState<AuthFormState>(() => initialForm(props.initialMode ?? 'signin'))

  useEffect(() => {
    document.title = form.mode === 'signin' ? 'Sign in · Creator Mall' : 'Create an account · Creator Mall'
  }, [form.mode])

  const validity = validateForm(form)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!validity.valid || form.busy) {
      setForm((current) => ({ ...current, problems: validity.problems }))
      return
    }

    setForm((current) => ({ ...current, busy: true, error: null, problems: [] }))
    try {
      if (form.mode === 'signin') {
        await signIn(form.email.trim(), form.password)
      } else {
        await signUp({
          email: form.email.trim(),
          password: form.password,
          displayName: form.displayName.trim(),
          platformSlugs: form.platformSlugs,
        })
      }
      props.onAuthenticated()
    } catch (error) {
      const { message, problems } = problemsFrom(error)
      setForm((current) => ({ ...current, busy: false, error: message, problems }))
    }
  }

  return (
    <div className="auth-shell">
      <form className="card auth-card" onSubmit={(event) => void submit(event)}>
        <div className="row">
          <h1 style={{ margin: 0, fontSize: 22 }}>Creator Mall</h1>
          <span className="pill right accent">always up to date</span>
        </div>
        <p style={{ marginTop: 8 }}>
          {form.mode === 'signin'
            ? 'Sign in to see what changed on the platforms you use.'
            : 'Create an account and we will only tell you about changes that affect you.'}
        </p>

        {form.error && <div className="notice stop" style={{ marginTop: 14 }}>{form.error}</div>}
        {form.problems.length > 0 && (
          <ul className="auth-problems">
            {form.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        {form.mode === 'signup' && (
          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="displayName">What should we call you?</label>
            <input
              id="displayName"
              type="text"
              autoComplete="name"
              value={form.displayName}
              onChange={(event) => setForm((current) => clearFeedback(withField(current, 'displayName', event.target.value)))}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="text"
            autoComplete="email"
            value={form.email}
            onChange={(event) => setForm((current) => clearFeedback(withField(current, 'email', event.target.value)))}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={form.mode === 'signin' ? 'current-password' : 'new-password'}
            value={form.password}
            onChange={(event) => setForm((current) => clearFeedback(withField(current, 'password', event.target.value)))}
          />
          {form.mode === 'signup' && <span className="help">At least 10 characters, with a letter and a number.</span>}
        </div>

        {form.mode === 'signup' && (
          <div className="field">
            <label>Where do you post?</label>
            <div className="row">
              {PLATFORM_CHOICES.map((choice) => {
                const selected = form.platformSlugs.includes(choice.slug)
                return (
                  <button
                    key={choice.slug}
                    type="button"
                    className={`pill ${selected ? 'accent' : ''}`}
                    onClick={() => setForm((current) => clearFeedback(togglePlatform(current, choice.slug)))}
                  >
                    {choice.label}
                  </button>
                )
              })}
            </div>
            <span className="help">Optional. We use this to decide which updates are worth interrupting you for.</span>
          </div>
        )}

        <button className="primary" type="submit" disabled={form.busy}>
          {form.busy ? 'Working…' : form.submitLabel}
        </button>

        <p style={{ marginTop: 16, fontSize: 14 }}>
          {form.mode === 'signin' ? 'New here? ' : 'Already have an account? '}
          <button
            type="button"
            className="link-button"
            onClick={() => setForm((current) => withMode(current, current.mode === 'signin' ? 'signup' : 'signin'))}
          >
            {form.mode === 'signin' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </form>
    </div>
  )
}
