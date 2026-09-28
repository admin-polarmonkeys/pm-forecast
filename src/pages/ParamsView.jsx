import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useColumnWidths, ResizableTh, ResetWidthsButton } from '../lib/useColumnWidths'
import {
  AVG_SALES_MONTHS_KEY,
  DEFAULT_AVG_SALES_MONTHS,
  TRIM_EXTREMES_KEY,
  DEFAULT_TRIM_EXTREMES,
  TRIM_MIN_KEPT_MONTHS,
} from '../lib/forecast'

// Normaliza lo que el usuario tipeó en un campo de ventana de meses.
// Devuelve un entero >= 1, o null si está vacío / no es válido (= "usar el global").
function normalizeMonthsInput(value) {
  if (value == null || String(value).trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n)
  return rounded >= 1 ? rounded : null
}

// Normaliza el recorte de extremos: 0, 1, o null si está vacío (= "usar el global").
// El 0 es un valor válido y explícito, no un "sin valor".
function normalizeTrimInput(value) {
  if (value == null || String(value).trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n) >= 1 ? 1 : 0
}

const DEFAULT_COL_WIDTHS = {
  sku: 130, name: 220, lead_time: 115, coverage: 130, growth: 115, moq: 90,
  avg_months: 110, trim: 110, supplier: 110, fob: 110, landed: 115,
}

export default function ParamsView() {
  const colWidths = useColumnWidths('parameters', DEFAULT_COL_WIDTHS)
  const [params, setParams] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [search, setSearch] = useState('')
  const [filterSupplier, setFilterSupplier] = useState('All')
  const [globalGrowth, setGlobalGrowth] = useState('')
  const [globalCoverage, setGlobalCoverage] = useState('')
  const [globalLeadTime, setGlobalLeadTime] = useState('')
  // Ventana global del promedio de ventas. A diferencia de los otros campos globales
  // (que son un "aplicar a todas las filas"), este se guarda en app_settings y es el
  // default que usa cualquier SKU que no tenga su propio override.
  const [globalAvgMonths, setGlobalAvgMonths] = useState('')
  // Recorte global de extremos ('0' | '1'), también persistido en app_settings
  const [globalTrim, setGlobalTrim] = useState(String(DEFAULT_TRIM_EXTREMES))

  useEffect(() => { loadParams() }, [])

  async function loadParams() {
    setLoading(true)
    const [{ data, error }, settings] = await Promise.all([
      supabase.from('purchase_params').select('*, products(name)').order('sku'),
      supabase.from('app_settings').select('key, value').in('key', [AVG_SALES_MONTHS_KEY, TRIM_EXTREMES_KEY]),
    ])
    if (!error) setParams(data || [])
    // Si la key todavía no existe en app_settings, mostramos el default del motor
    const byKey = Object.fromEntries((settings.data || []).map(x => [x.key, x.value]))
    const storedMonths = byKey[AVG_SALES_MONTHS_KEY]
    setGlobalAvgMonths(storedMonths != null && storedMonths !== '' ? String(storedMonths) : String(DEFAULT_AVG_SALES_MONTHS))
    const storedTrim = normalizeTrimInput(byKey[TRIM_EXTREMES_KEY])
    setGlobalTrim(String(storedTrim ?? DEFAULT_TRIM_EXTREMES))
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
    setSaveError(null)
    const updates = params.map(p => ({
      sku: p.sku,
      lead_time_weeks: parseInt(p.lead_time_weeks) || 12,
      coverage_target_months: parseFloat(p.coverage_target_months) || 3,
      growth_factor: parseFloat(p.growth_factor) || 1.4,
      moq: parseInt(p.moq) || 1,
      supplier: p.supplier || null,
      fob_cost_usd: p.fob_cost_usd ? parseFloat(p.fob_cost_usd) : null,
      landed_cost_usd: p.landed_cost_usd ? parseFloat(p.landed_cost_usd) : null,
      // Vacío = sin override, el SKU usa la ventana global. Un valor < 1 no tiene
      // sentido como ventana, así que también lo tratamos como "sin override".
      avg_sales_months: normalizeMonthsInput(p.avg_sales_months),
      // Vacío = sin override. El 0 sí se guarda: significa "no recortar este SKU".
      trim_extremes: normalizeTrimInput(p.trim_extremes),
      updated_at: new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('purchase_params')
      .upsert(updates, { onConflict: 'sku' })

    // Los globales van a app_settings (tabla clave/valor, value es TEXT)
    const globalMonths = normalizeMonthsInput(globalAvgMonths)
    const globalTrimValue = normalizeTrimInput(globalTrim)
    const { error: settingsError } = await supabase
      .from('app_settings')
      .upsert(
        [
          {
            key: AVG_SALES_MONTHS_KEY,
            value: String(globalMonths ?? DEFAULT_AVG_SALES_MONTHS),
            updated_at: new Date().toISOString(),
          },
          {
            key: TRIM_EXTREMES_KEY,
            value: String(globalTrimValue ?? DEFAULT_TRIM_EXTREMES),
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: 'key' }
      )

    if (!error && !settingsError) setSaved(true)
    if (error || settingsError) setSaveError((error || settingsError).message)
    setSaving(false)
  }

  const suppliers = ['All', ...new Set(params.map(p => p.supplier).filter(Boolean))]

  const filtered = params.filter(p => {
    if (filterSupplier !== 'All' && p.supplier !== filterSupplier) return false
    if (search && !p.sku.toLowerCase().includes(search.toLowerCase()) &&
        !p.products?.name?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  if (loading) return <div style={styles.loading}>Loading parameters...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>⚙️ Parameters</h1>
          <p style={styles.pageDesc}>Edit purchase parameters by SKU. Changes apply to the next forecast.</p>
        </div>
        <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : saved ? '✅ Saved' : '💾 Save Changes'}
        </button>
      </div>

      {saveError && <div style={styles.error}>No se pudo guardar: {saveError}</div>}

      <div style={styles.globalCard}>
        <h2 style={styles.globalTitle}>🌐 Global Settings</h2>
        <p style={styles.globalNote}>
          Apply a value to all SKUs at once. You can adjust individual SKUs afterward in the table.
          <strong> Press Save Changes to confirm.</strong>
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
            <label style={styles.globalLabel}>Global Coverage Target (months)</label>
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
            <label style={styles.globalLabel}>Global Lead Time (weeks)</label>
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

        <div style={styles.globalDivider} />

        <div style={styles.globalRow}>
          <div style={styles.globalField}>
            <label style={styles.globalLabel}>Meses para promedio de ventas</label>
            <div style={styles.globalInputGroup}>
              <input
                type="number"
                step={1}
                min={1}
                max={60}
                value={globalAvgMonths}
                onChange={e => { setGlobalAvgMonths(e.target.value); setSaved(false) }}
                style={styles.globalInput}
                placeholder={String(DEFAULT_AVG_SALES_MONTHS)}
              />
              <span style={styles.globalHelp}>
                Default global: cada SKU usa esta ventana salvo que tenga su propio valor
                en la columna <strong>Avg Months</strong> de la tabla. No es un "Apply to All" —
                se guarda una sola vez y aplica a todos los SKUs sin override.
              </span>
            </div>
          </div>

          <div style={styles.globalField}>
            <label style={styles.globalLabel}>Recortar extremos</label>
            <div style={styles.globalInputGroup}>
              <select
                value={globalTrim}
                onChange={e => { setGlobalTrim(e.target.value); setSaved(false) }}
                style={{ ...styles.globalInput, width: 150, textAlign: 'left' }}
              >
                <option value="0">No (0)</option>
                <option value="1">Sí, quitar extremos (1)</option>
              </select>
              <span style={styles.globalHelp}>
                Con <strong>Sí</strong> se descarta el mes más alto y el más bajo de la ventana
                antes de promediar, y el divisor pasa a ser los meses que quedaron. Los meses en
                cero son candidatos normales a ser el extremo bajo. Si después de recortar
                quedarían menos de {TRIM_MIN_KEPT_MONTHS} meses no se recorta, así que con una
                ventana de 4 meses o menos nunca se aplica.
              </span>
            </div>
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
        <span style={styles.count}>{filtered.length} SKUs</span>
        <ResetWidthsButton resize={colWidths} />
      </div>

      <div style={styles.tableWrap}>
        <table style={{ ...styles.table, minWidth: colWidths.totalWidth, width: '100%' }}>
          <thead>
            <tr style={styles.thead}>
              <ResizableTh colKey="sku" resize={colWidths} style={styles.th}>SKU</ResizableTh>
              <ResizableTh colKey="name" resize={colWidths} style={styles.th}>Name</ResizableTh>
              <ResizableTh colKey="lead_time" resize={colWidths} style={{ ...styles.th, textAlign: 'center' }}>Lead Time (wk)</ResizableTh>
              <ResizableTh colKey="coverage" resize={colWidths} style={{ ...styles.th, textAlign: 'center' }}>Coverage (months)</ResizableTh>
              <ResizableTh colKey="growth" resize={colWidths} style={{ ...styles.th, textAlign: 'center' }}>Growth Factor</ResizableTh>
              <ResizableTh colKey="moq" resize={colWidths} style={{ ...styles.th, textAlign: 'center' }}>MOQ</ResizableTh>
              <ResizableTh
                colKey="avg_months"
                resize={colWidths}
                style={{ ...styles.th, textAlign: 'center' }}
                title="Ventana de meses para el promedio de ventas de este SKU. Vacío = usar el global."
              >
                Avg Months ⓘ
              </ResizableTh>
              <ResizableTh
                colKey="trim"
                resize={colWidths}
                style={{ ...styles.th, textAlign: 'center' }}
                title="Recorte de extremos de este SKU. Vacío = usar el global. 0 = no recortar (decisión explícita que le gana al global)."
              >
                Trim ⓘ
              </ResizableTh>
              <ResizableTh colKey="supplier" resize={colWidths} style={styles.th}>Supplier</ResizableTh>
              <ResizableTh colKey="fob" resize={colWidths} style={{ ...styles.th, textAlign: 'right' }}>FOB Cost $</ResizableTh>
              <ResizableTh colKey="landed" resize={colWidths} style={{ ...styles.th, textAlign: 'right' }}>Landed Cost $</ResizableTh>
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
                <td style={{ ...styles.td, textAlign: 'center' }}>
                  <input
                    type="number"
                    value={p.avg_sales_months ?? ''}
                    onChange={e => updateParam(p.sku, 'avg_sales_months', e.target.value)}
                    style={styles.numInput}
                    min={1} max={60} step={1}
                    placeholder={globalAvgMonths || String(DEFAULT_AVG_SALES_MONTHS)}
                    title="Vacío = usar la ventana global"
                  />
                </td>
                <td style={{ ...styles.td, textAlign: 'center' }}>
                  <select
                    value={p.trim_extremes == null ? '' : String(p.trim_extremes)}
                    onChange={e => updateParam(p.sku, 'trim_extremes', e.target.value)}
                    style={styles.trimSelect}
                    title="Vacío = usar el global. 0 = no recortar este SKU, incluso si el global es 1."
                  >
                    <option value="">Global ({globalTrim === '1' ? 'sí' : 'no'})</option>
                    <option value="0">No</option>
                    <option value="1">Sí</option>
                  </select>
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
  globalDivider: { height: 1, background: '#f0e4b8', margin: '16px 0 14px' },
  globalHelp: { fontSize: 11, color: '#7a6a2a', maxWidth: 520, lineHeight: 1.45 },
  error: { background: '#fff0f0', color: '#c00', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 },
  globalInput: { width: 90, padding: '7px 10px', border: '1.5px solid #e0d6a8', borderRadius: 6, fontSize: 13, textAlign: 'center', background: '#fff' },
  applyBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  filters: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 },
  searchInput: { padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, width: 240 },
  select: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff' },
  count: { fontSize: 12, color: '#888' },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  table: { tableLayout: 'fixed', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  trEven: { background: '#fff', borderBottom: '1px solid #f0f0f0' },
  trOdd: { background: '#f8f9ff', borderBottom: '1px solid #f0f0f0' },
  td: { padding: '7px 14px', verticalAlign: 'middle' },
  numInput: { width: 68, padding: '5px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, textAlign: 'center' },
  trimSelect: { width: 92, padding: '5px 6px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 12, background: '#fff' },
  textInput: { width: 80, padding: '5px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13 },
}
