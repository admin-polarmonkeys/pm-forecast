import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import { useColumnWidths, ResizableTh, ResetWidthsButton } from '../lib/useColumnWidths'

function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)
}
function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
// Etiqueta del recorte en la UI. null = el run es anterior a la columna trim_extremes.
function trimLabel(v) {
  if (v == null) return 'sin registro'
  return Number(v) === 1 ? 'sí' : 'no'
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

// Una tabla por vista: detalle de un run, lista de runs y comparación de dos runs.
// Cada una guarda sus anchos por separado.
const DETAIL_COL_WIDTHS = {
  sku: 130, name: 220, supplier: 100, avg_sales: 110, projected: 110, available: 105,
  transit: 100, coverage: 105, suggested: 125, landed_cost: 115, total_landed: 125,
}
const RUNS_COL_WIDTHS = {
  compare: 80, run_date: 110, snapshot: 110, months: 100, trim: 90,
  sku_count: 120, total_landed: 125, notes: 220, actions: 150,
}
const COMPARE_COL_WIDTHS = {
  sku: 130, name: 200, avg_a: 130, avg_b: 130, diff_pct: 100,
  qty_a: 100, qty_b: 100, diff_qty: 100,
}

export default function ForecastHistory() {
  const detailCols = useColumnWidths('fh_detail', DETAIL_COL_WIDTHS)
  const runsCols = useColumnWidths('fh_runs', RUNS_COL_WIDTHS)
  const compareCols = useColumnWidths('fh_compare', COMPARE_COL_WIDTHS)
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
        fetchAll('forecast_runs', '*', { orderBy: [['created_at', { ascending: false }]] }),
        fetchAll('purchase_orders', '*'),
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
              {' '}{selectedRun.months_history} months of history · recorte: {trimLabel(selectedRun.trim_extremes)}
              {selectedRun.notes ? ` · ${selectedRun.notes}` : ''}
            </p>
          </div>
          <div style={styles.headerBtns}>
            <ResetWidthsButton resize={detailCols} />
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
          <table style={{ ...styles.table, minWidth: detailCols.totalWidth, width: '100%' }}>
            <thead>
              <tr style={styles.thead}>
                <ResizableTh colKey="sku" resize={detailCols} style={styles.th}>SKU</ResizableTh>
                <ResizableTh colKey="name" resize={detailCols} style={styles.th}>Name</ResizableTh>
                <ResizableTh colKey="supplier" resize={detailCols} style={styles.th}>Supplier</ResizableTh>
                <ResizableTh colKey="avg_sales" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>Avg Sales</ResizableTh>
                <ResizableTh colKey="projected" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>Projected</ResizableTh>
                <ResizableTh colKey="available" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>Available</ResizableTh>
                <ResizableTh colKey="transit" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>In Transit</ResizableTh>
                <ResizableTh colKey="coverage" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>Coverage</ResizableTh>
                <ResizableTh colKey="suggested" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>Suggested Qty</ResizableTh>
                <ResizableTh colKey="landed_cost" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>Landed Cost</ResizableTh>
                <ResizableTh colKey="total_landed" resize={detailCols} style={{ ...styles.th, textAlign: 'right' }}>Total Landed</ResizableTh>
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
    // Run 1 = el más viejo, Run 2 = el más nuevo. Las diferencias se leen como "nuevo - viejo".
    const [idA, idB] = [...compare].sort((a, b) => {
      const ra = runs.find(r => r.id === a), rb = runs.find(r => r.id === b)
      return (ra?.run_date || '').localeCompare(rb?.run_date || '')
    })
    const runA = runs.find(r => r.id === idA)
    const runB = runs.find(r => r.id === idB)

    // Guardamos la FILA COMPLETA, no solo qty_suggested: necesitamos avg_monthly_sales.
    const byA = {}, byB = {}
    for (const o of ordersByRun[idA] || []) byA[o.sku] = o
    for (const o of ordersByRun[idB] || []) byB[o.sku] = o

    const skus = [...new Set([...Object.keys(byA), ...Object.keys(byB)])]
    const rows = skus.map(sku => {
      const oa = byA[sku], ob = byB[sku]
      // inA/inB = si el SKU tiene fila guardada en ese run. purchase_orders solo
      // guarda SKUs con qty_suggested > 0, así que una fila ausente NO es un cero:
      // es "no sabemos", y se excluye del cálculo de diferencia porcentual.
      const avgA = oa && oa.avg_monthly_sales != null ? Number(oa.avg_monthly_sales) : null
      const avgB = ob && ob.avg_monthly_sales != null ? Number(ob.avg_monthly_sales) : null
      const comparable = avgA != null && avgB != null
      return {
        sku,
        name: nameBySku[sku] || '—',
        inA: !!oa,
        inB: !!ob,
        avgA,
        avgB,
        diffAvg: comparable ? avgB - avgA : null,
        // Sin base anterior (o con base 0) el porcentaje no significa nada
        diffPct: comparable && avgA !== 0 ? ((avgB - avgA) / avgA) * 100 : null,
        qtyA: oa ? (oa.qty_suggested ?? 0) : null,
        qtyB: ob ? (ob.qty_suggested ?? 0) : null,
        // Orden por demanda: el mayor de los dos promedios, así un SKU que aparece
        // en un solo run no queda enterrado al fondo de la tabla.
        sortKey: Math.max(avgA ?? -1, avgB ?? -1),
      }
    })
    rows.sort((a, b) => b.sortKey - a.sortKey)

    const totalA = (ordersByRun[idA] || []).reduce((s, o) => s + (o.total_landed_cost || 0), 0)
    const totalB = (ordersByRun[idB] || []).reduce((s, o) => s + (o.total_landed_cost || 0), 0)

    // Ventana usada por cada run. avg_sales_months es la columna nueva (null en runs
    // anteriores al cambio), así que caemos a months_history.
    const windowA = runA?.avg_sales_months ?? runA?.months_history ?? null
    const windowB = runB?.avg_sales_months ?? runB?.months_history ?? null
    // trim_extremes es null en runs anteriores al cambio: ahí no sabemos qué se usó
    const trimA = runA?.trim_extremes ?? null
    const trimB = runB?.trim_extremes ?? null

    comparison = {
      runA, runB, rows, totalA, totalB, diffTotal: totalB - totalA,
      windowA, windowB,
      trimA, trimB,
      sameWindow: windowA != null && windowA === windowB,
      // Solo se declara "difieren" cuando los dos valores son conocidos
      trimDiffers: trimA != null && trimB != null && trimA !== trimB,
      trimUnknown: trimA == null || trimB == null,
      // Conteo de SKUs guardados por run = SKUs que tuvieron orden sugerida.
      // Si Run 2 tiene muchos menos, el cálculo nuevo los llevó a qty_suggested = 0.
      countA: Object.keys(byA).length,
      countB: Object.keys(byB).length,
      onlyA: rows.filter(r => r.inA && !r.inB).length,
      onlyB: rows.filter(r => !r.inA && r.inB).length,
      comparableCount: rows.filter(r => r.avgA != null && r.avgB != null).length,
    }
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
        <ResetWidthsButton resize={runsCols} label="↔ Reset widths (runs list)" />
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
          <table style={{ ...styles.table, minWidth: runsCols.totalWidth, width: '100%' }}>
            <thead>
              <tr style={styles.thead}>
                <ResizableTh colKey="compare" resize={runsCols} style={{ ...styles.th, textAlign: 'center' }}>Compare</ResizableTh>
                <ResizableTh colKey="run_date" resize={runsCols} style={styles.th}>Run Date</ResizableTh>
                <ResizableTh colKey="snapshot" resize={runsCols} style={styles.th}>Snapshot</ResizableTh>
                <ResizableTh colKey="months" resize={runsCols} style={{ ...styles.th, textAlign: 'center' }}>Months Hist.</ResizableTh>
                <ResizableTh colKey="trim" resize={runsCols} style={{ ...styles.th, textAlign: 'center' }} title="Recorte de extremos usado en la corrida">Trim</ResizableTh>
                <ResizableTh colKey="sku_count" resize={runsCols} style={{ ...styles.th, textAlign: 'right' }}># SKUs w/ order</ResizableTh>
                <ResizableTh colKey="total_landed" resize={runsCols} style={{ ...styles.th, textAlign: 'right' }}>Total Landed</ResizableTh>
                <ResizableTh colKey="notes" resize={runsCols} style={styles.th}>Notes</ResizableTh>
                <ResizableTh colKey="actions" resize={runsCols} style={{ ...styles.th, textAlign: 'right' }}>Actions</ResizableTh>
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
                    <td style={{ ...styles.td, textAlign: 'center', color: run.trim_extremes == null ? '#bbb' : undefined }}>
                      {trimLabel(run.trim_extremes)}
                    </td>
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

          {/* Config de cada run. Si cambian dos cosas a la vez, la diferencia no aísla nada. */}
          <div style={comparison.sameWindow ? styles.windowBar : styles.windowBarWarn}>
            <div>
              <strong>Ventana del promedio</strong> — Run 1: {comparison.windowA ?? '—'} meses
              {' · '}Run 2: {comparison.windowB ?? '—'} meses
            </div>
            <div style={{ marginTop: 4 }}>
              <strong>Recorte de extremos</strong> — Run 1: {trimLabel(comparison.trimA)}
              {' · '}Run 2: {trimLabel(comparison.trimB)}
            </div>
            {!comparison.sameWindow && (
              <div style={styles.windowWarnText}>
                ⚠️ Las ventanas son distintas, así que los dos runs no son directamente comparables:
                la diferencia que ves mezcla el cambio de ventana con el cambio de cálculo.
                Para aislar uno solo, corré el forecast con la misma ventana que usó el otro run.
              </div>
            )}
            {comparison.sameWindow && comparison.trimDiffers && (
              <div style={styles.windowIsolatedText}>
                ✓ Misma ventana y distinto recorte: la diferencia que ves abajo es el efecto
                del recorte de extremos, aislado.
              </div>
            )}
            {comparison.sameWindow && !comparison.trimDiffers && !comparison.trimUnknown && (
              <div style={styles.windowIsolatedText}>
                Los dos runs usaron la misma ventana y el mismo recorte: la diferencia sale de
                los datos (ventas, inventario, BOM o parámetros por SKU), no de la configuración.
              </div>
            )}
            {comparison.trimUnknown && (
              <div style={styles.windowWarnText}>
                Alguno de los runs no tiene registrado el recorte (es anterior a esa columna),
                así que no se puede confirmar si difieren en ese punto.
              </div>
            )}
          </div>

          {/* Conteo de SKUs guardados: la señal de cuántos cayeron a qty_suggested = 0 */}
          <div style={styles.countBar}>
            <div style={styles.countItem}>
              <span style={styles.countVal}>{comparison.countA}</span>
              <span style={styles.countLabel}>SKUs en Run 1</span>
            </div>
            <div style={styles.countArrow}>→</div>
            <div style={styles.countItem}>
              <span style={{
                ...styles.countVal,
                color: comparison.countB < comparison.countA ? '#c0392b'
                     : comparison.countB > comparison.countA ? '#1a7a4a' : '#1a1a2e',
              }}>
                {comparison.countB}
              </span>
              <span style={styles.countLabel}>SKUs en Run 2</span>
            </div>
            <div style={styles.countNote}>
              <div>
                {comparison.onlyA > 0 && (
                  <><strong>{comparison.onlyA}</strong> SKU{comparison.onlyA === 1 ? '' : 's'} estaba{comparison.onlyA === 1 ? '' : 'n'} en Run 1 y no en Run 2 → su orden sugerida cayó a 0. </>
                )}
                {comparison.onlyB > 0 && (
                  <><strong>{comparison.onlyB}</strong> apareció{comparison.onlyB === 1 ? '' : 'n'} solo en Run 2. </>
                )}
                {comparison.onlyA === 0 && comparison.onlyB === 0 && 'Los dos runs tienen los mismos SKUs. '}
              </div>
              <div style={{ marginTop: 4, color: '#888' }}>
                purchase_orders solo guarda SKUs con orden sugerida &gt; 0, así que un SKU ausente
                no tiene promedio registrado en ese run. {comparison.comparableCount} de{' '}
                {comparison.rows.length} SKUs tienen promedio en ambos y entran en el cálculo de Dif %.
              </div>
            </div>
          </div>

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
            <table style={{ ...styles.table, minWidth: compareCols.totalWidth, width: '100%' }}>
              <thead>
                <tr style={styles.thead}>
                  <ResizableTh colKey="sku" resize={compareCols} style={styles.th}>SKU</ResizableTh>
                  <ResizableTh colKey="name" resize={compareCols} style={styles.th}>Name</ResizableTh>
                  <ResizableTh colKey="avg_a" resize={compareCols} style={{ ...styles.th, textAlign: 'right' }}>Avg Sales Run 1</ResizableTh>
                  <ResizableTh colKey="avg_b" resize={compareCols} style={{ ...styles.th, textAlign: 'right' }}>Avg Sales Run 2</ResizableTh>
                  <ResizableTh colKey="diff_pct" resize={compareCols} style={{ ...styles.th, textAlign: 'right' }}>Dif %</ResizableTh>
                  <ResizableTh colKey="qty_a" resize={compareCols} style={{ ...styles.th, textAlign: 'right' }}>Qty Run 1</ResizableTh>
                  <ResizableTh colKey="qty_b" resize={compareCols} style={{ ...styles.th, textAlign: 'right' }}>Qty Run 2</ResizableTh>
                  <ResizableTh colKey="diff_qty" resize={compareCols} style={{ ...styles.th, textAlign: 'right' }}>Dif Qty</ResizableTh>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map(r => {
                  // Fila incompleta = el SKU falta en alguno de los dos runs.
                  // Se marca en gris y su Dif % queda fuera del cálculo.
                  const partial = !r.inA || !r.inB
                  const diffQty = r.qtyA != null && r.qtyB != null ? r.qtyB - r.qtyA : null
                  return (
                    <tr key={r.sku} style={partial ? styles.trPartial : styles.tr}>
                      <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
                      <td style={styles.td}>{r.name}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {r.inA
                          ? (r.avgA != null ? fmt(r.avgA) : '—')
                          : <span style={styles.notSaved} title="Sin orden sugerida en este run, así que no quedó guardado su promedio">no guardado</span>}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {r.inB
                          ? (r.avgB != null ? fmt(r.avgB) : '—')
                          : <span style={styles.notSaved} title="Sin orden sugerida en este run, así que no quedó guardado su promedio">no guardado</span>}
                      </td>
                      <td style={{
                        ...styles.td, textAlign: 'right', fontWeight: 700,
                        color: r.diffPct == null ? '#bbb'
                             : r.diffPct > 0.05 ? '#1a7a4a'
                             : r.diffPct < -0.05 ? '#c0392b' : '#999',
                      }}>
                        {r.diffPct == null
                          ? <span style={styles.notComparable} title="No se puede calcular: falta el promedio en alguno de los dos runs, o la base era 0">n/a</span>
                          : `${r.diffPct > 0 ? '+' : ''}${r.diffPct.toFixed(1)}%`}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', color: r.qtyA == null ? '#bbb' : undefined }}>
                        {r.qtyA ?? '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', color: r.qtyB == null ? '#bbb' : undefined }}>
                        {r.qtyB ?? '—'}
                      </td>
                      <td style={{
                        ...styles.td, textAlign: 'right', fontWeight: 700,
                        color: diffQty == null ? '#bbb' : diffQty > 0 ? '#c0392b' : diffQty < 0 ? '#1a7a4a' : '#999',
                      }}>
                        {diffQty == null ? 'n/a' : `${diffQty > 0 ? '+' : ''}${diffQty}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={styles.compareFootnote}>
            Ordenado por promedio de ventas descendente (el mayor de los dos runs, para que un SKU
            presente en uno solo no quede al final). "No guardado" significa que ese SKU no tuvo orden
            sugerida en ese run: purchase_orders no guarda su fila, así que no hay promedio registrado —
            no es un cero. Esas filas se muestran en gris y su Dif % queda en n/a.
          </div>
          <ResetWidthsButton resize={compareCols} label="↔ Reset widths (comparison)" />
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
  table: { tableLayout: 'fixed', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
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
  windowBar: { background: '#eef0ff', color: '#3a4a8a', borderRadius: 10, padding: '11px 16px', fontSize: 13, marginBottom: 12 },
  windowBarWarn: { background: '#fff4e5', border: '1.5px solid #ffd9a0', color: '#8a5200', borderRadius: 10, padding: '11px 16px', fontSize: 13, marginBottom: 12 },
  windowWarnText: { marginTop: 6, fontSize: 12, lineHeight: 1.5 },
  windowIsolatedText: { marginTop: 6, fontSize: 12, lineHeight: 1.5, color: '#1a7a4a', fontWeight: 600 },
  countBar: { display: 'flex', alignItems: 'center', gap: 16, background: '#fff', borderRadius: 10, padding: '14px 18px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', marginBottom: 20, flexWrap: 'wrap' },
  countItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 90 },
  countVal: { fontSize: 24, fontWeight: 700, color: '#1a1a2e', lineHeight: 1.1 },
  countLabel: { fontSize: 11, color: '#888', marginTop: 2, whiteSpace: 'nowrap' },
  countArrow: { fontSize: 18, color: '#bbb' },
  countNote: { fontSize: 12, color: '#555', lineHeight: 1.5, flex: 1, minWidth: 260, borderLeft: '1px solid #eee', paddingLeft: 16 },
  // Fila con el SKU ausente en alguno de los dos runs
  trPartial: { borderBottom: '1px solid #f0f0f0', background: '#fafafa' },
  notSaved: { color: '#aaa', fontStyle: 'italic', fontSize: 11 },
  notComparable: { color: '#bbb', fontWeight: 400 },
  compareFootnote: { fontSize: 11, color: '#888', fontStyle: 'italic', lineHeight: 1.6, marginTop: -12, marginBottom: 24 },
}
