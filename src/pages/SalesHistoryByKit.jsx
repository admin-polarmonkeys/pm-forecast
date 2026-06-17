import { useState, useEffect, useMemo, Fragment } from 'react'
import { supabase } from '../lib/supabase'

const MONTH_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const NO_FAMILY = '(Sin familia)'

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

// Color de fondo para un valor dado el min/max NO-CERO de la fila
function cellColor(value, min, max) {
  if (value == null || value === 0) return undefined  // cero/vacío: sin color
  if (value === max) return GREEN                      // máximo de la fila
  if (value === min) return RED                        // mínimo de la fila (no-cero)
  if (max === min) return GREEN                        // todos iguales
  const t = (value - min) / (max - min)
  return lerpColor(YELLOW, GREEN, t)                   // intermedios: amarillo -> verde
}

// min/max de los valores no-cero de un mapa monthKey -> qty
function rowRange(cells) {
  const nonZero = Object.values(cells).filter(v => v > 0)
  if (!nonZero.length) return { min: 0, max: 0 }
  return { min: Math.min(...nonZero), max: Math.max(...nonZero) }
}

// Promedio de los meses NO-CERO (null si no hay ventas)
function avgNonZero(cells) {
  const nonZero = Object.values(cells).filter(v => v > 0)
  if (!nonZero.length) return null
  return nonZero.reduce((s, v) => s + v, 0) / nonZero.length
}

export default function SalesHistoryByKit() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [kits, setKits] = useState([])
  const [bomRows, setBomRows] = useState([])
  const [sales, setSales] = useState([])
  const [search, setSearch] = useState('')
  const [onlyWithSales, setOnlyWithSales] = useState(false)
  const [expanded, setExpanded] = useState({})

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [prod, bom, sal] = await Promise.all([
        supabase.from('products').select('sku, name, type').eq('type', 'kit'),
        supabase.from('bom').select('kit_sku, variant_group'),
        supabase.from('sales_history').select('sku, year, month, qty_fulfilled'),
      ])
      if (prod.error) throw prod.error
      if (bom.error) throw bom.error
      if (sal.error) throw sal.error
      setKits(prod.data || [])
      setBomRows(bom.data || [])
      setSales(sal.data || [])
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  const kitSkus = useMemo(() => new Set(kits.map(k => k.sku)), [kits])

  // kit_sku -> variant_group (primer match en bom, igual que calcKitFamilySales)
  const kitToGroup = useMemo(() => {
    const map = {}
    for (const b of bomRows) {
      if (map[b.kit_sku] == null) map[b.kit_sku] = b.variant_group
    }
    return map
  }, [bomRows])

  // Columnas: meses con ventas de algún kit, orden cronológico (viejo -> nuevo)
  const months = useMemo(() => {
    const seen = new Map()
    for (const s of sales) {
      if (!kitSkus.has(s.sku)) continue
      const key = `${s.year}-${s.month}`
      if (!seen.has(key)) seen.set(key, { key, year: s.year, month: s.month })
    }
    return [...seen.values()].sort((a, b) => a.year - b.year || a.month - b.month)
  }, [sales, kitSkus])

  // qtyMap[sku][year-month] = qty_fulfilled (solo kits)
  const qtyMap = useMemo(() => {
    const map = {}
    for (const s of sales) {
      if (!kitSkus.has(s.sku)) continue
      if (!map[s.sku]) map[s.sku] = {}
      const key = `${s.year}-${s.month}`
      map[s.sku][key] = (map[s.sku][key] || 0) + (s.qty_fulfilled || 0)
    }
    return map
  }, [sales, kitSkus])

  // Familias: { variant_group, kits:[{sku,name}], familyMonthly:{key:sum}, total }
  const families = useMemo(() => {
    const byGroup = {}
    for (const k of kits) {
      const vg = kitToGroup[k.sku] || NO_FAMILY
      if (!byGroup[vg]) byGroup[vg] = { variant_group: vg, kits: [] }
      byGroup[vg].kits.push({ sku: k.sku, name: k.name || '—' })
    }
    const list = Object.values(byGroup).map(f => {
      const familyMonthly = {}
      for (const kit of f.kits) {
        const cells = qtyMap[kit.sku] || {}
        for (const [key, qty] of Object.entries(cells)) {
          familyMonthly[key] = (familyMonthly[key] || 0) + qty
        }
      }
      f.kits.sort((a, b) => a.sku.localeCompare(b.sku))
      const total = Object.values(familyMonthly).reduce((s, v) => s + v, 0)
      return { ...f, familyMonthly, total }
    })
    // Familias con más ventas primero; desempate alfabético
    return list.sort((a, b) => b.total - a.total || a.variant_group.localeCompare(b.variant_group))
  }, [kits, kitToGroup, qtyMap])

  function toggleFamily(vg) {
    setExpanded(prev => ({ ...prev, [vg]: !prev[vg] }))
  }
  function kitHasSale(sku) {
    const c = qtyMap[sku]
    return c && Object.values(c).some(v => v > 0)
  }

  if (loading) return <div style={styles.loading}>Cargando datos...</div>

  const q = search.trim().toLowerCase()

  // Pre-calcula qué familias y kits son visibles, y si expanden automáticamente
  const visibleFamilies = families
    .map(f => {
      const nameMatch = q && f.variant_group.toLowerCase().includes(q)
      let visKits = f.kits
      if (q && !nameMatch) {
        visKits = visKits.filter(k =>
          k.sku.toLowerCase().includes(q) || k.name.toLowerCase().includes(q)
        )
      }
      if (onlyWithSales) visKits = visKits.filter(k => kitHasSale(k.sku))
      // Auto-expandir si el match vino por un kit interno (no por el nombre de familia)
      const autoExpand = !!q && !nameMatch
      return { family: f, visKits, autoExpand }
    })
    .filter(x => x.visKits.length > 0)

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>📦 Sales History by Kit</h1>
          <p style={styles.pageDesc}>
            {kits.length > 0
              ? `${families.length} familias · ${kits.length} kits · ${months.length} meses`
              : 'Sin kits en el catálogo — sube productos primero'}
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
          &nbsp;Solo kits con al menos una venta
        </label>
        <span style={styles.filterTotal}>{visibleFamilies.length} familias visibles</span>
      </div>

      {months.length === 0 ? (
        <div style={styles.empty}>
          <p>No hay ventas de kits cargadas todavía.</p>
          <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
            Sube un archivo de ventas desde "Upload Data".
          </p>
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.thead}>
                <th style={{ ...styles.th, ...styles.stickyCol, ...styles.stickyHead, textAlign: 'left' }}>Familia / SKU</th>
                <th style={{ ...styles.th, ...styles.stickyColName, ...styles.stickyHead, textAlign: 'left' }}>Nombre</th>
                {months.map(m => (
                  <th key={m.key} style={{ ...styles.th, textAlign: 'right' }}>
                    {MONTH_ABBR[m.month - 1]} {String(m.year).slice(2)}
                  </th>
                ))}
                <th style={{ ...styles.th, ...styles.stickyAvg, ...styles.stickyHead, textAlign: 'right' }}>Avg Sales</th>
              </tr>
            </thead>
            <tbody>
              {visibleFamilies.map(({ family, visKits, autoExpand }) => {
                const isExpanded = expanded[family.variant_group] || autoExpand
                const famRange = rowRange(family.familyMonthly)
                const famAvg = avgNonZero(family.familyMonthly)
                return (
                  <Fragment key={family.variant_group}>
                    {/* Fila de familia (suma) */}
                    <tr style={styles.familyRow} onClick={() => toggleFamily(family.variant_group)}>
                      <td colSpan={2} style={{ ...styles.familyStickyCell }}>
                        <span style={styles.expandIcon}>{isExpanded ? '▼' : '▶'}</span>
                        <strong>{family.variant_group}</strong>
                        <span style={styles.kitCount}>{family.kits.length} variantes</span>
                      </td>
                      {months.map(m => {
                        const v = family.familyMonthly[m.key]
                        const bg = cellColor(v, famRange.min, famRange.max)
                        return (
                          <td
                            key={m.key}
                            style={{
                              ...styles.td,
                              textAlign: 'right',
                              fontWeight: 700,
                              background: bg || styles.familyBg.background,
                              color: v ? '#1a1a2e' : '#9aa1c0',
                            }}
                          >
                            {v != null ? v : ''}
                          </td>
                        )
                      })}
                      <td style={{ ...styles.td, ...styles.stickyAvg, ...styles.stickyAvgFamily }}>
                        {famAvg != null ? famAvg.toFixed(1) : '—'}
                      </td>
                    </tr>

                    {/* Sub-filas: cada kit con su propia escala */}
                    {isExpanded && visKits.map(kit => {
                      const cells = qtyMap[kit.sku] || {}
                      const r = rowRange(cells)
                      const kitAvg = avgNonZero(cells)
                      return (
                        <tr key={kit.sku} style={styles.tr}>
                          <td style={{ ...styles.td, ...styles.stickyCol, ...styles.kitSkuCell }}>{kit.sku}</td>
                          <td style={{ ...styles.td, ...styles.stickyColName }}>{kit.name}</td>
                          {months.map(m => {
                            const v = cells[m.key]
                            const bg = cellColor(v, r.min, r.max)
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
                          <td style={{ ...styles.td, ...styles.stickyAvg, ...styles.stickyAvgKit }}>
                            {kitAvg != null ? kitAvg.toFixed(1) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
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
  // Fila de familia: más oscura y en negrita
  familyRow: { borderBottom: '2px solid #c9cff0', cursor: 'pointer' },
  familyBg: { background: '#e6e9f7' },
  // Sin display:flex — un <td> flex pierde su comportamiento table-cell y el colSpan deja de aplicarse,
  // lo que desalineaba los meses y el Avg. Con table-cell normal, colSpan={2} cubre SKU + Nombre.
  familyStickyCell: {
    position: 'sticky', left: 0, zIndex: 1,
    width: 350, minWidth: 350, maxWidth: 350, boxSizing: 'border-box',
    background: '#d7dcf2', color: '#1a1a2e', fontWeight: 700,
    padding: '11px 14px', verticalAlign: 'middle',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  expandIcon: { fontSize: 10, color: '#556', marginRight: 8 },
  kitCount: { fontSize: 11, color: '#778', fontWeight: 400, marginLeft: 8 },
  kitSkuCell: { fontFamily: 'monospace', fontSize: 12, paddingLeft: 28 },
  // Primeras columnas fijas al hacer scroll horizontal (anchos explícitos para alinear thead/tbody)
  stickyCol: { position: 'sticky', left: 0, background: '#fff', zIndex: 1, width: 130, minWidth: 130, maxWidth: 130, boxSizing: 'border-box' },
  stickyColName: { position: 'sticky', left: 130, background: '#fff', zIndex: 1, width: 220, minWidth: 220, maxWidth: 220, boxSizing: 'border-box', overflow: 'hidden', textOverflow: 'ellipsis' },
  stickyHead: { background: '#1a1a2e', zIndex: 2 },
  // Columna "Avg Sales" fija a la derecha, en negrita, sin escala de color
  stickyAvg: { position: 'sticky', right: 0, zIndex: 1, textAlign: 'right', fontWeight: 700, width: 90, minWidth: 90, maxWidth: 90, boxSizing: 'border-box', borderLeft: '1px solid #e6e6e6' },
  stickyAvgFamily: { background: '#d7dcf2', color: '#1a1a2e' },
  stickyAvgKit: { background: '#fff', color: '#1a1a2e' },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
}
