import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'

const LINKS: Array<{ to: string; label: string }> = [
  { to: '/', label: "What's changed" },
  { to: '/create', label: 'Create' },
  { to: '/platforms', label: 'Platform support' },
  { to: '/updates', label: 'Your updates' },
  { to: '/library', label: 'Your library' },
  { to: '/tools', label: 'Tools' },
  { to: '/coming-soon', label: 'Coming soon' },
  { to: '/you', label: "What we've learned" },
]

export function Shell(props: {
  creator: string
  role?: string
  unread: number
  onSignOut: () => void
  children: ReactNode
}): ReactNode {
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="mark">◆</span>
          <span>Creator Mall</span>
          <span className="sub">always up to date</span>
        </Link>
        <nav className="nav">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              {link.label}
              {link.to === '/updates' && props.unread > 0 ? ` (${props.unread})` : ''}
            </NavLink>
          ))}
        </nav>
        <div className="account">
          {props.role === 'ADMIN' && (
            <a className="pill" href="/evolution-center">
              Operator view
            </a>
          )}
          <span className="account-name">{props.creator}</span>
          <button className="link-button" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="main" id="main" tabIndex={-1}>{props.children}</main>
      <footer className="footer">
        Platform facts come from official sources and are re-checked automatically ·{' '}
        <Link to="/platforms">Platform support</Link>
      </footer>
    </div>
  )
}
