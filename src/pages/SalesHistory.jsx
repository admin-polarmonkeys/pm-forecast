import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'

const MONTH_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

// Colores base de la escala
const RED = '#ffc7ce'     // mínimo de la fila (excluyendo cero)
const YELLOW = '#ffeb9c'  // valores intermedios bajos
const GREEN = '#c6efce'   // máximo de la fila

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function lerpColor(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b)
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

// Devuelve el color de fondo para un valor dado el min/max NO-CERO de la fila
function cellColor(value, min, max) {
  if (value == null || value === 0) return undefined  // cero/vacío: sin color
  if (value === max) return GREEN                      // máximo de la fila
  if (value === min) return RED                        // mínimo de la fila (no-cero)
  if (max === min) return GREEN                        // todos iguales
  // intermedios: gradiente amarillo -> verde según valor relativo
  const t = (value - min) / (max - min)
  return lerpColor(YELLOW, GREEN, t)
}

export default function SalesHistory() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [products, setProducts] = useState([])
  const [sales, setSales] = useState([])
  const [search, setSearch] = useState('')
  const [onlyWithSales, setOnlyWithSales] = useState(false)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [prod, sal] = await Promise.all([
        supabase.from('products').select('sku, name'),
        supabase.from('sales_history').select('sku, year, month, qty_fulfilled'),
      ])
      if (prod.error) throw prod.error
      if (sal.error) throw sal.error
      setProducts(prod.data || [])
      setSales(sal.data || [])
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  // Columnas: todos los (año, mes) únicos, orden cronológico (viejo -> nuevo)
  const months = useMemo(() => {
    const seen = new Map()
    for (const s of sales) {
      const key = `${s.year}-${s.month}`
      if (!seen.has(key)) {
        seen.set(key, { key, year: s.year, month: s.month })
      }
    }
    return [...seen.values()].sort((a, b) => a.year - b.year || a.month - b.month)
  }, [sales])

  // Lookup: qty[sku][year-month] = qty_fulfilled
  const qtyMap = useMemo(() => {
    const map = {}
    for (const s of sales) {
      if (!map[s.sku]) map[s.sku] = {}
      map[s.sku][`${s.year}-${s.month}`] = (map[s.sku][`${s.year}-${s.month}`] || 0) + (s.qty_fulfilled || 0)
    }
    return map
  }, [sales])

  // Filas: todos los SKUs de products + cualquiera presente solo en ventas
  const rows = useMemo(() => {
    const names = {}
    for (const p of products) names[p.sku] = p.name
    const skus = new Set(products.map(p => p.sku))
    for (const s of sales) skus.add(s.sku)
    return [...skus]
      .map(sku => ({ sku, name: names[sku] || '—' }))
      .sort((a, b) => a.sku.localeCompare(b.sku))
  }, [products, sales])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (q && !r.sku.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false
      if (onlyWithSales) {
        const cells = qtyMap[r.sku]
        const hasSale = cells && Object.values(cells).some(v => v > 0)
        if (!hasSale) return false
      }
      return true
    })
  }, [rows, search, onlyWithSales, qtyMap])

  if (loading) return <div style={styles.loading}>Cargando datos...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>📈 Sales History by SKU</h1>
          <p style={styles.pageDesc}>
            {sales.length > 0
              ? `${rows.length} SKUs · ${months.length} meses de historial`
              : 'Sin datos de ventas — sube un archivo primero'}
          </p>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.filters}>
        <input
          placeholder="Buscar SKU o nombre..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        <label style={styles.checkLabel}>
          <input
            type="checkbox"
            checked={onlyWithSales}
            onChange={e => setOnlyWithSales(e.target.checked)}
          />
          &nbsp;Solo SKUs con al menos una venta
        </label>
        <span style={styles.filterTotal}>{filteredRows.length} SKUs visibles</span>
      </div>

      {months.length === 0 ? (
        <div style={styles.empty}>
          <p>No hay ventas cargadas todavía.</p>
          <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
            Sube un archivo de ventas desde "Upload Data".
          </p>
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.thead}>
                <th style={{ ...styles.th, ...styles.stickyCol, ...styles.stickyHead, textAlign: 'left' }}>SKU</th>
                <th style={{ ...styles.th, ...styles.stickyColName, ...styles.stickyHead, textAlign: 'left' }}>Nombre</th>
                {months.map(m => (
                  <th key={m.key} style={{ ...styles.th, textAlign: 'right' }}>
                    {MONTH_ABBR[m.month - 1]} {String(m.year).slice(2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(r => {
                const cells = qtyMap[r.sku] || {}
                const nonZero = Object.values(cells).filter(v => v > 0)
                const min = nonZero.length ? Math.min(...nonZero) : 0
                const max = nonZero.length ? Math.max(...nonZero) : 0
                return (
                  <tr key={r.sku} style={styles.tr}>
                    <td style={{ ...styles.td, ...styles.stickyCol, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
                    <td style={{ ...styles.td, ...styles.stickyColName }}>{r.name}</td>
                    {months.map(m => {
                      const v = cells[m.key]
                      const bg = cellColor(v, min, max)
                      return (
                        <td
                          key={m.key}
                          style={{
                            ...styles.td,
                            textAlign: 'right',
                            background: bg,
                            color: v ? '#1a1a2e' : '#ccc',
                            fontWeight: bg === GREEN ? 700 : 400,
                          }}
                        >
                          {v != null ? v : ''}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
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
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  filters: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  searchInput: { padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, width: 240 },
  checkLabel: { fontSize: 13, color: '#555', display: 'flex', alignItems: 'center', cursor: 'pointer' },
  filterTotal: { fontSize: 13, fontWeight: 700, color: '#1a1a2e', marginLeft: 'auto' },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  table: { borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  // Primeras columnas fijas al hacer scroll horizontal (anchos explícitos para alinear thead/tbody)
  stickyCol: { position: 'sticky', left: 0, background: '#fff', zIndex: 1, width: 130, minWidth: 130, maxWidth: 130, boxSizing: 'border-box' },
  stickyColName: { position: 'sticky', left: 130, background: '#fff', zIndex: 1, width: 220, minWidth: 220, maxWidth: 220, boxSizing: 'border-box', overflow: 'hidden', textOverflow: 'ellipsis' },
  stickyHead: { background: '#1a1a2e', zIndex: 2 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
}
