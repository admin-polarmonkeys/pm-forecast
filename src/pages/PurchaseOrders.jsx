import { useState, useEffect, useMemo, Fragment } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

// --- Helpers para exportar a Excel ---
const XLS_HEADER_STYLE = {
  fill: { patternType: 'solid', fgColor: { rgb: '1F3864' } },
  font: { color: { rgb: 'FFFFFF' }, bold: true },
  alignment: { horizontal: 'center' },
}
const XLS_BOLD_STYLE = { font: { bold: true } }

function round2(n) {
  if (n == null || isNaN(n)) return ''
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

// Nombre de pestaña válido en Excel: sin : \ / ? * [ ] ; máx 31 chars; único
function sanitizeSheetName(name, used) {
  let n = String(name || 'Sheet').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet'
  const base = n
  let i = 2
  while (used.has(n.toLowerCase())) {
    const suffix = ` (${i++})`
    n = base.slice(0, 31 - suffix.length) + suffix
  }
  used.add(n.toLowerCase())
  return n
}

function autoColWidths(aoa) {
  const ncol = Math.max(...aoa.map(r => r.length))
  const cols = []
  for (let c = 0; c < ncol; c++) {
    let max = 10
    for (const row of aoa) {
      const v = row[c]
      if (v != null && String(v).length > max) max = String(v).length
    }
    cols.push({ wch: max + 2 })
  }
  return cols
}

function styleHeaderRow(ws, ncol) {
  for (let c = 0; c < ncol; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c })
    if (ws[ref]) ws[ref].s = XLS_HEADER_STYLE
  }
}

function styleRow(ws, r, ncol, style) {
  for (let c = 0; c < ncol; c++) {
    const ref = XLSX.utils.encode_cell({ r, c })
    if (ws[ref]) ws[ref].s = { ...(ws[ref].s || {}), ...style }
  }
}

// Aplica formato numérico a columnas dadas en todas las filas de datos (salta el header)
function formatNumberCols(ws, nrow, cols, z) {
  for (let r = 1; r < nrow; r++) {
    for (const c of cols) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.t === 'n') cell.z = z
    }
  }
}

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)
}

const NO_SUPPLIER = 'Sin proveedor'

// Pares [label, value] para el panel de detalle del cálculo
function buildDetailItems(d) {
  return [
    ['Avg Monthly Sales (total)', fmt(d.avgTotal)],
    ['— Ventas directas', fmt(d.avgDirect)],
    ['— Derivadas de kits (BOM)', fmt(d.avgDerived)],
    ['Growth Factor', d.growth != null ? `× ${fmt(d.growth)}` : '—'],
    ['Projected Monthly Demand (avg × growth)', fmt(d.projected)],
    ['Lead Time (semanas)', fmt(d.leadWeeks)],
    ['Coverage Target (meses)', fmt(d.coverage)],
    ['MOQ', fmt(d.moq)],
    ['Current Available', fmt(d.available)],
    ['In Transit', fmt(d.transit)],
    ['Months of Coverage actual', d.monthsCoverage != null ? `${fmt(d.monthsCoverage)} m` : '—'],
    ['Target Stock necesario (demanda × (cobertura + lead))', fmt(d.targetStock)],
    ['Current Stock (disponible + tránsito)', fmt(d.currentStock)],
    ['Raw Order necesaria (target − current)', fmt(d.rawOrder)],
    ['Orden Sugerida Final (redondeada a MOQ)', fmt(d.finalSuggested)],
  ]
}

// Estados posibles de una orden (value = lo que se guarda en order_status)
const STATUS_OPTIONS = [
  { value: '', label: 'Sin estado', color: 'transparent' },
  { value: 'revision', label: '🟡 En revisión', color: '#fff7c2' },
  { value: 'negociacion', label: '🟠 En negociación', color: '#ffe0c2' },
  { value: 'ordenado', label: '🟢 Ordenado', color: '#d5f5e3' },
  { value: 'bloqueado', label: '🔴 Bloqueado', color: '#ffd5d5' },
]
const statusColor = v => STATUS_OPTIONS.find(s => s.value === (v || ''))?.color || 'transparent'
const statusLabel = v => (v ? (STATUS_OPTIONS.find(s => s.value === v)?.label || '') : '')

export default function PurchaseOrders() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [noRun, setNoRun] = useState(false)
  const [runInfo, setRunInfo] = useState(null)
  const [groups, setGroups] = useState([]) // [{ supplier, rows, totalFob, totalLanded }]
  const [expanded, setExpanded] = useState(() => new Set())
  const [notesOpen, setNotesOpen] = useState(() => new Set())
  const [noteDrafts, setNoteDrafts] = useState({})
  const [savingNote, setSavingNote] = useState(null)
  const [view, setView] = useState('sugerido') // 'sugerido' | 'confirmado'
  const [confirmedDrafts, setConfirmedDrafts] = useState({})
  // selectedSuppliers === null significa "todos". Un Set = selección explícita.
  const [selectedSuppliers, setSelectedSuppliers] = useState(null)
  const [supplierFilterOpen, setSupplierFilterOpen] = useState(false)

  useEffect(() => { loadData() }, [])

  function toggleRow(sku) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }

  function toggleNotes(sku, currentNote) {
    setNotesOpen(prev => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
    // Al abrir, el borrador parte de la nota guardada
    setNoteDrafts(d => ({ ...d, [sku]: currentNote ?? '' }))
  }

  // Actualiza un campo de una fila en el estado local (sin recargar todo)
  function updateRowField(id, field, value) {
    setGroups(prev => prev.map(g => ({
      ...g,
      rows: g.rows.map(r => (r.id === id ? { ...r, [field]: value } : r)),
    })))
  }

  async function saveNote(row) {
    const text = (noteDrafts[row.sku] ?? '').trim()
    setSavingNote(row.sku)
    const { error } = await supabase
      .from('purchase_orders')
      .update({ notes: text || null })
      .eq('id', row.id)
    setSavingNote(null)
    if (error) { setError(error.message); return }
    updateRowField(row.id, 'notes', text)
    setNotesOpen(prev => { const n = new Set(prev); n.delete(row.sku); return n })
  }

  async function saveStatus(row, value) {
    updateRowField(row.id, 'orderStatus', value) // optimista
    const { error } = await supabase
      .from('purchase_orders')
      .update({ order_status: value || null })
      .eq('id', row.id)
    if (error) setError(error.message)
  }

  const isSupplierSelected = s => selectedSuppliers === null || selectedSuppliers.has(s)
  function toggleSupplier(s) {
    setSelectedSuppliers(prev => {
      const base = prev === null ? new Set(groups.map(g => g.supplier)) : new Set(prev)
      if (base.has(s)) base.delete(s)
      else base.add(s)
      return base
    })
  }
  function selectAllSuppliers() { setSelectedSuppliers(null) }
  function clearAllSuppliers() { setSelectedSuppliers(new Set()) }

  async function saveConfirmed(row, rawValue) {
    const n = parseInt(rawValue) || 0
    if (n === (row.confirmedQty || 0)) {
      setConfirmedDrafts(d => { const c = { ...d }; delete c[row.sku]; return c })
      return // sin cambios
    }
    updateRowField(row.id, 'confirmedQty', n) // optimista
    setConfirmedDrafts(d => { const c = { ...d }; delete c[row.sku]; return c })
    const { error } = await supabase
      .from('purchase_orders')
      .update({ confirmed_qty: n })
      .eq('id', row.id)
    if (error) setError(error.message)
  }

  async function loadData() {
    setLoading(true)
    setError(null)
    setNoRun(false)
    try {
      // 1. Última corrida del forecast
      const { data: runs, error: runErr } = await supabase
        .from('forecast_runs')
        .select('id, run_date, snapshot_date, months_history, created_at')
        .order('created_at', { ascending: false })
        .limit(1)
      if (runErr) throw runErr

      if (!runs || runs.length === 0) {
        setNoRun(true)
        setLoading(false)
        return
      }
      const run = runs[0]
      setRunInfo(run)

      // 2. Órdenes de esa corrida + parámetros (costos/proveedor). Unimos en JS por sku
      //    porque no hay FK directa entre purchase_orders y purchase_params.
      const [ordersRes, paramsRes, productsRes] = await Promise.all([
        supabase.from('purchase_orders').select('*').eq('run_id', run.id),
        supabase.from('purchase_params').select('sku, supplier, landed_cost_usd'),
        supabase.from('products').select('sku, name'),
      ])

      if (ordersRes.error) throw ordersRes.error
      if (paramsRes.error) throw paramsRes.error

      const paramsBySku = {}
      for (const p of paramsRes.data || []) paramsBySku[p.sku] = p
      const nameBySku = {}
      for (const p of productsRes.data || []) nameBySku[p.sku] = p.name

      // 3. Solo SKUs con qty_suggested > 0
      const rows = (ordersRes.data || [])
        .filter(o => o.qty_suggested > 0)
        .map(o => {
          const p = paramsBySku[o.sku] || {}
          const qty = o.qty_suggested
          // fob_cost_usd ahora se persiste en purchase_orders (fallback a params para corridas viejas)
          const fobCost = o.fob_cost_usd != null ? Number(o.fob_cost_usd)
            : (p.fob_cost_usd != null ? Number(p.fob_cost_usd) : null)
          const landedCost = p.landed_cost_usd != null ? Number(p.landed_cost_usd) : null

          // Todos los parámetros del cálculo vienen de la fila de purchase_orders (snapshot de la corrida)
          const leadWeeks = o.lead_time_weeks ?? null
          const coverage = o.coverage_target_months ?? null
          const leadMonths = leadWeeks != null ? leadWeeks / 4.33 : null
          const projected = o.projected_monthly_demand ?? null
          const available = o.qty_available_real ?? 0
          const transit = o.qty_transit ?? 0
          const targetStock = (projected != null && coverage != null && leadMonths != null)
            ? projected * (coverage + leadMonths) : null
          const currentStock = available + transit
          const rawOrder = targetStock != null ? Math.max(0, targetStock - currentStock) : null

          return {
            id: o.id,
            sku: o.sku,
            name: nameBySku[o.sku] || '—',
            supplier: p.supplier || o.supplier || NO_SUPPLIER,
            qty,
            fobCost,
            landedCost,
            totalFob: fobCost != null ? fobCost * qty : null,
            totalLanded: landedCost != null ? landedCost * qty : null,
            notes: o.notes || '',
            orderStatus: o.order_status || '',
            confirmedQty: o.confirmed_qty || 0,
            detail: {
              avgTotal: o.avg_monthly_sales,
              avgDirect: o.avg_monthly_sales_direct,
              avgDerived: o.avg_monthly_sales_derived,
              growth: o.growth_factor ?? null,
              projected,
              leadWeeks,
              coverage,
              moq: o.moq ?? null,
              available,
              transit,
              monthsCoverage: o.months_coverage_current,
              targetStock,
              currentStock,
              rawOrder,
              finalSuggested: o.qty_suggested,
            },
          }
        })

      // 4. Agrupar por proveedor
      const bySupplier = {}
      for (const r of rows) {
        if (!bySupplier[r.supplier]) bySupplier[r.supplier] = []
        bySupplier[r.supplier].push(r)
      }
      const grouped = Object.entries(bySupplier)
        .map(([supplier, supRows]) => ({
          supplier,
          rows: supRows.sort((a, b) => a.sku.localeCompare(b.sku)),
          totalFob: supRows.reduce((s, r) => s + (r.totalFob || 0), 0),
          totalLanded: supRows.reduce((s, r) => s + (r.totalLanded || 0), 0),
        }))
        .sort((a, b) => b.totalLanded - a.totalLanded)

      setGroups(grouped)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  function exportToExcel() {
    // Usa los grupos visibles: vista activa (sugerido/confirmado) + proveedores seleccionados
    const expGroups = viewGroups.filter(g => isSupplierSelected(g.supplier))
    if (!expGroups.length) return
    const confirmado = view === 'confirmado'
    const grandFob = expGroups.reduce((s, g) => s + g.totalFob, 0)
    const grandLanded = expGroups.reduce((s, g) => s + g.totalLanded, 0)
    const grandSkus = expGroups.reduce((s, g) => s + g.rows.length, 0)

    const wb = XLSX.utils.book_new()
    const used = new Set()
    const MONEY = '#,##0.00'

    // Hoja RESUMEN (primera pestaña)
    const resHeader = ['Supplier', '# of SKUs', 'Total FOB', 'Total Landed']
    const resData = expGroups.map(g => [g.supplier, g.rows.length, round2(g.totalFob), round2(g.totalLanded)])
    const resAoa = [resHeader, ...resData, ['TOTAL', grandSkus, round2(grandFob), round2(grandLanded)]]
    const resWs = XLSX.utils.aoa_to_sheet(resAoa)
    styleHeaderRow(resWs, resHeader.length)
    formatNumberCols(resWs, resAoa.length, [2, 3], MONEY)
    styleRow(resWs, resAoa.length - 1, resHeader.length, XLS_BOLD_STYLE) // fila TOTAL en negrita
    resWs['!cols'] = autoColWidths(resAoa)
    XLSX.utils.book_append_sheet(wb, resWs, sanitizeSheetName('RESUMEN', used))

    // Una hoja por proveedor
    for (const g of expGroups) {
      const header = ['SKU', 'Description', 'Qty Suggested', 'Confirmed Qty', 'FOB Cost', 'Total FOB', 'Landed Cost', 'Total Landed', 'Lead Time (weeks)', 'Status', 'Notes']
      const data = g.rows.map(r => [
        r.sku,
        r.name,
        r.qty,
        r.confirmedQty,
        round2(r.fobCost),
        round2(r.effTotalFob), // totales según la vista (confirmado usa confirmed_qty)
        round2(r.landedCost),
        round2(r.effTotalLanded),
        r.detail?.leadWeeks ?? '',
        statusLabel(r.orderStatus),
        r.notes || '',
      ])
      const subtotal = ['Subtotal', '', '', '', '', round2(g.totalFob), '', round2(g.totalLanded), '', '', '']
      const aoa = [header, ...data, subtotal]
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      styleHeaderRow(ws, header.length)
      formatNumberCols(ws, aoa.length, [4, 6], '0.00') // FOB Cost / Landed Cost: 2 decimales
      formatNumberCols(ws, aoa.length, [5, 7], MONEY)  // Total FOB / Total Landed
      styleRow(ws, aoa.length - 1, header.length, XLS_BOLD_STYLE) // fila Subtotal en negrita
      ws['!cols'] = autoColWidths(aoa)
      XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(g.supplier, used))
    }

    const today = new Date().toISOString().slice(0, 10)
    const prefix = confirmado ? 'PM_Confirmed_Orders' : 'PM_Purchase_Order'
    XLSX.writeFile(wb, `${prefix}_${today}.xlsx`)
  }

  // Grupos según la vista activa. En "confirmado" solo SKUs con confirmedQty>0 y
  // los totales usan confirmedQty en vez de qty_suggested.
  const viewGroups = useMemo(() => {
    return groups
      .map(g => {
        const rows = g.rows
          .filter(r => (view === 'confirmado' ? r.confirmedQty > 0 : true))
          .map(r => {
            const effQty = view === 'confirmado' ? r.confirmedQty : r.qty
            return {
              ...r,
              effQty,
              effTotalFob: r.fobCost != null ? r.fobCost * effQty : null,
              effTotalLanded: r.landedCost != null ? r.landedCost * effQty : null,
            }
          })
        return {
          supplier: g.supplier,
          rows,
          totalFob: rows.reduce((s, r) => s + (r.effTotalFob || 0), 0),
          totalLanded: rows.reduce((s, r) => s + (r.effTotalLanded || 0), 0),
        }
      })
      .filter(g => g.rows.length > 0)
  }, [groups, view])

  // Estadísticas de confirmados (sobre TODOS los grupos, independiente de la vista)
  const confirmedStats = useMemo(() => {
    let count = 0, totalLanded = 0
    for (const g of groups) for (const r of g.rows) {
      if (r.confirmedQty > 0) {
        count++
        totalLanded += (r.landedCost || 0) * r.confirmedQty
      }
    }
    return { count, totalLanded }
  }, [groups])

  if (loading) return <div style={styles.loading}>Cargando órdenes de compra...</div>

  // Filtro de proveedores: lista completa (universo) y conteo de SKUs por proveedor en la vista actual
  const allSuppliers = groups.map(g => g.supplier)
  const countsBySupplier = {}
  for (const g of viewGroups) countsBySupplier[g.supplier] = g.rows.length
  const selectedSupplierCount = selectedSuppliers === null ? allSuppliers.length : selectedSuppliers.size

  // Solo los proveedores seleccionados se muestran (y se exportan)
  const visibleGroups = viewGroups.filter(g => isSupplierSelected(g.supplier))
  const grandFob = visibleGroups.reduce((s, g) => s + g.totalFob, 0)
  const grandLanded = visibleGroups.reduce((s, g) => s + g.totalLanded, 0)

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>🛒 Purchase Orders</h1>
          <p style={styles.pageDesc}>
            {runInfo
              ? `Basado en el forecast del ${runInfo.run_date} (inventario al ${runInfo.snapshot_date})`
              : 'Órdenes de compra sugeridas, agrupadas por proveedor'}
          </p>
        </div>
        <div style={styles.headerBtns}>
          <div style={styles.toggleGroup}>
            <button
              style={{ ...styles.toggleBtn, ...(view === 'sugerido' ? styles.toggleBtnActive : {}) }}
              onClick={() => setView('sugerido')}
            >📋 Sugerido</button>
            <button
              style={{ ...styles.toggleBtn, ...(view === 'confirmado' ? styles.toggleBtnActive : {}) }}
              onClick={() => setView('confirmado')}
            >✅ Confirmado</button>
          </div>
          <button style={styles.exportBtn} onClick={exportToExcel} disabled={!visibleGroups.length}>
            ⬇️ Export to Excel
          </button>
          <button style={styles.runBtn} onClick={loadData}>↻ Re-cargar del último forecast</button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {noRun ? (
        <div style={styles.empty}>
          <p>Todavía no se ha corrido ningún forecast.</p>
          <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
            Andá a "Purchase Forecast" y presioná "Correr Forecast" primero.
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div style={styles.empty}>
          <p>El último forecast no generó órdenes sugeridas (ningún SKU con cantidad &gt; 0).</p>
        </div>
      ) : (
        <>
          {/* Filtro multi-select de proveedores */}
          <div style={styles.filterBar}>
            <div style={styles.supplierFilter}>
              <button style={styles.supplierBtn} onClick={() => setSupplierFilterOpen(o => !o)}>
                Proveedores: {selectedSupplierCount} de {allSuppliers.length} ▾
              </button>
              {supplierFilterOpen && (
                <>
                  <div style={styles.backdrop} onClick={() => setSupplierFilterOpen(false)} />
                  <div style={styles.popover}>
                    <div style={styles.popActions}>
                      <button style={styles.popActionBtn} onClick={selectAllSuppliers}>Seleccionar todos</button>
                      <button style={styles.popActionBtn} onClick={clearAllSuppliers}>Limpiar</button>
                    </div>
                    <div style={styles.popList}>
                      {allSuppliers.map(s => (
                        <label key={s} style={styles.popItem}>
                          <input type="checkbox" checked={isSupplierSelected(s)} onChange={() => toggleSupplier(s)} />
                          <span style={styles.popItemName}>{s}</span>
                          <span style={styles.popItemCount}>{countsBySupplier[s] || 0} SKUs</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Tarjetas resumen por proveedor (según la vista activa) */}
          <div style={styles.summaryGrid}>
            {visibleGroups.map(g => (
              <div key={g.supplier} style={styles.summaryCard}>
                <div style={styles.summarySupplier}>{g.supplier}</div>
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>FOB</span>
                  <span style={styles.summaryVal}>{fmtCurrency(g.totalFob)}</span>
                </div>
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>Landed</span>
                  <span style={styles.summaryValLanded}>{fmtCurrency(g.totalLanded)}</span>
                </div>
              </div>
            ))}
            <div style={{ ...styles.summaryCard, ...styles.summaryCardTotal }}>
              <div style={styles.summarySupplier}>TOTAL GENERAL {view === 'confirmado' ? '(Confirmado)' : ''}</div>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>FOB</span>
                <span style={styles.summaryVal}>{fmtCurrency(grandFob)}</span>
              </div>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Landed</span>
                <span style={styles.summaryValLanded}>{fmtCurrency(grandLanded)}</span>
              </div>
            </div>
            {/* Tarjetas de confirmados (verde) */}
            <div style={{ ...styles.summaryCard, ...styles.summaryCardConfirmed }}>
              <div style={styles.summarySupplierConfirmed}>ÓRDENES CONFIRMADAS</div>
              <div style={styles.confirmedBig}>{confirmedStats.count}</div>
              <div style={styles.summaryLabel}>SKUs confirmados</div>
            </div>
            <div style={{ ...styles.summaryCard, ...styles.summaryCardConfirmed }}>
              <div style={styles.summarySupplierConfirmed}>TOTAL COMPROMETIDO (LANDED)</div>
              <div style={styles.confirmedBig}>{fmtCurrency(confirmedStats.totalLanded)}</div>
              <div style={styles.summaryLabel}>confirmado × landed cost</div>
            </div>
          </div>

          {viewGroups.length === 0 && view === 'confirmado' && (
            <div style={styles.empty}>
              <p>No hay órdenes confirmadas todavía.</p>
              <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
                En la vista "📋 Sugerido", ingresá la cantidad confirmada por SKU.
              </p>
            </div>
          )}

          {visibleGroups.length === 0 && viewGroups.length > 0 && (
            <div style={styles.empty}>
              <p>Ningún proveedor seleccionado.</p>
              <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
                Elegí al menos un proveedor en el filtro de arriba.
              </p>
            </div>
          )}

          {/* Una sección por proveedor */}
          {visibleGroups.map(g => (
            <div key={g.supplier} style={styles.section}>
              <h2 style={styles.sectionTitle}>{g.supplier}</h2>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr style={styles.thead}>
                      <th style={styles.th}>SKU</th>
                      <th style={styles.th}>Nombre</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Qty Sugerida</th>
                      <th style={{ ...styles.th, textAlign: 'center' }}>Confirmed Qty</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>FOB Cost</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Total FOB</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Landed Cost</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Total Landed</th>
                      <th style={{ ...styles.th, textAlign: 'center' }}>Estado</th>
                      <th style={{ ...styles.th, textAlign: 'center' }}>Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map(r => {
                      const isOpen = expanded.has(r.sku)
                      return (
                        <Fragment key={r.sku}>
                          <tr style={{ ...styles.tr, cursor: 'pointer' }} onClick={() => toggleRow(r.sku)}>
                            <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>
                              <span style={{ ...styles.caret, transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
                              {r.sku}
                            </td>
                            <td style={styles.td}>{r.name}</td>
                            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{r.qty}</td>
                            <td style={{ ...styles.td, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                              <input
                                type="number"
                                min={0}
                                value={confirmedDrafts[r.sku] !== undefined ? confirmedDrafts[r.sku] : (r.confirmedQty || '')}
                                placeholder="0"
                                onChange={e => setConfirmedDrafts(d => ({ ...d, [r.sku]: e.target.value }))}
                                onBlur={e => saveConfirmed(r, e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                                style={styles.confirmedInput}
                              />
                              {r.confirmedQty > 0 && (r.confirmedQty === r.qty
                                ? <span style={styles.okBadge}>✅</span>
                                : <span style={styles.diffBadge}>≠</span>)}
                            </td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(r.fobCost)}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(r.effTotalFob)}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(r.landedCost)}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(r.effTotalLanded)}</td>
                            <td style={{ ...styles.td, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                              <select
                                value={r.orderStatus || ''}
                                onChange={e => saveStatus(r, e.target.value)}
                                style={{ ...styles.statusSelect, background: statusColor(r.orderStatus) }}
                              >
                                {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                              </select>
                            </td>
                            <td style={{ ...styles.td, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                              <button
                                style={styles.noteBtn}
                                onClick={() => toggleNotes(r.sku, r.notes)}
                                title={r.notes || 'Agregar nota'}
                              >
                                📝
                                {r.notes ? <span style={styles.noteDot} /> : null}
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr style={styles.detailRow}>
                              <td colSpan={10} style={styles.detailCell}>
                                <div style={styles.detailGrid}>
                                  {buildDetailItems(r.detail).map(([label, value]) => (
                                    <div key={label} style={styles.detailItem}>
                                      <span style={styles.detailLabel}>{label}</span>
                                      <span style={styles.detailValue}>{value}</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                          {notesOpen.has(r.sku) && (
                            <tr style={styles.notesRow}>
                              <td colSpan={10} style={styles.notesCell} onClick={e => e.stopPropagation()}>
                                <div style={styles.notesPanel}>
                                  <input
                                    type="text"
                                    value={noteDrafts[r.sku] ?? ''}
                                    placeholder="Agregar nota..."
                                    onChange={e => setNoteDrafts(d => ({ ...d, [r.sku]: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter') saveNote(r) }}
                                    style={styles.notesInput}
                                    autoFocus
                                  />
                                  <button
                                    style={styles.notesSaveBtn}
                                    onClick={() => saveNote(r)}
                                    disabled={savingNote === r.sku}
                                  >
                                    {savingNote === r.sku ? '...' : '💾'}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                    <tr style={styles.subtotalRow}>
                      <td style={{ ...styles.td, fontWeight: 700 }} colSpan={5}>Subtotal {g.supplier}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmtCurrency(g.totalFob)}</td>
                      <td style={styles.td}></td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmtCurrency(g.totalLanded)}</td>
                      <td style={styles.td}></td>
                      <td style={styles.td}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
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
  runBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  exportBtn: { background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, marginBottom: 28 },
  summaryCard: { background: '#fff', borderRadius: 10, padding: '14px 18px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  summaryCardTotal: { background: '#fff', border: '2px solid #d6dae8' },
  summarySupplier: { fontSize: 13, fontWeight: 700, color: '#4455aa', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  summaryRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  summaryLabel: { fontSize: 12, color: '#888' },
  summaryVal: { fontSize: 16, fontWeight: 700, color: '#1a1a2e' },
  summaryValLanded: { fontSize: 18, fontWeight: 700, color: '#1a7a4a' },
  section: { marginBottom: 28 },
  sectionTitle: { fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 12 },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  table: { width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle' },
  subtotalRow: { background: '#f5f6fa', borderTop: '2px solid #e0e4ff' },
  statusSelect: { border: '1px solid #d8d8e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  noteBtn: { position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2 },
  noteDot: { position: 'absolute', top: 0, right: -2, width: 8, height: 8, borderRadius: '50%', background: '#f1c40f', border: '1px solid #fff' },
  notesRow: { background: '#fffdf2' },
  notesCell: { padding: '10px 16px', borderBottom: '1px solid #f0ecd0' },
  notesPanel: { display: 'flex', gap: 8, alignItems: 'center', maxWidth: 560 },
  notesInput: { flex: 1, padding: '8px 12px', border: '1.5px solid #e0d6a8', borderRadius: 6, fontSize: 13, background: '#fff' },
  notesSaveBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 14, cursor: 'pointer' },
  toggleGroup: { display: 'flex', border: '1.5px solid #d8d8e0', borderRadius: 8, overflow: 'hidden' },
  toggleBtn: { background: '#fff', color: '#555', border: 'none', padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  toggleBtnActive: { background: '#1a1a2e', color: '#fff' },
  confirmedInput: { width: 64, padding: '5px 8px', border: '1.5px solid #cdd6e0', borderRadius: 6, fontSize: 13, textAlign: 'center' },
  okBadge: { marginLeft: 6, color: '#1a7a4a', fontSize: 13 },
  diffBadge: { marginLeft: 6, color: '#e67e22', fontWeight: 700, fontSize: 14 },
  summaryCardConfirmed: { background: '#e8f8ef', border: '1.5px solid #b6e6cb' },
  summarySupplierConfirmed: { fontSize: 13, fontWeight: 700, color: '#1a7a4a', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  confirmedBig: { fontSize: 24, fontWeight: 700, color: '#1a7a4a' },
  filterBar: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  supplierFilter: { position: 'relative' },
  supplierBtn: { padding: '9px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff', cursor: 'pointer', fontWeight: 600, color: '#333', whiteSpace: 'nowrap' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 10 },
  popover: { position: 'absolute', top: '100%', left: 0, marginTop: 6, background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 10, width: 280, zIndex: 20 },
  popActions: { display: 'flex', gap: 8, marginBottom: 8 },
  popActionBtn: { flex: 1, padding: '6px 8px', border: '1px solid #e0e0e0', borderRadius: 6, background: '#f7f7f9', fontSize: 12, fontWeight: 600, color: '#4455aa', cursor: 'pointer' },
  popList: { maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 },
  popItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px', borderRadius: 4, fontSize: 13, cursor: 'pointer' },
  popItemName: { color: '#333', flex: 1 },
  popItemCount: { color: '#999', fontSize: 11 },
  caret: { display: 'inline-block', marginRight: 8, fontSize: 9, color: '#888', transition: 'transform 0.15s' },
  detailRow: { background: '#f7f7f9' },
  detailCell: { padding: '16px 20px', borderBottom: '1px solid #e6e6e6' },
  detailGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 36px', maxWidth: 760 },
  detailItem: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', borderBottom: '1px dotted #dcdce2' },
  detailLabel: { fontSize: 12, color: '#666' },
  detailValue: { fontSize: 12, fontWeight: 700, color: '#1a1a2e', whiteSpace: 'nowrap' },
}
