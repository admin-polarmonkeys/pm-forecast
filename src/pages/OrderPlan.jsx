import { useState, useEffect, useMemo, Fragment } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { calcAvgMonthlySales } from '../lib/forecast'

const MONTHS_ES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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

// Filtros de SKU guardados por el usuario en localStorage. Formato: [{ name, skus: [] }]
const SAVED_FILTERS_KEY = 'pm_orderplan_filters'
const MAX_SAVED_FILTERS = 10

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem(SAVED_FILTERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(f => f && typeof f.name === 'string' && Array.isArray(f.skus))
      .slice(0, MAX_SAVED_FILTERS)
  } catch {
    return []
  }
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
  const [fSupplier, setFSupplier] = useState('All')
  const [fQty, setFQty] = useState({ min: '', max: '' })
  const [fFob, setFFob] = useState({ min: '', max: '' })
  const [fLanded, setFLanded] = useState({ min: '', max: '' })

  // Filtro multi-select de SKU (mismo patrón que ForecastView)
  // selectedSkus === null = "todos seleccionados" (sin filtro); un Set = selección explícita
  const [selectedSkus, setSelectedSkus] = useState(null)
  const [skuFilterOpen, setSkuFilterOpen] = useState(false)
  const [skuSearch, setSkuSearch] = useState('')
  const [savedFilters, setSavedFilters] = useState(loadSavedFilters)
  const [activeFilterName, setActiveFilterName] = useState(null)
  const [savingFilter, setSavingFilter] = useState(false)
  const [newFilterName, setNewFilterName] = useState('')

  const [sortKey, setSortKey] = useState('totalLanded')
  const [sortDir, setSortDir] = useState('desc')

  const [groupBySupplier, setGroupBySupplier] = useState(false)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [monthlyOpen, setMonthlyOpen] = useState(true) // Monthly Summary expandido por defecto
  const [expandedMonths, setExpandedMonths] = useState(() => new Set()) // meses expandidos en el resumen

  function toggleMonth(label) {
    setExpandedMonths(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

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
      // Lead time del proveedor (semanas). Null o 0 -> 0.
      const leadWeeks = params.lead_time_weeks && params.lead_time_weeks > 0 ? params.lead_time_weeks : 0
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
        // El slot marca cuándo el inventario toca el mínimo; la orden se coloca antes,
        // descontando el lead time (date = fecha de colocación de la orden).
        const date = new Date(slotDates[i].getTime())
        date.setDate(date.getDate() - leadWeeks * 7)
        const days = Math.round((date - now) / 86400000)
        const overdue = days < 0
        orders.push({ qty, date, days, hasOrder: qty > 0, overdue })
      }

      const totalQty = orders.reduce((s, o) => s + o.qty, 0)
      rows.push({
        sku: prod.sku,
        name: prod.name,
        supplier: params.supplier || '—',
        leadWeeks,
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
    return ['All', ...[...set].sort()]
  }, [plan])

  // Aplica filtros de autofiltro
  const filtered = useMemo(() => {
    const inRange = (v, { min, max }) => {
      if (min !== '' && v < Number(min)) return false
      if (max !== '' && v > Number(max)) return false
      return true
    }
    return plan.filter(r => {
      if (selectedSkus !== null && !selectedSkus.has(r.sku)) return false
      if (fSku && !r.sku.toLowerCase().includes(fSku.toLowerCase())) return false
      if (fName && !(r.name || '').toLowerCase().includes(fName.toLowerCase())) return false
      if (fSupplier !== 'All' && r.supplier !== fSupplier) return false
      if (!inRange(r.totalQty, fQty)) return false
      if (!inRange(r.totalFob, fFob)) return false
      if (!inRange(r.totalLanded, fLanded)) return false
      return true
    })
  }, [plan, selectedSkus, fSku, fName, fSupplier, fQty, fFob, fLanded])

  // Opciones del multi-select de SKU (ordenadas A–Z) y derivados
  const skuOptions = useMemo(
    () => plan.map(r => ({ sku: r.sku, name: r.name })).sort((a, b) => a.sku.localeCompare(b.sku)),
    [plan]
  )
  const visibleSkuOptions = useMemo(() => {
    const q = skuSearch.trim().toLowerCase()
    if (!q) return skuOptions
    return skuOptions.filter(o => o.sku.toLowerCase().includes(q) || (o.name || '').toLowerCase().includes(q))
  }, [skuOptions, skuSearch])

  const selectedCount = selectedSkus === null ? skuOptions.length : selectedSkus.size
  const isSkuSelected = sku => selectedSkus === null || selectedSkus.has(sku)

  function toggleSku(sku) {
    setActiveFilterName(null) // edición manual: deja de coincidir con el filtro guardado
    setSelectedSkus(prev => {
      const next = prev === null ? new Set(skuOptions.map(o => o.sku)) : new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }
  function selectAllSkus() { setSelectedSkus(null); setActiveFilterName(null) }
  function clearAllSkus() { setSelectedSkus(new Set()); setActiveFilterName(null) }

  function persistSavedFilters(next) {
    setSavedFilters(next)
    try {
      localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(next))
    } catch {
      // localStorage lleno o no disponible: el estado en memoria igual queda actualizado
    }
  }

  function saveCurrentFilter() {
    const name = newFilterName.trim()
    if (!name) return
    const skus = selectedSkus === null ? skuOptions.map(o => o.sku) : [...selectedSkus]
    const withoutDup = savedFilters.filter(f => f.name !== name)
    if (withoutDup.length >= MAX_SAVED_FILTERS) {
      alert(`Maximum ${MAX_SAVED_FILTERS} saved filters. Delete one before saving another.`)
      return
    }
    persistSavedFilters([...withoutDup, { name, skus }])
    setActiveFilterName(name)
    setSavingFilter(false)
    setNewFilterName('')
  }

  function applySavedFilter(filter) {
    const valid = filter.skus.filter(s => skuOptions.some(o => o.sku === s))
    setSelectedSkus(new Set(valid))
    setActiveFilterName(filter.name)
  }

  function deleteSavedFilter(name) {
    persistSavedFilters(savedFilters.filter(f => f.name !== name))
    if (activeFilterName === name) setActiveFilterName(null)
  }

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

  // Resumen mensual: una fila por mes del horizonte; agrega las órdenes que caen en ese mes.
  const monthlySummary = useMemo(() => {
    const now = new Date()
    const months = []
    for (let m = 0; m < applied.planningHorizon; m++) {
      const md = addMonths(now, m)
      const y = md.getFullYear(), mo = md.getMonth()
      const items = []
      let qty = 0, fob = 0, landed = 0
      for (const r of sorted) {
        for (const o of r.orders) {
          // Agrupamos por mes de la fecha de COLOCACIÓN (o.date). Las vencidas (placeDate en el
          // pasado) se asignan al mes actual: hay que colocarlas ya.
          const eff = o.overdue ? now : o.date
          if (o.hasOrder && eff.getFullYear() === y && eff.getMonth() === mo) {
            items.push({
              sku: r.sku,
              name: r.name,
              supplier: r.supplier,
              qty: o.qty,
              fobCost: r.fob,
              totalFob: o.qty * (r.fob || 0),
              landedCost: r.landed,
              totalLanded: o.qty * (r.landed || 0),
            })
            qty += o.qty
            fob += o.qty * (r.fob || 0)
            landed += o.qty * (r.landed || 0)
          }
        }
      }
      months.push({ label: `${MONTHS_ES[mo]} ${y}`, count: items.length, qty, fob, landed, items })
    }
    return months
  }, [sorted, applied.planningHorizon])

  const monthlyTotals = useMemo(() => ({
    count: monthlySummary.reduce((s, r) => s + r.count, 0),
    qty: monthlySummary.reduce((s, r) => s + r.qty, 0),
    fob: monthlySummary.reduce((s, r) => s + r.fob, 0),
    landed: monthlySummary.reduce((s, r) => s + r.landed, 0),
  }), [monthlySummary])

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
      { key: 'name', label: 'Name' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'leadWeeks', label: 'Lead Time (wk)', num: true },
    ]
    for (let i = 0; i < numOrders; i++) {
      cols.push({ key: `order_${i}_date`, label: `Order ${i + 1} Date`, num: true })
      cols.push({ key: `order_${i}_qty`, label: `Order ${i + 1} Qty`, num: true })
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
      { header: 'Date', get: r => r.fecha, w: 14 },
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
    XLSX.utils.book_append_sheet(wb, buildSheet(resumenCols, resumenRows, resumenTotal), 'SUMMARY')

    // Una hoja por fecha con los SKUs ordenados ese día
    const dateCols = [
      { header: 'SKU', get: r => r.sku, w: 14 },
      { header: 'Name', get: r => r.name, w: 30 },
      { header: 'Supplier', get: r => r.supplier, w: 12 },
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
    // El export ya usa `sorted` (filtrado por SKU); el filtro activo se refleja en el nombre del archivo
    const filterPart = activeFilterName
      ? '_' + activeFilterName.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      : ''
    XLSX.writeFile(wb, `PM_Order_Plan${filterPart}_${today}.xlsx`)
  }

  if (loading) return <div style={styles.loading}>Loading...</div>

  // Render de una fila de SKU (reutilizable con/sin agrupamiento)
  const renderRow = r => (
    <tr key={r.sku} style={styles.tr}>
      <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
      <td style={styles.td}>{r.name}</td>
      <td style={styles.td}><span style={styles.supplierBadge}>{r.supplier}</span></td>
      <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.leadWeeks)}</td>
      {r.orders.map((o, i) => [
        <td key={`d${i}`} style={{ ...styles.td, textAlign: 'center', color: !o.hasOrder ? '#bbb' : o.overdue ? '#c00' : dateColor(o.days), fontWeight: o.hasOrder && (o.overdue || o.days <= 30) ? 700 : 400 }}>
          {!o.hasOrder ? '—' : o.overdue ? 'OVERDUE ⚠️' : formatDate(o.date)}
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
            {data?.snapshotDate ? `Inventory as of ${data.snapshotDate}` : 'No inventory data'}
            {' · '}{applied.planningHorizon}-month plan, order every {applied.orderFrequency}
          </p>
        </div>
        <div style={styles.headerControls}>
          <button
            style={{ ...styles.toggleBtn, ...(groupBySupplier ? styles.toggleBtnActive : {}) }}
            onClick={() => setGroupBySupplier(g => !g)}
          >
            {groupBySupplier ? '✓ ' : ''}Group by Supplier
          </button>
          {plan.length > 0 && (
            <button style={styles.exportBtn} onClick={exportToExcel}>⬇ Export to Excel</button>
          )}
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Barra de parámetros */}
      <div style={styles.paramsBar}>
        {[
          { key: 'coverageTarget', label: 'Coverage Target (months)', step: 1 },
          { key: 'orderFrequency', label: 'Order Frequency (months)', step: 1 },
          { key: 'planningHorizon', label: 'Planning Horizon (months)', step: 1 },
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
        {plan.length > 0 && (
          <div style={styles.skuFilter}>
            <button style={styles.skuFilterBtn} onClick={() => setSkuFilterOpen(o => !o)}>
              {activeFilterName
                ? `Filter: ${activeFilterName} (${selectedCount} SKUs) ▼`
                : `${selectedCount} of ${skuOptions.length} SKUs ▼`}
            </button>
            {skuFilterOpen && (
              <>
                <div style={styles.skuBackdrop} onClick={() => setSkuFilterOpen(false)} />
                <div style={styles.skuPopover}>
                  {savedFilters.length > 0 && (
                    <div style={styles.savedSection}>
                      <div style={styles.savedTitle}>Saved Filters</div>
                      <div style={styles.savedChips}>
                        {savedFilters.map(f => (
                          <span
                            key={f.name}
                            style={{ ...styles.savedChip, ...(activeFilterName === f.name ? styles.savedChipActive : {}) }}
                          >
                            <button
                              style={styles.savedChipLabel}
                              onClick={() => applySavedFilter(f)}
                              title={`Apply "${f.name}" (${f.skus.length} SKUs)`}
                            >
                              {f.name}
                            </button>
                            <button style={styles.savedChipDelete} onClick={() => deleteSavedFilter(f.name)} title="Delete filter">×</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <input
                    placeholder="Search SKU or name..."
                    value={skuSearch}
                    onChange={e => setSkuSearch(e.target.value)}
                    style={styles.skuSearchInput}
                    autoFocus
                  />
                  <div style={styles.skuActions}>
                    <button style={styles.skuActionBtn} onClick={selectAllSkus}>Select all</button>
                    <button style={styles.skuActionBtn} onClick={clearAllSkus}>Clear all</button>
                  </div>
                  <div style={styles.skuList}>
                    {visibleSkuOptions.map(o => (
                      <label key={o.sku} style={styles.skuItem}>
                        <input type="checkbox" checked={isSkuSelected(o.sku)} onChange={() => toggleSku(o.sku)} />
                        <span style={styles.skuItemCode}>{o.sku}</span>
                        <span style={styles.skuItemName}>{o.name}</span>
                      </label>
                    ))}
                    {visibleSkuOptions.length === 0 && <div style={styles.skuEmpty}>No matches</div>}
                  </div>
                  <div style={styles.savedFooter}>
                    {savingFilter ? (
                      <div style={styles.saveRow}>
                        <input
                          placeholder="Filter name..."
                          value={newFilterName}
                          onChange={e => setNewFilterName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') saveCurrentFilter()
                            if (e.key === 'Escape') { setSavingFilter(false); setNewFilterName('') }
                          }}
                          style={styles.saveInput}
                          autoFocus
                        />
                        <button style={styles.saveConfirmBtn} onClick={saveCurrentFilter} disabled={!newFilterName.trim()}>Save</button>
                        <button style={styles.saveCancelBtn} onClick={() => { setSavingFilter(false); setNewFilterName('') }}>✕</button>
                      </div>
                    ) : (
                      <button
                        style={styles.saveFilterBtn}
                        onClick={() => setSavingFilter(true)}
                        disabled={savedFilters.length >= MAX_SAVED_FILTERS}
                        title={savedFilters.length >= MAX_SAVED_FILTERS ? `Maximum ${MAX_SAVED_FILTERS} saved filters` : 'Save current selection'}
                      >
                        + Save current filter
                        {savedFilters.length >= MAX_SAVED_FILTERS ? ` (${MAX_SAVED_FILTERS}/${MAX_SAVED_FILTERS})` : ''}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        <button style={styles.recalcBtn} onClick={() => setApplied(form)}>Recalculate</button>
      </div>

      {plan.length > 0 && (
        <>
          {/* Monthly Summary (collapsible, expanded by default) */}
          <div style={styles.monthlyWrap}>
            <div style={styles.monthlyHeader} onClick={() => setMonthlyOpen(o => !o)}>
              <span>Monthly Summary {monthlyOpen ? '▼' : '►'}</span>
            </div>
            {monthlyOpen && (
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr style={styles.thead}>
                      <th style={{ ...styles.th, textAlign: 'left' }}>Month</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}># SKUs to Order</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Total Qty</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Total FOB</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Total Landed</th>
                      <th style={{ ...styles.th, textAlign: 'left' }}>SKUs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthlySummary.map(m => {
                      const isOpen = expandedMonths.has(m.label)
                      const canExpand = m.count > 0
                      return (
                        <Fragment key={m.label}>
                          <tr
                            style={{ ...styles.tr, ...(m.landed > 50000 ? styles.monthlyHighlight : {}), cursor: canExpand ? 'pointer' : 'default' }}
                            onClick={() => canExpand && toggleMonth(m.label)}
                          >
                            <td style={{ ...styles.td, fontWeight: 600 }}>
                              {canExpand && <span style={{ ...styles.monthCaret, transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>}
                              {m.label}
                            </td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{m.count > 0 ? fmt(m.count) : '—'}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{m.qty > 0 ? fmt(m.qty) : '—'}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{m.fob > 0 ? fmtCurrency(m.fob) : '—'}</td>
                            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{m.landed > 0 ? fmtCurrency(m.landed) : '—'}</td>
                            <td style={{ ...styles.td, color: '#666', fontSize: 12 }}>
                              {m.count > 0 ? `${m.count} SKUs` : '—'}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={6} style={styles.subTableCell}>
                                <table style={styles.subTable}>
                                  <thead>
                                    <tr>
                                      {['SKU', 'Name', 'Supplier', 'Qty', 'FOB Cost', 'Total FOB', 'Landed Cost', 'Total Landed'].map((h, idx) => (
                                        <th key={h} style={{ ...styles.subTh, textAlign: idx >= 3 ? 'right' : 'left' }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {m.items.map(it => (
                                      <tr key={it.sku} style={styles.subTr}>
                                        <td style={{ ...styles.subTd, fontFamily: 'monospace', fontSize: 12 }}>{it.sku}</td>
                                        <td style={styles.subTd}>{it.name}</td>
                                        <td style={styles.subTd}><span style={styles.supplierBadge}>{it.supplier}</span></td>
                                        <td style={{ ...styles.subTd, textAlign: 'right', fontWeight: 700 }}>{fmt(it.qty)}</td>
                                        <td style={{ ...styles.subTd, textAlign: 'right' }}>{fmtCurrency(it.fobCost)}</td>
                                        <td style={{ ...styles.subTd, textAlign: 'right' }}>{fmtCurrency(it.totalFob)}</td>
                                        <td style={{ ...styles.subTd, textAlign: 'right' }}>{fmtCurrency(it.landedCost)}</td>
                                        <td style={{ ...styles.subTd, textAlign: 'right', fontWeight: 700 }}>{fmtCurrency(it.totalLanded)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                    <tr style={styles.monthlyTotalRow}>
                      <td style={{ ...styles.td, fontWeight: 700 }}>TOTAL</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmt(monthlyTotals.count)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmt(monthlyTotals.qty)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmtCurrency(monthlyTotals.fob)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmtCurrency(monthlyTotals.landed)}</td>
                      <td style={styles.td} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={styles.summaryGrid}>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(summary.fob)}</div>
              <div style={styles.summaryLabel}>Total investment FOB</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(summary.landed)}</div>
              <div style={styles.summaryLabel}>Total investment Landed</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmt(summary.events)}</div>
              <div style={styles.summaryLabel}>Order events</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmt(summary.skusWithOrder)}</div>
              <div style={styles.summaryLabel}>SKUs with at least one order</div>
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
                    <input value={fSku} onChange={e => setFSku(e.target.value)} placeholder="Filter..." style={styles.filterInput} />
                  </td>
                  <td style={styles.filterCell}>
                    <input value={fName} onChange={e => setFName(e.target.value)} placeholder="Filter..." style={styles.filterInput} />
                  </td>
                  <td style={styles.filterCell}>
                    <select value={fSupplier} onChange={e => setFSupplier(e.target.value)} style={styles.filterSelect}>
                      {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={styles.filterCell} />{/* Lead Time: sin filtro */}
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
                  <tr><td colSpan={totalColCount} style={{ ...styles.td, textAlign: 'center', padding: 30, color: '#888' }}>No matches</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {plan.length === 0 && !loading && (
        <div style={styles.empty}>
          <p>No SKUs with projected demand. Check sales, inventory and parameters, then press "Recalculate".</p>
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
  skuFilter: { position: 'relative' },
  skuFilterBtn: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff', cursor: 'pointer', fontWeight: 600, color: '#333', whiteSpace: 'nowrap' },
  skuBackdrop: { position: 'fixed', inset: 0, zIndex: 10 },
  skuPopover: { position: 'absolute', top: '100%', left: 0, marginTop: 6, background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 10, width: 300, zIndex: 20 },
  skuSearchInput: { width: '100%', padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, marginBottom: 8, boxSizing: 'border-box' },
  skuActions: { display: 'flex', gap: 8, marginBottom: 8 },
  skuActionBtn: { flex: 1, padding: '6px 8px', border: '1px solid #e0e0e0', borderRadius: 6, background: '#f7f7f9', fontSize: 12, fontWeight: 600, color: '#4455aa', cursor: 'pointer' },
  skuList: { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 },
  skuItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 4, fontSize: 12, cursor: 'pointer' },
  skuItemCode: { fontFamily: 'monospace', color: '#333', whiteSpace: 'nowrap' },
  skuItemName: { color: '#999', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  skuEmpty: { padding: 14, color: '#999', fontSize: 12, textAlign: 'center' },
  savedSection: { marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #eee' },
  savedTitle: { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  savedChips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  savedChip: { display: 'inline-flex', alignItems: 'center', background: '#f0f1f5', borderRadius: 6, overflow: 'hidden', border: '1px solid #e0e0e0' },
  savedChipActive: { background: '#e7ebff', border: '1px solid #4455aa' },
  savedChipLabel: { border: 'none', background: 'transparent', padding: '4px 4px 4px 8px', fontSize: 12, fontWeight: 600, color: '#4455aa', cursor: 'pointer', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  savedChipDelete: { border: 'none', background: 'transparent', padding: '4px 7px', fontSize: 14, lineHeight: 1, color: '#999', cursor: 'pointer' },
  savedFooter: { marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee' },
  saveFilterBtn: { width: '100%', padding: '7px 8px', border: '1.5px dashed #4455aa', borderRadius: 6, background: '#f7f8ff', fontSize: 12, fontWeight: 600, color: '#4455aa', cursor: 'pointer' },
  saveRow: { display: 'flex', gap: 6, alignItems: 'center' },
  saveInput: { flex: 1, padding: '6px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 12, boxSizing: 'border-box', minWidth: 0 },
  saveConfirmBtn: { padding: '6px 10px', border: 'none', borderRadius: 6, background: '#4455aa', fontSize: 12, fontWeight: 600, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
  saveCancelBtn: { padding: '6px 9px', border: '1px solid #e0e0e0', borderRadius: 6, background: '#fff', fontSize: 12, color: '#999', cursor: 'pointer' },
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
  monthlyWrap: { marginBottom: 24, background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)', overflow: 'hidden' },
  monthlyHeader: { padding: '12px 16px', fontSize: 15, fontWeight: 700, color: '#1a1a2e', cursor: 'pointer', userSelect: 'none', borderBottom: '1px solid #eee' },
  monthlyHighlight: { background: '#fff7c2' },
  monthlyTotalRow: { borderTop: '2px solid #1a1a2e', background: '#eef0f6' },
  monthCaret: { display: 'inline-block', width: 16, color: '#4455aa', fontSize: 10, transition: 'transform 0.15s' },
  subTableCell: { padding: '0 0 0 24px', background: '#fafbfd', borderBottom: '1px solid #e6e8ef' },
  subTable: { borderCollapse: 'collapse', width: '100%', background: '#fafbfd' },
  subTh: { padding: '7px 12px', color: '#666', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #e0e3ec', whiteSpace: 'nowrap' },
  subTr: { borderBottom: '1px solid #eef0f4' },
  subTd: { padding: '7px 12px', color: '#333', fontSize: 12, whiteSpace: 'nowrap' },
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
