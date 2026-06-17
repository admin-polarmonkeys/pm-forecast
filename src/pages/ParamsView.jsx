import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function ParamsView() {
  const [params, setParams] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [search, setSearch] = useState('')
  const [filterSupplier, setFilterSupplier] = useState('Todos')
  const [globalGrowth, setGlobalGrowth] = useState('')
  const [globalCoverage, setGlobalCoverage] = useState('')
  const [globalLeadTime, setGlobalLeadTime] = useState('')

  useEffect(() => { loadParams() }, [])

  async function loadParams() {
    setLoading(true)
    const { data, error } = await supabase
      .from('purchase_params')
      .select('*, products(name)')
      .order('sku')
    if (!error) setParams(data || [])
    setLoading(false)
  }

  function updateParam(sku, field, value) {
    setParams(prev => prev.map(p =>
      p.sku === sku ? { ...p, [field]: value } : p
    ))
    setSaved(false)
  }

  // Aplica un valor a un campo en TODAS las filas (solo estado local; no persiste hasta Guardar)
  function applyToAll(field, value) {
    if (value === '' || value == null) return
    setParams(prev => prev.map(p => ({ ...p, [field]: value })))
    setSaved(false)
  }

  async function handleSave() {
    setSaving(true)
    const updates = params.map(p => ({
      sku: p.sku,
      lead_time_weeks: parseInt(p.lead_time_weeks) || 12,
      coverage_target_months: parseFloat(p.coverage_target_months) || 3,
      growth_factor: parseFloat(p.growth_factor) || 1.4,
      moq: parseInt(p.moq) || 1,
      supplier: p.supplier || null,
      fob_cost_usd: p.fob_cost_usd ? parseFloat(p.fob_cost_usd) : null,
      landed_cost_usd: p.landed_cost_usd ? parseFloat(p.landed_cost_usd) : null,
      updated_at: new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('purchase_params')
      .upsert(updates, { onConflict: 'sku' })

    if (!error) setSaved(true)
    setSaving(false)
  }

  const suppliers = ['Todos', ...new Set(params.map(p => p.supplier).filter(Boolean))]

  const filtered = params.filter(p => {
    if (filterSupplier !== 'Todos' && p.supplier !== filterSupplier) return false
    if (search && !p.sku.toLowerCase().includes(search.toLowerCase()) &&
        !p.products?.name?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  if (loading) return <div style={styles.loading}>Cargando parámetros...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>⚙️ Parameters</h1>
          <p style={styles.pageDesc}>Edita los parámetros de compra por SKU. Cambios aplican al próximo forecast.</p>
        </div>
        <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando...' : saved ? '✅ Guardado' : '💾 Guardar Cambios'}
        </button>
      </div>

      <div style={styles.globalCard}>
        <h2 style={styles.globalTitle}>🌐 Global Settings</h2>
        <p style={styles.globalNote}>
          Aplica un valor a todos los SKUs de una vez. Podés ajustar SKUs individuales después en la tabla.
          <strong> Presiona Guardar Cambios para confirmar.</strong>
        </p>
        <div style={styles.globalRow}>
          <div style={styles.globalField}>
            <label style={styles.globalLabel}>Global Growth Factor</label>
            <div style={styles.globalInputGroup}>
              <input
                type="number"
                step={0.05}
                min={0.5}
                value={globalGrowth}
                onChange={e => setGlobalGrowth(e.target.value)}
                style={styles.globalInput}
                placeholder="1.40"
              />
              <button style={styles.applyBtn} onClick={() => applyToAll('growth_factor', globalGrowth)}>
                Apply to All
              </button>
            </div>
          </div>

          <div style={styles.globalField}>
            <label style={styles.globalLabel}>Global Coverage Target (meses)</label>
            <div style={styles.globalInputGroup}>
              <input
                type="number"
                step={0.5}
                min={1}
                value={globalCoverage}
                onChange={e => setGlobalCoverage(e.target.value)}
                style={styles.globalInput}
                placeholder="3"
              />
              <button style={styles.applyBtn} onClick={() => applyToAll('coverage_target_months', globalCoverage)}>
                Apply to All
              </button>
            </div>
          </div>

          <div style={styles.globalField}>
            <label style={styles.globalLabel}>Global Lead Time (semanas)</label>
            <div style={styles.globalInputGroup}>
              <input
                type="number"
                step={1}
                min={1}
                value={globalLeadTime}
                onChange={e => setGlobalLeadTime(e.target.value)}
                style={styles.globalInput}
                placeholder="12"
              />
              <button style={styles.applyBtn} onClick={() => applyToAll('lead_time_weeks', globalLeadTime)}>
                Apply to All
              </button>
            </div>
          </div>
        </div>
      </div>

      <div style={styles.filters}>
        <input
          placeholder="Buscar SKU o nombre..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={styles.select}>
          {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={styles.count}>{filtered.length} SKUs</span>
      </div>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr style={styles.thead}>
              <th style={styles.th}>SKU</th>
              <th style={styles.th}>Nombre</th>
              <th style={{ ...styles.th, textAlign: 'center' }}>Lead Time (sem)</th>
              <th style={{ ...styles.th, textAlign: 'center' }}>Cobertura (meses)</th>
              <th style={{ ...styles.th, textAlign: 'center' }}>Growth Factor</th>
              <th style={{ ...styles.th, textAlign: 'center' }}>MOQ</th>
              <th style={styles.th}>Proveedor</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>FOB Cost $</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Landed Cost $</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, idx) => (
              <tr key={p.sku} style={idx % 2 === 0 ? styles.trEven : styles.trOdd}>
                <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 11 }}>{p.sku}</td>
                <td style={styles.td}>{p.products?.name || '—'}</td>
                <td style={{ ...styles.td, textAlign: 'center' }}>
                  <input
                    type="number"
                    value={p.lead_time_weeks}
                    onChange={e => updateParam(p.sku, 'lead_time_weeks', e.target.value)}
                    style={styles.numInput}
                    min={1} max={52}
                  />
                </td>
                <td style={{ ...styles.td, textAlign: 'center' }}>
                  <input
                    type="number"
                    value={p.coverage_target_months}
                    onChange={e => updateParam(p.sku, 'coverage_target_months', e.target.value)}
                    style={styles.numInput}
                    min={1} max={24} step={0.5}
                  />
                </td>
                <td style={{ ...styles.td, textAlign: 'center' }}>
                  <input
                    type="number"
                    value={p.growth_factor}
                    onChange={e => updateParam(p.sku, 'growth_factor', e.target.value)}
                    style={styles.numInput}
                    min={0.5} max={3} step={0.05}
                  />
                </td>
                <td style={{ ...styles.td, textAlign: 'center' }}>
                  <input
                    type="number"
                    value={p.moq}
                    onChange={e => updateParam(p.sku, 'moq', e.target.value)}
                    style={styles.numInput}
                    min={1}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    type="text"
                    value={p.supplier || ''}
                    onChange={e => updateParam(p.sku, 'supplier', e.target.value)}
                    style={styles.textInput}
                    placeholder="—"
                  />
                </td>
                <td style={{ ...styles.td, textAlign: 'right' }}>
                  <input
                    type="number"
                    value={p.fob_cost_usd || ''}
                    onChange={e => updateParam(p.sku, 'fob_cost_usd', e.target.value)}
                    style={{ ...styles.numInput, width: 90 }}
                    min={0} step={0.01}
                    placeholder="—"
                  />
                </td>
                <td style={{ ...styles.td, textAlign: 'right' }}>
                  <input
                    type="number"
                    value={p.landed_cost_usd || ''}
                    onChange={e => updateParam(p.sku, 'landed_cost_usd', e.target.value)}
                    style={{ ...styles.numInput, width: 90 }}
                    min={0} step={0.01}
                    placeholder="—"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const styles = {
  loading: { padding: 40, color: '#666', textAlign: 'center' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  pageTitle: { fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  pageDesc: { color: '#666', fontSize: 13 },
  saveBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  globalCard: { background: '#fffbe6', border: '1.5px solid #ffe9a8', borderRadius: 12, padding: '18px 20px', marginBottom: 20 },
  globalTitle: { fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  globalNote: { fontSize: 12, color: '#7a6a2a', marginBottom: 14 },
  globalRow: { display: 'flex', gap: 24, flexWrap: 'wrap' },
  globalField: { display: 'flex', flexDirection: 'column', gap: 6 },
  globalLabel: { fontSize: 12, fontWeight: 600, color: '#666' },
  globalInputGroup: { display: 'flex', gap: 8, alignItems: 'center' },
  globalInput: { width: 90, padding: '7px 10px', border: '1.5px solid #e0d6a8', borderRadius: 6, fontSize: 13, textAlign: 'center', background: '#fff' },
  applyBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  filters: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 },
  searchInput: { padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, width: 240 },
  select: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff' },
  count: { fontSize: 12, color: '#888' },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  table: { width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  trEven: { background: '#fff', borderBottom: '1px solid #f0f0f0' },
  trOdd: { background: '#f8f9ff', borderBottom: '1px solid #f0f0f0' },
  td: { padding: '7px 14px', verticalAlign: 'middle' },
  numInput: { width: 68, padding: '5px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, textAlign: 'center' },
  textInput: { width: 80, padding: '5px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13 },
}
