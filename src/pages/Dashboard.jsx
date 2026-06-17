import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { calcAvgMonthlySales } from '../lib/forecast'

function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)
}
function fmtDate(d) {
  if (!d) return '—'
  return String(d).slice(0, 10)
}

// Color por meses de cobertura
function coverageColor(m) {
  if (m == null) return '#f0f0f0'
  if (m < 1) return '#ffd5d5'   // rojo
  if (m < 2) return '#ffecd5'   // naranja
  if (m < 3) return '#fff9d5'   // amarillo
  return '#d5f5e3'              // verde
}

export default function Dashboard() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [threshold, setThreshold] = useState(3)
  const [rows, setRows] = useState([])        // todos los SKUs con su cobertura
  const [summary, setSummary] = useState(null)
  const [activity, setActivity] = useState(null)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const [products, inv, sales, transit, params, runs] = await Promise.all([
        supabase.from('products').select('sku, name, type'),
        supabase.from('inventory_snapshots').select('*').order('snapshot_date', { ascending: false }),
        supabase.from('sales_history').select('sku, year, month, qty_fulfilled, created_at'),
        supabase.from('transit_orders').select('sku, qty'),
        supabase.from('purchase_params').select('sku, supplier'),
        supabase.from('forecast_runs').select('id, run_date, created_at').order('created_at', { ascending: false }).limit(1),
      ])
      if (inv.error) throw inv.error
      if (sales.error) throw sales.error

      const salesData = sales.data || []
      const nameBySku = {}
      for (const p of products.data || []) nameBySku[p.sku] = p.name
      // Solo componentes: los kits nunca deben aparecer en alertas de stockout
      const componentSkus = new Set((products.data || []).filter(p => p.type === 'component').map(p => p.sku))
      const supplierBySku = {}
      for (const p of params.data || []) supplierBySku[p.sku] = p.supplier

      // Último snapshot de inventario
      const latestDate = inv.data?.[0]?.snapshot_date || null
      const latestInv = latestDate ? inv.data.filter(r => r.snapshot_date === latestDate) : []
      const availBySku = {}
      for (const r of latestInv) availBySku[r.sku] = r.qty_available_real ?? 0

      // Tránsito sumado por SKU
      const transitBySku = {}
      for (const t of transit.data || []) transitBySku[t.sku] = (transitBySku[t.sku] || 0) + (t.qty || 0)

      // Universo de SKUs: componentes que tienen inventario, ventas o tránsito (kits excluidos)
      const universe = new Set([
        ...latestInv.map(r => r.sku),
        ...salesData.map(r => r.sku),
        ...Object.keys(transitBySku),
      ].filter(sku => componentSkus.has(sku)))

      const computed = [...universe].map(sku => {
        const avg = calcAvgMonthlySales(salesData, sku, 6) // solo ventas directas, últimos 6 meses
        const available = availBySku[sku] || 0
        const qtyTransit = transitBySku[sku] || 0
        const monthsCoverage = avg > 0 ? (available + qtyTransit) / avg : null
        const daysInventory = monthsCoverage != null ? monthsCoverage * 30 : null
        return {
          sku,
          name: nameBySku[sku] || '—',
          supplier: supplierBySku[sku] || '—',
          available,
          qtyTransit,
          avg,
          monthsCoverage,
          daysInventory,
        }
      })

      // Resumen
      const zeroStock = computed.filter(r => r.available === 0).length
      const skusInTransit = Object.keys(transitBySku).filter(s => transitBySku[s] > 0).length

      // Actividad reciente
      const lastRun = runs.data?.[0] || null
      let lastRunSkuCount = 0
      if (lastRun) {
        const po = await supabase.from('purchase_orders').select('qty_suggested').eq('run_id', lastRun.id)
        lastRunSkuCount = (po.data || []).filter(o => o.qty_suggested > 0).length
      }
      let lastSalesUpload = null
      for (const r of salesData) {
        if (r.created_at && (!lastSalesUpload || r.created_at > lastSalesUpload)) lastSalesUpload = r.created_at
      }

      setRows(computed)
      setSummary({
        totalTracked: computed.length,
        zeroStock,
        skusInTransit,
        lastSnapshot: latestDate,
      })
      setActivity({
        lastRunDate: lastRun?.run_date || null,
        lastRunSkuCount,
        lastSalesUpload,
        lastInventoryUpload: latestDate,
      })
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  // SKUs por debajo del umbral, ordenados por cobertura ascendente
  const alerts = useMemo(() => {
    return rows
      .filter(r => r.monthsCoverage != null && r.monthsCoverage < threshold)
      .sort((a, b) => a.monthsCoverage - b.monthsCoverage)
  }, [rows, threshold])

  if (loading) return <div style={styles.loading}>Cargando dashboard...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>🏠 Dashboard</h1>
          <p style={styles.pageDesc}>Cobertura en tiempo real — no requiere correr el forecast</p>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* 1. STOCKOUT ALERTS */}
      <div style={styles.section}>
        <div style={styles.alertHeader}>
          <div style={styles.alertTitleRow}>
            <h2 style={styles.sectionTitle}>⚠️ Alertas de Stockout</h2>
            <span style={styles.criticalBadge}>{alerts.length} SKUs críticos</span>
          </div>
          <div style={styles.thresholdControl}>
            <label style={styles.thresholdLabel}>Mostrar SKUs con menos de</label>
            <select value={threshold} onChange={e => setThreshold(+e.target.value)} style={styles.select}>
              {[1, 2, 3, 4, 5, 6].map(m => <option key={m} value={m}>{m} {m === 1 ? 'mes' : 'meses'}</option>)}
            </select>
          </div>
        </div>

        {alerts.length === 0 ? (
          <div style={styles.allGood}>✅ Todo en orden — ningún SKU por debajo de {threshold} {threshold === 1 ? 'mes' : 'meses'} de cobertura.</div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  <th style={styles.th}>SKU</th>
                  <th style={styles.th}>Nombre</th>
                  <th style={styles.th}>Proveedor</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Disponible</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Tránsito</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Avg Sales/Mes</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Cobertura</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Días de Inv.</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map(r => (
                  <tr key={r.sku} style={styles.tr}>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
                    <td style={styles.td}>{r.name}</td>
                    <td style={styles.td}>{r.supplier}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.available)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.qtyTransit)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.avg)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <span style={{ ...styles.coverageBadge, background: coverageColor(r.monthsCoverage) }}>
                        {fmt(r.monthsCoverage)}m
                      </span>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{r.daysInventory != null ? Math.round(r.daysInventory) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 2. INVENTORY SUMMARY CARDS */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>📦 Resumen de Inventario</h2>
        <div style={styles.summaryGrid}>
          <div style={styles.summaryCard}>
            <div style={styles.summaryVal}>{summary?.totalTracked ?? 0}</div>
            <div style={styles.summaryLabel}>SKUs monitoreados</div>
          </div>
          <div style={styles.summaryCard}>
            <div style={{ ...styles.summaryVal, color: summary?.zeroStock ? '#c0392b' : '#1a1a2e' }}>{summary?.zeroStock ?? 0}</div>
            <div style={styles.summaryLabel}>SKUs sin stock</div>
          </div>
          <div style={styles.summaryCard}>
            <div style={styles.summaryVal}>{summary?.skusInTransit ?? 0}</div>
            <div style={styles.summaryLabel}>SKUs en tránsito</div>
          </div>
          <div style={styles.summaryCard}>
            <div style={{ ...styles.summaryVal, fontSize: 18 }}>{fmtDate(summary?.lastSnapshot)}</div>
            <div style={styles.summaryLabel}>Último snapshot</div>
          </div>
        </div>
      </div>

      {/* 3. RECENT ACTIVITY */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>🕑 Actividad Reciente</h2>
        <div style={styles.activityGrid}>
          <div style={styles.activityCard}>
            <div style={styles.activityLabel}>Último forecast</div>
            <div style={styles.activityVal}>{fmtDate(activity?.lastRunDate)}</div>
            <div style={styles.activitySub}>
              {activity?.lastRunDate ? `${activity.lastRunSkuCount} SKUs ordenados` : 'Sin corridas aún'}
            </div>
          </div>
          <div style={styles.activityCard}>
            <div style={styles.activityLabel}>Última carga de ventas</div>
            <div style={styles.activityVal}>{fmtDate(activity?.lastSalesUpload)}</div>
            <div style={styles.activitySub}>desde Report Pundit</div>
          </div>
          <div style={styles.activityCard}>
            <div style={styles.activityLabel}>Última carga de inventario</div>
            <div style={styles.activityVal}>{fmtDate(activity?.lastInventoryUpload)}</div>
            <div style={styles.activitySub}>snapshot de NetSuite</div>
          </div>
        </div>
      </div>
    </div>
  )
}

const styles = {
  loading: { padding: 40, color: '#666', textAlign: 'center' },
  header: { marginBottom: 24 },
  pageTitle: { fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  pageDesc: { color: '#666', fontSize: 13 },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  section: { marginBottom: 32 },
  sectionTitle: { fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 14 },
  alertHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 12 },
  alertTitleRow: { display: 'flex', alignItems: 'center', gap: 12 },
  criticalBadge: { background: '#c0392b', color: '#fff', borderRadius: 20, padding: '4px 14px', fontSize: 13, fontWeight: 700 },
  thresholdControl: { display: 'flex', alignItems: 'center', gap: 8 },
  thresholdLabel: { fontSize: 13, color: '#666' },
  select: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff' },
  allGood: { background: '#e8f8ef', color: '#1a7a4a', border: '1px solid #b6e6cb', borderRadius: 10, padding: '20px 24px', fontSize: 15, fontWeight: 600 },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  table: { width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle' },
  coverageBadge: { borderRadius: 4, padding: '2px 7px', fontSize: 12, fontWeight: 600 },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 },
  summaryCard: { background: '#fff', borderRadius: 10, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  summaryVal: { fontSize: 28, fontWeight: 700, color: '#1a1a2e' },
  summaryLabel: { fontSize: 12, color: '#888', marginTop: 4 },
  activityGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 },
  activityCard: { background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  activityLabel: { fontSize: 12, color: '#888', marginBottom: 6 },
  activityVal: { fontSize: 20, fontWeight: 700, color: '#1a1a2e' },
  activitySub: { fontSize: 12, color: '#999', marginTop: 4 },
}
