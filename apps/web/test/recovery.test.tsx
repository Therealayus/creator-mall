import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToString } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ResetPasswordPage } from '../src/pages/ResetPasswordPage.js'
import { VerifyEmailPage } from '../src/pages/VerifyEmailPage.js'
import { SignInPage } from '../src/pages/SignInPage.js'
import { PASSWORD_HELP, PUBLIC_PATHS, isPublicPath, passwordProblems } from '../src/lib/view-models.js'

/**
 * Account recovery in the browser.
 *
 * These tests exist because of two bugs that only a person clicking a link would
 * have found: the server pointed reset links at pages that did not exist, and
 * the pages that were added sat behind the signed-out gate, so they were
 * unreachable at exactly the moment they were needed.
 */

function renderAt(node: ReactNode, path: string): string {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: node,
        children: [
          { index: true, element: node },
          { path: '*', element: node },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  return renderToString(<RouterProvider router={router} />).replace(/<!-- -->/g, '')
}

describe('the reset password page', () => {
  it('asks for a new password when the link carries a token', () => {
    const html = renderAt(<ResetPasswordPage />, '/reset-password?token=abc123')
    assert.match(html, /Choose a new password/)
    assert.match(html, /new-password/)
    assert.match(html, /Change my password/)
  })

  it('explains itself when the link has no token, instead of failing silently', () => {
    const html = renderAt(<ResetPasswordPage />, '/reset-password')
    assert.match(html, /missing its code/)
    assert.equal(/Change my password/.test(html), false, 'there is nothing to submit without a token')
  })

  it('says what a good password looks like, before submitting', () => {
    const html = renderAt(<ResetPasswordPage />, '/reset-password?token=abc123')
    assert.match(html, /At least 10 characters/)
  })

  it('is reachable on its own route', () => {
    const html = renderAt(
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Routes>,
      '/reset-password?token=abc123',
    )
    assert.match(html, /Change my password/)
  })
})

describe('the verify email page', () => {
  it('confirms the address from the token alone', () => {
    const html = renderAt(<VerifyEmailPage />, '/verify-email?token=abc123')
    assert.match(html, /Confirming your address/)
  })

  it('explains itself when the link has no token', () => {
    const html = renderAt(<VerifyEmailPage />, '/verify-email')
    assert.match(html, /missing its code/)
  })
})

describe('the sign-in page', () => {
  it('offers a way to recover a forgotten password', () => {
    const html = renderToString(
      <MemoryRouter>
        <SignInPage onAuthenticated={() => undefined} />
      </MemoryRouter>,
    )
    assert.match(html, /Forgotten your password\?/)
  })
})

describe('the app routes recovery above the session gate', () => {
  /**
   * The regression that matters: a signed-out visitor following a reset link
   * must reach the reset page, not the sign-in form. `App` renders the sign-in
   * page for every route once nobody is signed in, so this rule is what makes
   * recovery reachable at all.
   */
  it('treats the recovery paths as public, and nothing else', () => {
    assert.equal(isPublicPath('/reset-password'), true)
    assert.equal(isPublicPath('/verify-email'), true)
    assert.equal(isPublicPath('/'), false)
    assert.equal(isPublicPath('/library'), false, 'the library still needs a session')
    assert.equal(isPublicPath('/create'), false)
  })

  it('matches the paths the server actually links to', () => {
    // The server builds `${baseUrl}/reset-password?token=…` and
    // `${baseUrl}/verify-email?token=…`. If these two lists ever drift apart,
    // a reset link lands on the home page and silently does nothing.
    assert.deepEqual([...PUBLIC_PATHS].sort(), ['/reset-password', '/verify-email'])
  })
})

describe('the password rule', () => {
  it('matches what the server enforces', () => {
    assert.deepEqual(passwordProblems('short1'), ['Use at least 10 characters.'])
    assert.deepEqual(passwordProblems('nodigitshere'), ['Include at least one number.'])
    assert.deepEqual(passwordProblems('1234567890'), ['Include at least one letter.'])
    assert.deepEqual(passwordProblems('longenough1'), [])
  })

  it('states the rule in one sentence', () => {
    assert.equal(PASSWORD_HELP, 'At least 10 characters, with a letter and a number.')
  })
})
