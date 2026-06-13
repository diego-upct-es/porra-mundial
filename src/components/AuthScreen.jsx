import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

/* ============================================================
   Pantalla de autenticación — Porra Mundial 2026
   Misma paleta "electric" que la app pero autocontenida (no
   depende del CSS principal, que solo se inyecta tras el login).
   ============================================================ */

export default function AuthScreen() {
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [emailSent, setEmailSent] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      if (mode === 'register') {
        const { data, error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { display_name: displayName.trim() },
            // Redirige siempre al origen actual (localhost en dev, dominio real en prod)
            emailRedirectTo: window.location.origin,
          },
        })
        if (err) throw err
        // Si no hay sesión, Supabase requiere confirmación de email
        if (!data.session) setEmailSent(true)
        // Si hay sesión, onAuthStateChange en App.jsx navega al home
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (err) throw err
      }
    } catch (err) {
      setError(translateAuthError(err.message))
    } finally {
      setLoading(false)
    }
  }

  function switchMode() {
    setMode(m => (m === 'login' ? 'register' : 'login'))
    setError(null)
  }

  if (emailSent) {
    return (
      <div style={rootStyle}>
        <style>{CSS}</style>
        <div className="auth-phone">
          <AuthHero subtitle="Revisa tu email" />
          <div className="auth-body">
            <p className="auth-confirm-msg">
              Hemos enviado un enlace de confirmación a{' '}
              <strong style={{ color: '#FF7A2F' }}>{email}</strong>.
              <br />
              Haz clic en él para activar tu cuenta y entrar.
            </p>
            <button
              className="auth-link"
              onClick={() => { setEmailSent(false); setMode('login') }}
            >
              Ya lo confirmé → Iniciar sesión
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={rootStyle}>
      <style>{CSS}</style>
      <div className="auth-phone">
        <AuthHero subtitle={mode === 'login' ? 'Entrar' : 'Crear cuenta'} />
        <div className="auth-body">
          <form onSubmit={handleSubmit} noValidate>
            {mode === 'register' && (
              <>
                <label className="auth-label">Tu apodo</label>
                <input
                  className="auth-input"
                  type="text"
                  placeholder="Cómo te conocen los demás"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  maxLength={24}
                  required
                  autoFocus
                />
              </>
            )}

            <label className="auth-label">Email</label>
            <input
              className="auth-input"
              type="email"
              placeholder="tu@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus={mode === 'login'}
            />

            <label className="auth-label">Contraseña</label>
            <input
              className="auth-input"
              type="password"
              placeholder={mode === 'register' ? 'Mínimo 6 caracteres' : '••••••••'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={6}
            />

            {error && <div className="auth-error">{error}</div>}

            <button className="auth-btn" type="submit" disabled={loading}>
              {loading
                ? 'Cargando…'
                : mode === 'login'
                ? 'Entrar'
                : 'Crear cuenta y entrar'}
            </button>
          </form>

          <button className="auth-link" onClick={switchMode}>
            {mode === 'login'
              ? '¿Primera vez? Crea una cuenta →'
              : '¿Ya tienes cuenta? Inicia sesión →'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AuthHero({ subtitle }) {
  return (
    <header className="auth-hero">
      <div className="auth-mark">26</div>
      <div>
        <div className="auth-eyebrow">Porra Mundial</div>
        <h1 className="auth-h1">{subtitle}</h1>
      </div>
    </header>
  )
}

// Traduce los mensajes de error de Supabase Auth a español
function translateAuthError(msg) {
  if (!msg) return 'Error desconocido.'
  if (msg.includes('Invalid login credentials')) return 'Email o contraseña incorrectos.'
  if (msg.includes('Email not confirmed')) return 'Confirma tu email antes de entrar.'
  if (msg.includes('User already registered')) return 'Ya existe una cuenta con ese email.'
  if (msg.includes('Password should be at least')) return 'La contraseña debe tener al menos 6 caracteres.'
  if (msg.includes('Unable to validate email')) return 'El formato del email no es válido.'
  if (msg.includes('Email rate limit')) return 'Demasiados intentos. Espera unos minutos.'
  if (msg.includes('signup is disabled')) return 'El registro está desactivado. Contacta al administrador.'
  return msg
}

const rootStyle = {
  fontFamily: "'Inter', system-ui, sans-serif",
  background: '#0c0b22',
  minHeight: '100vh',
  display: 'flex',
  justifyContent: 'center',
  color: '#fff',
  WebkitFontSmoothing: 'antialiased',
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap');

*{box-sizing:border-box;}

.auth-phone{width:100%;max-width:430px;min-height:100vh;background:#15246F;display:flex;flex-direction:column;}

/* Hero */
.auth-hero{padding:56px 22px 28px;display:flex;align-items:center;gap:16px;background:#2D4ED8;}
.auth-mark{font-family:'Fredoka',sans-serif;font-size:58px;font-weight:700;line-height:.8;
  color:#FF7A2F;-webkit-text-stroke:3px #15246F;letter-spacing:-2px;flex:none;}
.auth-eyebrow{font-size:12px;letter-spacing:3px;text-transform:uppercase;opacity:.85;font-weight:600;}
.auth-h1{margin:4px 0 0;font-family:'Fredoka',sans-serif;font-size:34px;font-weight:700;letter-spacing:-.5px;}

/* Body */
.auth-body{padding:28px 20px 32px;flex:1;display:flex;flex-direction:column;gap:4px;}

/* Form fields */
.auth-label{display:block;font-size:12px;font-weight:600;opacity:.7;margin:14px 0 7px;
  text-transform:uppercase;letter-spacing:1px;}
.auth-input{width:100%;background:rgba(0,0,0,.3);border:2px solid rgba(255,255,255,.1);color:#fff;
  border-radius:14px;padding:14px;font-size:16px;font-family:'Inter',sans-serif;}
.auth-input:focus{outline:none;border-color:#FF7A2F;}
.auth-input::placeholder{opacity:.45;}

/* Error */
.auth-error{margin-top:10px;background:rgba(238,74,107,.15);border:1px solid rgba(255,225,77,.5);
  color:#ffd2dc;font-size:13px;padding:10px 13px;border-radius:12px;line-height:1.4;}

/* Primary button */
.auth-btn{display:block;width:100%;margin-top:18px;background:#FF7A2F;color:#161122;border:none;
  border-radius:18px;padding:16px;font-size:16px;font-family:'Fredoka',sans-serif;font-weight:600;
  cursor:pointer;letter-spacing:.3px;}
.auth-btn:disabled{opacity:.45;cursor:not-allowed;}
.auth-btn:not(:disabled):active{transform:translateY(1px);}

/* Switch mode link */
.auth-link{margin-top:20px;background:none;border:none;color:rgba(255,255,255,.55);font-size:14px;
  cursor:pointer;font-family:'Inter',sans-serif;padding:8px 0;text-align:center;width:100%;
  display:block;}
.auth-link:hover{color:#fff;}

/* Email confirmation */
.auth-confirm-msg{font-size:16px;line-height:1.7;opacity:.85;margin:0 0 24px;}

button:focus-visible,input:focus-visible{outline:2px solid #fff;outline-offset:2px;}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;}}
`
