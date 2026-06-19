import { useState, useEffect, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { calcAvgMonthlySales } from '../lib/forecast'

const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

function fmt(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}
function fmtCurrency(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0')
  return `${dd} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}`
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// Color de la fecha de orden: rojo ≤30 días, naranja 31–60, verde >60
function dateColor(days) {
  if (days <= 30) return '#c00'
  if (days <= 60) return '#e08600'
  return '#1f9d57'
}

// Suma una cantidad de meses a una fecha base (clon, no muta el original)
function addMonths(base, months) {
  const d = new Date(base.getTime())
  d.setMonth(d.getMonth() + months)
  return d
}

const DEFAULT_PARAMS = { coverageTarget: 3, orderFrequency: 2, planningHorizon: 12, growthFactor: 1.4 }

export default function OrderPlan() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // form = lo que se edita; applied = lo que se usó en el último "Recalcular"
  const [form, setForm] = useState(DEFAULT_PARAMS)
  const [applied, setApplied] = useState(DEFAULT_PARAMS)

  // Filtros tipo autofiltro de Excel
  const [fSku, setFSku] = useState('')
  const [fName, setFName] = useState('')
  const [fSupplier, setFSupplier] = useState('Todos')
  const [fQty, setFQty] = useState({ min: '', max: '' })
  const [fFob, setFFob] = useState({ min: '', max: '' })
  const [fLanded, setFLanded] = useState({ min: '', max: '' })

  const [sortKey, setSortKey] = useState('totalLanded')
  const [sortDir, setSortDir] = useState('desc')

  const [groupBySupplier, setGroupBySupplier] = useState(false)
  const [collapsed, setCollapsed] = useState(() => new Set())

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [products, sales, inventory, params, transit] = await Promise.all([
        supabase.from('products').select('*'),
        supabase.from('sales_history').select('*'),
        supabase.from('inventory_snapshots').select('*').order('snapshot_date', { ascending: false }),
        supabase.from('purchase_params').select('*'),
        supabase.from('transit_orders').select('sku, qty'),
      ])
      for (const res of [products, sales, inventory, params, transit]) {
        if (res.error) throw res.error
      }

      const latestDate = inventory.data?.[0]?.snapshot_date || null
      const latestInv = latestDate ? inventory.data.filter(r => r.snapshot_date === latestDate) : []

      setData({
        products: products.data || [],
        salesHistory: sales.data || [],
        inventory: latestInv,
        purchaseParams: params.data || [],
        transitOrders: transit.data || [],
        snapshotDate: latestDate,
      })
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  // Número de slots de orden: planning_horizon / order_frequency (redondeado hacia arriba)
  const numOrders = useMemo(() => {
    const freq = applied.orderFrequency > 0 ? applied.orderFrequency : 1
    return Math.max(1, Math.ceil(applied.planningHorizon / freq))
  }, [applied])

  // Fechas de cada slot (hoy + i*frequency meses). Iguales para todos los SKUs.
  const slotDates = useMemo(() => {
    const now = new Date()
    return Array.from({ length: numOrders }, (_, i) => addMonths(now, i * applied.orderFrequency))
  }, [numOrders, applied.orderFrequency])

  // Plan de compras por SKU
  const plan = useMemo(() => {
    if (!data) return []
    const { coverageTarget, orderFrequency, growthFactor } = applied

    const invBySku = {}
    for (const i of data.inventory) invBySku[i.sku] = i
    const paramsBySku = {}
    for (const p of data.purchaseParams) paramsBySku[p.sku] = p
    const transitBySku = {}
    for (const t of data.transitOrders) transitBySku[t.sku] = (transitBySku[t.sku] || 0) + (t.qty || 0)

    const now = new Date()
    const rows = []

    for (const prod of data.products) {
      if (prod.type !== 'component') continue
      const params = paramsBySku[prod.sku] || {}

      const avgDemand = calcAvgMonthlySales(data.salesHistory, prod.sku, 6)
      const projected = avgDemand * growthFactor
      if (!projected || projected <= 0) continue // Skip SKUs sin demanda proyectada

      const moq = params.moq && params.moq > 0 ? params.moq : 1
      const fob = params.fob_cost_usd ?? null
      const landed = params.landed_cost_usd ?? null
      const currentStock = (invBySku[prod.sku]?.qty_available_real || 0) + (transitBySku[prod.sku] || 0)

      // Simulación de inventario corrido: incluye órdenes previas ya colocadas
      let orderedSoFar = 0
      const orders = []
      for (let i = 0; i < numOrders; i++) {
        const invBefore = currentStock + orderedSoFar - projected * i * orderFrequency
        let qty = 0
        if (invBefore < projected * coverageTarget) {
          const need = projected * (coverageTarget + orderFrequency) - invBefore
          qty = Math.max(moq, Math.ceil(need / moq) * moq)
          orderedSoFar += qty
        }
        const date = slotDates[i]
        const days = Math.round((date - now) / 86400000)
        orders.push({ qty, date, days, hasOrder: qty > 0 })
      }

      const totalQty = orders.reduce((s, o) => s + o.qty, 0)
      rows.push({
        sku: prod.sku,
        name: prod.name,
        supplier: params.supplier || '—',
        fob, landed,
        orders,
        totalQty,
        totalFob: totalQty * (fob || 0),
        totalLanded: totalQty * (landed || 0),
      })
    }
    return rows
  }, [data, applied, numOrders, slotDates])

  const suppliers = useMemo(() => {
    const set = new Set(plan.map(r => r.supplier).filter(Boolean))
    return ['Todos', ...[...set].sort()]
  }, [plan])

  // Aplica filtros de autofiltro
  const filtered = useMemo(() => {
    const inRange = (v, { min, max }) => {
      if (min !== '' && v < Number(min)) return false
      if (max !== '' && v > Number(max)) return false
      return true
    }
    return plan.filter(r => {
      if (fSku && !r.sku.toLowerCase().includes(fSku.toLowerCase())) return false
      if (fName && !(r.name || '').toLowerCase().includes(fName.toLowerCase())) return false
      if (fSupplier !== 'Todos' && r.supplier !== fSupplier) return false
      if (!inRange(r.totalQty, fQty)) return false
      if (!inRange(r.totalFob, fFob)) return false
      if (!inRange(r.totalLanded, fLanded)) return false
      return true
    })
  }, [plan, fSku, fName, fSupplier, fQty, fFob, fLanded])

  function getSortVal(row, key) {
    if (key.startsWith('order_')) {
      const [, idx, kind] = key.split('_')
      const o = row.orders[Number(idx)]
      if (!o) return null
      if (kind === 'date') return o.qty > 0 ? o.date.getTime() : null
      return o.qty // qty
    }
    return row[key]
  }

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = getSortVal(a, sortKey)
      const bv = getSortVal(b, sortKey)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv))
        : av - bv
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [filtered, sortKey, sortDir])

  // Resumen (sobre lo filtrado)
  const summary = useMemo(() => {
    let fob = 0, landed = 0, events = 0, skusWithOrder = 0
    for (const r of filtered) {
      fob += r.totalFob
      landed += r.totalLanded
      const ev = r.orders.filter(o => o.qty > 0).length
      events += ev
      if (ev > 0) skusWithOrder++
    }
    return { fob, landed, events, skusWithOrder }
  }, [filtered])

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(['sku', 'name', 'supplier'].includes(key) ? 'asc' : 'desc')
    }
  }

  function toggleSupplier(name) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // Columnas para render y orden
  const columns = useMemo(() => {
    const cols = [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Nombre' },
      { key: 'supplier', label: 'Proveedor' },
    ]
    for (let i = 0; i < numOrders; i++) {
      cols.push({ key: `order_${i}_date`, label: `Orden ${i + 1} Fecha`, num: true })
      cols.push({ key: `order_${i}_qty`, label: `Orden ${i + 1} Cant`, num: true })
    }
    cols.push({ key: 'totalQty', label: 'Total Qty', num: true })
    cols.push({ key: 'totalFob', label: 'Total FOB', num: true })
    cols.push({ key: 'totalLanded', label: 'Total Landed', num: true })
    return cols
  }, [numOrders])

  function exportToExcel() {
    const wb = XLSX.utils.book_new()
    const headerStyle = {
      fill: { fgColor: { rgb: '1F3864' } },
      font: { color: { rgb: 'FFFFFF' }, bold: true },
      alignment: { horizontal: 'center', vertical: 'center' },
    }
    const summaryStyle = {
      font: { bold: true },
      fill: { fgColor: { rgb: 'E7ECF5' } },
      border: { top: { style: 'thin', color: { rgb: '1F3864' } } },
    }

    // Construye una hoja con estilos a partir de cols + filas (objetos) + fila TOTAL
    function buildSheet(cols, rows, totalRow) {
      const aoa = [cols.map(c => c.header), ...rows.map(r => cols.map(c => {
        const v = c.get(r)
        return v == null ? '' : v
      }))]
      if (totalRow) aoa.push(totalRow)
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      const lastRow = aoa.length - 1
      for (let c = 0; c < cols.length; c++) {
        const h = ws[XLSX.utils.encode_cell({ r: 0, c })]
        if (h) h.s = headerStyle
        for (let i = 0; i < rows.length; i++) {
          const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c })]
          if (cell && cols[c].z && typeof cell.v === 'number') {
            cell.z = cols[c].z
            cell.s = { alignment: { horizontal: 'right' } }
          }
        }
        if (totalRow) {
          const sc = ws[XLSX.utils.encode_cell({ r: lastRow, c })]
          if (sc) {
            sc.s = { ...summaryStyle }
            if (cols[c].z && typeof sc.v === 'number') {
              sc.z = cols[c].z
              sc.s = { ...summaryStyle, alignment: { horizontal: 'right' } }
            }
          }
        }
      }
      ws['!cols'] = cols.map((col, c) => {
        let maxLen = col.header.length
        for (let r = 1; r < aoa.length; r++) {
          const v = aoa[r][c]
          const len = v == null ? 0 : String(v).length
          if (len > maxLen) maxLen = len
        }
        return { wch: Math.min(Math.max(maxLen + 2, col.w || 10), 40) }
      })
      return ws
    }

    // Hoja RESUMEN: una fila por fecha de orden
    const resumenCols = [
      { header: 'Fecha', get: r => r.fecha, w: 14 },
      { header: '# SKUs', get: r => r.skus, w: 10, z: '#,##0' },
      { header: 'Total FOB', get: r => r.fob, w: 16, z: '"$"#,##0.00' },
      { header: 'Total Landed', get: r => r.landed, w: 16, z: '"$"#,##0.00' },
    ]
    const resumenRows = slotDates.map((d, i) => {
      const ordered = sorted.filter(r => r.orders[i].qty > 0)
      return {
        fecha: isoDate(d),
        skus: ordered.length,
        fob: ordered.reduce((s, r) => s + r.orders[i].qty * (r.fob || 0), 0),
        landed: ordered.reduce((s, r) => s + r.orders[i].qty * (r.landed || 0), 0),
      }
    })
    const resumenTotal = ['TOTAL', resumenRows.reduce((s, r) => s + r.skus, 0),
      resumenRows.reduce((s, r) => s + r.fob, 0), resumenRows.reduce((s, r) => s + r.landed, 0)]
    XLSX.utils.book_append_sheet(wb, buildSheet(resumenCols, resumenRows, resumenTotal), 'RESUMEN')

    // Una hoja por fecha con los SKUs ordenados ese día
    const dateCols = [
      { header: 'SKU', get: r => r.sku, w: 14 },
      { header: 'Nombre', get: r => r.name, w: 30 },
      { header: 'Proveedor', get: r => r.supplier, w: 12 },
      { header: 'Qty', get: r => r.qty, w: 10, z: '#,##0' },
      { header: 'FOB', get: r => r.fob, w: 14, z: '"$"#,##0.00' },
      { header: 'Landed', get: r => r.landed, w: 14, z: '"$"#,##0.00' },
    ]
    slotDates.forEach((d, i) => {
      const ordered = sorted.filter(r => r.orders[i].qty > 0).map(r => ({
        sku: r.sku, name: r.name, supplier: r.supplier,
        qty: r.orders[i].qty,
        fob: r.orders[i].qty * (r.fob || 0),
        landed: r.orders[i].qty * (r.landed || 0),
      }))
      if (!ordered.length) return
      const totalRow = ['TOTAL', '', '', ordered.reduce((s, r) => s + r.qty, 0),
        ordered.reduce((s, r) => s + r.fob, 0), ordered.reduce((s, r) => s + r.landed, 0)]
      XLSX.utils.book_append_sheet(wb, buildSheet(dateCols, ordered, totalRow), isoDate(d))
    })

    const today = isoDate(new Date())
    XLSX.writeFile(wb, `PM_Order_Plan_${today}.xlsx`)
  }

  if (loading) return <div style={styles.loading}>Cargando...</div>

  // Render de una fila de SKU (reutilizable con/sin agrupamiento)
  const renderRow = r => (
    <tr key={r.sku} style={styles.tr}>
      <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
      <td style={styles.td}>{r.name}</td>
      <td style={styles.td}><span style={styles.supplierBadge}>{r.supplier}</span></td>
      {r.orders.map((o, i) => [
        <td key={`d${i}`} style={{ ...styles.td, textAlign: 'center', color: o.hasOrder ? dateColor(o.days) : '#bbb', fontWeight: o.hasOrder && o.days <= 30 ? 700 : 400 }}>
          {o.hasOrder ? formatDate(o.date) : '—'}
        </td>,
        <td key={`q${i}`} style={{ ...styles.td, textAlign: 'right', fontWeight: o.hasOrder ? 700 : 400 }}>
          {o.hasOrder ? fmt(o.qty) : '—'}
        </td>,
      ])}
      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmt(r.totalQty)}</td>
      <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(r.totalFob)}</td>
      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmtCurrency(r.totalLanded)}</td>
    </tr>
  )

  // Agrupa filas por proveedor para el modo agrupado
  const groups = []
  if (groupBySupplier) {
    const bySupplier = {}
    for (const r of sorted) {
      (bySupplier[r.supplier] = bySupplier[r.supplier] || []).push(r)
    }
    for (const [name, rows] of Object.entries(bySupplier)) {
      groups.push({
        name,
        rows,
        fob: rows.reduce((s, r) => s + r.totalFob, 0),
        landed: rows.reduce((s, r) => s + r.totalLanded, 0),
      })
    }
  }

  const totalColCount = columns.length

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>📅 Order Plan</h1>
          <p style={styles.pageDesc}>
            {data?.snapshotDate ? `Inventario al ${data.snapshotDate}` : 'Sin datos de inventario'}
            {' · '}Plan a {applied.planningHorizon} meses, orden cada {applied.orderFrequency}
          </p>
        </div>
        <div style={styles.headerControls}>
          <button
            style={{ ...styles.toggleBtn, ...(groupBySupplier ? styles.toggleBtnActive : {}) }}
            onClick={() => setGroupBySupplier(g => !g)}
          >
            {groupBySupplier ? '✓ ' : ''}Agrupar por Proveedor
          </button>
          {plan.length > 0 && (
            <button style={styles.exportBtn} onClick={exportToExcel}>⬇ Exportar a Excel</button>
          )}
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Barra de parámetros */}
      <div style={styles.paramsBar}>
        {[
          { key: 'coverageTarget', label: 'Coverage Target (meses)', step: 1 },
          { key: 'orderFrequency', label: 'Order Frequency (meses)', step: 1 },
          { key: 'planningHorizon', label: 'Planning Horizon (meses)', step: 1 },
          { key: 'growthFactor', label: 'Growth Factor', step: 0.05 },
        ].map(f => (
          <label key={f.key} style={styles.paramField}>
            <span style={styles.paramLabel}>{f.label}</span>
            <input
              type="number"
              step={f.step}
              min="0"
              value={form[f.key]}
              onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value === '' ? '' : Number(e.target.value) }))}
              style={styles.paramInput}
            />
          </label>
        ))}
        <button style={styles.recalcBtn} onClick={() => setApplied(form)}>Recalcular</button>
      </div>

      {plan.length > 0 && (
        <>
          <div style={styles.summaryGrid}>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(summary.fob)}</div>
              <div style={styles.summaryLabel}>Inversión total FOB</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(summary.landed)}</div>
              <div style={styles.summaryLabel}>Inversión total Landed</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmt(summary.events)}</div>
              <div style={styles.summaryLabel}>Eventos de orden</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmt(summary.skusWithOrder)}</div>
              <div style={styles.summaryLabel}>SKUs con al menos una orden</div>
            </div>
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  {columns.map(col => (
                    <th
                      key={col.key}
                      style={{ ...styles.th, textAlign: col.num ? 'right' : 'left', cursor: 'pointer', userSelect: 'none' }}
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}
                      {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  ))}
                </tr>
                {/* Fila de autofiltros */}
                <tr style={styles.filterRow}>
                  <td style={styles.filterCell}>
                    <input value={fSku} onChange={e => setFSku(e.target.value)} placeholder="Filtrar..." style={styles.filterInput} />
                  </td>
                  <td style={styles.filterCell}>
                    <input value={fName} onChange={e => setFName(e.target.value)} placeholder="Filtrar..." style={styles.filterInput} />
                  </td>
                  <td style={styles.filterCell}>
                    <select value={fSupplier} onChange={e => setFSupplier(e.target.value)} style={styles.filterSelect}>
                      {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  {/* Columnas de orden: sin filtro */}
                  {Array.from({ length: numOrders }).map((_, i) => [
                    <td key={`fd${i}`} style={styles.filterCell} />,
                    <td key={`fq${i}`} style={styles.filterCell} />,
                  ])}
                  <td style={styles.filterCell}>
                    <div style={styles.rangeWrap}>
                      <input value={fQty.min} onChange={e => setFQty(p => ({ ...p, min: e.target.value }))} placeholder="min" style={styles.rangeInput} />
                      <input value={fQty.max} onChange={e => setFQty(p => ({ ...p, max: e.target.value }))} placeholder="max" style={styles.rangeInput} />
                    </div>
                  </td>
                  <td style={styles.filterCell}>
                    <div style={styles.rangeWrap}>
                      <input value={fFob.min} onChange={e => setFFob(p => ({ ...p, min: e.target.value }))} placeholder="min" style={styles.rangeInput} />
                      <input value={fFob.max} onChange={e => setFFob(p => ({ ...p, max: e.target.value }))} placeholder="max" style={styles.rangeInput} />
                    </div>
                  </td>
                  <td style={styles.filterCell}>
                    <div style={styles.rangeWrap}>
                      <input value={fLanded.min} onChange={e => setFLanded(p => ({ ...p, min: e.target.value }))} placeholder="min" style={styles.rangeInput} />
                      <input value={fLanded.max} onChange={e => setFLanded(p => ({ ...p, max: e.target.value }))} placeholder="max" style={styles.rangeInput} />
                    </div>
                  </td>
                </tr>
              </thead>
              <tbody>
                {!groupBySupplier && sorted.map(renderRow)}
                {groupBySupplier && groups.map(g => (
                  <RowGroup key={g.name} group={g} colSpan={totalColCount} collapsed={collapsed.has(g.name)} onToggle={() => toggleSupplier(g.name)} renderRow={renderRow} />
                ))}
                {sorted.length === 0 && (
                  <tr><td colSpan={totalColCount} style={{ ...styles.td, textAlign: 'center', padding: 30, color: '#888' }}>Sin coincidencias</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {plan.length === 0 && !loading && (
        <div style={styles.empty}>
          <p>No hay SKUs con demanda proyectada. Verifica ventas, inventario y parámetros, y presiona "Recalcular".</p>
        </div>
      )}
    </div>
  )
}

// Bloque de proveedor colapsable (cabecera + filas)
function RowGroup({ group, colSpan, collapsed, onToggle, renderRow }) {
  return (
    <>
      <tr style={styles.groupRow} onClick={onToggle}>
        <td colSpan={colSpan} style={styles.groupCell}>
          <span style={styles.groupCaret}>{collapsed ? '▸' : '▾'}</span>
          <strong>{group.name}</strong>
          <span style={styles.groupMeta}>
            {group.rows.length} SKUs · FOB {fmtCurrency(group.fob)} · Landed {fmtCurrency(group.landed)}
          </span>
        </td>
      </tr>
      {!collapsed && group.rows.map(renderRow)}
    </>
  )
}

const styles = {
  loading: { padding: 40, color: '#666', textAlign: 'center' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 16 },
  pageTitle: { fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  pageDesc: { color: '#666', fontSize: 13 },
  headerControls: { display: 'flex', alignItems: 'center', gap: 12 },
  toggleBtn: { background: '#fff', color: '#4455aa', border: '1.5px solid #c5ccea', borderRadius: 8, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  toggleBtnActive: { background: '#4455aa', color: '#fff', border: '1.5px solid #4455aa' },
  exportBtn: { background: '#1F3864', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  paramsBar: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 14, background: '#fff', borderRadius: 10, padding: 16, marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  paramField: { display: 'flex', flexDirection: 'column', gap: 4 },
  paramLabel: { fontSize: 11, fontWeight: 600, color: '#666' },
  paramInput: { width: 150, padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' },
  recalcBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 },
  summaryCard: { background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  summaryVal: { fontSize: 24, fontWeight: 700, color: '#1a1a2e' },
  summaryLabel: { fontSize: 12, color: '#888', marginTop: 2 },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  table: { borderCollapse: 'collapse', background: '#fff', fontSize: 13, whiteSpace: 'nowrap' },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  filterRow: { background: '#f3f4f8' },
  filterCell: { padding: '5px 8px', borderBottom: '1px solid #e6e8ef' },
  filterInput: { width: '100%', minWidth: 90, padding: '5px 7px', border: '1px solid #d5d8e2', borderRadius: 5, fontSize: 12, boxSizing: 'border-box' },
  filterSelect: { width: '100%', minWidth: 90, padding: '5px 7px', border: '1px solid #d5d8e2', borderRadius: 5, fontSize: 12, background: '#fff', boxSizing: 'border-box' },
  rangeWrap: { display: 'flex', gap: 4 },
  rangeInput: { width: 52, padding: '5px 6px', border: '1px solid #d5d8e2', borderRadius: 5, fontSize: 12, boxSizing: 'border-box' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  supplierBadge: { background: '#eef0ff', color: '#4455aa', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 },
  groupRow: { background: '#eef0f6', cursor: 'pointer', borderBottom: '1px solid #dde0ea' },
  groupCell: { padding: '10px 14px', fontSize: 13, color: '#1a1a2e' },
  groupCaret: { display: 'inline-block', width: 18, color: '#4455aa', fontWeight: 700 },
  groupMeta: { marginLeft: 12, color: '#666', fontSize: 12, fontWeight: 500 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
}
