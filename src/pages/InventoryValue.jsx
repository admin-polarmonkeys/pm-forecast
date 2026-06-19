import { useState, useEffect, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

// Columnas de la tabla (mismas que se exportan a Excel)
const COLUMNS = [
  { key: 'sku', label: 'SKU', align: 'left' },
  { key: 'name', label: 'Name', align: 'left' },
  { key: 'supplier', label: 'Supplier', align: 'left' },
  { key: 'qty_available_real', label: 'Available', align: 'right' },
  { key: 'landed_cost_usd', label: 'Landed Cost', align: 'right' },
  { key: 'total_landed', label: 'Total Landed Cost', align: 'right' },
]

function fmt(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}

function fmtCurrency(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
}

// Color del Total Landed Cost: verde > $10k, amarillo $1k–$10k, normal < $1k
function valueColor(v) {
  if (v > 10000) return '#d5f5e3'
  if (v >= 1000) return '#fff9d5'
  return undefined
}

export default function InventoryValue() {
  const [rows, setRows] = useState([])
  const [snapshotDate, setSnapshotDate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [filterSupplier, setFilterSupplier] = useState('All')
  const [sortKey, setSortKey] = useState('total_landed')
  const [sortDir, setSortDir] = useState('desc')

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [inventory, params, products] = await Promise.all([
        supabase.from('inventory_snapshots').select('*').order('snapshot_date', { ascending: false }),
        supabase.from('purchase_params').select('*'),
        supabase.from('products').select('*'),
      ])
      if (inventory.error) throw inventory.error
      if (params.error) throw params.error
      if (products.error) throw products.error

      // Solo el snapshot más reciente
      const latestDate = inventory.data?.[0]?.snapshot_date || null
      setSnapshotDate(latestDate)
      const latestInv = latestDate ? inventory.data.filter(r => r.snapshot_date === latestDate) : []

      const invBySku = {}
      for (const i of latestInv) invBySku[i.sku] = i
      const paramsBySku = {}
      for (const p of (params.data || [])) paramsBySku[p.sku] = p

      // Solo componentes con stock disponible > 0
      const built = (products.data || [])
        .filter(p => p.type === 'component')
        .map(p => {
          const qty = invBySku[p.sku]?.qty_available_real || 0
          const params = paramsBySku[p.sku] || {}
          const landed = params.landed_cost_usd ?? null
          return {
            sku: p.sku,
            name: p.name,
            supplier: params.supplier || '—',
            qty_available_real: qty,
            landed_cost_usd: landed,
            total_landed: qty * (landed || 0),
          }
        })
        .filter(r => r.qty_available_real > 0)

      setRows(built)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  // Proveedores presentes en los datos (más robusto que una lista fija)
  const suppliers = useMemo(() => {
    const set = new Set(rows.map(r => r.supplier).filter(Boolean))
    return ['All', ...[...set].sort()]
  }, [rows])

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (filterSupplier !== 'All' && r.supplier !== filterSupplier) return false
      if (search) {
        const q = search.toLowerCase()
        if (!r.sku.toLowerCase().includes(q) && !(r.name || '').toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [rows, filterSupplier, search])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
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

  const totalValue = useMemo(() => filtered.reduce((s, r) => s + r.total_landed, 0), [filtered])
  const mostValuable = useMemo(
    () => filtered.reduce((best, r) => (r.total_landed > (best?.total_landed || 0) ? r : best), null),
    [filtered]
  )

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Texto arranca ascendente; números descendente (lo más relevante primero)
      setSortDir(['sku', 'name', 'supplier'].includes(key) ? 'asc' : 'desc')
    }
  }

  // Exporta las filas visibles (sorted) a .xlsx con una fila TOTAL al final
  function exportToExcel() {
    const cols = [
      { header: 'SKU', get: r => r.sku, w: 14 },
      { header: 'Name', get: r => r.name, w: 30 },
      { header: 'Supplier', get: r => r.supplier, w: 12 },
      { header: 'Available', get: r => r.qty_available_real, w: 12, z: '#,##0' },
      { header: 'Landed Cost', get: r => r.landed_cost_usd, w: 14, z: '"$"#,##0.00' },
      { header: 'Total Landed Cost', get: r => r.total_landed, w: 18, z: '"$"#,##0.00' },
    ]

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

    const totalQty = sorted.reduce((s, r) => s + (r.qty_available_real || 0), 0)
    const totalLanded = sorted.reduce((s, r) => s + (r.total_landed || 0), 0)

    const aoa = [
      cols.map(c => c.header),
      ...sorted.map(r => cols.map(c => {
        const v = c.get(r)
        return v == null ? '' : v
      })),
    ]
    const summary = cols.map(() => '')
    summary[0] = 'TOTAL'
    summary[2] = `${sorted.length} SKUs`
    summary[3] = totalQty
    summary[5] = totalLanded
    aoa.push(summary)

    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const summaryRow = aoa.length - 1

    for (let c = 0; c < cols.length; c++) {
      const hAddr = XLSX.utils.encode_cell({ r: 0, c })
      if (ws[hAddr]) ws[hAddr].s = headerStyle

      for (let i = 0; i < sorted.length; i++) {
        const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c })]
        if (!cell) continue
        if (cols[c].z && typeof cell.v === 'number') {
          cell.z = cols[c].z
          cell.s = { alignment: { horizontal: 'right' } }
        }
      }

      const sCell = ws[XLSX.utils.encode_cell({ r: summaryRow, c })]
      if (sCell) {
        sCell.s = { ...summaryStyle }
        if (cols[c].z && typeof sCell.v === 'number') {
          sCell.z = cols[c].z
          sCell.s = { ...summaryStyle, alignment: { horizontal: 'right' } }
        }
      }
    }

    // Auto-ancho según el contenido más largo por columna
    ws['!cols'] = cols.map((col, c) => {
      let maxLen = col.header.length
      for (let r = 1; r < aoa.length; r++) {
        const v = aoa[r][c]
        const len = v == null ? 0 : String(v).length
        if (len > maxLen) maxLen = len
      }
      return { wch: Math.min(Math.max(maxLen + 2, col.w), 40) }
    })

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Inventory Value')
    const today = new Date().toISOString().split('T')[0]
    XLSX.writeFile(wb, `PM_Inventory_Value_${today}.xlsx`)
  }

  if (loading) return <div style={styles.loading}>Loading...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>💰 Inventory Value</h1>
          <p style={styles.pageDesc}>
            {snapshotDate ? `Inventory as of ${snapshotDate}` : 'No inventory data — upload a snapshot first'}
          </p>
        </div>
        <div style={styles.headerControls}>
          {sorted.length > 0 && (
            <button style={styles.exportBtn} onClick={exportToExcel}>
              ⬇ Export to Excel
            </button>
          )}
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {rows.length > 0 && (
        <>
          <div style={styles.summaryGrid}>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(totalValue)}</div>
              <div style={styles.summaryLabel}>Total Inventory Value</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmt(filtered.length)}</div>
              <div style={styles.summaryLabel}>SKUs with stock</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{mostValuable ? mostValuable.sku : '—'}</div>
              <div style={styles.summaryLabel}>
                Most valuable SKU{mostValuable ? ` · ${fmtCurrency(mostValuable.total_landed)}` : ''}
              </div>
            </div>
          </div>

          <div style={styles.filters}>
            <input
              placeholder="Search SKU or name..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={styles.searchInput}
            />
            <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={styles.select}>
              {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <span style={styles.filterTotal}>{fmtCurrency(totalValue)} filtered total</span>
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  {COLUMNS.map(col => (
                    <th
                      key={col.key}
                      style={{ ...styles.th, textAlign: col.align, cursor: 'pointer', userSelect: 'none' }}
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}
                      {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => (
                  <tr key={r.sku} style={styles.tr}>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
                    <td style={styles.td}>{r.name}</td>
                    <td style={styles.td}>
                      <span style={styles.supplierBadge}>{r.supplier}</span>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmt(r.qty_available_real)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{fmtCurrency(r.landed_cost_usd)}</td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, background: valueColor(r.total_landed) }}>
                      {fmtCurrency(r.total_landed)}
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS.length} style={{ ...styles.td, textAlign: 'center', padding: 30, color: '#888' }}>
                      No matches
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rows.length === 0 && !loading && (
        <div style={styles.empty}>
          <p>No components with available stock in the latest snapshot.</p>
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
  exportBtn: { background: '#1F3864', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  select: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff' },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 },
  summaryCard: { background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  summaryVal: { fontSize: 26, fontWeight: 700, color: '#1a1a2e' },
  summaryLabel: { fontSize: 12, color: '#888', marginTop: 2 },
  filters: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  searchInput: { padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, width: 240 },
  filterTotal: { fontSize: 13, fontWeight: 700, color: '#1a1a2e', marginLeft: 'auto' },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  table: { width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle' },
  supplierBadge: { background: '#eef0ff', color: '#4455aa', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
}
