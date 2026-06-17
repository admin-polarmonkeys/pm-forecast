import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import ForecastView from './pages/ForecastView'
import SalesHistory from './pages/SalesHistory'
import SalesHistoryByKit from './pages/SalesHistoryByKit'
import UploadData from './pages/UploadData'
import ParamsView from './pages/ParamsView'
import PurchaseOrders from './pages/PurchaseOrders'
import ForecastHistory from './pages/ForecastHistory'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('dashboard')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1a1a2e' }}>
        <span style={{ color: '#fff', fontSize: 18 }}>🐒 Cargando...</span>
      </div>
    )
  }

  if (!session) return <Login />

  function renderTab() {
    switch (activeTab) {
      case 'dashboard': return <Dashboard />
      case 'forecast': return <ForecastView />
      case 'sales-sku': return <SalesHistory />
      case 'sales-kit': return <SalesHistoryByKit />
      case 'upload':   return <UploadData />
      case 'params':   return <ParamsView />
      case 'orders':   return <PurchaseOrders />
      case 'history':  return <ForecastHistory />
      default:         return <Dashboard />
    }
  }

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab} user={session.user}>
      {renderTab()}
    </Layout>
  )
}
