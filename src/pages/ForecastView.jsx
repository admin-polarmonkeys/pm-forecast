import { useState, useEffect, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { runForecast } from '../lib/forecast'

const SUPPLIERS = ['All', 'SV', 'HAW', 'GUGU', 'HIM', 'TAR', 'DAR', 'WAT', 'WES', 'NING', 'UP', 'ALI', 'SIR', 'SC']

// Filtros de SKU guardados por el usuario en localStorage. Formato: [{ name, skus: [] }]
const SAVED_FILTERS_KEY = 'pm_forecast_filters'
const MAX_SAVED_FILTERS = 10

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem(SAVED_FILTERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Validamos la forma de cada entrada por si el storage quedó corrupto
    return parsed
      .filter(f => f && typeof f.name === 'string' && Array.isArray(f.skus))
      .slice(0, MAX_SAVED_FILTERS)
  } catch {
    return []
  }
}

// Definición de columnas: key = campo del registro, align = alineación.
// param: true -> columna de input (header gris) para distinguir de los outputs (header oscuro)
const COLUMNS = [
  { key: 'sku', label: 'SKU', align: 'left' },
  { key: 'name', label: 'Name', align: 'left' },
  { key: 'supplier', label: 'Supplier', align: 'left' },
  { key: 'avg_monthly_sales_total', label: 'Avg Sales/Mo', align: 'right' },
  { key: 'projected_monthly_demand', label: 'Projected/Mo', align: 'right' },
  { key: 'qty_available_real', label: 'Available', align: 'right' },
  { key: 'qty_transit', label: 'In Transit', align: 'right' },
  { key: 'days_of_inventory', label: 'Days of Inventory', align: 'right' },
  { key: 'growth_factor', label: 'Growth Factor', align: 'right', param: true },
  { key: 'lead_time_weeks', label: 'Lead Time (wk)', align: 'right', param: true },
  { key: 'coverage_target_months', label: 'Coverage Target', align: 'right', param: true },
  { key: 'months_coverage_current', label: 'Months Coverage', align: 'right' },
  { key: 'qty_suggested', label: 'Suggested Order', align: 'right' },
  { key: 'order_by_days', label: 'Order By', align: 'right' },
  { key: 'total_landed_cost', label: 'Total Landed', align: 'right' },
]

// Anchos por defecto de cada columna (px). El usuario puede redimensionarlas arrastrando.
const DEFAULT_COL_WIDTHS = {
  sku: 120,
  name: 200,
  supplier: 110,
  avg_monthly_sales_total: 120,
  projected_monthly_demand: 130,
  qty_available_real: 100,
  qty_transit: 90,
  days_of_inventory: 130,
  growth_factor: 110,
  lead_time_weeks: 110,
  coverage_target_months: 120,
  months_coverage_current: 130,
  qty_suggested: 120,
  order_by_days: 130,
  total_landed_cost: 120,
}
const MIN_COL_WIDTH = 60

function fmt(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n)
}

function fmtCurrency(n) {
  if (n == null || n === 0) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function coverageColor(months) {
  if (months == null) return '#f0f0f0'
  if (months <= 1) return '#ffd5d5'
  if (months <= 2) return '#ffecd5'
  if (months <= 3) return '#fff9d5'
  return '#d5f5e3'
}

// Días de inventario = (disponible + tránsito) / demanda proyectada mensual × 30
function daysOfInventory(r) {
  const proj = r.projected_monthly_demand
  if (!proj || proj === 0) return null
  return Math.round((r.qty_available_real + r.qty_transit) / proj * 30)
}

function daysColor(d) {
  if (d == null) return undefined
  if (d < 30) return '#ffd5d5'   // rojo
  if (d <= 60) return '#ffecd5'  // naranja
  if (d <= 90) return '#fff9d5'  // amarillo
  return '#d5f5e3'               // verde
}

// Abreviaturas de mes en español para formatear "DD MMM YYYY" (ej. "15 Jul 2026")
const MONTHS_ES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatOrderDate(d) {
  const dd = String(d.getDate()).padStart(2, '0')
  return `${dd} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}`
}

// "Pedir Antes De": fecha límite para colocar la orden considerando lead time del proveedor.
// days_until_order = (months_coverage_current - coverage_target_months)*30 - lead_time_weeks*7
// La fecha es hoy + max(0, días). Devuelve también `days` (clamp >= 0, null si no aplica) para ordenar.
function orderByInfo(r) {
  // Sin orden sugerida: no aplica
  if (!r.qty_suggested || r.qty_suggested === 0) {
    return { text: '—', color: undefined, bold: false, days: null }
  }
  const cov = r.months_coverage_current
  // Sin cobertura actual: hay que pedir ya
  if (cov == null || cov === 0) {
    return { text: 'NOW ⚠️', color: '#c00', bold: true, days: 0 }
  }
  const target = r.coverage_target_months || 0
  const lead = r.lead_time_weeks || 0
  const daysUntil = (cov - target) * 30 - lead * 7
  if (daysUntil <= 0) {
    return { text: 'NOW ⚠️', color: '#c00', bold: true, days: 0 }
  }
  const d = new Date()
  d.setDate(d.getDate() + Math.round(daysUntil))
  let color = '#1f9d57'           // verde > 60 días
  let bold = false
  if (daysUntil <= 30) { color = '#c00'; bold = true }  // rojo negrita ≤ 30 días
  else if (daysUntil <= 60) { color = '#e08600' }       // naranja 31–60 días
  return { text: formatOrderDate(d), color, bold, days: Math.round(daysUntil) }
}

export default function ForecastView() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [results, setResults] = useState([])
  const [monthsBack, setMonthsBack] = useState(6)
  const [filterSupplier, setFilterSupplier] = useState('All')
  const [filterOnlyOrders, setFilterOnlyOrders] = useState(false)
  const [search, setSearch] = useState('')
  const [snapshotDate, setSnapshotDate] = useState(null)
  const [sortKey, setSortKey] = useState('qty_suggested')
  const [sortDir, setSortDir] = useState('desc')
  // selectedSkus === null significa "todos seleccionados" (sin filtro). Un Set significa selección explícita.
  const [selectedSkus, setSelectedSkus] = useState(null)
  const [skuFilterOpen, setSkuFilterOpen] = useState(false)
  const [skuSearch, setSkuSearch] = useState('')
  // Filtros guardados (localStorage), nombre del filtro activo, y estado del input para guardar uno nuevo
  const [savedFilters, setSavedFilters] = useState(loadSavedFilters)
  const [activeFilterName, setActiveFilterName] = useState(null)
  const [savingFilter, setSavingFilter] = useState(false)
  const [newFilterName, setNewFilterName] = useState('')
  // Ajuste rápido (what-if): overrides temporales que se aplican a todos los SKUs sin guardar en Supabase.
  // Vacío = no se toca ese parámetro. Growth Factor arranca en 1.40.
  const [quickGrowth, setQuickGrowth] = useState('1.40')
  const [quickLeadTime, setQuickLeadTime] = useState('')
  const [quickCoverage, setQuickCoverage] = useState('')
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS)
  const [hoverHandle, setHoverHandle] = useState(null)

  useEffect(() => { loadData() }, [])

  // Al correr un forecast nuevo, volvemos a "todos seleccionados" y limpiamos el filtro activo
  useEffect(() => { setSelectedSkus(null); setActiveFilterName(null) }, [results])

  async function loadData({ refresh = false } = {}) {
    // refresh: no usamos el loading de pantalla completa para no ocultar los resultados actuales
    refresh ? setRefreshing(true) : setLoading(true)
    try {
      const [products, bom, sales, inventory, params, transit, latestRun] = await Promise.all([
        supabase.from('products').select('*'),
        supabase.from('bom').select('*'),
        supabase.from('sales_history').select('*'),
        supabase.from('inventory_snapshots').select('*').order('snapshot_date', { ascending: false }),
        supabase.from('purchase_params').select('*'),
        supabase.from('transit_orders').select('sku, qty'),
        supabase.from('forecast_runs').select('id').order('created_at', { ascending: false }).limit(1),
      ])

      if (products.error) throw products.error
      if (bom.error) throw bom.error

      // Get latest snapshot date
      const latestDate = inventory.data?.[0]?.snapshot_date || null
      setSnapshotDate(latestDate)

      // Filter inventory to latest snapshot only
      const latestInventory = latestDate
        ? inventory.data.filter(r => r.snapshot_date === latestDate)
        : []

      // Órdenes confirmadas (status "ordenado") de la ÚLTIMA corrida cuentan como tránsito:
      // ya están pedidas pero todavía no figuran en transit_orders. Se suman al qty_transit existente.
      // Nota: order_status se guarda como 'ordenado' (no 'ordered') — ver STATUS_OPTIONS en PurchaseOrders.jsx.
      const lastRunId = latestRun.data?.[0]?.id || null
      let confirmedTransit = []
      if (lastRunId) {
        const { data: confirmedOrders } = await supabase
          .from('purchase_orders')
          .select('sku, confirmed_qty')
          .eq('run_id', lastRunId)
          .eq('order_status', 'ordenado')
          .gt('confirmed_qty', 0)
        // GROUP BY sku: sumamos confirmed_qty por SKU del lado del cliente
        const sumBySku = {}
        for (const o of (confirmedOrders || [])) {
          sumBySku[o.sku] = (sumBySku[o.sku] || 0) + (o.confirmed_qty || 0)
        }
        confirmedTransit = Object.entries(sumBySku).map(([sku, qty]) => ({ sku, qty }))
      }

      // runForecast suma qty por SKU sobre transitOrders, así que concatenar las confirmadas
      // incrementa el qty_transit de cada SKU sin lógica extra de merge.
      const mergedTransit = [...(transit.data || []), ...confirmedTransit]

      setData({
        products: products.data || [],
        bomRows: bom.data || [],
        salesHistory: sales.data || [],
        inventorySnapshot: latestInventory,
        purchaseParams: params.data || [],
        transitOrders: mergedTransit,
      })
    } catch (err) {
      setError(err.message)
    }
    refresh ? setRefreshing(false) : setLoading(false)
  }

  async function handleRunForecast() {
    if (!data) return
    setRunning(true)
    try {
      const forecast = runForecast({ ...data, monthsBack })

      // Save run to DB
      const { data: run, error: runErr } = await supabase
        .from('forecast_runs')
        .insert({
          snapshot_date: snapshotDate || new Date().toISOString().split('T')[0],
          months_history: monthsBack,
          notes: `Run manual ${new Date().toLocaleDateString()}`,
        })
        .select()
        .single()

      if (!runErr && run) {
        // fob_cost_usd no viene en los resultados del forecast; lo tomamos de purchase_params
        const paramsBySku = {}
        for (const p of (data.purchaseParams || [])) paramsBySku[p.sku] = p

        const orders = forecast
          .filter(r => r.qty_suggested > 0)
          .map(r => {
            // Costos desde purchase_params (no desde los resultados del forecast)
            const params = paramsBySku[r.sku] || {}
            const landedCost = params.landed_cost_usd ?? null
            const fobCost = params.fob_cost_usd ?? null
            return {
              run_id: run.id,
              sku: r.sku,
              avg_monthly_sales: r.avg_monthly_sales_total,
              projected_monthly_demand: r.projected_monthly_demand,
              qty_available_real: r.qty_available_real,
              qty_transit: r.qty_transit,
              months_coverage_current: r.months_coverage_current,
              qty_suggested: r.qty_suggested,
              // Recalculado acá, no desde el motor de forecast
              total_landed_cost: landedCost != null ? r.qty_suggested * landedCost : null,
              supplier: r.supplier,
              // Parámetros usados en el cálculo — se persisten para el panel de detalle
              growth_factor: r.growth_factor,
              lead_time_weeks: r.lead_time_weeks,
              coverage_target_months: r.coverage_target_months,
              moq: r.moq,
              avg_monthly_sales_direct: r.avg_monthly_sales_direct,
              avg_monthly_sales_derived: r.avg_monthly_sales_derived,
              fob_cost_usd: fobCost,
              landed_cost_usd: landedCost,
            }
          })

        if (orders.length > 0) {
          await supabase.from('purchase_orders').insert(orders)
        }
      }

      setResults(forecast)
    } catch (err) {
      setError(err.message)
    }
    setRunning(false)
  }

  // Ajuste rápido (what-if): pisa growth/lead time/coverage de TODOS los SKUs en el estado local
  // de purchaseParams y recalcula el forecast al instante. No persiste en Supabase.
  function applyQuickAdjust() {
    if (!data) return
    // Solo aplicamos los campos con valor; un input vacío deja intacto el valor por SKU.
    const growth = quickGrowth.trim() === '' ? null : Number(quickGrowth)
    const lead = quickLeadTime.trim() === '' ? null : Number(quickLeadTime)
    const coverage = quickCoverage.trim() === '' ? null : Number(quickCoverage)

    const updatedParams = (data.purchaseParams || []).map(p => ({
      ...p,
      ...(growth != null && !Number.isNaN(growth) ? { growth_factor: growth } : {}),
      ...(lead != null && !Number.isNaN(lead) ? { lead_time_weeks: lead } : {}),
      ...(coverage != null && !Number.isNaN(coverage) ? { coverage_target_months: coverage } : {}),
    }))

    const updatedData = { ...data, purchaseParams: updatedParams }
    setData(updatedData)
    setResults(runForecast({ ...updatedData, monthsBack }))
  }

  // Agrega campos calculados: days_of_inventory y la info de "Pedir Antes De"
  // (_orderBy para el render, order_by_days para poder ordenar la columna)
  const enriched = useMemo(
    () => results.map(r => {
      const info = orderByInfo(r)
      return { ...r, days_of_inventory: daysOfInventory(r), _orderBy: info, order_by_days: info.days }
    }),
    [results]
  )

  const filtered = useMemo(() => {
    return enriched.filter(r => {
      if (selectedSkus !== null && !selectedSkus.has(r.sku)) return false
      if (filterSupplier !== 'All' && r.supplier !== filterSupplier) return false
      if (filterOnlyOrders && r.qty_suggested === 0) return false
      if (search && !r.sku.toLowerCase().includes(search.toLowerCase()) &&
          !r.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [enriched, selectedSkus, filterSupplier, filterOnlyOrders, search])

  // Lista de SKUs (con nombre) para el filtro multi-select
  const skuOptions = useMemo(
    () => results
      .map(r => ({ sku: r.sku, name: r.name }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
    [results]
  )
  const visibleSkuOptions = useMemo(() => {
    const q = skuSearch.trim().toLowerCase()
    if (!q) return skuOptions
    return skuOptions.filter(o =>
      o.sku.toLowerCase().includes(q) || (o.name || '').toLowerCase().includes(q)
    )
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

  // Persiste el array de filtros en localStorage y en el estado a la vez
  function persistSavedFilters(next) {
    setSavedFilters(next)
    try {
      localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(next))
    } catch {
      // localStorage lleno o no disponible: el estado en memoria igual queda actualizado
    }
  }

  // Guarda la selección actual con el nombre escrito en el input inline
  function saveCurrentFilter() {
    const name = newFilterName.trim()
    if (!name) return
    // selectedSkus === null = "todos"; lo materializamos como la lista completa de SKUs
    const skus = selectedSkus === null ? skuOptions.map(o => o.sku) : [...selectedSkus]
    // Si ya existe un filtro con ese nombre, lo sobrescribimos en lugar de duplicar
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

  // Aplica un filtro guardado, intersectando con los SKUs que existen en el forecast actual
  function applySavedFilter(filter) {
    const valid = filter.skus.filter(s => skuOptions.some(o => o.sku === s))
    setSelectedSkus(new Set(valid))
    setActiveFilterName(filter.name)
  }

  function deleteSavedFilter(name) {
    persistSavedFilters(savedFilters.filter(f => f.name !== name))
    if (activeFilterName === name) setActiveFilterName(null)
  }

  // Click en header: misma columna -> invierte dirección; columna nueva -> empieza ascendente
  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  // Arrastrar el handle del header para redimensionar una columna
  function startResize(e, key) {
    e.preventDefault()
    e.stopPropagation() // no disparar el sort del th
    const startX = e.clientX
    const startWidth = colWidths[key] || DEFAULT_COL_WIDTHS[key] || 100

    function onMove(ev) {
      const newWidth = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX))
      setColWidths(prev => ({ ...prev, [key]: newWidth }))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none' // evita selección de texto durante el drag
  }

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      // Valores nulos siempre al final, sin importar la dirección
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

  const totalCost = useMemo(() =>
    filtered.reduce((sum, r) => sum + (r.total_landed_cost || 0), 0),
    [filtered]
  )

  // Ancho total de la tabla = suma de anchos de columna (necesario con table-layout: fixed)
  const totalWidth = COLUMNS.reduce((s, c) => s + (colWidths[c.key] || DEFAULT_COL_WIDTHS[c.key] || 100), 0)

  // Landed cost por SKU desde purchase_params, para recalcular "Total Landed" en vivo (antes de guardar)
  const landedCostBySku = useMemo(() => {
    const m = {}
    for (const p of (data?.purchaseParams || [])) m[p.sku] = p.landed_cost_usd
    return m
  }, [data])

  // Exporta las filas actualmente visibles (sorted = filtered + orden) a un .xlsx con SheetJS.
  // Respeta filtros de SKU/proveedor/"solo con orden" porque parte de `sorted`.
  function exportToExcel() {
    // Definición de columnas: header + cómo obtener el valor + formato numérico + ancho mínimo
    const cols = [
      { header: 'SKU', get: r => r.sku, w: 14 },
      { header: 'Name', get: r => r.name, w: 30 },
      { header: 'Supplier', get: r => r.supplier, w: 12 },
      { header: 'Avg Sales/Mo', get: r => r.avg_monthly_sales_total, w: 14, z: '0.00' },
      { header: 'Projected/Mo', get: r => r.projected_monthly_demand, w: 15, z: '0.00' },
      { header: 'Available', get: r => r.qty_available_real, w: 12, z: '#,##0' },
      { header: 'In Transit', get: r => r.qty_transit, w: 12, z: '#,##0' },
      { header: 'Days of Inventory', get: r => r.days_of_inventory, w: 16, z: '#,##0' },
      { header: 'Growth Factor', get: r => r.growth_factor, w: 14, z: '0.00' },
      { header: 'Lead Time (wk)', get: r => r.lead_time_weeks, w: 14, z: '0' },
      { header: 'Coverage Target', get: r => r.coverage_target_months, w: 15, z: '0.0' },
      { header: 'Months Coverage', get: r => r.months_coverage_current, w: 15, z: '0.0' },
      { header: 'Suggested Order', get: r => r.qty_suggested, w: 14, z: '#,##0' },
      { header: 'Total Landed', get: r => r.qty_suggested * (landedCostBySku[r.sku] || 0), w: 16, z: '"$"#,##0.00' },
    ]

    const headerStyle = {
      fill: { fgColor: { rgb: '1F3864' } },
      font: { color: { rgb: 'FFFFFF' }, bold: true },
      alignment: { horizontal: 'center', vertical: 'center' },
    }

    // Totales para la fila resumen
    const totalQty = sorted.reduce((s, r) => s + (r.qty_suggested || 0), 0)
    const totalLanded = sorted.reduce((s, r) => s + (r.qty_suggested * (landedCostBySku[r.sku] || 0)), 0)

    // Matriz de valores: encabezados + filas + resumen
    const aoa = [
      cols.map(c => c.header),
      ...sorted.map(r => cols.map(c => {
        const v = c.get(r)
        return v == null ? '' : v
      })),
    ]
    // Fila resumen: total SKUs, suma de Orden Sugerida y de Total Landed alineadas a sus columnas
    const summary = cols.map(() => '')
    summary[0] = 'TOTAL'
    summary[1] = `${sorted.length} SKUs`
    summary[12] = totalQty
    summary[13] = totalLanded
    aoa.push(summary)

    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const headerRow = 0
    const summaryRow = aoa.length - 1

    const summaryStyle = {
      font: { bold: true },
      fill: { fgColor: { rgb: 'E7ECF5' } },
      border: { top: { style: 'thin', color: { rgb: '1F3864' } } },
    }

    // Aplica estilos y formatos celda por celda
    for (let c = 0; c < cols.length; c++) {
      // Header
      const hAddr = XLSX.utils.encode_cell({ r: headerRow, c })
      if (ws[hAddr]) ws[hAddr].s = headerStyle

      // Filas de datos: formato numérico + alineación a la derecha en columnas numéricas
      for (let i = 0; i < sorted.length; i++) {
        const addr = XLSX.utils.encode_cell({ r: i + 1, c })
        const cell = ws[addr]
        if (!cell) continue
        if (cols[c].z && typeof cell.v === 'number') {
          cell.z = cols[c].z
          cell.s = { alignment: { horizontal: 'right' } }
        }
      }

      // Fila resumen
      const sAddr = XLSX.utils.encode_cell({ r: summaryRow, c })
      if (ws[sAddr]) {
        ws[sAddr].s = { ...summaryStyle }
        if (cols[c].z && typeof ws[sAddr].v === 'number') {
          ws[sAddr].z = cols[c].z
          ws[sAddr].s = { ...summaryStyle, alignment: { horizontal: 'right' } }
        }
      }
    }

    // Auto-ancho: tomamos el largo máximo entre header, valores y resumen por columna
    ws['!cols'] = cols.map((col, c) => {
      let maxLen = col.header.length
      for (let r = 1; r < aoa.length; r++) {
        const v = aoa[r][c]
        const len = v == null ? 0 : String(v).length
        if (len > maxLen) maxLen = len
      }
      // +2 de padding, con un piso (col.w) y techo razonable para no desbordar
      return { wch: Math.min(Math.max(maxLen + 2, col.w), 40) }
    })

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase Forecast')

    // Nombre de archivo: PM_Forecast[_Filtro]_YYYY-MM-DD.xlsx
    const today = new Date().toISOString().split('T')[0]
    const filterPart = activeFilterName
      ? '_' + activeFilterName.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      : ''
    XLSX.writeFile(wb, `PM_Forecast${filterPart}_${today}.xlsx`)
  }

  if (loading) return <div style={styles.loading}>Loading data...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>📦 Purchase Forecast</h1>
          <p style={styles.pageDesc}>
            {snapshotDate
              ? `Inventory as of ${snapshotDate} · ${data?.salesHistory?.length || 0} sales records`
              : 'No inventory data — upload a snapshot first'}
          </p>
        </div>
        <div style={styles.headerControls}>
          <div style={styles.controlGroup}>
            <label style={styles.controlLabel}>Months of history</label>
            <select value={monthsBack} onChange={e => setMonthsBack(+e.target.value)} style={styles.select}>
              {[3,4,5,6,9,12].map(m => <option key={m} value={m}>{m} months</option>)}
            </select>
          </div>
          <button style={styles.refreshBtn} onClick={() => loadData({ refresh: true })} disabled={refreshing || loading}>
            {refreshing ? '⏳ Refreshing...' : '↻ Refresh Data'}
          </button>
          <button style={styles.runBtn} onClick={handleRunForecast} disabled={running || !data}>
            {running ? '⏳ Calculating...' : '▶ Run Forecast'}
          </button>
          {results.length > 0 && (
            <button style={styles.exportBtn} onClick={exportToExcel}>
              ⬇ Export to Excel
            </button>
          )}
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {results.length > 0 && (
        <>
          {/* Summary cards */}
          <div style={styles.summaryGrid}>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.qty_suggested > 0).length}</div>
              <div style={styles.summaryLabel}>SKUs to order</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(results.reduce((s, r) => s + (r.total_landed_cost || 0), 0))}</div>
              <div style={styles.summaryLabel}>Total landed cost</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.months_coverage_current != null && r.months_coverage_current <= 2).length}</div>
              <div style={styles.summaryLabel}>Critical SKUs (≤2 months)</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.months_coverage_current == null || r.months_coverage_current === 0).length}</div>
              <div style={styles.summaryLabel}>No current coverage</div>
            </div>
          </div>

          {/* Filters */}
          <div style={styles.filters}>
            <input
              placeholder="Search SKU or name..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={styles.searchInput}
            />
            <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={styles.select}>
              {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div style={styles.skuFilter}>
              <button style={styles.skuFilterBtn} onClick={() => setSkuFilterOpen(o => !o)}>
                {activeFilterName
                  ? `Filter: ${activeFilterName} (${selectedCount} SKUs) ▾`
                  : `${selectedCount} of ${skuOptions.length} SKUs ▾`}
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
                              style={{
                                ...styles.savedChip,
                                ...(activeFilterName === f.name ? styles.savedChipActive : {}),
                              }}
                            >
                              <button
                                style={styles.savedChipLabel}
                                onClick={() => applySavedFilter(f)}
                                title={`Apply "${f.name}" (${f.skus.length} SKUs)`}
                              >
                                {f.name}
                              </button>
                              <button
                                style={styles.savedChipDelete}
                                onClick={() => deleteSavedFilter(f.name)}
                                title="Delete filter"
                              >
                                ×
                              </button>
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
                          <input
                            type="checkbox"
                            checked={isSkuSelected(o.sku)}
                            onChange={() => toggleSku(o.sku)}
                          />
                          <span style={styles.skuItemCode}>{o.sku}</span>
                          <span style={styles.skuItemName}>{o.name}</span>
                        </label>
                      ))}
                      {visibleSkuOptions.length === 0 && (
                        <div style={styles.skuEmpty}>No matches</div>
                      )}
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
                          <button
                            style={styles.saveConfirmBtn}
                            onClick={saveCurrentFilter}
                            disabled={!newFilterName.trim()}
                          >
                            Save
                          </button>
                          <button
                            style={styles.saveCancelBtn}
                            onClick={() => { setSavingFilter(false); setNewFilterName('') }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          style={styles.saveFilterBtn}
                          onClick={() => setSavingFilter(true)}
                          disabled={savedFilters.length >= MAX_SAVED_FILTERS}
                          title={savedFilters.length >= MAX_SAVED_FILTERS
                            ? `Maximum ${MAX_SAVED_FILTERS} saved filters`
                            : 'Save current selection'}
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
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={filterOnlyOrders}
                onChange={e => setFilterOnlyOrders(e.target.checked)}
              />
              &nbsp;Only with suggested order
            </label>
            {filterSupplier !== 'All' || filterOnlyOrders || search || selectedSkus !== null ? (
              <span style={styles.filterTotal}>
                {fmtCurrency(totalCost)} filtered total
              </span>
            ) : null}
          </div>

          {/* Ajuste rápido (what-if) — solo visible con resultados */}
          {results.length > 0 && (
            <div style={styles.quickBar}>
              <div style={styles.quickHint}>
                ⚡ Quick adjust — applies to all SKUs without saving to Parameters
              </div>
              <div style={styles.quickControls}>
                <label style={styles.quickField}>
                  <span style={styles.quickLabel}>Growth Factor</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0.5"
                    max="3"
                    value={quickGrowth}
                    onChange={e => setQuickGrowth(e.target.value)}
                    style={styles.quickInput}
                  />
                </label>
                <label style={styles.quickField}>
                  <span style={styles.quickLabel}>Lead Time (weeks)</span>
                  <input
                    type="number"
                    min="0"
                    value={quickLeadTime}
                    onChange={e => setQuickLeadTime(e.target.value)}
                    style={styles.quickInput}
                  />
                </label>
                <label style={styles.quickField}>
                  <span style={styles.quickLabel}>Coverage Target (months)</span>
                  <input
                    type="number"
                    min="0"
                    value={quickCoverage}
                    onChange={e => setQuickCoverage(e.target.value)}
                    style={styles.quickInput}
                  />
                </label>
                <button style={styles.quickApplyBtn} onClick={applyQuickAdjust}>
                  Apply to all and recalculate
                </button>
              </div>
            </div>
          )}

          {/* Table */}
          <div style={styles.tableWrap}>
            <table style={{ ...styles.table, width: totalWidth }}>
              <thead>
                <tr style={styles.thead}>
                  {COLUMNS.map(col => {
                    const w = colWidths[col.key] || DEFAULT_COL_WIDTHS[col.key] || 100
                    const sticky = col.key === 'sku'
                      ? { ...styles.stickyHeadSku, left: 0, width: w, minWidth: w, maxWidth: w }
                      : col.key === 'name'
                      ? { ...styles.stickyHeadName, left: colWidths.sku, width: w, minWidth: w, maxWidth: w }
                      : null
                    return (
                      <th
                        key={col.key}
                        style={{
                          ...styles.th,
                          ...(col.param ? styles.thParam : null),
                          ...(sticky || { position: 'relative' }),
                          width: w, minWidth: w, maxWidth: w,
                          overflow: 'hidden',
                          textAlign: col.align,
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                        onClick={() => handleSort(col.key)}
                        title={
                          col.key === 'qty_transit' ? 'Includes confirmed orders with status Ordered'
                          : col.key === 'order_by_days' ? 'Deadline to place the order accounting for the supplier lead time'
                          : undefined
                        }
                      >
                        {col.label}
                        {col.key === 'qty_transit' ? ' *' : ''}
                        {col.key === 'order_by_days' ? ' ⓘ' : ''}
                        {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                        <span
                          onMouseDown={e => startResize(e, col.key)}
                          onClick={e => e.stopPropagation()}
                          onMouseEnter={() => setHoverHandle(col.key)}
                          onMouseLeave={() => setHoverHandle(null)}
                          style={{
                            ...styles.resizeHandle,
                            background: hoverHandle === col.key ? 'rgba(120,150,230,0.9)' : 'rgba(255,255,255,0.18)',
                          }}
                        />
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => {
                  const rowBg = r.qty_suggested > 0 ? '#fffde7' : '#fff'
                  const days = r.days_of_inventory
                  return (
                    <tr key={r.sku} style={r.qty_suggested > 0 ? styles.trOrder : styles.tr}>
                      <td style={{ ...styles.td, ...styles.stickyColSku, left: 0, width: colWidths.sku, minWidth: colWidths.sku, maxWidth: colWidths.sku, background: rowBg, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
                      <td style={{ ...styles.td, ...styles.stickyColName, left: colWidths.sku, width: colWidths.name, minWidth: colWidths.name, maxWidth: colWidths.name, background: rowBg }}>{r.name}</td>
                      <td style={styles.td}>
                        <span style={styles.supplierBadge}>{r.supplier || '—'}</span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.avg_monthly_sales_total)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.projected_monthly_demand)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmt(r.qty_available_real)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.qty_transit)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, background: daysColor(days) }}>
                        {days != null ? days : '—'}
                      </td>
                      <td style={{ ...styles.td, ...styles.paramCell, textAlign: 'right' }}>
                        {r.growth_factor != null ? Number(r.growth_factor).toFixed(2) : '—'}
                      </td>
                      <td style={{ ...styles.td, ...styles.paramCell, textAlign: 'right' }}>{fmt(r.lead_time_weeks)}</td>
                      <td style={{ ...styles.td, ...styles.paramCell, textAlign: 'right' }}>{fmt(r.coverage_target_months)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        <span style={{ ...styles.coverageBadge, background: coverageColor(r.months_coverage_current) }}>
                          {r.months_coverage_current != null ? `${fmt(r.months_coverage_current)}m` : '—'}
                        </span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: r.qty_suggested > 0 ? 700 : 400 }}>
                        {r.qty_suggested > 0 ? r.qty_suggested : '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', color: r._orderBy.color, fontWeight: r._orderBy.bold ? 700 : 400 }}>
                        {r._orderBy.text}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {fmtCurrency(r.qty_suggested * (landedCostBySku[r.sku] || 0))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={styles.transitNote}>
            * In Transit includes confirmed orders with status Ordered (from the latest run), so it may exceed what is recorded in transit_orders.
          </div>
        </>
      )}

      {results.length === 0 && !loading && (
        <div style={styles.empty}>
          <p>Press "Run Forecast" to calculate suggested orders.</p>
          <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
            Make sure you have uploaded sales and inventory first.
          </p>
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
  headerControls: { display: 'flex', alignItems: 'center', gap: 16 },
  controlGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  controlLabel: { fontSize: 11, color: '#888', fontWeight: 600 },
  select: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff' },
  runBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  refreshBtn: { background: '#fff', color: '#4455aa', border: '1.5px solid #c5ccea', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  exportBtn: { background: '#1F3864', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 },
  summaryCard: { background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  summaryVal: { fontSize: 26, fontWeight: 700, color: '#1a1a2e' },
  summaryLabel: { fontSize: 12, color: '#888', marginTop: 2 },
  filters: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  searchInput: { padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, width: 240 },
  checkLabel: { fontSize: 13, color: '#555', display: 'flex', alignItems: 'center', cursor: 'pointer' },
  filterTotal: { fontSize: 13, fontWeight: 700, color: '#1a1a2e', marginLeft: 'auto' },
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
  quickBar: { background: '#fffbe9', border: '1.5px solid #f3e3a3', borderRadius: 10, padding: 12, marginBottom: 12 },
  quickHint: { fontSize: 12, fontWeight: 600, color: '#8a6d1a', marginBottom: 8 },
  quickControls: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 },
  quickField: { display: 'flex', flexDirection: 'column', gap: 4 },
  quickLabel: { fontSize: 11, fontWeight: 600, color: '#666' },
  quickInput: { width: 130, padding: '7px 9px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' },
  quickApplyBtn: { padding: '8px 16px', border: 'none', borderRadius: 8, background: '#1a1a2e', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  transitNote: { marginTop: 8, fontSize: 11, color: '#888', fontStyle: 'italic' },
  table: { tableLayout: 'fixed', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  // Handle de resize: franja vertical de 4px en el borde derecho del header
  resizeHandle: { position: 'absolute', top: 0, right: 0, height: '100%', width: 4, cursor: 'col-resize' },
  // Header gris para columnas de input (parámetros), distinto del header oscuro de los outputs
  thParam: { background: '#c8cdd8', color: '#2a2f3a' },
  // Celdas de parámetros con fondo levemente gris para reforzar el agrupamiento
  paramCell: { background: '#f6f7fa' },
  // Columnas fijas a la izquierda (anchos explícitos para alinear thead/tbody)
  stickyColSku: { position: 'sticky', left: 0, zIndex: 1, width: 120, minWidth: 120, maxWidth: 120, boxSizing: 'border-box' },
  stickyColName: { position: 'sticky', left: 120, zIndex: 1, width: 200, minWidth: 200, maxWidth: 200, boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  stickyHeadSku: { position: 'sticky', left: 0, zIndex: 3, background: '#1a1a2e', width: 120, minWidth: 120, maxWidth: 120, boxSizing: 'border-box' },
  stickyHeadName: { position: 'sticky', left: 120, zIndex: 3, background: '#1a1a2e', width: 200, minWidth: 200, maxWidth: 200, boxSizing: 'border-box' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  trOrder: { borderBottom: '1px solid #f0f0f0', background: '#fffde7' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  supplierBadge: { background: '#eef0ff', color: '#4455aa', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 },
  coverageBadge: { borderRadius: 4, padding: '2px 7px', fontSize: 12, fontWeight: 600 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
}
