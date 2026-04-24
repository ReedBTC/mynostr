/**
 * LoginModalContext — app-wide handle for opening the login modal.
 *
 * Consumers call `useLoginModal().openLogin()` from anywhere in the tree
 * (sidebar, mobile drawer, homepage CTA, any future place that gates on
 * auth) to pop the modal over the current page without navigating away.
 *
 * The provider owns the open/close state and renders the modal itself,
 * so no consumer has to think about mounting. `onLogin` is wired once at
 * the App root where sessionUser lives — the modal flows through it on
 * success and then auto-closes.
 */
import { createContext, useCallback, useContext, useState } from 'react'
import LoginModal from './LoginModal.jsx'

const LoginModalContext = createContext({
  openLogin: () => {},
  closeLogin: () => {},
})

export function useLoginModal() {
  return useContext(LoginModalContext)
}

export function LoginModalProvider({ onLogin, children }) {
  const [open, setOpen] = useState(false)

  const openLogin  = useCallback(() => setOpen(true),  [])
  const closeLogin = useCallback(() => setOpen(false), [])

  // Wrap onLogin so the provider can close itself after success without
  // pushing that concern into LoginModal. Keeps LoginModal a dumb view.
  const handleLogin = useCallback((user) => {
    onLogin(user)
    setOpen(false)
  }, [onLogin])

  return (
    <LoginModalContext.Provider value={{ openLogin, closeLogin }}>
      {children}
      {open && (
        <LoginModal onLogin={handleLogin} onClose={closeLogin} />
      )}
    </LoginModalContext.Provider>
  )
}
