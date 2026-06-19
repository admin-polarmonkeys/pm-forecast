import { useState } from 'react'
import { supabase } from '../lib/supabase'

const NAV = [
  { id: 'dashboard', label: '🏠 Dashboard' },
  { id: 'forecast', label: '📦 Purchase Forecast' },
  { id: 'order-plan', label: '📅 Order Plan' },
  { id: 'inventory-value', label: '💰 Inventory Value' },
  { id: 'sales-sku', label: '📈 Sales History by SKU' },
  { id: 'sales-kit', label: '📦 Sales History by Kit' },
  { id: 'upload', label: '⬆️ Upload Data' },
  { id: 'params', label: '⚙️ Parameters' },
  { id: 'orders', label: '🛒 Purchase Orders' },
  { id: 'history', label: '📋 Forecast History' },
]

export default function Layout({ children, activeTab, onTabChange, user }) {
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    setLoggingOut(true)
    await supabase.auth.signOut()
  }

  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          <span style={styles.brandIcon}>🐒</span>
          <div>
            <div style={styles.brandName}>PM Forecast</div>
            <div style={styles.brandSub}>Polar Monkeys</div>
          </div>
        </div>
        <nav style={styles.nav}>
          {NAV.map(item => (
            <button
              key={item.id}
              style={{ ...styles.navItem, ...(activeTab === item.id ? styles.navActive : {}) }}
              onClick={() => onTabChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div style={styles.userBox}>
          <div style={styles.userEmail}>{user?.email}</div>
          <button style={styles.logoutBtn} onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out...' : 'Sign Out'}
          </button>
        </div>
      </aside>
      <main style={styles.main}>
        {children}
      </main>
    </div>
  )
}

const styles = {
  shell: { display: 'flex', minHeight: '100vh', background: '#f5f6fa' },
  sidebar: {
    width: 240,
    background: '#1a1a2e',
    display: 'flex',
    flexDirection: 'column',
    padding: '24px 0',
    flexShrink: 0,
    position: 'fixed',
    top: 0, left: 0, bottom: 0,
    zIndex: 100,
  },
  brand: { display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px 28px' },
  brandIcon: { fontSize: 32 },
  brandName: { color: '#fff', fontWeight: 700, fontSize: 16 },
  brandSub: { color: '#8899aa', fontSize: 11 },
  nav: { display: 'flex', flexDirection: 'column', gap: 2, padding: '0 12px', flex: 1 },
  navItem: {
    background: 'transparent',
    border: 'none',
    color: '#aab4c4',
    padding: '10px 12px',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 13,
    fontWeight: 500,
    transition: 'all 0.15s',
  },
  navActive: {
    background: 'rgba(255,255,255,0.1)',
    color: '#fff',
  },
  userBox: {
    padding: '16px 20px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    marginTop: 'auto',
  },
  userEmail: { color: '#8899aa', fontSize: 11, marginBottom: 8, wordBreak: 'break-all' },
  logoutBtn: {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.2)',
    color: '#aab4c4',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    width: '100%',
  },
  main: { marginLeft: 240, flex: 1, padding: 32, minHeight: '100vh' },
}
