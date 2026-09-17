import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { supabase } from '../lib/supabase'

// Etiqueta para los kits que todavía no tienen filas en bom. Ojo: variant_group vive en la
// tabla bom (se repite en cada fila), no en products. Un kit sin componentes no tiene grupo.
const NO_GROUP = '— No variant group —'

export default function BOMEditor() {
  const [products, setProducts] = useState([])
  const [bomRows, setBomRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null) // { type: 'ok' | 'err', msg }
  const flashTimer = useRef(null)
  const rowSeq = useRef(0) // contador para las keys de React de las filas nuevas

  const [kitSearch, setKitSearch] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
  const [selectedKit, setSelectedKit] = useState(null)

  // Borrador del kit seleccionado (no se persiste hasta apretar Save Changes)
  const [draft, setDraft] = useState([])          // [{ key, id, component_sku, qty_per_kit }]
  const [draftGroup, setDraftGroup] = useState('')
  const [originalIds, setOriginalIds] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Alta de kit nuevo
  const [newKitOpen, setNewKitOpen] = useState(false)
  const [newKit, setNewKit] = useState({ sku: '', name: '', group: '', newGroup: '' })
  const [creatingKit, setCreatingKit] = useState(false)

  useEffect(() => {
    loadAll()
    return () => { if (flashTimer.current) clearTimeout(flashTimer.current) }
  }, [])

  function showFlash(type, msg) {
    setFlash({ type, msg })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 3500)
  }

  async function fetchAll() {
    const [prodRes, bomRes] = await Promise.all([
      supabase.from('products').select('sku, name, type').order('sku'),
      supabase.from('bom').select('id, kit_sku, component_sku, qty_per_kit, variant_group'),
    ])
    if (prodRes.error) throw new Error(prodRes.error.message)
    if (bomRes.error) throw new Error(bomRes.error.message)
    return { products: prodRes.data || [], bom: bomRes.data || [] }
  }

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const { products: p, bom: b } = await fetchAll()
      setProducts(p)
      setBomRows(b)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  // ============================================================
  // Derivados
  // ============================================================

  const productBySku = useMemo(() => {
    const m = {}
    for (const p of products) m[p.sku] = p
    return m
  }, [products])

  const kits = useMemo(() => products.filter(p => p.type === 'kit'), [products])

  // kit_sku -> variant_group. Se toma la primera fila de bom, igual que calcKitFamilySales
  // y SalesHistoryByKit, para que el agrupamiento coincida con el resto de la app.
  const groupByKit = useMemo(() => {
    const m = {}
    for (const b of bomRows) if (m[b.kit_sku] == null) m[b.kit_sku] = b.variant_group
    return m
  }, [bomRows])

  const countByKit = useMemo(() => {
    const m = {}
    for (const b of bomRows) m[b.kit_sku] = (m[b.kit_sku] || 0) + 1
    return m
  }, [bomRows])

  const variantGroups = useMemo(
    () => [...new Set(bomRows.map(b => b.variant_group).filter(Boolean))].sort(),
    [bomRows]
  )

  // Kits agrupados por variant_group, filtrados por el buscador.
  // El grupo de los kits sin componentes va siempre último.
  const groupedKits = useMemo(() => {
    const q = kitSearch.trim().toLowerCase()
    const matching = kits.filter(k =>
      !q || k.sku.toLowerCase().includes(q) || (k.name || '').toLowerCase().includes(q)
    )
    const byGroup = {}
    for (const k of matching) {
      const g = groupByKit[k.sku] || NO_GROUP
      ;(byGroup[g] = byGroup[g] || []).push(k)
    }
    return Object.entries(byGroup)
      .map(([group, items]) => ({ group, items: items.sort((a, b) => a.sku.localeCompare(b.sku)) }))
      .sort((a, b) => {
        if (a.group === NO_GROUP) return 1
        if (b.group === NO_GROUP) return -1
        return a.group.localeCompare(b.group)
      })
  }, [kits, groupByKit, kitSearch])

  // Problemas por fila. Mientras haya alguno, no se puede guardar.
  const rowIssues = useMemo(() => {
    const issues = {}
    const counts = {}
    for (const r of draft) {
      const sku = (r.component_sku || '').trim()
      if (sku) counts[sku] = (counts[sku] || 0) + 1
    }
    for (const r of draft) {
      const sku = (r.component_sku || '').trim()
      const qty = Number(r.qty_per_kit)
      if (!sku) issues[r.key] = 'Pick a component'
      else if (!productBySku[sku]) issues[r.key] = `"${sku}" is not in the products table`
      else if (sku === selectedKit) issues[r.key] = 'A kit cannot contain itself'
      else if (counts[sku] > 1) issues[r.key] = 'This component is already in the kit'
      else if (!(qty > 0)) issues[r.key] = 'Qty must be greater than 0'
    }
    return issues
  }, [draft, productBySku, selectedKit])

  const issueCount = Object.keys(rowIssues).length
  const groupMissing = draft.length > 0 && !draftGroup.trim()
  const canSave = dirty && !saving && issueCount === 0 && !groupMissing

  // ============================================================
  // Selección de kit y edición del borrador
  // ============================================================

  function buildDraft(rows, kitSku, groupOverride) {
    const mine = rows.filter(b => b.kit_sku === kitSku)
    setDraft(mine.map(r => ({
      key: `db-${r.id}`,
      id: r.id,
      component_sku: r.component_sku,
      qty_per_kit: r.qty_per_kit,
    })))
    setOriginalIds(mine.map(r => r.id))
    setDraftGroup(groupOverride != null ? groupOverride : (mine[0]?.variant_group || ''))
    setDirty(false)
  }

  // Cualquier salida del kit actual con cambios sin guardar pide confirmación
  function confirmDiscard() {
    if (!dirty) return true
    return window.confirm('You have unsaved changes in this kit. Discard them?')
  }

  function selectKit(sku) {
    if (sku === selectedKit) return
    if (!confirmDiscard()) return
    setSelectedKit(sku)
    buildDraft(bomRows, sku)
  }

  function toggleGroup(group) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  function updateRow(key, field, value) {
    setDraft(prev => prev.map(r => (r.key === key ? { ...r, [field]: value } : r)))
    setDirty(true)
  }

  function addRow() {
    rowSeq.current += 1
    setDraft(prev => [...prev, { key: `new-${rowSeq.current}`, id: null, component_sku: '', qty_per_kit: 1 }])
    setDirty(true)
  }

  // El borrado se aplica recién al guardar; el texto del confirm lo aclara
  function removeRow(key) {
    const row = draft.find(r => r.key === key)
    if (!row) return
    const label = (row.component_sku || '').trim() || 'this empty row'
    if (!window.confirm(`Remove ${label} from this kit?\n\nThe change is applied when you press Save Changes.`)) return
    setDraft(prev => prev.filter(r => r.key !== key))
    setDirty(true)
  }

  async function handleSave() {
    if (!selectedKit || !canSave) return
    setSaving(true)
    try {
      // 1) Borrar primero las filas quitadas. El orden importa: si un componente se borró
      //    y se volvió a agregar en la misma edición, hacerlo al revés borraría la fila recién
      //    actualizada por el upsert.
      const keptIds = new Set(draft.map(r => r.id).filter(Boolean))
      const removed = originalIds.filter(id => !keptIds.has(id))
      if (removed.length > 0) {
        const { error: delErr } = await supabase.from('bom').delete().in('id', removed)
        if (delErr) throw new Error(delErr.message)
      }

      // 2) Upsert del resto. variant_group se escribe igual en TODAS las filas del kit:
      //    es el valor que después lee el resto de la app para agrupar por familia.
      const group = draftGroup.trim()
      const payload = draft.map(r => ({
        kit_sku: selectedKit,
        component_sku: r.component_sku.trim(),
        qty_per_kit: Number(r.qty_per_kit),
        variant_group: group,
      }))
      if (payload.length > 0) {
        const { error: upErr } = await supabase
          .from('bom')
          .upsert(payload, { onConflict: 'kit_sku,component_sku' })
        if (upErr) throw new Error(upErr.message)
      }

      const fresh = await fetchAll()
      setProducts(fresh.products)
      setBomRows(fresh.bom)
      buildDraft(fresh.bom, selectedKit, group)
      showFlash('ok', `BOM saved — ${payload.length} component${payload.length === 1 ? '' : 's'}`)
    } catch (e) {
      showFlash('err', `Could not save: ${e.message}`)
    }
    setSaving(false)
  }

  // ============================================================
  // Alta de kit nuevo
  // ============================================================

  function openNewKit() {
    if (!confirmDiscard()) return
    setNewKit({ sku: '', name: '', group: variantGroups[0] || '__new__', newGroup: '' })
    setNewKitOpen(true)
  }

  async function createKit() {
    const sku = newKit.sku.trim()
    const name = newKit.name.trim()
    const group = (newKit.group === '__new__' ? newKit.newGroup : newKit.group).trim()
    if (!sku) { showFlash('err', 'Kit SKU is required'); return }
    if (!name) { showFlash('err', 'Kit name is required'); return }
    if (!group) { showFlash('err', 'Variant group is required'); return }
    // El SKU es PK de products, así que no puede existir ni como kit ni como componente
    const clash = products.find(p => p.sku.toLowerCase() === sku.toLowerCase())
    if (clash) {
      showFlash('err', `SKU "${clash.sku}" already exists as a ${clash.type} — "${clash.name}"`)
      return
    }

    setCreatingKit(true)
    const { error: insErr } = await supabase.from('products').insert({ sku, name, type: 'kit' })
    if (insErr) {
      showFlash('err', insErr.message)
      setCreatingKit(false)
      return
    }

    setProducts(prev => [...prev, { sku, name, type: 'kit' }].sort((a, b) => a.sku.localeCompare(b.sku)))
    setSelectedKit(sku)
    // El kit ya existe en products, pero el variant_group solo queda guardado cuando se
    // graba la primera fila de bom: por eso arranca con una fila vacía y en estado "sin guardar".
    rowSeq.current += 1
    setDraft([{ key: `new-${rowSeq.current}`, id: null, component_sku: '', qty_per_kit: 1 }])
    setOriginalIds([])
    setDraftGroup(group)
    setDirty(true)
    setNewKitOpen(false)
    setCreatingKit(false)
    showFlash('ok', `Kit "${sku}" created — add its components and press Save Changes`)
  }

  // ============================================================
  // Render
  // ============================================================

  if (loading) return <div style={styles.loading}>Loading BOM...</div>

  if (error) {
    return (
      <div>
        <h1 style={styles.pageTitle}>🧩 BOM</h1>
        <div style={styles.errorBox}>
          <strong>Could not load the data:</strong> {error}
          <button style={styles.retryBtn} onClick={loadAll}>Retry</button>
        </div>
      </div>
    )
  }

  const selectedProduct = selectedKit ? productBySku[selectedKit] : null

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>🧩 BOM</h1>
          <p style={styles.pageDesc}>
            Bill of materials: which components make up each kit. Used by the forecast to turn
            kit sales into component demand.
          </p>
        </div>
        <button style={styles.primaryBtn} onClick={openNewKit}>+ New Kit</button>
      </div>

      {flash && (
        <div style={{ ...styles.flash, ...(flash.type === 'ok' ? styles.flashOk : styles.flashErr) }}>
          {flash.type === 'ok' ? '✅' : '⚠️'} {flash.msg}
        </div>
      )}

      {/* Datalist compartido por todas las filas: buscador nativo de SKU */}
      <datalist id="bom-product-list">
        {products.map(p => (
          <option key={p.sku} value={p.sku}>{p.name} ({p.type})</option>
        ))}
      </datalist>

      {newKitOpen && (
        <div style={styles.newKitCard}>
          <h2 style={styles.cardTitle}>New Kit</h2>
          <div style={styles.newKitRow}>
            <div style={styles.field}>
              <label style={styles.label}>Kit SKU</label>
              <input
                type="text"
                value={newKit.sku}
                onChange={e => setNewKit(k => ({ ...k, sku: e.target.value }))}
                style={styles.input}
                placeholder="e.g. PM-BRAIN2-BL-67-008-HC2"
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Kit Name</label>
              <input
                type="text"
                value={newKit.name}
                onChange={e => setNewKit(k => ({ ...k, name: e.target.value }))}
                style={{ ...styles.input, minWidth: 260 }}
                placeholder="e.g. Brainpod 2.0 / 67'' / Black"
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Variant Group</label>
              <select
                value={newKit.group}
                onChange={e => setNewKit(k => ({ ...k, group: e.target.value }))}
                style={styles.input}
              >
                {variantGroups.map(g => <option key={g} value={g}>{g}</option>)}
                <option value="__new__">+ New group...</option>
              </select>
            </div>
            {newKit.group === '__new__' && (
              <div style={styles.field}>
                <label style={styles.label}>New Group Name</label>
                <input
                  type="text"
                  value={newKit.newGroup}
                  onChange={e => setNewKit(k => ({ ...k, newGroup: e.target.value }))}
                  style={styles.input}
                  placeholder="e.g. Brainpod 3.0"
                />
              </div>
            )}
            <button style={styles.primaryBtn} onClick={createKit} disabled={creatingKit}>
              {creatingKit ? 'Creating...' : 'Create'}
            </button>
            <button style={styles.ghostBtn} onClick={() => setNewKitOpen(false)}>Cancel</button>
          </div>
          <p style={styles.newKitNote}>
            The variant group is stored on the kit's BOM rows, not on the kit itself — it is
            saved once you add the first component and press Save Changes.
          </p>
        </div>
      )}

      <div style={styles.columns}>
        {/* ===================== LISTA DE KITS ===================== */}
        <div style={styles.listCol}>
          <div style={styles.card}>
            <input
              type="text"
              value={kitSearch}
              onChange={e => setKitSearch(e.target.value)}
              style={styles.searchInput}
              placeholder="Search kits by SKU or name..."
            />
            <div style={styles.kitCount}>
              {groupedKits.reduce((n, g) => n + g.items.length, 0)} of {kits.length} kits
            </div>
            <div style={styles.kitList}>
              {groupedKits.map(g => {
                const isCollapsed = collapsedGroups.has(g.group)
                return (
                  <Fragment key={g.group}>
                    <div style={styles.groupHeader} onClick={() => toggleGroup(g.group)}>
                      <span style={{ ...styles.caret, transform: isCollapsed ? 'none' : 'rotate(90deg)' }}>▶</span>
                      <span style={styles.groupName}>{g.group}</span>
                      <span style={styles.groupCount}>{g.items.length}</span>
                    </div>
                    {!isCollapsed && g.items.map(k => {
                      const n = countByKit[k.sku] || 0
                      return (
                        <div
                          key={k.sku}
                          style={{ ...styles.kitItem, ...(selectedKit === k.sku ? styles.kitItemActive : null) }}
                          onClick={() => selectKit(k.sku)}
                        >
                          <div style={styles.kitSku}>{k.sku}</div>
                          <div style={styles.kitName}>{k.name}</div>
                          <div style={n === 0 ? styles.kitCompsEmpty : styles.kitComps}>
                            {n} component{n === 1 ? '' : 's'}
                          </div>
                        </div>
                      )
                    })}
                  </Fragment>
                )
              })}
              {groupedKits.length === 0 && (
                <div style={styles.emptyList}>No kits match "{kitSearch}".</div>
              )}
            </div>
          </div>
        </div>

        {/* ===================== DETALLE DEL KIT ===================== */}
        <div style={styles.detailCol}>
          {!selectedKit ? (
            <div style={{ ...styles.card, ...styles.placeholder }}>
              Select a kit from the list to view and edit its components.
            </div>
          ) : (
            <div style={styles.card}>
              <div style={styles.detailHeader}>
                <div>
                  <h2 style={styles.cardTitle}>{selectedProduct?.name || selectedKit}</h2>
                  <div style={styles.detailSku}>{selectedKit}</div>
                </div>
                <div style={styles.detailActions}>
                  {dirty && <span style={styles.dirtyTag}>● Unsaved changes</span>}
                  <button
                    style={{ ...styles.primaryBtn, ...(canSave ? null : styles.btnDisabled) }}
                    onClick={handleSave}
                    disabled={!canSave}
                    title={
                      !dirty ? 'No changes to save'
                      : issueCount > 0 ? 'Fix the highlighted rows first'
                      : groupMissing ? 'Set a variant group first'
                      : 'Save this BOM'
                    }
                  >
                    {saving ? 'Saving...' : '💾 Save Changes'}
                  </button>
                </div>
              </div>

              <div style={styles.groupField}>
                <label style={styles.label}>Variant Group</label>
                <input
                  type="text"
                  list="bom-group-list"
                  value={draftGroup}
                  onChange={e => { setDraftGroup(e.target.value); setDirty(true) }}
                  style={{ ...styles.input, ...(groupMissing ? styles.inputError : null) }}
                  placeholder="e.g. Brainpod 2.0"
                />
                <datalist id="bom-group-list">
                  {variantGroups.map(g => <option key={g} value={g} />)}
                </datalist>
                <span style={styles.groupHint}>
                  Applied to every component row of this kit. Groups kits into families across the app.
                </span>
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead style={styles.thead}>
                    <tr>
                      <th style={styles.th}>Component SKU</th>
                      <th style={styles.th}>Component Name</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Qty per Kit</th>
                      <th style={{ ...styles.th, textAlign: 'center' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.map((r, i) => {
                      const issue = rowIssues[r.key]
                      const comp = productBySku[(r.component_sku || '').trim()]
                      return (
                        <tr key={r.key} style={i % 2 === 0 ? styles.trEven : styles.trOdd}>
                          <td style={styles.td}>
                            <input
                              type="text"
                              list="bom-product-list"
                              value={r.component_sku}
                              onChange={e => updateRow(r.key, 'component_sku', e.target.value)}
                              style={{ ...styles.skuInput, ...(issue ? styles.inputError : null) }}
                              placeholder="Type or pick a SKU"
                            />
                            {issue && <div style={styles.issueText}>{issue}</div>}
                          </td>
                          <td style={styles.td}>
                            {comp
                              ? <span>{comp.name} <span style={styles.typeTag}>{comp.type}</span></span>
                              : <span style={styles.muted}>—</span>}
                          </td>
                          <td style={{ ...styles.td, textAlign: 'right' }}>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              value={r.qty_per_kit}
                              onChange={e => updateRow(r.key, 'qty_per_kit', e.target.value)}
                              style={styles.qtyInput}
                            />
                          </td>
                          <td style={{ ...styles.td, textAlign: 'center' }}>
                            <button style={styles.deleteBtn} onClick={() => removeRow(r.key)}>Delete</button>
                          </td>
                        </tr>
                      )
                    })}
                    {draft.length === 0 && (
                      <tr>
                        <td style={{ ...styles.td, textAlign: 'center', color: '#888' }} colSpan={4}>
                          This kit has no components yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <button style={styles.addBtn} onClick={addRow}>+ Add Component</button>

              {issueCount > 0 && (
                <div style={styles.issueBanner}>
                  ⚠️ {issueCount} row{issueCount === 1 ? '' : 's'} need{issueCount === 1 ? 's' : ''} attention
                  before you can save.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  loading: { padding: 40, color: '#666', textAlign: 'center' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 20 },
  pageTitle: { fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 },
  pageDesc: { color: '#666', fontSize: 13, maxWidth: 620, lineHeight: 1.5 },
  errorBox: { background: '#fff0f0', border: '1.5px solid #ffc9c9', borderRadius: 12, padding: 20, color: '#8a2020', fontSize: 13 },
  retryBtn: { display: 'block', marginTop: 14, background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  flash: { borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16 },
  flashOk: { background: '#e8f7ee', border: '1.5px solid #a8e0c0', color: '#1a7a4a' },
  flashErr: { background: '#fff0f0', border: '1.5px solid #ffc9c9', color: '#8a2020' },
  columns: { display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' },
  listCol: { flex: '1 1 320px', minWidth: 300, maxWidth: 420 },
  detailCol: { flex: '3 1 520px', minWidth: 420 },
  card: { background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  cardTitle: { fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 2 },
  placeholder: { color: '#888', fontSize: 13, textAlign: 'center', padding: 48 },
  searchInput: { width: '100%', padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' },
  kitCount: { fontSize: 11, color: '#888', margin: '8px 0 10px' },
  kitList: { maxHeight: 560, overflowY: 'auto', margin: '0 -20px -18px', borderTop: '1px solid #f0f0f0' },
  groupHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: '#f4f5fa', borderBottom: '1px solid #e8e8ee', cursor: 'pointer', userSelect: 'none', position: 'sticky', top: 0 },
  caret: { fontSize: 9, color: '#888', transition: 'transform 0.15s', display: 'inline-block' },
  groupName: { fontSize: 12, fontWeight: 700, color: '#1a1a2e', flex: 1 },
  groupCount: { fontSize: 11, color: '#888', background: '#fff', borderRadius: 10, padding: '1px 8px' },
  kitItem: { padding: '9px 20px 9px 36px', borderBottom: '1px solid #f4f4f4', cursor: 'pointer' },
  kitItemActive: { background: '#eef2ff', borderLeft: '3px solid #1a1a2e', paddingLeft: 33 },
  kitSku: { fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: '#1a1a2e' },
  kitName: { fontSize: 12, color: '#666', marginTop: 1 },
  kitComps: { fontSize: 11, color: '#888', marginTop: 2 },
  kitCompsEmpty: { fontSize: 11, color: '#c08a20', marginTop: 2, fontWeight: 600 },
  emptyList: { padding: 24, textAlign: 'center', color: '#888', fontSize: 13 },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 },
  detailSku: { fontFamily: 'monospace', fontSize: 12, color: '#888' },
  detailActions: { display: 'flex', alignItems: 'center', gap: 12 },
  dirtyTag: { fontSize: 12, fontWeight: 700, color: '#c08a20', whiteSpace: 'nowrap' },
  groupField: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #f0f0f0' },
  groupHint: { fontSize: 11, color: '#999' },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 12, fontWeight: 600, color: '#666' },
  input: { padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, minWidth: 200 },
  inputError: { borderColor: '#e08080', background: '#fff8f8' },
  tableWrap: { overflowX: 'auto', borderRadius: 10, border: '1px solid #eee' },
  table: { width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '10px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  trEven: { background: '#fff', borderBottom: '1px solid #f0f0f0' },
  trOdd: { background: '#f8f9ff', borderBottom: '1px solid #f0f0f0' },
  td: { padding: '7px 14px', verticalAlign: 'top' },
  skuInput: { width: '100%', minWidth: 180, padding: '5px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box' },
  qtyInput: { width: 80, padding: '5px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, textAlign: 'right' },
  issueText: { fontSize: 11, color: '#c00', marginTop: 3, fontWeight: 600 },
  typeTag: { fontSize: 10, color: '#888', background: '#f0f0f4', borderRadius: 4, padding: '1px 6px', marginLeft: 6 },
  muted: { color: '#bbb' },
  deleteBtn: { background: 'transparent', border: '1.5px solid #e8b0b0', color: '#a33', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  addBtn: { marginTop: 14, background: '#f0f2f8', border: '1.5px dashed #c0c6d8', color: '#1a1a2e', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  primaryBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  ghostBtn: { background: 'transparent', border: '1.5px solid #d8d8e0', color: '#666', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnDisabled: { background: '#c8ccd8', cursor: 'not-allowed' },
  issueBanner: { marginTop: 14, padding: '10px 14px', background: '#fff4d5', border: '1.5px solid #f0c040', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#8a5a00' },
  newKitCard: { background: '#fffbe6', border: '1.5px solid #ffe9a8', borderRadius: 12, padding: '18px 20px', marginBottom: 20 },
  newKitRow: { display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 },
  newKitNote: { marginTop: 14, fontSize: 12, color: '#7a6a2a', lineHeight: 1.5 },
}
