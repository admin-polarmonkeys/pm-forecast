import { useState, useEffect } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'

const TODAY = new Date().toISOString().split('T')[0]

function pad2(n) { return String(n).padStart(2, '0') }

// Arma 'YYYY-MM-DD' solo si (y, m, d) es una fecha real y cae en una ventana razonable
// (3 años atrás / 1 año adelante). La ventana evita falsos positivos con números sueltos
// del nombre del archivo (versiones, números de reporte, etc.).
function buildDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
  const now = new Date()
  const min = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate())
  const max = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
  if (dt < min || dt > max) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

// Años de 2 dígitos -> 2000s (NetSuite exporta "26" por 2026)
function expandYear(yy) { return yy < 100 ? 2000 + yy : yy }

// Intenta deducir la fecha del snapshot desde el nombre del archivo.
// NetSuite suele embeberla: "Inventory_090326.csv" (MMDDYY),
// "CurrentInventorySnapshot322.csv" (MDD del año en curso), "Inventory_2026-09-03.csv".
// Devuelve 'YYYY-MM-DD' o null si no encuentra nada válido.
export function detectDateFromFilename(filename) {
  if (!filename) return null
  const base = String(filename).replace(/\.[^.]+$/, '') // saca la extensión
  const thisYear = new Date().getFullYear()

  // a) ISO: 2026-09-03 / 2026_09_03 / 20260903
  let m = base.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/)
  if (m) {
    const d = buildDate(Number(m[1]), Number(m[2]), Number(m[3]))
    if (d) return d
  }

  // b) Con separadores: 9-3-26 / 09_03_2026 / 9.3.26
  m = base.match(/(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})/)
  if (m) {
    const d = buildDate(expandYear(Number(m[3])), Number(m[1]), Number(m[2]))
    if (d) return d
  }

  // c) Bloques de dígitos pegados, del más largo/específico al más corto
  for (const run of base.match(/\d+/g) || []) {
    let d = null
    if (run.length === 8) {          // MMDDYYYY (YYYYMMDD ya lo cubrió el patrón a)
      d = buildDate(Number(run.slice(4)), Number(run.slice(0, 2)), Number(run.slice(2, 4)))
    } else if (run.length === 6) {   // MMDDYY
      d = buildDate(expandYear(Number(run.slice(4))), Number(run.slice(0, 2)), Number(run.slice(2, 4)))
    } else if (run.length === 5) {   // MDDYY
      d = buildDate(expandYear(Number(run.slice(3))), Number(run.slice(0, 1)), Number(run.slice(1, 3)))
    } else if (run.length === 4) {   // MMDD, año en curso
      d = buildDate(thisYear, Number(run.slice(0, 2)), Number(run.slice(2)))
    } else if (run.length === 3) {   // MDD, año en curso
      d = buildDate(thisYear, Number(run.slice(0, 1)), Number(run.slice(1)))
    }
    if (d) return d
  }
  return null
}

export default function UploadData() {
  const [salesFile, setSalesFile] = useState(null)
  const [inventoryFile, setInventoryFile] = useState(null)
  const [costFile, setCostFile] = useState(null)
  const [unfulfilled, setUnfulfilled] = useState([{ sku: '', qty: '' }])
  const [snapshotDate, setSnapshotDate] = useState(TODAY)
  // 'filename' = la fecha salió del nombre del archivo; null = default de hoy o editada a mano
  const [dateSource, setDateSource] = useState(null)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  // SKUs del archivo de inventario que todavía no existen en products
  const [newSkus, setNewSkus] = useState([])            // [{ sku, description, snapshot }]
  const [newSkuSelected, setNewSkuSelected] = useState({}) // sku -> bool
  const [addingNewSkus, setAddingNewSkus] = useState(false)
  const [newSkuResult, setNewSkuResult] = useState(null)

  // Inventario en tránsito (persistente en Supabase)
  const [transitOrders, setTransitOrders] = useState([])
  const [transitForm, setTransitForm] = useState({ sku: '', qty: '', expected_date: '', notes: '' })
  const [transitSaving, setTransitSaving] = useState(false)

  useEffect(() => { loadTransitOrders() }, [])

  async function loadTransitOrders() {
    const { data, error } = await supabase
      .from('transit_orders')
      .select('*')
      .order('expected_date', { ascending: true })
    if (!error) setTransitOrders(data || [])
  }

  async function addTransitOrder() {
    const sku = transitForm.sku.trim()
    const qty = parseInt(transitForm.qty)
    if (!sku || !qty) {
      setError('In Transit: SKU and Qty are required')
      return
    }
    setTransitSaving(true)
    setError(null)
    const { error } = await supabase.from('transit_orders').insert({
      sku,
      qty,
      expected_date: transitForm.expected_date || null,
      notes: transitForm.notes.trim() || null,
    })
    if (error) {
      setError(`In Transit: ${error.message}`)
    } else {
      setTransitForm({ sku: '', qty: '', expected_date: '', notes: '' })
      await loadTransitOrders()
    }
    setTransitSaving(false)
  }

  async function deleteTransitOrder(id) {
    const { error } = await supabase.from('transit_orders').delete().eq('id', id)
    if (error) setError(`In Transit: ${error.message}`)
    else await loadTransitOrders()
  }

  // Parse Report Pundit CSV (wide format: SKU + months as columns).
  // Soporta dos formatos:
  //   A) Header de UNA fila: cada celda combina mes + "Net Quantity" (ej "Jan 2026 Net Quantity")
  //   B) Header de DOS filas: fila 1 = meses ("Jan 2026"...), fila 2 = "Net Quantity" debajo de cada mes
  function parseSalesCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // quitar BOM
    const parsed = Papa.parse(text, { skipEmptyLines: true })
    const rows = parsed.data
    if (rows.length < 2) throw new Error('Invalid sales CSV')

    const monthNames = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 }

    // "Jan 2026" / "January 2026" exacto -> { month, year } (null si no matchea)
    function parseMonthCell(cell) {
      const h = String(cell || '').toLowerCase().trim()
      for (const [abbr, num] of Object.entries(monthNames)) {
        const m = h.match(new RegExp(`^${abbr}[a-z]*\\s*(\\d{4})$`))
        if (m) return { month: num, year: parseInt(m[1]) }
      }
      return null
    }
    // ¿La celda contiene un mes + año en cualquier parte? (para localizar la fila de header)
    function hasMonthToken(cell) {
      return /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{4}/i.test(String(cell || ''))
    }

    // Fila que contiene los nombres de mes (fila 1 en formato B, única header en formato A)
    let headerIdx = 0
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      if (rows[i].some(hasMonthToken)) { headerIdx = i; break }
    }

    const headerRow = rows[headerIdx]
    const subHeaderRow = rows[headerIdx + 1] || []

    // Formato B: la fila siguiente trae "Net Quantity" como sub-header -> los datos arrancan 2 filas más abajo
    const isTwoRowHeader = subHeaderRow.some(c => /net\s*quantity/i.test(String(c || '')))
    const dataStartIdx = isTwoRowHeader ? headerIdx + 2 : headerIdx + 1

    // Columna SKU: "SKU" exacto en la fila 1; si no, cualquier celda que contenga "sku"
    let skuColIdx = headerRow.findIndex(h => /^\s*sku\s*$/i.test(String(h || '')))
    if (skuColIdx === -1) skuColIdx = headerRow.findIndex(h => /sku/i.test(String(h || '')))
    if (skuColIdx === -1) throw new Error('No SKU column found in the sales CSV')

    // Columnas de mes desde la fila 1 (formato B): "Jan 2026", "Feb 2026", etc.
    const monthCols = []
    for (let i = 0; i < headerRow.length; i++) {
      const parsedMonth = parseMonthCell(headerRow[i])
      if (parsedMonth) monthCols.push({ colIdx: i, month: parsedMonth.month, year: parsedMonth.year })
    }

    // Fallback formato A: header de una fila con mes + "Net Quantity" en la misma celda
    if (monthCols.length === 0) {
      for (let i = 0; i < headerRow.length; i++) {
        const h = String(headerRow[i] || '').toLowerCase().trim()
        if (!/net.*qty|quantity/i.test(h)) continue
        for (const [abbr, num] of Object.entries(monthNames)) {
          const m = h.match(new RegExp(`${abbr}[a-z]*\\s*(\\d{4})`))
          if (m) {
            monthCols.push({ colIdx: i, month: num, year: parseInt(m[1]) })
            break
          }
        }
      }
    }

    if (monthCols.length === 0) throw new Error('No month columns found in the CSV')

    // Filas de datos. Sumamos cantidades de SKUs duplicados para el mismo mes.
    const skuSales = {}
    for (let i = dataStartIdx; i < rows.length; i++) {
      const row = rows[i]
      const sku = row[skuColIdx]?.trim()
      if (!sku || !sku.startsWith('PM-')) continue

      for (const { colIdx, month, year } of monthCols) {
        const qty = parseInt(String(row[colIdx] ?? '').replace(/,/g, '')) || 0 // quitar separador de miles
        if (qty === 0) continue
        const key = `${sku}-${year}-${month}`
        if (!skuSales[key]) skuSales[key] = { sku, year, month, qty_fulfilled: 0 }
        skuSales[key].qty_fulfilled += qty
      }
    }

    return Object.values(skuSales)
  }

  // Parse NetSuite inventory CSV ("Current Inventory Snapshot").
  // Formato actual (posicional, sin header usable):
  //   filas 1-6  metadata (razón social, título del reporte, filas vacías)
  //   fila 7     "Item ,Description ,"        <- ojo: espacios al final
  //   fila 8     "  ,,On Hand "               <- la columna de cantidad vive acá
  //   fila 9     "Inventory Item,,"           <- fila de categoría
  //   fila 10+   "PM-CHIL-008-HC,Chiller 0.8 HP,12"
  // Como el header está partido en dos filas, leemos por índice de columna:
  //   0 = SKU, 1 = Description, 2 = On Hand
  function parseInventoryCSV(text) {
    // Strip BOM character (U+FEFF) so the first cell isn't prefixed with an invisible char
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

    const parsed = Papa.parse(text, { header: false, skipEmptyLines: true })
    const rows = parsed.data

    // "1,234.00" -> 1234 ; vacío / no numérico -> 0
    const cleanQty = val => {
      const n = parseFloat(String(val ?? '').replace(/[,\s]/g, ''))
      return isNaN(n) ? 0 : Math.round(n)
    }

    const records = []
    let hasQtyCol = false // ¿alguna fila trae dato en la col 2? (los formatos viejos no la tienen)
    for (const row of rows) {
      // Toda fila de datos arranca con el SKU; metadata y headers no matchean "PM-"
      const sku = String(row[0] ?? '').trim()
      if (!sku.startsWith('PM-')) continue

      if (String(row[2] ?? '').trim() !== '') hasQtyCol = true

      records.push({
        sku,
        // se usa como products.name al dar de alta SKUs nuevos
        description: String(row[1] ?? '').trim(),
        qty_physical: cleanQty(row[2]),
        // transit sale solo de la tabla transit_orders; este archivo no lo trae
        qty_transit: 0,
      })
    }

    // qty_unfulfilled_with_stock no se toca acá: viene del formulario manual.

    // Si no hay filas PM-, o la columna 2 no existe/está vacía, el archivo no es de este
    // formato: probamos los formatos viejos por nombre de header. Sin este segundo chequeo
    // un CSV viejo (que también tiene el SKU en la col 0) importaría todo en 0.
    if (records.length === 0 || !hasQtyCol) {
      console.log('parseInventoryCSV: no matchea el formato posicional, probando formato con header')
      const fallback = parseInventoryCSVWithHeader(text)
      if (fallback.length > 0) return fallback
    }

    return records
  }

  // Fallback: formatos viejos de NetSuite con header de una sola fila
  function parseInventoryCSVWithHeader(text) {
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: header => header.trim(), // strip whitespace (e.g. trailing space on "Quantity ")
    })
    const records = []

    // Log the first row's keys to verify headers parsed correctly
    if (parsed.data.length > 0) {
      console.log('parseInventoryCSV headers:', Object.keys(parsed.data[0]))
    }

    for (const row of parsed.data) {
      // Try common NetSuite column names
      const sku = String(row['Item'] || row['Name'] || row['SKU'] || row['Item Name'] || '').trim()
      if (!sku || !sku.startsWith('PM-')) continue

      const physical = parseInt(
        row['Quantity'] || row['Total Quantity'] || row['Quantity On Hand'] || row['On Hand'] || row['Physical'] || 0
      ) || 0
      const description = String(row['Description'] || row['Display Name'] || row['Item Name'] || '').trim()
      // transit no viene en este CSV de NetSuite; por ahora siempre 0
      const transit = 0

      records.push({ sku, description, qty_physical: physical, qty_transit: transit })
    }

    return records
  }

  // Parse Cost List CSV (Item, FOB Cost, Landed Average)
  function parseCostCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // quitar BOM
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: header => header.trim(),
    })

    // "$1,234.50" -> 1234.5 ; vacío -> null
    const cleanNum = val => {
      if (val == null || String(val).trim() === '') return null
      const n = parseFloat(String(val).replace(/[$,\s]/g, ''))
      return isNaN(n) ? null : n
    }

    const records = []
    for (const row of parsed.data) {
      const sku = (row['Item'] || row['SKU'] || row['Name'] || '').trim()
      if (!sku || !sku.startsWith('PM-')) continue

      const fob = cleanNum(row['FOB Cost'])
      const landed = cleanNum(row['Landed Average'])

      // Saltar filas donde ambos costos son 0 o vacíos
      if (!fob && !landed) continue

      records.push({ sku, fob_cost_usd: fob, landed_cost_usd: landed })
    }
    return records
  }

  async function handleUpload() {
    if (!salesFile && !inventoryFile && !costFile) {
      setError('Upload at least one file')
      return
    }
    setLoading(true)
    setError(null)
    setResults(null)
    setNewSkus([])
    setNewSkuResult(null)

    try {
      let salesCount = 0
      let inventoryCount = 0
      let costCount = 0

      // Process sales CSV
      if (salesFile) {
        const text = await salesFile.text()
        const records = parseSalesCSV(text)

        if (records.length > 0) {
          const { error } = await supabase
            .from('sales_history')
            .upsert(records, { onConflict: 'sku,year,month' })
          if (error) throw new Error(`Sales error: ${error.message}`)
          salesCount = records.length
        }
      }

      // Process inventory CSV + manual unfulfilled
      if (inventoryFile) {
        const text = await inventoryFile.text()
        const records = parseInventoryCSV(text)

        // Merge manual unfulfilled
        const unfulfilledMap = {}
        for (const row of unfulfilled) {
          if (row.sku && row.qty) unfulfilledMap[row.sku.trim()] = parseInt(row.qty) || 0
        }

        // Tránsito: suma de todas las transit_orders por SKU (en vez de 0)
        const transitMap = {}
        for (const t of transitOrders) {
          transitMap[t.sku] = (transitMap[t.sku] || 0) + (t.qty || 0)
        }

        // Fila de inventory_snapshots a partir de un registro del CSV
        const toSnapshotRow = r => ({
          sku: r.sku,
          snapshot_date: snapshotDate,
          qty_physical: r.qty_physical,
          qty_transit: transitMap[r.sku] || 0,
          qty_unfulfilled_with_stock: unfulfilledMap[r.sku] || 0,
        })

        // Detectar SKUs nuevos: están en el archivo pero no en el catálogo products.
        // inventory_snapshots.sku tiene FK a products, así que los nuevos NO se pueden
        // guardar todavía — se separan y se ofrecen para dar de alta en el panel de abajo.
        const { data: existingProducts, error: prodErr } = await supabase
          .from('products')
          .select('sku')
        if (prodErr) throw new Error(`Inventory error: ${prodErr.message}`)
        const knownSkus = new Set((existingProducts || []).map(p => p.sku))

        const finalRecords = records.filter(r => knownSkus.has(r.sku)).map(toSnapshotRow)
        const pendingSkus = records
          .filter(r => !knownSkus.has(r.sku))
          .map(r => ({ sku: r.sku, description: r.description || '', snapshot: toSnapshotRow(r) }))

        if (finalRecords.length > 0) {
          const { error } = await supabase
            .from('inventory_snapshots')
            .upsert(finalRecords, { onConflict: 'sku,snapshot_date' })
          if (error) throw new Error(`Inventory error: ${error.message}`)
          inventoryCount = finalRecords.length
        }

        if (pendingSkus.length > 0) {
          setNewSkus(pendingSkus)
          setNewSkuSelected(Object.fromEntries(pendingSkus.map(r => [r.sku, true]))) // todos tildados por defecto
        }
      }

      // Process cost list CSV — solo actualiza SKUs que ya existen en purchase_params
      if (costFile) {
        const text = await costFile.text()
        const records = parseCostCSV(text)

        if (records.length > 0) {
          const { data: existing, error: exErr } = await supabase
            .from('purchase_params')
            .select('sku')
          if (exErr) throw new Error(`Cost error: ${exErr.message}`)

          const existingSkus = new Set((existing || []).map(r => r.sku))
          const toUpsert = records.filter(r => existingSkus.has(r.sku))

          if (toUpsert.length > 0) {
            const { error } = await supabase
              .from('purchase_params')
              .upsert(toUpsert, { onConflict: 'sku' })
            if (error) throw new Error(`Cost error: ${error.message}`)
          }
          costCount = toUpsert.length
        }
      }

      setResults({ salesCount, inventoryCount, costCount })
      setSalesFile(null)
      setInventoryFile(null)
      setCostFile(null)
      setDateSource(null)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  function toggleNewSku(sku) {
    setNewSkuSelected(prev => ({ ...prev, [sku]: !prev[sku] }))
  }

  function ignoreNewSkus() {
    setNewSkus([])
    setNewSkuResult(null)
  }

  // Alta de SKUs nuevos: catálogo + parámetros por defecto + su stock del archivo.
  // El orden importa: purchase_params e inventory_snapshots tienen FK a products.
  async function addSelectedNewSkus() {
    const selected = newSkus.filter(r => newSkuSelected[r.sku])
    if (selected.length === 0) {
      setError('Select at least one SKU to add')
      return
    }
    setAddingNewSkus(true)
    setError(null)

    try {
      // 1. Catálogo. products.name es NOT NULL: si el CSV no trae descripción, usamos el SKU
      const { error: prodErr } = await supabase.from('products').insert(
        selected.map(r => ({
          sku: r.sku,
          name: r.description || r.sku,
          type: 'component',
          is_active: true,
        }))
      )
      if (prodErr) throw new Error(prodErr.message)

      // 2. Parámetros de compra por defecto
      const { error: paramsErr } = await supabase.from('purchase_params').insert(
        selected.map(r => ({
          sku: r.sku,
          lead_time_weeks: 12,
          coverage_target_months: 3,
          growth_factor: 1.40,
          moq: 1,
        }))
      )
      if (paramsErr) throw new Error(paramsErr.message)

      // 3. Ya existen en products, así que ahora sí se puede guardar su stock del archivo
      const { error: invErr } = await supabase
        .from('inventory_snapshots')
        .upsert(selected.map(r => r.snapshot), { onConflict: 'sku,snapshot_date' })
      if (invErr) throw new Error(invErr.message)

      setNewSkuResult(
        `${selected.length} new product${selected.length === 1 ? '' : 's'} added to the system with default purchase params and their stock from the file`
      )
      setResults(prev => (prev ? { ...prev, inventoryCount: prev.inventoryCount + selected.length } : prev))
      setNewSkus([])
    } catch (err) {
      setError(`New products error: ${err.message}`)
    }
    setAddingNewSkus(false)
  }

  function addUnfulfilled() {
    setUnfulfilled([...unfulfilled, { sku: '', qty: '' }])
  }

  // Al elegir el CSV de inventario, intenta sacar la fecha del nombre del archivo.
  // Si no la encuentra, deja hoy como default y el aviso queda visible para que se confirme.
  function handleInventoryFile(file) {
    setInventoryFile(file || null)
    if (!file) { setDateSource(null); return }
    const detected = detectDateFromFilename(file.name)
    if (detected) {
      setSnapshotDate(detected)
      setDateSource('filename')
    } else {
      setDateSource(null)
    }
  }

  function updateUnfulfilled(idx, field, val) {
    const updated = [...unfulfilled]
    updated[idx][field] = val
    setUnfulfilled(updated)
  }

  function removeUnfulfilled(idx) {
    setUnfulfilled(unfulfilled.filter((_, i) => i !== idx))
  }

  // El aviso aparece cuando hay archivo de inventario cargado y la fecha sigue siendo
  // el default de hoy sin haberse detectado del nombre del archivo.
  const showDateWarning = !!inventoryFile && dateSource !== 'filename' && snapshotDate === TODAY

  return (
    <div>
      <h1 style={styles.pageTitle}>⬆️ Upload Data</h1>
      <p style={styles.pageDesc}>Upload the monthly files to update the forecast</p>

      <div style={styles.grid}>
        {/* Sales CSV */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>📊 Fulfilled Sales</h2>
          <p style={styles.cardDesc}>CSV exported from Report Pundit (Shopify)</p>
          <div style={styles.uploadZone} onClick={() => document.getElementById('sales-input').click()}>
            {salesFile ? (
              <span style={styles.fileName}>✅ {salesFile.name}</span>
            ) : (
              <span style={styles.uploadPrompt}>Click to select CSV</span>
            )}
          </div>
          <input
            id="sales-input"
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={e => setSalesFile(e.target.files[0])}
          />
        </div>

        {/* Inventory CSV */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>📦 NetSuite Inventory</h2>
          <p style={styles.cardDesc}>CSV exported from NetSuite (physical + in transit)</p>
          <div style={styles.uploadZone} onClick={() => document.getElementById('inv-input').click()}>
            {inventoryFile ? (
              <span style={styles.fileName}>✅ {inventoryFile.name}</span>
            ) : (
              <span style={styles.uploadPrompt}>Click to select CSV</span>
            )}
          </div>
          <input
            id="inv-input"
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={e => handleInventoryFile(e.target.files[0])}
          />
          <div style={{ ...styles.dateField, ...(showDateWarning ? styles.dateFieldAlert : null) }}>
            <label style={styles.dateLabel}>📅 Snapshot date</label>
            <input
              type="date"
              value={snapshotDate}
              onChange={e => { setSnapshotDate(e.target.value); setDateSource(null) }}
              style={{ ...styles.dateInput, ...(showDateWarning ? styles.dateInputAlert : null) }}
            />
            {showDateWarning && (
              <div style={styles.dateWarning}>
                ⚠️ Confirm the snapshot date matches your NetSuite report date
              </div>
            )}
            {inventoryFile && dateSource === 'filename' && (
              <div style={styles.dateNote}>✓ Date detected from filename</div>
            )}
          </div>
        </div>
      </div>

      {/* Cost List CSV */}
      <div style={{ ...styles.card, marginTop: 24 }}>
        <h2 style={styles.cardTitle}>💰 Cost List</h2>
        <p style={styles.cardDesc}>
          CSV with columns "Item", "FOB Cost" and "Landed Average". Updates costs only for SKUs
          that already exist in Parameters (purchase_params). Rows with both costs at $0 or empty are skipped.
        </p>
        <div style={styles.uploadZone} onClick={() => document.getElementById('cost-input').click()}>
          {costFile ? (
            <span style={styles.fileName}>✅ {costFile.name}</span>
          ) : (
            <span style={styles.uploadPrompt}>Click to select CSV</span>
          )}
        </div>
        <input
          id="cost-input"
          type="file"
          accept=".csv"
          style={{ display: 'none' }}
          onChange={e => setCostFile(e.target.files[0])}
        />
      </div>

      {/* Inventario en Tránsito (persistente) */}
      <div style={{ ...styles.card, marginTop: 24 }}>
        <h2 style={styles.cardTitle}>🚢 Inventory In Transit</h2>
        <p style={styles.transitNote}>
          These orders persist across sessions. Delete them manually when the inventory arrives.
        </p>
        <p style={styles.cardDesc}>
          When processing the inventory snapshot, the sum of these orders per SKU is used as in-transit quantity.
        </p>

        {/* Formulario para agregar */}
        <div style={styles.transitForm}>
          <input
            placeholder="PM-..."
            value={transitForm.sku}
            onChange={e => setTransitForm({ ...transitForm, sku: e.target.value })}
            style={{ ...styles.input, flex: 2 }}
          />
          <input
            type="number"
            placeholder="Qty"
            value={transitForm.qty}
            onChange={e => setTransitForm({ ...transitForm, qty: e.target.value })}
            style={{ ...styles.input, flex: 1 }}
          />
          <input
            type="date"
            value={transitForm.expected_date}
            onChange={e => setTransitForm({ ...transitForm, expected_date: e.target.value })}
            style={{ ...styles.input, flex: 1.5 }}
          />
          <input
            placeholder="Notes (optional)"
            value={transitForm.notes}
            onChange={e => setTransitForm({ ...transitForm, notes: e.target.value })}
            style={{ ...styles.input, flex: 2 }}
          />
          <button style={styles.transitAddBtn} onClick={addTransitOrder} disabled={transitSaving}>
            {transitSaving ? '...' : 'Add'}
          </button>
        </div>

        {/* Tabla de órdenes existentes */}
        {transitOrders.length > 0 ? (
          <table style={styles.transitTable}>
            <thead>
              <tr>
                <th style={styles.transitTh}>SKU</th>
                <th style={{ ...styles.transitTh, textAlign: 'right' }}>Qty</th>
                <th style={styles.transitTh}>Expected Date</th>
                <th style={styles.transitTh}>Notes</th>
                <th style={styles.transitTh}></th>
              </tr>
            </thead>
            <tbody>
              {transitOrders.map(t => (
                <tr key={t.id} style={styles.transitTr}>
                  <td style={{ ...styles.transitTd, fontFamily: 'monospace', fontSize: 12 }}>{t.sku}</td>
                  <td style={{ ...styles.transitTd, textAlign: 'right', fontWeight: 600 }}>{t.qty}</td>
                  <td style={styles.transitTd}>{t.expected_date || '—'}</td>
                  <td style={{ ...styles.transitTd, color: '#666' }}>{t.notes || '—'}</td>
                  <td style={{ ...styles.transitTd, textAlign: 'right' }}>
                    <button style={styles.removeBtn} onClick={() => deleteTransitOrder(t.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={styles.transitEmpty}>No in-transit orders registered.</p>
        )}
      </div>

      {/* Unfulfilled manual */}
      <div style={{ ...styles.card, marginTop: 24 }}>
        <h2 style={styles.cardTitle}>⚠️ Unfulfilled Orders with Physical Stock</h2>
        <p style={styles.cardDesc}>
          Manually enter the orders pending fulfillment that already have stock allocated in the warehouse.
          These are deducted from the real available inventory.
        </p>
        <div style={styles.unfulfilledList}>
          {unfulfilled.map((row, idx) => (
            <div key={idx} style={styles.unfulfilledRow}>
              <input
                placeholder="SKU (e.g. PM-CHIL-008-HC)"
                value={row.sku}
                onChange={e => updateUnfulfilled(idx, 'sku', e.target.value)}
                style={{ ...styles.input, flex: 2 }}
              />
              <input
                type="number"
                placeholder="Qty"
                value={row.qty}
                onChange={e => updateUnfulfilled(idx, 'qty', e.target.value)}
                style={{ ...styles.input, flex: 1 }}
              />
              <button style={styles.removeBtn} onClick={() => removeUnfulfilled(idx)}>✕</button>
            </div>
          ))}
          <button style={styles.addBtn} onClick={addUnfulfilled}>+ Add SKU</button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {results && (
        <div style={styles.success}>
          ✅ Upload successful — {results.salesCount} sales records, {results.inventoryCount} inventory SKUs
          {results.costCount > 0 && `, ${results.costCount} cost SKUs`} updated
        </div>
      )}

      {newSkus.length > 0 && (
        <div style={styles.newSkuPanel}>
          <div style={styles.newSkuTitle}>
            ⚠️ Found {newSkus.length} new product{newSkus.length === 1 ? '' : 's'} in the inventory file not yet in the system
          </div>
          <p style={styles.newSkuDesc}>
            Their stock was <strong>not</strong> imported: a SKU must exist in the catalog first.
            Add them below and their quantities from this file will be saved too.
          </p>
          <div style={styles.newSkuList}>
            {newSkus.map(r => (
              <label key={r.sku} style={styles.newSkuRow}>
                <input
                  type="checkbox"
                  checked={!!newSkuSelected[r.sku]}
                  onChange={() => toggleNewSku(r.sku)}
                />
                <span style={styles.newSkuCode}>{r.sku}</span>
                <span style={styles.newSkuName}>{r.description || <em>(no description in file)</em>}</span>
                <span style={styles.newSkuQty}>{r.snapshot.qty_physical} on hand</span>
              </label>
            ))}
          </div>
          <div style={styles.newSkuActions}>
            <button style={styles.newSkuAddBtn} onClick={addSelectedNewSkus} disabled={addingNewSkus}>
              {addingNewSkus ? 'Adding...' : 'Add selected to system'}
            </button>
            <button style={styles.newSkuIgnoreBtn} onClick={ignoreNewSkus} disabled={addingNewSkus}>
              Ignore
            </button>
          </div>
        </div>
      )}
      {newSkuResult && <div style={styles.success}>✅ {newSkuResult}</div>}

      <button style={styles.uploadBtn} onClick={handleUpload} disabled={loading}>
        {loading ? 'Processing...' : '⬆️ Process and Save'}
      </button>
    </div>
  )
}

const styles = {
  pageTitle: { fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 6 },
  pageDesc: { color: '#666', fontSize: 14, marginBottom: 32 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 },
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  cardTitle: { fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 6 },
  cardDesc: { fontSize: 13, color: '#666', marginBottom: 16 },
  uploadZone: {
    border: '2px dashed #d0d5e8',
    borderRadius: 8,
    padding: '24px 16px',
    textAlign: 'center',
    cursor: 'pointer',
    background: '#f8f9ff',
    transition: 'border-color 0.2s',
  },
  uploadPrompt: { color: '#8899cc', fontSize: 14 },
  fileName: { color: '#1a7a4a', fontSize: 14, fontWeight: 600 },
  dateField: { marginTop: 16, padding: 12, borderRadius: 8, background: '#f7f8fa', border: '1.5px solid #e8e8ec' },
  dateFieldAlert: { background: '#fffaf0', borderColor: '#f0c040' },
  dateLabel: { display: 'block', fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 6 },
  dateInput: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 14, width: '100%', boxSizing: 'border-box' },
  dateInputAlert: { borderColor: '#f0c040', background: '#fff' },
  dateWarning: { marginTop: 8, padding: '8px 10px', background: '#fff4d5', border: '1.5px solid #f0c040', borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#8a5a00', lineHeight: 1.4 },
  dateNote: { marginTop: 8, fontSize: 12, fontWeight: 600, color: '#1a7a4a' },
  unfulfilledList: { display: 'flex', flexDirection: 'column', gap: 10 },
  unfulfilledRow: { display: 'flex', gap: 10, alignItems: 'center' },
  input: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 14 },
  removeBtn: { background: '#fee', border: '1px solid #fcc', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', color: '#c00' },
  addBtn: { background: 'transparent', border: '1.5px dashed #c0c8e0', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', color: '#5566aa', fontSize: 13, alignSelf: 'flex-start', marginTop: 4 },
  transitNote: { fontSize: 12, color: '#7a5a1a', background: '#fffbe6', border: '1px solid #ffe9a8', borderRadius: 6, padding: '8px 12px', marginBottom: 12 },
  transitForm: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' },
  transitAddBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  transitTable: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  transitTh: { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#888', borderBottom: '2px solid #eee', whiteSpace: 'nowrap' },
  transitTr: { borderBottom: '1px solid #f0f0f0' },
  transitTd: { padding: '8px 12px', color: '#333', verticalAlign: 'middle' },
  transitEmpty: { fontSize: 13, color: '#999', fontStyle: 'italic' },
  newSkuPanel: { background: '#fffbe6', border: '1px solid #ffe9a8', borderRadius: 8, padding: '16px 18px', marginTop: 20 },
  newSkuTitle: { fontSize: 14, fontWeight: 700, color: '#7a5a1a', marginBottom: 6 },
  newSkuDesc: { fontSize: 12, color: '#8a6a2a', marginBottom: 14 },
  newSkuList: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto', marginBottom: 14 },
  newSkuRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, background: '#fff', border: '1px solid #f0e4c0', borderRadius: 6, padding: '7px 10px', cursor: 'pointer' },
  newSkuCode: { fontWeight: 600, color: '#1a1a2e', minWidth: 160 },
  newSkuName: { color: '#666', flex: 1 },
  newSkuQty: { color: '#888', fontSize: 12, whiteSpace: 'nowrap' },
  newSkuActions: { display: 'flex', gap: 10 },
  newSkuAddBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  newSkuIgnoreBtn: { background: 'transparent', color: '#7a5a1a', border: '1.5px solid #e0cf9a', borderRadius: 6, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, border: '1px solid #fcc', marginTop: 20 },
  success: { background: '#f0fff4', color: '#1a7a4a', padding: '12px 16px', borderRadius: 8, fontSize: 13, border: '1px solid #9de', marginTop: 20 },
  uploadBtn: {
    marginTop: 24,
    background: '#1a1a2e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '12px 28px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
}
