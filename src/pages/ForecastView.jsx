import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { runForecast } from '../lib/forecast'

const SUPPLIERS = ['Todos', 'SV', 'HAW', 'GUGU', 'HIM', 'TAR', 'DAR', 'WAT', 'WES', 'NING', 'UP', 'ALI', 'SIR', 'SC']

// Definición de columnas: key = campo del registro, align = alineación.
// param: true -> columna de input (header gris) para distinguir de los outputs (header oscuro)
const COLUMNS = [
  { key: 'sku', label: 'SKU', align: 'left' },
  { key: 'name', label: 'Nombre', align: 'left' },
  { key: 'supplier', label: 'Proveedor', align: 'left' },
  { key: 'avg_monthly_sales_total', label: 'Avg Sales/Mes', align: 'right' },
  { key: 'projected_monthly_demand', label: 'Proyectado/Mes', align: 'right' },
  { key: 'qty_available_real', label: 'Disponible', align: 'right' },
  { key: 'qty_transit', label: 'Tránsito', align: 'right' },
  { key: 'days_of_inventory', label: 'Days of Inventory', align: 'right' },
  { key: 'growth_factor', label: 'Growth Factor', align: 'right', param: true },
  { key: 'lead_time_weeks', label: 'Lead Time (sem)', align: 'right', param: true },
  { key: 'coverage_target_months', label: 'Coverage Target', align: 'right', param: true },
  { key: 'months_coverage_current', label: 'Months Coverage', align: 'right' },
  { key: 'qty_suggested', label: 'Orden Sugerida', align: 'right' },
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

export default function ForecastView() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [results, setResults] = useState([])
  const [monthsBack, setMonthsBack] = useState(6)
  const [filterSupplier, setFilterSupplier] = useState('Todos')
  const [filterOnlyOrders, setFilterOnlyOrders] = useState(false)
  const [search, setSearch] = useState('')
  const [snapshotDate, setSnapshotDate] = useState(null)
  const [sortKey, setSortKey] = useState('qty_suggested')
  const [sortDir, setSortDir] = useState('desc')
  // selectedSkus === null significa "todos seleccionados" (sin filtro). Un Set significa selección explícita.
  const [selectedSkus, setSelectedSkus] = useState(null)
  const [skuFilterOpen, setSkuFilterOpen] = useState(false)
  const [skuSearch, setSkuSearch] = useState('')
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS)
  const [hoverHandle, setHoverHandle] = useState(null)

  useEffect(() => { loadData() }, [])

  // Al correr un forecast nuevo, volvemos a "todos seleccionados"
  useEffect(() => { setSelectedSkus(null) }, [results])

  async function loadData() {
    setLoading(true)
    try {
      const [products, bom, sales, inventory, params, transit] = await Promise.all([
        supabase.from('products').select('*'),
        supabase.from('bom').select('*'),
        supabase.from('sales_history').select('*'),
        supabase.from('inventory_snapshots').select('*').order('snapshot_date', { ascending: false }),
        supabase.from('purchase_params').select('*'),
        supabase.from('transit_orders').select('sku, qty'),
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

      setData({
        products: products.data || [],
        bomRows: bom.data || [],
        salesHistory: sales.data || [],
        inventorySnapshot: latestInventory,
        purchaseParams: params.data || [],
        transitOrders: transit.data || [],
      })
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
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

  // Agrega el campo calculado days_of_inventory para mostrarlo y poder ordenar por él
  const enriched = useMemo(
    () => results.map(r => ({ ...r, days_of_inventory: daysOfInventory(r) })),
    [results]
  )

  const filtered = useMemo(() => {
    return enriched.filter(r => {
      if (selectedSkus !== null && !selectedSkus.has(r.sku)) return false
      if (filterSupplier !== 'Todos' && r.supplier !== filterSupplier) return false
      if (filterOnlyOrders && r.qty_suggested === 0) return false
      if (search && !r.sku.toLowerCase().includes(search.toLowerCase()) &&
          !r.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [enriched, selectedSkus, filterSupplier, filterOnlyOrders, search])

  // Lista de SKUs (con nombre) para el filtro multi-select
  const skuOptions = useMemo(
    () => results.map(r => ({ sku: r.sku, name: r.name })),
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
    setSelectedSkus(prev => {
      const next = prev === null ? new Set(skuOptions.map(o => o.sku)) : new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }
  function selectAllSkus() { setSelectedSkus(null) }
  function clearAllSkus() { setSelectedSkus(new Set()) }

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

  if (loading) return <div style={styles.loading}>Cargando datos...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>📦 Purchase Forecast</h1>
          <p style={styles.pageDesc}>
            {snapshotDate
              ? `Inventario al ${snapshotDate} · ${data?.salesHistory?.length || 0} registros de ventas`
              : 'Sin datos de inventario — sube un snapshot primero'}
          </p>
        </div>
        <div style={styles.headerControls}>
          <div style={styles.controlGroup}>
            <label style={styles.controlLabel}>Meses de historial</label>
            <select value={monthsBack} onChange={e => setMonthsBack(+e.target.value)} style={styles.select}>
              {[3,4,5,6,9,12].map(m => <option key={m} value={m}>{m} meses</option>)}
            </select>
          </div>
          <button style={styles.runBtn} onClick={handleRunForecast} disabled={running || !data}>
            {running ? '⏳ Calculando...' : '▶ Correr Forecast'}
          </button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {results.length > 0 && (
        <>
          {/* Summary cards */}
          <div style={styles.summaryGrid}>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.qty_suggested > 0).length}</div>
              <div style={styles.summaryLabel}>SKUs a ordenar</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(results.reduce((s, r) => s + (r.total_landed_cost || 0), 0))}</div>
              <div style={styles.summaryLabel}>Total landed cost</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.months_coverage_current != null && r.months_coverage_current <= 2).length}</div>
              <div style={styles.summaryLabel}>SKUs críticos (≤2 meses)</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.months_coverage_current == null || r.months_coverage_current === 0).length}</div>
              <div style={styles.summaryLabel}>Sin cobertura actual</div>
            </div>
          </div>

          {/* Filters */}
          <div style={styles.filters}>
            <input
              placeholder="Buscar SKU o nombre..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={styles.searchInput}
            />
            <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={styles.select}>
              {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div style={styles.skuFilter}>
              <button style={styles.skuFilterBtn} onClick={() => setSkuFilterOpen(o => !o)}>
                {selectedCount} de {skuOptions.length} SKUs ▾
              </button>
              {skuFilterOpen && (
                <>
                  <div style={styles.skuBackdrop} onClick={() => setSkuFilterOpen(false)} />
                  <div style={styles.skuPopover}>
                    <input
                      placeholder="Buscar SKU o nombre..."
                      value={skuSearch}
                      onChange={e => setSkuSearch(e.target.value)}
                      style={styles.skuSearchInput}
                      autoFocus
                    />
                    <div style={styles.skuActions}>
                      <button style={styles.skuActionBtn} onClick={selectAllSkus}>Seleccionar todo</button>
                      <button style={styles.skuActionBtn} onClick={clearAllSkus}>Limpiar todo</button>
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
                        <div style={styles.skuEmpty}>Sin coincidencias</div>
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
              &nbsp;Solo con orden sugerida
            </label>
            {filterSupplier !== 'Todos' || filterOnlyOrders || search || selectedSkus !== null ? (
              <span style={styles.filterTotal}>
                {fmtCurrency(totalCost)} total filtrado
              </span>
            ) : null}
          </div>

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
                      >
                        {col.label}
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
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.qty_available_real)}</td>
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
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {fmtCurrency(r.qty_suggested * (landedCostBySku[r.sku] || 0))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {results.length === 0 && !loading && (
        <div style={styles.empty}>
          <p>Presiona "Correr Forecast" para calcular las órdenes sugeridas.</p>
          <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
            Asegúrate de haber subido ventas e inventario primero.
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
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
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
