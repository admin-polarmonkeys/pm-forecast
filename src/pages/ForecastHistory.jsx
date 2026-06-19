import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)
}
function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function round2(n) {
  if (n == null || isNaN(n)) return ''
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

const XLS_HEADER_STYLE = {
  fill: { patternType: 'solid', fgColor: { rgb: '1F3864' } },
  font: { color: { rgb: 'FFFFFF' }, bold: true },
  alignment: { horizontal: 'center' },
}

export default function ForecastHistory() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [runs, setRuns] = useState([])
  const [ordersByRun, setOrdersByRun] = useState({})
  const [nameBySku, setNameBySku] = useState({})
  const [selectedRun, setSelectedRun] = useState(null) // modo detalle
  const [compare, setCompare] = useState([]) // ids de runs a comparar (máx 2)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const [runsRes, ordersRes, prodRes] = await Promise.all([
        supabase.from('forecast_runs').select('*').order('created_at', { ascending: false }),
        supabase.from('purchase_orders').select('*'),
        supabase.from('products').select('sku, name'),
      ])
      if (runsRes.error) throw runsRes.error
      if (ordersRes.error) throw ordersRes.error

      const byRun = {}
      for (const o of ordersRes.data || []) {
        if (!byRun[o.run_id]) byRun[o.run_id] = []
        byRun[o.run_id].push(o)
      }
      const names = {}
      for (const p of prodRes.data || []) names[p.sku] = p.name

      setRuns(runsRes.data || [])
      setOrdersByRun(byRun)
      setNameBySku(names)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  async function deleteRun(run) {
    const ok = window.confirm(
      `Delete the forecast from ${run.run_date}? All of its purchase orders will also be deleted. This action cannot be undone.`
    )
    if (!ok) return
    const { error } = await supabase.from('forecast_runs').delete().eq('id', run.id)
    if (error) {
      setError(error.message)
      return
    }
    // Limpia selección de comparación si incluía este run
    setCompare(prev => prev.filter(id => id !== run.id))
    if (selectedRun?.id === run.id) setSelectedRun(null)
    await loadData()
  }

  function toggleCompare(id) {
    setCompare(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      if (prev.length >= 2) return prev // máximo 2
      return [...prev, id]
    })
  }

  // Detalle/exportación de un run -> filas de detalle ordenadas por qty sugerida desc
  function runRows(runId) {
    return (ordersByRun[runId] || [])
      .filter(o => o.qty_suggested > 0)
      .map(o => ({ ...o, name: nameBySku[o.sku] || '—' }))
      .sort((a, b) => b.qty_suggested - a.qty_suggested)
  }

  function exportRun(run) {
    const rows = runRows(run.id)
    const header = ['SKU', 'Name', 'Supplier', 'Avg Monthly Sales', 'Projected Demand', 'Available', 'Transit', 'Months Coverage', 'Qty Suggested', 'Landed Cost', 'Total Landed']
    const data = rows.map(o => [
      o.sku, o.name, o.supplier || '—',
      round2(o.avg_monthly_sales), round2(o.projected_monthly_demand),
      o.qty_available_real ?? '', o.qty_transit ?? '',
      round2(o.months_coverage_current), o.qty_suggested,
      round2(o.landed_cost_usd), round2(o.total_landed_cost),
    ])
    const totalLanded = rows.reduce((s, o) => s + (o.total_landed_cost || 0), 0)
    const subtotal = ['TOTAL', '', '', '', '', '', '', '', '', '', round2(totalLanded)]
    const aoa = [header, ...data, subtotal]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    for (let c = 0; c < header.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: 0, c })
      if (ws[ref]) ws[ref].s = XLS_HEADER_STYLE
    }
    ws['!cols'] = header.map((h, c) => {
      let max = h.length
      for (const row of aoa) if (row[c] != null && String(row[c]).length > max) max = String(row[c]).length
      return { wch: max + 2 }
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Forecast')
    XLSX.writeFile(wb, `PM_Forecast_Run_${run.run_date}.xlsx`)
  }

  if (loading) return <div style={styles.loading}>Loading history...</div>

  // ---------- DETALLE ----------
  if (selectedRun) {
    const rows = runRows(selectedRun.id)
    const totalLanded = rows.reduce((s, o) => s + (o.total_landed_cost || 0), 0)
    return (
      <div>
        <div style={styles.header}>
          <div>
            <h1 style={styles.pageTitle}>📋 Forecast Detail</h1>
            <p style={styles.pageDesc}>
              Run from {selectedRun.run_date} · Inventory as of {selectedRun.snapshot_date} ·
              {' '}{selectedRun.months_history} months of history
              {selectedRun.notes ? ` · ${selectedRun.notes}` : ''}
            </p>
          </div>
          <div style={styles.headerBtns}>
            <button style={styles.exportBtn} onClick={() => exportRun(selectedRun)} disabled={!rows.length}>⬇️ Export to Excel</button>
            <button style={styles.backBtn} onClick={() => setSelectedRun(null)}>← Back</button>
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.summaryBar}>
          <span><strong>{rows.length}</strong> SKUs ordered</span>
          <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{fmtCurrency(totalLanded)} total landed</span>
        </div>

        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.thead}>
                <th style={styles.th}>SKU</th>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Supplier</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Avg Sales</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Projected</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Available</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>In Transit</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Coverage</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Suggested Qty</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Landed Cost</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Total Landed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(o => (
                <tr key={o.sku} style={styles.tr}>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{o.sku}</td>
                  <td style={styles.td}>{o.name}</td>
                  <td style={styles.td}>{o.supplier || '—'}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(o.avg_monthly_sales)}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(o.projected_monthly_demand)}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(o.qty_available_real)}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(o.qty_transit)}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>
                    {o.months_coverage_current != null ? `${fmt(o.months_coverage_current)}m` : '—'}
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{o.qty_suggested}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(o.landed_cost_usd)}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(o.total_landed_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // ---------- LISTA + COMPARACIÓN ----------
  let comparison = null
  if (compare.length === 2) {
    const [idA, idB] = [...compare].sort((a, b) => {
      const ra = runs.find(r => r.id === a), rb = runs.find(r => r.id === b)
      return (ra?.run_date || '').localeCompare(rb?.run_date || '')
    })
    const runA = runs.find(r => r.id === idA)
    const runB = runs.find(r => r.id === idB)
    const qtyA = {}, qtyB = {}
    for (const o of ordersByRun[idA] || []) qtyA[o.sku] = o.qty_suggested
    for (const o of ordersByRun[idB] || []) qtyB[o.sku] = o.qty_suggested
    const skus = [...new Set([...Object.keys(qtyA), ...Object.keys(qtyB)])].sort()
    const rows = skus.map(sku => {
      const a = qtyA[sku] || 0, b = qtyB[sku] || 0
      return { sku, name: nameBySku[sku] || '—', a, b, diff: b - a }
    })
    const totalA = (ordersByRun[idA] || []).reduce((s, o) => s + (o.total_landed_cost || 0), 0)
    const totalB = (ordersByRun[idB] || []).reduce((s, o) => s + (o.total_landed_cost || 0), 0)
    comparison = { runA, runB, rows, totalA, totalB, diffTotal: totalB - totalA }
  }

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>📋 Forecast History</h1>
          <p style={styles.pageDesc}>
            Past forecast runs. Select two to compare.
          </p>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {runs.length === 0 ? (
        <div style={styles.empty}>
          <p>No forecasts saved yet.</p>
          <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
            Run a forecast from "Purchase Forecast" to see it here.
          </p>
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.thead}>
                <th style={{ ...styles.th, textAlign: 'center' }}>Compare</th>
                <th style={styles.th}>Run Date</th>
                <th style={styles.th}>Snapshot</th>
                <th style={{ ...styles.th, textAlign: 'center' }}>Months Hist.</th>
                <th style={{ ...styles.th, textAlign: 'right' }}># SKUs w/ order</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Total Landed</th>
                <th style={styles.th}>Notes</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => {
                const orders = ordersByRun[run.id] || []
                const skuCount = orders.filter(o => o.qty_suggested > 0).length
                const totalLanded = orders.reduce((s, o) => s + (o.total_landed_cost || 0), 0)
                const checked = compare.includes(run.id)
                const disableCheck = !checked && compare.length >= 2
                return (
                  <tr key={run.id} style={styles.tr}>
                    <td style={{ ...styles.td, textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disableCheck}
                        onChange={() => toggleCompare(run.id)}
                      />
                    </td>
                    <td style={{ ...styles.td, fontWeight: 600 }}>{run.run_date}</td>
                    <td style={styles.td}>{run.snapshot_date}</td>
                    <td style={{ ...styles.td, textAlign: 'center' }}>{run.months_history}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{skuCount}</td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(totalLanded)}</td>
                    <td style={{ ...styles.td, color: '#666', fontSize: 12 }}>{run.notes || '—'}</td>
                    <td style={{ ...styles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button style={styles.detailBtn} onClick={() => setSelectedRun(run)}>View Detail</button>
                      <button style={styles.deleteBtn} onClick={() => deleteRun(run)}>🗑</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Vista de comparación */}
      {comparison && (
        <div style={styles.compareSection}>
          <h2 style={styles.compareTitle}>
            Comparison: {comparison.runA?.run_date} (Run 1) vs {comparison.runB?.run_date} (Run 2)
          </h2>

          <div style={styles.compareSummary}>
            <div style={styles.compareCard}>
              <div style={styles.compareCardLabel}>Total Landed Run 1 ({comparison.runA?.run_date})</div>
              <div style={styles.compareCardVal}>{fmtCurrency(comparison.totalA)}</div>
            </div>
            <div style={styles.compareCard}>
              <div style={styles.compareCardLabel}>Total Landed Run 2 ({comparison.runB?.run_date})</div>
              <div style={styles.compareCardVal}>{fmtCurrency(comparison.totalB)}</div>
            </div>
            <div style={styles.compareCard}>
              <div style={styles.compareCardLabel}>Difference</div>
              <div style={{ ...styles.compareCardVal, color: comparison.diffTotal > 0 ? '#c0392b' : comparison.diffTotal < 0 ? '#1a7a4a' : '#1a1a2e' }}>
                {comparison.diffTotal > 0 ? '+' : ''}{fmtCurrency(comparison.diffTotal)}
              </div>
            </div>
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  <th style={styles.th}>SKU</th>
                  <th style={styles.th}>Name</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Qty Run 1</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Qty Run 2</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map(r => (
                  <tr key={r.sku} style={styles.tr}>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
                    <td style={styles.td}>{r.name}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{r.a || '—'}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{r.b || '—'}</td>
                    <td style={{
                      ...styles.td, textAlign: 'right', fontWeight: 700,
                      color: r.diff > 0 ? '#c0392b' : r.diff < 0 ? '#1a7a4a' : '#999',
                    }}>
                      {r.diff > 0 ? '+' : ''}{r.diff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  loading: { padding: 40, color: '#666', textAlign: 'center' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28, flexWrap: 'wrap', gap: 16 },
  pageTitle: { fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  pageDesc: { color: '#666', fontSize: 13 },
  headerBtns: { display: 'flex', gap: 10, alignItems: 'center' },
  exportBtn: { background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  backBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
  summaryBar: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, fontSize: 13, color: '#555' },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)', marginBottom: 24 },
  table: { width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle' },
  detailBtn: { background: '#eef0ff', color: '#4455aa', border: '1px solid #d5dbff', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginRight: 6 },
  deleteBtn: { background: '#fee', color: '#c00', border: '1px solid #fcc', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  compareSection: { marginTop: 8 },
  compareTitle: { fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 14 },
  compareSummary: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 },
  compareCard: { background: '#fff', borderRadius: 10, padding: '14px 18px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  compareCardLabel: { fontSize: 12, color: '#888', marginBottom: 6 },
  compareCardVal: { fontSize: 20, fontWeight: 700, color: '#1a1a2e' },
}
