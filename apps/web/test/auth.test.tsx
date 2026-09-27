import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToString } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import {
  PLATFORM_CHOICES,
  clearFeedback,
  initialForm,
  problemsFrom,
  sessionHeadline,
  togglePlatform,
  validateForm,
  withField,
  withMode,
} from '../src/lib/auth-view.js'
import { AuthError } from '../src/lib/auth.js'
import { SignInPage } from '../src/pages/SignInPage.js'
import { Shell } from '../src/components/Shell.js'

describe('sign-in form rules', () => {
  it('asks only for what sign-in needs', () => {
    const state = initialForm('signin')
    assert.equal(state.displayName, '')
    const filled = withField(withField(state, 'email', 'creator@example.com'), 'password', 'secretpass1')
    assert.equal(validateForm(filled).valid, true)
  })

  it('demands a display name and a strong password when creating an account', () => {
    const state = withMode(initialForm('signin'), 'signup')
    const problems = validateForm(state).problems
    assert.ok(problems.some((problem) => /call you/i.test(problem)))
    assert.ok(problems.some((problem) => /email/i.test(problem)))

    const weak = withField(withField(withField(state, 'displayName', 'Creator'), 'email', 'a@b.co'), 'password', 'short1')
    assert.equal(validateForm(weak).valid, false)

    const strong = withField(withField(withField(state, 'displayName', 'Creator'), 'email', 'a@b.co'), 'password', 'longenough1')
    assert.equal(validateForm(strong).valid, true)
  })

  it('toggles platforms and keeps the choice', () => {
    let state = initialForm('signup')
    state = togglePlatform(state, 'instagram')
    assert.deepEqual(state.platformSlugs, ['instagram'])
    state = togglePlatform(state, 'youtube')
    assert.deepEqual(state.platformSlugs, ['instagram', 'youtube'])
    state = togglePlatform(state, 'instagram')
    assert.deepEqual(state.platformSlugs, ['youtube'])
  })

  it('clears the error as soon as the creator edits a field', () => {
    const failed = { ...initialForm('signin'), error: 'That email and password do not match.' }
    assert.equal(failed.error, 'That email and password do not match.')
    assert.equal(clearFeedback(withField(failed, 'email', 'a@b.co')).error, null)
  })

  it('keeps the email when switching between sign in and sign up', () => {
    const state = withField(initialForm('signin'), 'email', 'creator@example.com')
    const switched = withMode(state, 'signup')
    assert.equal(switched.email, 'creator@example.com')
    assert.equal(switched.mode, 'signup')
    assert.equal(switched.password, '')
  })

  it('surfaces server problems verbatim so the form explains itself', () => {
    const error = new AuthError('Choose a stronger password.', ['Use at least 10 characters.'])
    const { message, problems } = problemsFrom(error)
    assert.equal(message, 'Choose a stronger password.')
    assert.deepEqual(problems, ['Use at least 10 characters.'])

    const unknown = problemsFrom(new Error('offline'))
    assert.equal(unknown.message, 'offline')
  })

  it('names the session', () => {
    assert.equal(sessionHeadline({ displayName: 'Riya' }), 'Signed in as Riya')
    assert.equal(sessionHeadline(null), 'Sign in to Creator Mall')
  })
})

describe('sign-in page', () => {
  const render = (node: ReactNode): string => {
    const router = createMemoryRouter([{ path: '/', element: node }], { initialEntries: ['/'] })
    return renderToString(<RouterProvider router={router} />).replace(/<!-- -->/g, '')
  }

  it('offers both paths and asks for the basics', () => {
    const html = render(<SignInPage onAuthenticated={() => undefined} />)
    assert.match(html, /Sign in to see what changed/)
    assert.match(html, /Create an account/)
    assert.match(html, /id="email"/)
    assert.match(html, /id="password"/)
    assert.equal(/displayName/.test(html), false, 'the display name is only needed when creating an account')
  })

  it('never shows internal vocabulary', () => {
    const html = render(<SignInPage onAuthenticated={() => undefined} />)
    const jargon = /capability|adapter|embedding|crawler|evolution|session token|hash/i
    assert.equal(jargon.test(html), false)
  })

  it('offers the platforms a creator might use when creating an account', () => {
    const html = render(<SignInPage onAuthenticated={() => undefined} initialMode="signup" />)
    for (const choice of PLATFORM_CHOICES) assert.ok(html.includes(choice.label))
  })
})

describe('shell', () => {
  const render = (node: ReactNode): string => {
    const router = createMemoryRouter([{ path: '/', element: node }], { initialEntries: ['/'] })
    return renderToString(<RouterProvider router={router} />).replace(/<!-- -->/g, '')
  }

  it('shows who is signed in and offers a way out', () => {
    const html = render(
      <Shell creator="Riya" role="CREATOR" unread={2} onSignOut={() => undefined}>
        <p>content</p>
      </Shell>,
    )
    assert.match(html, /Riya/)
    assert.match(html, /Sign out/)
    assert.match(html, /Your updates \(2\)/)
    assert.equal(html.includes('/evolution-center'), false, 'operator view is for admins only')
  })

  it('shows the operator view to an admin', () => {
    const html = render(
      <Shell creator="Ops" role="ADMIN" unread={0} onSignOut={() => undefined}>
        <p>content</p>
      </Shell>,
    )
    assert.match(html, /Operator view/)
  })
})
