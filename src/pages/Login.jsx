import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.logo}>
          <span style={styles.logoText}>🐒 PM Forecast</span>
        </div>
        <h1 style={styles.title}>Iniciar sesión</h1>
        <p style={styles.subtitle}>Purchase Forecast System</p>
        <form onSubmit={handleLogin} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={styles.input}
              placeholder="tu@email.com"
              required
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={styles.input}
              placeholder="••••••••"
              required
            />
          </div>
          {error && <div style={styles.error}>{error}</div>}
          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
  },
  card: {
    background: '#fff',
    borderRadius: 16,
    padding: '40px 48px',
    width: '100%',
    maxWidth: 420,
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  },
  logo: { textAlign: 'center', marginBottom: 24 },
  logoText: { fontSize: 28, fontWeight: 700 },
  title: { fontSize: 24, fontWeight: 700, color: '#1a1a2e', textAlign: 'center', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 32 },
  form: { display: 'flex', flexDirection: 'column', gap: 20 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#444' },
  input: {
    padding: '10px 14px',
    border: '1.5px solid #e0e0e0',
    borderRadius: 8,
    fontSize: 15,
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  error: {
    background: '#fff0f0',
    color: '#c00',
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
    border: '1px solid #fcc',
  },
  button: {
    background: '#1a1a2e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '12px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
  },
}
