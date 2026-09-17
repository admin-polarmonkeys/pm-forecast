import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'

// Claves con las que se guarda el blackout de China en app_settings
const BLACKOUT_START_KEY = 'china_blackout_start'
const BLACKOUT_END_KEY = 'china_blackout_end'

export default function Admin() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null) // { type: 'ok' | 'err', msg }
  const flashTimer = useRef(null)
  // Nombres tal como están guardados en la base, para no escribir de más en cada blur
  const savedNames = useRef({})

  // --- Sección 1: proveedores ---
  const [suppliers, setSuppliers] = useState([])
  const [paramRows, setParamRows] = useState([]) // purchase_params: { sku, supplier }
  const [newSupplier, setNewSupplier] = useState({ code: '', name: '', is_china: false })
  const [addingSupplier, setAddingSupplier] = useState(false)

  // --- Sección 2: asignación producto -> proveedor ---
  const [products, setProducts] = useState([])
  const [productSearch, setProductSearch] = useState('')
  const [savingSku, setSavingSku] = useState(null)

  // --- Sección 3: blackout de China ---
  const [blackoutStart, setBlackoutStart] = useState('')
  const [blackoutEnd, setBlackoutEnd] = useState('')
  const [savingBlackout, setSavingBlackout] = useState(false)

  useEffect(() => {
    loadAll()
    return () => { if (flashTimer.current) clearTimeout(flashTimer.current) }
  }, [])

  // Mensaje efímero arriba de la página (se borra solo a los 3s)
  function showFlash(type, msg) {
    setFlash({ type, msg })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 3000)
  }

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [prodRes, paramsRes, supRes, settingsRes] = await Promise.all([
        supabase.from('products').select('sku, name').eq('type', 'component').order('sku'),
        supabase.from('purchase_params').select('sku, supplier'),
        supabase.from('suppliers').select('*').order('code'),
        supabase.from('app_settings').select('key, value').in('key', [BLACKOUT_START_KEY, BLACKOUT_END_KEY]),
      ])
      for (const r of [prodRes, paramsRes, supRes, settingsRes]) {
        if (r.error) throw new Error(r.error.message)
      }

      const params = paramsRes.data || []
      let supplierRows = supRes.data || []

      // Los proveedores que ya se usan en purchase_params pero todavía no existen en la tabla
      // suppliers se crean solos con is_china=false, para que queden editables desde acá.
      const known = new Set(supplierRows.map(s => s.code))
      const used = [...new Set(params.map(p => p.supplier).filter(Boolean))]
      const missing = used.filter(c => !known.has(c))
      if (missing.length > 0) {
        const { error: seedErr } = await supabase
          .from('suppliers')
          .upsert(missing.map(code => ({ code, name: code, is_china: false })), { onConflict: 'code' })
        if (seedErr) throw new Error(seedErr.message)
        const { data: reloaded, error: reErr } = await supabase.from('suppliers').select('*').order('code')
        if (reErr) throw new Error(reErr.message)
        supplierRows = reloaded || []
      }

      savedNames.current = Object.fromEntries(supplierRows.map(s => [s.code, s.name || '']))
      setProducts(prodRes.data || [])
      setParamRows(params)
      setSuppliers(supplierRows)

      const settings = Object.fromEntries((settingsRes.data || []).map(s => [s.key, s.value]))
      setBlackoutStart(settings[BLACKOUT_START_KEY] || '')
      setBlackoutEnd(settings[BLACKOUT_END_KEY] || '')
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  // sku -> proveedor asignado hoy en purchase_params
  const supplierBySku = useMemo(() => {
    const m = {}
    for (const p of paramRows) m[p.sku] = p.supplier || ''
    return m
  }, [paramRows])

  // code -> cuántos productos lo tienen asignado
  const productCounts = useMemo(() => {
    const m = {}
    for (const p of paramRows) {
      if (p.supplier) m[p.supplier] = (m[p.supplier] || 0) + 1
    }
    return m
  }, [paramRows])

  const chinaCodes = useMemo(
    () => new Set(suppliers.filter(s => s.is_china).map(s => s.code)),
    [suppliers]
  )

  // ============================================================
  // Sección 1 — proveedores
  // ============================================================

  // El checkbox guarda al instante: actualiza el estado local y revierte si la base falla
  async function toggleChina(code, value) {
    const before = suppliers
    setSuppliers(prev => prev.map(s => (s.code === code ? { ...s, is_china: value } : s)))
    const { error } = await supabase.from('suppliers').update({ is_china: value }).eq('code', code)
    if (error) {
      setSuppliers(before)
      showFlash('err', `Could not save ${code}: ${error.message}`)
    } else {
      showFlash('ok', `${code} ${value ? 'marked as China' : 'unmarked as China'}`)
    }
  }

  function editSupplierName(code, name) {
    setSuppliers(prev => prev.map(s => (s.code === code ? { ...s, name } : s)))
  }

  // Guarda el nombre al salir del input, solo si cambió respecto de lo guardado
  async function saveSupplierName(code) {
    const row = suppliers.find(s => s.code === code)
    if (!row) return
    const name = (row.name || '').trim()
    if (name === (savedNames.current[code] || '')) return
    const { error } = await supabase.from('suppliers').update({ name: name || null }).eq('code', code)
    if (error) {
      showFlash('err', `Could not save ${code}: ${error.message}`)
    } else {
      savedNames.current[code] = name
      showFlash('ok', `${code} renamed`)
    }
  }

  async function addSupplier() {
    const code = newSupplier.code.trim()
    if (!code) { showFlash('err', 'Supplier code is required'); return }
    if (suppliers.some(s => s.code.toLowerCase() === code.toLowerCase())) {
      showFlash('err', `Supplier "${code}" already exists`)
      return
    }
    setAddingSupplier(true)
    const row = { code, name: newSupplier.name.trim() || code, is_china: newSupplier.is_china }
    const { error } = await supabase.from('suppliers').insert(row)
    if (error) {
      showFlash('err', error.message)
    } else {
      setSuppliers(prev => [...prev, row].sort((a, b) => a.code.localeCompare(b.code)))
      savedNames.current[code] = row.name
      setNewSupplier({ code: '', name: '', is_china: false })
      showFlash('ok', `Supplier "${code}" added`)
    }
    setAddingSupplier(false)
  }

  // Solo se puede borrar un proveedor sin productos asignados, para no dejar SKUs huérfanos
  async function deleteSupplier(code) {
    const count = productCounts[code] || 0
    if (count > 0) {
      showFlash('err', `"${code}" has ${count} product${count === 1 ? '' : 's'} assigned. Reassign them first.`)
      return
    }
    if (!window.confirm(`Delete supplier "${code}"? This cannot be undone.`)) return
    const { error } = await supabase.from('suppliers').delete().eq('code', code)
    if (error) {
      showFlash('err', error.message)
    } else {
      setSuppliers(prev => prev.filter(s => s.code !== code))
      delete savedNames.current[code]
      showFlash('ok', `Supplier "${code}" deleted`)
    }
  }

  // ============================================================
  // Sección 2 — asignación producto -> proveedor
  // ============================================================

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase()
    if (!q) return products
    return products.filter(p =>
      p.sku.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)
    )
  }, [products, productSearch])

  // Opciones del dropdown. Si el SKU tiene un proveedor que ya no está en la tabla suppliers,
  // se agrega igual para que el select no muestre un valor distinto al real.
  function supplierOptions(current) {
    const codes = suppliers.map(s => s.code)
    if (current && !codes.includes(current)) codes.push(current)
    return codes
  }

  // Cambiar el dropdown guarda al instante en purchase_params.
  // Si el SKU todavía no tiene fila de parámetros, se crea con los defaults de la tabla.
  async function changeProductSupplier(sku, code) {
    const value = code || null
    const exists = paramRows.some(p => p.sku === sku)
    setSavingSku(sku)
    const { error } = exists
      ? await supabase
          .from('purchase_params')
          .update({ supplier: value, updated_at: new Date().toISOString() })
          .eq('sku', sku)
      : await supabase.from('purchase_params').insert({ sku, supplier: value })
    if (error) {
      showFlash('err', `Could not save ${sku}: ${error.message}`)
    } else {
      setParamRows(prev => exists
        ? prev.map(p => (p.sku === sku ? { ...p, supplier: value } : p))
        : [...prev, { sku, supplier: value }])
      showFlash('ok', `${sku} → ${value || 'no supplier'}`)
    }
    setSavingSku(null)
  }

  // ============================================================
  // Sección 3 — blackout de China
  // ============================================================

  async function saveBlackout() {
    if (blackoutStart && blackoutEnd && blackoutEnd < blackoutStart) {
      showFlash('err', 'Blackout End must be on or after Blackout Start')
      return
    }
    setSavingBlackout(true)
    const now = new Date().toISOString()
    const { error } = await supabase.from('app_settings').upsert([
      { key: BLACKOUT_START_KEY, value: blackoutStart || null, updated_at: now },
      { key: BLACKOUT_END_KEY, value: blackoutEnd || null, updated_at: now },
    ], { onConflict: 'key' })
    if (error) showFlash('err', error.message)
    else showFlash('ok', 'Blackout dates saved')
    setSavingBlackout(false)
  }

  if (loading) return <div style={styles.loading}>Loading admin data...</div>

  if (error) {
    return (
      <div>
        <h1 style={styles.pageTitle}>🏭 Suppliers</h1>
        <div style={styles.errorBox}>
          <strong>Could not load the data:</strong> {error}
          <div style={styles.errorHint}>
            If the error mentions <code>suppliers</code> or <code>app_settings</code>, run
            {' '}<code>supabase/admin_setup.sql</code> in the Supabase SQL Editor first.
          </div>
          <button style={styles.retryBtn} onClick={loadAll}>Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 style={styles.pageTitle}>🏭 Suppliers</h1>
      <p style={styles.pageDesc}>Suppliers, product assignment and global forecast settings</p>

      {flash && (
        <div style={{ ...styles.flash, ...(flash.type === 'ok' ? styles.flashOk : styles.flashErr) }}>
          {flash.type === 'ok' ? '✅' : '⚠️'} {flash.msg}
        </div>
      )}

      {/* ===================== SECCIÓN 1 ===================== */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>🏭 Supplier Management</h2>
        <p style={styles.cardDesc}>
          Suppliers already used in Parameters are listed automatically. Marking one as China
          flags it for the blackout rule below. Changes to the checkbox and the name save immediately.
        </p>

        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead style={styles.thead}>
              <tr>
                <th style={styles.th}>Supplier Code</th>
                <th style={styles.th}>Name</th>
                <th style={{ ...styles.th, textAlign: 'center' }}>Is China?</th>
                <th style={{ ...styles.th, textAlign: 'right' }}># Products</th>
                <th style={{ ...styles.th, textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s, i) => {
                const count = productCounts[s.code] || 0
                return (
                  <tr key={s.code} style={i % 2 === 0 ? styles.trEven : styles.trOdd}>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontWeight: 600 }}>{s.code}</td>
                    <td style={styles.td}>
                      <input
                        type="text"
                        value={s.name || ''}
                        onChange={e => editSupplierName(s.code, e.target.value)}
                        onBlur={() => saveSupplierName(s.code)}
                        style={styles.textInput}
                        placeholder="Supplier name"
                      />
                    </td>
                    <td style={{ ...styles.td, textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={!!s.is_china}
                        onChange={e => toggleChina(s.code, e.target.checked)}
                        style={styles.checkbox}
                      />
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      {count > 0 ? count : <span style={styles.muted}>0</span>}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'center' }}>
                      <button
                        style={{ ...styles.deleteBtn, ...(count > 0 ? styles.deleteBtnDisabled : null) }}
                        onClick={() => deleteSupplier(s.code)}
                        disabled={count > 0}
                        title={count > 0
                          ? `Reassign the ${count} product${count === 1 ? '' : 's'} before deleting`
                          : 'Delete this supplier'}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
              {suppliers.length === 0 && (
                <tr>
                  <td style={{ ...styles.td, textAlign: 'center', color: '#888' }} colSpan={5}>
                    No suppliers yet. Add the first one below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={styles.addRow}>
          <div style={styles.addField}>
            <label style={styles.label}>Code</label>
            <input
              type="text"
              value={newSupplier.code}
              onChange={e => setNewSupplier(s => ({ ...s, code: e.target.value }))}
              style={styles.input}
              placeholder="e.g. ACME"
            />
          </div>
          <div style={styles.addField}>
            <label style={styles.label}>Name</label>
            <input
              type="text"
              value={newSupplier.name}
              onChange={e => setNewSupplier(s => ({ ...s, name: e.target.value }))}
              style={styles.input}
              placeholder="e.g. Acme Manufacturing"
            />
          </div>
          <label style={styles.addCheck}>
            <input
              type="checkbox"
              checked={newSupplier.is_china}
              onChange={e => setNewSupplier(s => ({ ...s, is_china: e.target.checked }))}
              style={styles.checkbox}
            />
            Is China
          </label>
          <button style={styles.primaryBtn} onClick={addSupplier} disabled={addingSupplier}>
            {addingSupplier ? 'Adding...' : '+ Add'}
          </button>
        </div>
      </div>

      {/* ===================== SECCIÓN 2 ===================== */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>🔗 Product-Supplier Assignment</h2>
        <p style={styles.cardDesc}>
          Assign each component to a supplier. Changes save immediately to Parameters
          and apply to the next forecast run.
        </p>

        <div style={styles.filters}>
          <input
            type="text"
            value={productSearch}
            onChange={e => setProductSearch(e.target.value)}
            style={styles.searchInput}
            placeholder="Search by SKU or name..."
          />
          <span style={styles.count}>
            {filteredProducts.length} of {products.length} components
          </span>
        </div>

        <div style={{ ...styles.tableWrap, maxHeight: 460, overflowY: 'auto' }}>
          <table style={styles.table}>
            <thead style={styles.thead}>
              <tr>
                <th style={{ ...styles.th, ...styles.thSticky }}>SKU</th>
                <th style={{ ...styles.th, ...styles.thSticky }}>Name</th>
                <th style={{ ...styles.th, ...styles.thSticky }}>Supplier</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((p, i) => {
                const current = supplierBySku[p.sku] || ''
                return (
                  <tr key={p.sku} style={i % 2 === 0 ? styles.trEven : styles.trOdd}>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>{p.sku}</td>
                    <td style={styles.td}>{p.name}</td>
                    <td style={styles.td}>
                      <select
                        value={current}
                        onChange={e => changeProductSupplier(p.sku, e.target.value)}
                        disabled={savingSku === p.sku}
                        style={styles.select}
                      >
                        <option value="">— No supplier —</option>
                        {supplierOptions(current).map(code => (
                          <option key={code} value={code}>
                            {code}{chinaCodes.has(code) ? ' (China)' : ''}
                          </option>
                        ))}
                      </select>
                      {savingSku === p.sku && <span style={styles.savingTag}>saving...</span>}
                    </td>
                  </tr>
                )
              })}
              {filteredProducts.length === 0 && (
                <tr>
                  <td style={{ ...styles.td, textAlign: 'center', color: '#888' }} colSpan={3}>
                    No components match "{productSearch}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===================== SECCIÓN 3 ===================== */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>🇨🇳 China Blackout Dates</h2>
        <p style={styles.cardDesc}>
          Chinese New Year typically closes factories late January to mid February.
          Set the window your suppliers are closed.
        </p>

        <div style={styles.blackoutRow}>
          <div style={styles.addField}>
            <label style={styles.label}>Blackout Start</label>
            <input
              type="date"
              value={blackoutStart}
              onChange={e => setBlackoutStart(e.target.value)}
              style={styles.input}
            />
          </div>
          <div style={styles.addField}>
            <label style={styles.label}>Blackout End</label>
            <input
              type="date"
              value={blackoutEnd}
              onChange={e => setBlackoutEnd(e.target.value)}
              style={styles.input}
            />
          </div>
          <button style={styles.primaryBtn} onClick={saveBlackout} disabled={savingBlackout}>
            {savingBlackout ? 'Saving...' : '💾 Save'}
          </button>
        </div>

        <div style={styles.blackoutNote}>
          Orders to China suppliers during this period will be moved earlier in the Order Plan.
          {chinaCodes.size > 0 && (
            <div style={styles.blackoutSuppliers}>
              Currently flagged as China: {[...chinaCodes].sort().join(', ')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  loading: { padding: 40, color: '#666', textAlign: 'center' },
  pageTitle: { fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  pageDesc: { color: '#666', fontSize: 13, marginBottom: 24 },
  errorBox: { background: '#fff0f0', border: '1.5px solid #ffc9c9', borderRadius: 12, padding: 20, color: '#8a2020', fontSize: 13 },
  errorHint: { marginTop: 10, color: '#a05050', fontSize: 12, lineHeight: 1.5 },
  retryBtn: { marginTop: 14, background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  flash: { borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16 },
  flashOk: { background: '#e8f7ee', border: '1.5px solid #a8e0c0', color: '#1a7a4a' },
  flashErr: { background: '#fff0f0', border: '1.5px solid #ffc9c9', color: '#8a2020' },
  card: { background: '#fff', borderRadius: 12, padding: '20px 22px', marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  cardTitle: { fontSize: 17, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  cardDesc: { fontSize: 13, color: '#666', marginBottom: 16, lineHeight: 1.5 },
  tableWrap: { overflowX: 'auto', borderRadius: 10, border: '1px solid #eee' },
  table: { width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  thSticky: { position: 'sticky', top: 0, background: '#1a1a2e', zIndex: 1 },
  trEven: { background: '#fff', borderBottom: '1px solid #f0f0f0' },
  trOdd: { background: '#f8f9ff', borderBottom: '1px solid #f0f0f0' },
  td: { padding: '7px 14px', verticalAlign: 'middle' },
  muted: { color: '#bbb' },
  textInput: { width: '100%', maxWidth: 240, padding: '5px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13 },
  checkbox: { width: 16, height: 16, cursor: 'pointer', accentColor: '#1a1a2e' },
  deleteBtn: { background: 'transparent', border: '1.5px solid #e8b0b0', color: '#a33', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  deleteBtnDisabled: { borderColor: '#eee', color: '#ccc', cursor: 'not-allowed' },
  addRow: { display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 18, paddingTop: 18, borderTop: '1px solid #f0f0f0' },
  addField: { display: 'flex', flexDirection: 'column', gap: 6 },
  addCheck: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: '#555', paddingBottom: 8, cursor: 'pointer' },
  label: { fontSize: 12, fontWeight: 600, color: '#666' },
  input: { padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, minWidth: 180 },
  primaryBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  filters: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  searchInput: { padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, width: 280 },
  count: { fontSize: 12, color: '#888' },
  select: { padding: '5px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 170 },
  savingTag: { marginLeft: 8, fontSize: 11, color: '#888', fontStyle: 'italic' },
  blackoutRow: { display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' },
  blackoutNote: { marginTop: 18, padding: '12px 14px', background: '#fffbe6', border: '1.5px solid #ffe9a8', borderRadius: 8, fontSize: 12, color: '#7a6a2a', lineHeight: 1.5 },
  blackoutSuppliers: { marginTop: 8, fontWeight: 600, color: '#6a5a1a' },
}
