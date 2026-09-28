import { useState, useEffect, useMemo, Fragment } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { useColumnWidths, ResizableTh, ResetWidthsButton } from '../lib/useColumnWidths'
import {
  runForecast,
  calcTotalComponentDemand,
  resolveAvgSalesMonths,
  resolveTrimExtremes,
  AVG_SALES_MONTHS_KEY,
  DEFAULT_AVG_SALES_MONTHS,
  TRIM_EXTREMES_KEY,
  DEFAULT_TRIM_EXTREMES,
  TRIM_MIN_KEPT_MONTHS,
} from '../lib/forecast'

const SUPPLIERS = ['All', 'SV', 'HAW', 'GUGU', 'HIM', 'TAR', 'DAR', 'WAT', 'WES', 'NING', 'UP', 'ALI', 'SIR', 'SC']

// Filtros de SKU guardados por el usuario en localStorage. Formato: [{ name, skus: [] }]
// El banner verde de "Guardado OK" se esconde solo después de esto.
// El banner rojo de error NO se esconde nunca por tiempo.
const SAVE_INFO_TIMEOUT_MS = 4000

const SAVED_FILTERS_KEY = 'pm_forecast_filters'
const MAX_SAVED_FILTERS = 10

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem(SAVED_FILTERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Validamos la forma de cada entrada por si el storage quedó corrupto
    return parsed
      .filter(f => f && typeof f.name === 'string' && Array.isArray(f.skus))
      .slice(0, MAX_SAVED_FILTERS)
  } catch {
    return []
  }
}

// Definición de columnas: key = campo del registro, align = alineación.
// param: true -> columna de input (header gris) para distinguir de los outputs (header oscuro)
const COLUMNS = [
  { key: 'sku', label: 'SKU', align: 'left' },
  { key: 'name', label: 'Name', align: 'left' },
  { key: 'supplier', label: 'Supplier', align: 'left' },
  { key: 'avg_monthly_sales_total', label: 'Avg Sales/Mo', align: 'right' },
  { key: 'projected_monthly_demand', label: 'Projected/Mo', align: 'right' },
  { key: 'qty_available_real', label: 'Available', align: 'right' },
  { key: 'qty_transit', label: 'In Transit', align: 'right' },
  { key: 'days_of_inventory', label: 'Days of Inventory', align: 'right' },
  { key: 'growth_factor', label: 'Growth Factor', align: 'right', param: true },
  { key: 'lead_time_weeks', label: 'Lead Time (wk)', align: 'right', param: true },
  { key: 'coverage_target_months', label: 'Coverage Target', align: 'right', param: true },
  { key: 'months_coverage_current', label: 'Months Coverage', align: 'right' },
  { key: 'available_coverage', label: 'Available Coverage', align: 'right' },
  { key: 'qty_suggested', label: 'Suggested Order', align: 'right' },
  { key: 'order_by_days', label: 'Order By', align: 'right' },
  { key: 'total_landed_cost', label: 'Total Landed', align: 'right' },
]

// Anchos por defecto de cada columna (px). El usuario puede redimensionarlas arrastrando.
const DEFAULT_COL_WIDTHS = {
  sku: 120,
  name: 200,
  supplier: 110,
  avg_monthly_sales_total: 120,
  projected_monthly_demand: 130,
  qty_available_real: 100,
  qty_transit: 90,
  days_of_inventory: 130,
  growth_factor: 110,
  lead_time_weeks: 110,
  coverage_target_months: 120,
  months_coverage_current: 130,
  available_coverage: 150,
  qty_suggested: 120,
  order_by_days: 130,
  total_landed_cost: 120,
}

// Arma el texto COMPLETO del error que devuelve Supabase.
// PostgREST manda message + code + details + hint por separado; mostrar solo
// `message` esconde justo la parte que dice qué columna o constraint falló.
function dbErrorText(prefix, err) {
  if (!err) return prefix
  const lines = [prefix]
  if (err.message) lines.push(`message: ${err.message}`)
  if (err.code) lines.push(`code: ${err.code}`)
  if (err.details) lines.push(`details: ${err.details}`)
  if (err.hint) lines.push(`hint: ${err.hint}`)
  return lines.join('\n')
}

function fmt(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n)
}

function fmtCurrency(n) {
  if (n == null || n === 0) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function coverageColor(months) {
  if (months == null) return '#f0f0f0'
  if (months <= 1) return '#ffd5d5'
  if (months <= 2) return '#ffecd5'
  if (months <= 3) return '#fff9d5'
  return '#d5f5e3'
}

// Cobertura solo con stock disponible (sin contar tránsito) = disponible / demanda proyectada mensual.
// Complementa a months_coverage_current, que sí incluye el tránsito.
function availableCoverage(r) {
  const proj = r.projected_monthly_demand
  if (!proj || proj === 0) return null
  return r.qty_available_real / proj
}

// Días de inventario = (disponible + tránsito) / demanda proyectada mensual × 30
function daysOfInventory(r) {
  const proj = r.projected_monthly_demand
  if (!proj || proj === 0) return null
  return Math.round((r.qty_available_real + r.qty_transit) / proj * 30)
}

function daysColor(d) {
  if (d == null) return undefined
  if (d < 30) return '#ffd5d5'   // rojo
  if (d <= 60) return '#ffecd5'  // naranja
  if (d <= 90) return '#fff9d5'  // amarillo
  return '#d5f5e3'               // verde
}

// Abreviaturas de mes en español para formatear "DD MMM YYYY" (ej. "15 Jul 2026")
const MONTHS_ES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatOrderDate(d) {
  const dd = String(d.getDate()).padStart(2, '0')
  return `${dd} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}`
}

// "Pedir Antes De": fecha límite para colocar la orden considerando lead time del proveedor.
// days_until_order = (months_coverage_current - coverage_target_months)*30 - lead_time_weeks*7
// La fecha es hoy + max(0, días). Devuelve también `days` (clamp >= 0, null si no aplica) para ordenar.
function orderByInfo(r) {
  // Sin orden sugerida: no aplica
  if (!r.qty_suggested || r.qty_suggested === 0) {
    return { text: '—', color: undefined, bold: false, days: null }
  }
  const cov = r.months_coverage_current
  // Sin cobertura actual: hay que pedir ya
  if (cov == null || cov === 0) {
    return { text: 'NOW ⚠️', color: '#c00', bold: true, days: 0 }
  }
  const target = r.coverage_target_months || 0
  const lead = r.lead_time_weeks || 0
  const daysUntil = (cov - target) * 30 - lead * 7
  if (daysUntil <= 0) {
    return { text: 'NOW ⚠️', color: '#c00', bold: true, days: 0 }
  }
  const d = new Date()
  d.setDate(d.getDate() + Math.round(daysUntil))
  let color = '#1f9d57'           // verde > 60 días
  let bold = false
  if (daysUntil <= 30) { color = '#c00'; bold = true }  // rojo negrita ≤ 30 días
  else if (daysUntil <= 60) { color = '#e08600' }       // naranja 31–60 días
  return { text: formatOrderDate(d), color, bold, days: Math.round(daysUntil) }
}

// Explica en una frase qué pasó con el recorte en esta serie. Cuando NO se recortó,
// dice por qué: apagado en la config, o la regla de piso lo impidió.
function trimStatusText(detail) {
  if (!detail) return ''
  if (detail.trim_applied) {
    return `Recorte aplicado: se descartaron el mes más alto y el más bajo. El promedio divide por los ${detail.kept_count} meses que quedaron, no por ${detail.months_used}.`
  }
  if (detail.trim_skipped_reason === 'config') {
    return `Sin recorte: está apagado en la configuración (Trim = 0). Entran los ${detail.months_used} meses de la ventana.`
  }
  if (detail.trim_skipped_reason === 'floor') {
    return `Sin recorte aunque se pidió: con una ventana de ${detail.months_used} meses quedarían ${detail.months_used - 2}, menos del mínimo de ${TRIM_MIN_KEPT_MONTHS}. Por la regla de piso no se recorta y entran los ${detail.months_used} meses.`
  }
  if (detail.trim_skipped_reason === 'no_data') {
    return 'Sin recorte: no hay ningún registro de ventas en la base, así que no hay serie para recortar.'
  }
  return ''
}

// Serie mensual de la ventana. Los meses recortados se muestran tachados y en gris,
// con la marca de si fueron el extremo alto o bajo. Debajo, la cuenta que da el promedio.
function MonthStrip({ detail }) {
  if (!detail || !detail.series || detail.series.length === 0) {
    return <div style={styles.stripEmpty}>Sin serie mensual: no hay registros de ventas.</div>
  }
  return (
    <>
      <div style={styles.strip}>
        {detail.series.map(mo => {
          const out = mo.trimmed !== null
          const label = `${MONTHS_ES[mo.month - 1]} ${String(mo.year).slice(2)}`
          return (
            <div
              key={mo.period}
              style={{ ...styles.stripCell, ...(out ? styles.stripCellOut : null) }}
              title={out
                ? `${label}: ${mo.qty} unidades — RECORTADO (${mo.trimmed === 'high' ? 'mes más alto' : 'mes más bajo'})`
                : `${label}: ${mo.qty} unidades — entra al promedio`}
            >
              <div style={styles.stripMonth}>{label}</div>
              <div style={{ ...styles.stripQty, ...(out ? styles.stripQtyOut : null) }}>{mo.qty}</div>
              <div style={styles.stripMark}>
                {mo.trimmed === 'high' ? '▲ alto' : mo.trimmed === 'low' ? '▼ bajo' : ''}
              </div>
            </div>
          )
        })}
      </div>
      <div style={styles.stripMath}>
        {fmt(detail.kept_total)} ÷ {detail.kept_count} {detail.kept_count === 1 ? 'mes' : 'meses'}
        {' = '}<strong>{fmt(detail.avg)}</strong>
      </div>
    </>
  )
}

export default function ForecastView() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [results, setResults] = useState([])
  // Ventana global del promedio de ventas. Arranca con el valor guardado en
  // app_settings (editable en Parameters) y se puede pisar acá solo para esta sesión,
  // igual que el "Quick adjust" de los otros parámetros: no se guarda en Supabase.
  // Un override por SKU en purchase_params.avg_sales_months siempre tiene prioridad.
  const [avgMonthsGlobal, setAvgMonthsGlobal] = useState(DEFAULT_AVG_SALES_MONTHS)
  const [avgMonthsSaved, setAvgMonthsSaved] = useState(DEFAULT_AVG_SALES_MONTHS)
  // SKU cuyo desglose de Avg Sales/Mo está abierto en el panel lateral (null = cerrado)
  const [breakdownSku, setBreakdownSku] = useState(null)
  // Resultado del guardado en la base: confirma cuántas filas escribió, o queda null
  const [saveInfo, setSaveInfo] = useState(null)
  // Aviso no bloqueante de la carga (p. ej. app_settings ilegible -> ventana por default)
  const [dataWarning, setDataWarning] = useState(null)
  // Recorte de extremos global, con la misma mecánica que la ventana: arranca del
  // valor guardado y se puede pisar solo para esta sesión.
  const [trimGlobal, setTrimGlobal] = useState(DEFAULT_TRIM_EXTREMES)
  const [trimSaved, setTrimSaved] = useState(DEFAULT_TRIM_EXTREMES)
  // Kit cuya serie mensual está expandida dentro del panel de desglose
  const [expandedKit, setExpandedKit] = useState(null)

  // Ventana global efectiva: reusa la misma cadena de resolución del motor.
  // Si el input del header quedó vacío cae al valor guardado, y si ese tampoco
  // existe, al default (12). Nunca devuelve '' ni NaN, que romperían el INSERT
  // en forecast_runs (columnas INT).
  const effectiveAvgMonths = resolveAvgSalesMonths({
    skuOverride: avgMonthsGlobal,
    globalSetting: avgMonthsSaved,
  })
  // Mismo patrón para el recorte: lo elegido en el header > lo guardado > 0
  const effectiveTrim = resolveTrimExtremes({
    skuOverride: trimGlobal,
    globalSetting: trimSaved,
  })
  const [filterSupplier, setFilterSupplier] = useState('All')
  const [filterOnlyOrders, setFilterOnlyOrders] = useState(false)
  const [search, setSearch] = useState('')
  const [snapshotDate, setSnapshotDate] = useState(null)
  const [sortKey, setSortKey] = useState('qty_suggested')
  const [sortDir, setSortDir] = useState('desc')
  // selectedSkus === null significa "todos seleccionados" (sin filtro). Un Set significa selección explícita.
  const [selectedSkus, setSelectedSkus] = useState(null)
  const [skuFilterOpen, setSkuFilterOpen] = useState(false)
  const [skuSearch, setSkuSearch] = useState('')
  // Filtros guardados (localStorage), nombre del filtro activo, y estado del input para guardar uno nuevo
  const [savedFilters, setSavedFilters] = useState(loadSavedFilters)
  const [activeFilterName, setActiveFilterName] = useState(null)
  const [savingFilter, setSavingFilter] = useState(false)
  const [newFilterName, setNewFilterName] = useState('')
  // Ajuste rápido (what-if): overrides temporales que se aplican a todos los SKUs sin guardar en Supabase.
  // Vacío = no se toca ese parámetro. Growth Factor arranca en 1.40.
  const [quickGrowth, setQuickGrowth] = useState('1.40')
  const [quickLeadTime, setQuickLeadTime] = useState('')
  const [quickCoverage, setQuickCoverage] = useState('')
  // Anchos de columna: estado + persistencia + reset, compartido con el resto de las tablas
  const cols = useColumnWidths('forecast', DEFAULT_COL_WIDTHS)
  const colWidths = cols.widths

  useEffect(() => { loadData() }, [])

  // Al correr un forecast nuevo, volvemos a "todos seleccionados" y limpiamos el filtro activo
  useEffect(() => { setSelectedSkus(null); setActiveFilterName(null) }, [results])

  // El aviso de guardado exitoso se esconde solo a los 4 segundos: confirma que se
  // guardó y después deja de ocupar lugar. El banner de error no se toca acá —
  // se limpia recién al arrancar la próxima corrida, en handleRunForecast.
  useEffect(() => {
    if (!saveInfo) return
    const timer = setTimeout(() => setSaveInfo(null), SAVE_INFO_TIMEOUT_MS)
    // Se cancela si llega un aviso nuevo antes de los 4 s o si se desmonta la página,
    // así no queda un timer viejo apagando el aviso siguiente.
    return () => clearTimeout(timer)
  }, [saveInfo])

  async function loadData({ refresh = false } = {}) {
    // refresh: no usamos el loading de pantalla completa para no ocultar los resultados actuales
    refresh ? setRefreshing(true) : setLoading(true)
    setError(null)
    setDataWarning(null)
    try {
      const [products, bom, sales, inventory, params, transit, latestRun, settings] = await Promise.all([
        supabase.from('products').select('*'),
        supabase.from('bom').select('*'),
        supabase.from('sales_history').select('*'),
        supabase.from('inventory_snapshots').select('*').order('snapshot_date', { ascending: false }),
        supabase.from('purchase_params').select('*'),
        supabase.from('transit_orders').select('sku, qty'),
        supabase.from('forecast_runs').select('id').order('created_at', { ascending: false }).limit(1),
        supabase.from('app_settings').select('key, value').in('key', [AVG_SALES_MONTHS_KEY, TRIM_EXTREMES_KEY]),
      ])

      // Todas estas consultas alimentan números que se usan para decidir compras.
      // Un error silencioso acá produce un forecast que PARECE válido y no lo es:
      // sin sales_history la demanda da 0, sin inventory el stock da 0 y se sobre-ordena.
      // Por eso cortan la carga en vez de seguir con datos incompletos.
      for (const [label, res] of [
        ['products', products],
        ['bom', bom],
        ['sales_history', sales],
        ['inventory_snapshots', inventory],
        ['purchase_params', params],
        ['transit_orders', transit],
        ['forecast_runs', latestRun],
      ]) {
        if (res.error) {
          console.error(`[${label}]`, res.error)
          throw new Error(dbErrorText(`Falló la consulta a ${label}. No se cargaron los datos.`, res.error))
        }
      }

      // app_settings es tabla nueva (ver supabase/admin_setup.sql) y puede no existir todavía,
      // así que su error NO corta la carga — pero sí se avisa, porque sin ese valor la ventana
      // del promedio cae al default en vez de ser la que está guardada en Parameters.
      if (settings.error) {
        console.error('[app_settings]', settings.error)
        setDataWarning(dbErrorText(
          `No se pudo leer app_settings: la ventana del promedio cae al default de ${DEFAULT_AVG_SALES_MONTHS} meses ` +
          `y el recorte de extremos a ${DEFAULT_TRIM_EXTREMES}, que pueden no ser los que configuraste en Parameters. ` +
          'Verificá los valores del header antes de correr.',
          settings.error
        ))
      }

      // Valores globales desde app_settings. Si una key no existe todavía, cae a su default.
      // En un refresh reseteamos los overrides de sesión: el usuario pidió los datos guardados.
      const settingsByKey = Object.fromEntries((settings.data || []).map(x => [x.key, x.value]))
      const storedMonths = resolveAvgSalesMonths({ globalSetting: settingsByKey[AVG_SALES_MONTHS_KEY] })
      setAvgMonthsSaved(storedMonths)
      setAvgMonthsGlobal(storedMonths)
      const storedTrim = resolveTrimExtremes({ globalSetting: settingsByKey[TRIM_EXTREMES_KEY] })
      setTrimSaved(storedTrim)
      setTrimGlobal(storedTrim)

      // Get latest snapshot date
      const latestDate = inventory.data?.[0]?.snapshot_date || null
      setSnapshotDate(latestDate)

      // Filter inventory to latest snapshot only
      const latestInventory = latestDate
        ? inventory.data.filter(r => r.snapshot_date === latestDate)
        : []

      // Órdenes confirmadas (status "ordenado") de la ÚLTIMA corrida cuentan como tránsito:
      // ya están pedidas pero todavía no figuran en transit_orders. Se suman al qty_transit existente.
      // Nota: order_status se guarda como 'ordenado' (no 'ordered') — ver STATUS_OPTIONS en PurchaseOrders.jsx.
      const lastRunId = latestRun.data?.[0]?.id || null
      let confirmedTransit = []
      if (lastRunId) {
        const { data: confirmedOrders, error: confirmedErr } = await supabase
          .from('purchase_orders')
          .select('sku, confirmed_qty')
          .eq('run_id', lastRunId)
          .eq('order_status', 'ordenado')
          .gt('confirmed_qty', 0)

        // Esta consulta alimenta la columna In Transit. Si falla en silencio, el tránsito
        // queda SUBESTIMADO (faltan las órdenes ya confirmadas), el stock actual se ve más
        // bajo de lo real y la orden sugerida sale INFLADA: se vuelve a pedir algo que ya
        // está pedido. Por eso corta la carga en vez de mostrar un número equivocado.
        if (confirmedErr) {
          console.error('[purchase_orders confirmadas -> In Transit]', confirmedErr)
          throw new Error(dbErrorText(
            'Falló la consulta de órdenes confirmadas, que alimenta la columna In Transit. ' +
            'No se cargaron los datos para no calcular con un tránsito incompleto: eso subestima ' +
            'el tránsito e infla la orden sugerida, llevando a pedir de más algo ya ordenado.',
            confirmedErr
          ))
        }
        // GROUP BY sku: sumamos confirmed_qty por SKU del lado del cliente
        const sumBySku = {}
        for (const o of (confirmedOrders || [])) {
          sumBySku[o.sku] = (sumBySku[o.sku] || 0) + (o.confirmed_qty || 0)
        }
        confirmedTransit = Object.entries(sumBySku).map(([sku, qty]) => ({ sku, qty }))
      }

      // runForecast suma qty por SKU sobre transitOrders, así que concatenar las confirmadas
      // incrementa el qty_transit de cada SKU sin lógica extra de merge.
      const mergedTransit = [...(transit.data || []), ...confirmedTransit]

      setData({
        products: products.data || [],
        bomRows: bom.data || [],
        salesHistory: sales.data || [],
        inventorySnapshot: latestInventory,
        purchaseParams: params.data || [],
        transitOrders: mergedTransit,
      })
    } catch (err) {
      setError(err.message)
    }
    refresh ? setRefreshing(false) : setLoading(false)
  }

  async function handleRunForecast() {
    if (!data) return
    setRunning(true)
    setError(null)
    setSaveInfo(null)
    try {
      const forecast = runForecast({
        ...data,
        avgSalesMonthsGlobal: effectiveAvgMonths,
        trimExtremesGlobal: effectiveTrim,
      })

      // El cálculo se muestra siempre, incluso si después falla el guardado.
      // Antes esto se hacía al final, así que un guardado fallido no se distinguía
      // de uno exitoso: la tabla se llenaba igual.
      setResults(forecast)

      // Save run to DB
      const { data: run, error: runErr } = await supabase
        .from('forecast_runs')
        .insert({
          snapshot_date: snapshotDate || new Date().toISOString().split('T')[0],
          // months_history queda por compatibilidad: ForecastHistory y PurchaseOrders
          // todavía leen esa columna. avg_sales_months es la ventana global real usada.
          months_history: effectiveAvgMonths,
          avg_sales_months: effectiveAvgMonths,
          trim_extremes: effectiveTrim,
          notes: `Run manual ${new Date().toLocaleDateString()}`,
        })
        .select()
        .single()

      if (runErr || !run) {
        // Antes este caso caía en un `if (!runErr && run)` que salteaba todo sin avisar
        console.error('[forecast_runs insert]', runErr)
        setError(dbErrorText(
          'El forecast se calculó y se muestra abajo, pero NO se guardó nada: falló el insert en forecast_runs.',
          runErr
        ))
        return
      }

      {
        // fob_cost_usd no viene en los resultados del forecast; lo tomamos de purchase_params
        const paramsBySku = {}
        for (const p of (data.purchaseParams || [])) paramsBySku[p.sku] = p

        const orders = forecast
          .filter(r => r.qty_suggested > 0)
          .map(r => {
            // Costos desde purchase_params (no desde los resultados del forecast)
            const params = paramsBySku[r.sku] || {}
            const landedCost = params.landed_cost_usd ?? null
            const fobCost = params.fob_cost_usd ?? null
            return {
              run_id: run.id,
              sku: r.sku,
              avg_monthly_sales: r.avg_monthly_sales_total,
              projected_monthly_demand: r.projected_monthly_demand,
              qty_available_real: r.qty_available_real,
              qty_transit: r.qty_transit,
              months_coverage_current: r.months_coverage_current,
              qty_suggested: r.qty_suggested,
              // Recalculado acá, no desde el motor de forecast
              total_landed_cost: landedCost != null ? r.qty_suggested * landedCost : null,
              supplier: r.supplier,
              // Parámetros usados en el cálculo — se persisten para el panel de detalle
              growth_factor: r.growth_factor,
              lead_time_weeks: r.lead_time_weeks,
              coverage_target_months: r.coverage_target_months,
              moq: r.moq,
              avg_monthly_sales_direct: r.avg_monthly_sales_direct,
              avg_monthly_sales_derived: r.avg_monthly_sales_derived,
              fob_cost_usd: fobCost,
              landed_cost_usd: landedCost,
            }
          })

        const runTag = String(run.id).slice(0, 8)

        if (orders.length === 0) {
          setSaveInfo(`Run ${runTag}… guardado. Ningún SKU necesita orden, así que no había filas para guardar en purchase_orders.`)
          return
        }

        // .select('id') devuelve las filas realmente escritas: así el conteo lo
        // confirma la base, no la suposición de que el insert anduvo.
        const { data: inserted, error: ordersErr } = await supabase
          .from('purchase_orders')
          .insert(orders)
          .select('id')

        if (ordersErr) {
          // Logueamos también la primera fila del payload: sirve para ver qué se mandó
          console.error('[purchase_orders insert]', ordersErr, 'primera fila del payload:', orders[0])
          setError(dbErrorText(
            `El run ${runTag}… se guardó, pero las ${orders.length} filas de purchase_orders NO. ` +
            'Lo que ves en la tabla es solo el cálculo en memoria.',
            ordersErr
          ))
          return
        }

        const savedCount = inserted?.length ?? 0
        if (savedCount !== orders.length) {
          console.error('[purchase_orders insert] guardado parcial', { enviadas: orders.length, confirmadas: savedCount })
          setError(
            `Guardado parcial en purchase_orders: se enviaron ${orders.length} filas y la base confirmó ${savedCount}. ` +
            `Run ${runTag}…`
          )
          return
        }

        setSaveInfo(`Guardado OK: run ${runTag}… con ${savedCount} SKUs en purchase_orders.`)
      }
    } catch (err) {
      console.error('[handleRunForecast]', err)
      setError(dbErrorText('Error corriendo el forecast.', err))
    } finally {
      // finally: los return tempranos de arriba no deben dejar el botón trabado
      setRunning(false)
    }
  }

  // Ajuste rápido (what-if): pisa growth/lead time/coverage de TODOS los SKUs en el estado local
  // de purchaseParams y recalcula el forecast al instante. No persiste en Supabase.
  function applyQuickAdjust() {
    if (!data) return
    // Solo aplicamos los campos con valor; un input vacío deja intacto el valor por SKU.
    const growth = quickGrowth.trim() === '' ? null : Number(quickGrowth)
    const lead = quickLeadTime.trim() === '' ? null : Number(quickLeadTime)
    const coverage = quickCoverage.trim() === '' ? null : Number(quickCoverage)

    const updatedParams = (data.purchaseParams || []).map(p => ({
      ...p,
      ...(growth != null && !Number.isNaN(growth) ? { growth_factor: growth } : {}),
      ...(lead != null && !Number.isNaN(lead) ? { lead_time_weeks: lead } : {}),
      ...(coverage != null && !Number.isNaN(coverage) ? { coverage_target_months: coverage } : {}),
    }))

    const updatedData = { ...data, purchaseParams: updatedParams }
    setData(updatedData)
    setResults(runForecast({
      ...updatedData,
      avgSalesMonthsGlobal: effectiveAvgMonths,
      trimExtremesGlobal: effectiveTrim,
    }))
  }

  // Agrega campos calculados: days_of_inventory y la info de "Pedir Antes De"
  // (_orderBy para el render, order_by_days para poder ordenar la columna)
  const enriched = useMemo(
    () => results.map(r => {
      const info = orderByInfo(r)
      return {
        ...r,
        days_of_inventory: daysOfInventory(r),
        available_coverage: availableCoverage(r),
        _orderBy: info,
        order_by_days: info.days,
      }
    }),
    [results]
  )

  // sku -> nombre, para etiquetar kits al recalcular el desglose
  const nameBySku = useMemo(() => {
    const m = {}
    for (const p of (data?.products || [])) m[p.sku] = p.name
    return m
  }, [data])

  // Desglose del Avg Sales/Mo del SKU abierto en el panel.
  //
  // Mostramos el desglose GUARDADO en el resultado del forecast (`avg_sales_breakdown`),
  // que salió del mismo cálculo que el número de la tabla, así que cierra por construcción.
  // Además recalculamos con el BOM actual de `data`: si no coincide, el BOM (o las ventas)
  // cambiaron en la base después de correr el forecast y avisamos.
  const breakdown = useMemo(() => {
    if (!breakdownSku || !data) return null
    const row = enriched.find(r => r.sku === breakdownSku)
    if (!row) return null

    const stored = row.avg_sales_breakdown
    if (!stored) return null

    // ¿Cierra el desglose contra el total? (tolerancia por punto flotante)
    const kitsSum = stored.kit_lines.reduce((sum, l) => sum + l.contribution, 0)
    const reconciles = Math.abs(stored.direct + kitsSum - stored.total) < 0.01

    // Recálculo con los datos actuales, usando la MISMA ventana que usó la corrida
    const fresh = calcTotalComponentDemand(
      data.salesHistory,
      data.bomRows,
      breakdownSku,
      row.avg_sales_months,
      nameBySku,
      row.trim_extremes
    )
    // Comparamos el total Y línea por línea (kit + qty_per_kit): un kit reemplazado
    // por otro con el mismo aporte da el mismo total, y sin esto pasaría desapercibido.
    const lineKey = l => `${l.kit_sku}:${l.qty_per_kit}`
    const storedKeys = stored.kit_lines.map(lineKey).sort().join('|')
    const freshKeys = fresh.kit_lines.map(lineKey).sort().join('|')
    const bomChanged =
      Math.abs(fresh.total - stored.total) > 0.01 ||
      storedKeys !== freshKeys

    return { row, stored, kitsSum, reconciles, bomChanged }
  }, [breakdownSku, data, enriched, nameBySku])

  // ESC cierra el panel de desglose
  useEffect(() => {
    if (!breakdownSku) return
    function onKey(e) { if (e.key === 'Escape') { setBreakdownSku(null); setExpandedKit(null) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [breakdownSku])

  const filtered = useMemo(() => {
    return enriched.filter(r => {
      if (selectedSkus !== null && !selectedSkus.has(r.sku)) return false
      if (filterSupplier !== 'All' && r.supplier !== filterSupplier) return false
      if (filterOnlyOrders && r.qty_suggested === 0) return false
      if (search && !r.sku.toLowerCase().includes(search.toLowerCase()) &&
          !r.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [enriched, selectedSkus, filterSupplier, filterOnlyOrders, search])

  // Lista de SKUs (con nombre) para el filtro multi-select
  const skuOptions = useMemo(
    () => results
      .map(r => ({ sku: r.sku, name: r.name }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
    [results]
  )
  const visibleSkuOptions = useMemo(() => {
    const q = skuSearch.trim().toLowerCase()
    if (!q) return skuOptions
    return skuOptions.filter(o =>
      o.sku.toLowerCase().includes(q) || (o.name || '').toLowerCase().includes(q)
    )
  }, [skuOptions, skuSearch])

  const selectedCount = selectedSkus === null ? skuOptions.length : selectedSkus.size
  const isSkuSelected = sku => selectedSkus === null || selectedSkus.has(sku)

  function toggleSku(sku) {
    setActiveFilterName(null) // edición manual: deja de coincidir con el filtro guardado
    setSelectedSkus(prev => {
      const next = prev === null ? new Set(skuOptions.map(o => o.sku)) : new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }
  function selectAllSkus() { setSelectedSkus(null); setActiveFilterName(null) }
  function clearAllSkus() { setSelectedSkus(new Set()); setActiveFilterName(null) }

  // Persiste el array de filtros en localStorage y en el estado a la vez
  function persistSavedFilters(next) {
    setSavedFilters(next)
    try {
      localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(next))
    } catch {
      // localStorage lleno o no disponible: el estado en memoria igual queda actualizado
    }
  }

  // Guarda la selección actual con el nombre escrito en el input inline
  function saveCurrentFilter() {
    const name = newFilterName.trim()
    if (!name) return
    // selectedSkus === null = "todos"; lo materializamos como la lista completa de SKUs
    const skus = selectedSkus === null ? skuOptions.map(o => o.sku) : [...selectedSkus]
    // Si ya existe un filtro con ese nombre, lo sobrescribimos en lugar de duplicar
    const withoutDup = savedFilters.filter(f => f.name !== name)
    if (withoutDup.length >= MAX_SAVED_FILTERS) {
      alert(`Maximum ${MAX_SAVED_FILTERS} saved filters. Delete one before saving another.`)
      return
    }
    persistSavedFilters([...withoutDup, { name, skus }])
    setActiveFilterName(name)
    setSavingFilter(false)
    setNewFilterName('')
  }

  // Aplica un filtro guardado, intersectando con los SKUs que existen en el forecast actual
  function applySavedFilter(filter) {
    const valid = filter.skus.filter(s => skuOptions.some(o => o.sku === s))
    setSelectedSkus(new Set(valid))
    setActiveFilterName(filter.name)
  }

  function deleteSavedFilter(name) {
    persistSavedFilters(savedFilters.filter(f => f.name !== name))
    if (activeFilterName === name) setActiveFilterName(null)
  }

  // Click en header: misma columna -> invierte dirección; columna nueva -> empieza ascendente
  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      // Valores nulos siempre al final, sin importar la dirección
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

  const totalCost = useMemo(() =>
    filtered.reduce((sum, r) => sum + (r.total_landed_cost || 0), 0),
    [filtered]
  )

  // Ancho total de la tabla (necesario con table-layout: fixed) — lo calcula el hook
  const totalWidth = cols.totalWidth

  // Landed cost por SKU desde purchase_params, para recalcular "Total Landed" en vivo (antes de guardar)
  const landedCostBySku = useMemo(() => {
    const m = {}
    for (const p of (data?.purchaseParams || [])) m[p.sku] = p.landed_cost_usd
    return m
  }, [data])

  // Exporta las filas actualmente visibles (sorted = filtered + orden) a un .xlsx con SheetJS.
  // Respeta filtros de SKU/proveedor/"solo con orden" porque parte de `sorted`.
  function exportToExcel() {
    // Definición de columnas: header + cómo obtener el valor + formato numérico + ancho mínimo
    const cols = [
      { header: 'SKU', get: r => r.sku, w: 14 },
      { header: 'Name', get: r => r.name, w: 30 },
      { header: 'Supplier', get: r => r.supplier, w: 12 },
      { header: 'Avg Sales/Mo', get: r => r.avg_monthly_sales_total, w: 14, z: '0.00' },
      { header: 'Projected/Mo', get: r => r.projected_monthly_demand, w: 15, z: '0.00' },
      { header: 'Available', get: r => r.qty_available_real, w: 12, z: '#,##0' },
      { header: 'In Transit', get: r => r.qty_transit, w: 12, z: '#,##0' },
      { header: 'Days of Inventory', get: r => r.days_of_inventory, w: 16, z: '#,##0' },
      { header: 'Growth Factor', get: r => r.growth_factor, w: 14, z: '0.00' },
      { header: 'Lead Time (wk)', get: r => r.lead_time_weeks, w: 14, z: '0' },
      { header: 'Coverage Target', get: r => r.coverage_target_months, w: 15, z: '0.0' },
      { header: 'Months Coverage', get: r => r.months_coverage_current, w: 15, z: '0.0' },
      { header: 'Available Coverage', get: r => r.available_coverage, w: 17, z: '0.0' },
      { header: 'Suggested Order', get: r => r.qty_suggested, w: 14, z: '#,##0' },
      { header: 'Total Landed', get: r => r.qty_suggested * (landedCostBySku[r.sku] || 0), w: 16, z: '"$"#,##0.00' },
    ]

    const headerStyle = {
      fill: { fgColor: { rgb: '1F3864' } },
      font: { color: { rgb: 'FFFFFF' }, bold: true },
      alignment: { horizontal: 'center', vertical: 'center' },
    }

    // Totales para la fila resumen
    const totalQty = sorted.reduce((s, r) => s + (r.qty_suggested || 0), 0)
    const totalLanded = sorted.reduce((s, r) => s + (r.qty_suggested * (landedCostBySku[r.sku] || 0)), 0)

    // Matriz de valores: encabezados + filas + resumen
    const aoa = [
      cols.map(c => c.header),
      ...sorted.map(r => cols.map(c => {
        const v = c.get(r)
        return v == null ? '' : v
      })),
    ]
    // Fila resumen: total SKUs, suma de Orden Sugerida y de Total Landed alineadas a sus columnas
    const summary = cols.map(() => '')
    summary[0] = 'TOTAL'
    summary[1] = `${sorted.length} SKUs`
    summary[12] = totalQty
    summary[13] = totalLanded
    aoa.push(summary)

    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const headerRow = 0
    const summaryRow = aoa.length - 1

    const summaryStyle = {
      font: { bold: true },
      fill: { fgColor: { rgb: 'E7ECF5' } },
      border: { top: { style: 'thin', color: { rgb: '1F3864' } } },
    }

    // Aplica estilos y formatos celda por celda
    for (let c = 0; c < cols.length; c++) {
      // Header
      const hAddr = XLSX.utils.encode_cell({ r: headerRow, c })
      if (ws[hAddr]) ws[hAddr].s = headerStyle

      // Filas de datos: formato numérico + alineación a la derecha en columnas numéricas
      for (let i = 0; i < sorted.length; i++) {
        const addr = XLSX.utils.encode_cell({ r: i + 1, c })
        const cell = ws[addr]
        if (!cell) continue
        if (cols[c].z && typeof cell.v === 'number') {
          cell.z = cols[c].z
          cell.s = { alignment: { horizontal: 'right' } }
        }
      }

      // Fila resumen
      const sAddr = XLSX.utils.encode_cell({ r: summaryRow, c })
      if (ws[sAddr]) {
        ws[sAddr].s = { ...summaryStyle }
        if (cols[c].z && typeof ws[sAddr].v === 'number') {
          ws[sAddr].z = cols[c].z
          ws[sAddr].s = { ...summaryStyle, alignment: { horizontal: 'right' } }
        }
      }
    }

    // Auto-ancho: tomamos el largo máximo entre header, valores y resumen por columna
    ws['!cols'] = cols.map((col, c) => {
      let maxLen = col.header.length
      for (let r = 1; r < aoa.length; r++) {
        const v = aoa[r][c]
        const len = v == null ? 0 : String(v).length
        if (len > maxLen) maxLen = len
      }
      // +2 de padding, con un piso (col.w) y techo razonable para no desbordar
      return { wch: Math.min(Math.max(maxLen + 2, col.w), 40) }
    })

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase Forecast')

    // Nombre de archivo: PM_Forecast[_Filtro]_YYYY-MM-DD.xlsx
    const today = new Date().toISOString().split('T')[0]
    const filterPart = activeFilterName
      ? '_' + activeFilterName.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      : ''
    XLSX.writeFile(wb, `PM_Forecast${filterPart}_${today}.xlsx`)
  }

  if (loading) return <div style={styles.loading}>Loading data...</div>

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>📦 Purchase Forecast</h1>
          <p style={styles.pageDesc}>
            {snapshotDate
              ? `Inventory as of ${snapshotDate} · ${data?.salesHistory?.length || 0} sales records`
              : 'No inventory data — upload a snapshot first'}
          </p>
        </div>
        <div style={styles.headerControls}>
          <div style={styles.controlGroup}>
            <label style={styles.controlLabel}>
              Sales avg window (months)
              {effectiveAvgMonths !== avgMonthsSaved && (
                <span style={styles.overrideTag} title={`Valor guardado en Parameters: ${avgMonthsSaved}`}>
                  override
                </span>
              )}
            </label>
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={avgMonthsGlobal}
              onChange={e => {
                const n = parseInt(e.target.value, 10)
                setAvgMonthsGlobal(Number.isFinite(n) && n >= 1 ? n : '')
              }}
              onBlur={() => { if (avgMonthsGlobal === '' ) setAvgMonthsGlobal(avgMonthsSaved) }}
              style={{ ...styles.select, width: 90 }}
              title={`Ventana global. Se guarda en Parameters (actual: ${avgMonthsSaved}). Cambiarla acá aplica solo a esta sesión. Un SKU con Avg Months propio ignora este valor.`}
            />
          </div>
          <div style={styles.controlGroup}>
            <label style={styles.controlLabel}>
              Trim extremes
              {effectiveTrim !== trimSaved && (
                <span style={styles.overrideTag} title={`Valor guardado en Parameters: ${trimSaved}`}>
                  override
                </span>
              )}
            </label>
            <select
              value={String(trimGlobal)}
              onChange={e => setTrimGlobal(Number(e.target.value))}
              style={{ ...styles.select, width: 110 }}
              title={`Recorte global de extremos. Se guarda en Parameters (actual: ${trimSaved}). Cambiarlo acá aplica solo a esta sesión. Un SKU con Trim propio ignora este valor. Con ventana <= 4 meses no se recorta nunca.`}
            >
              <option value="0">No</option>
              <option value="1">Sí</option>
            </select>
          </div>
          <button style={styles.refreshBtn} onClick={() => loadData({ refresh: true })} disabled={refreshing || loading}>
            {refreshing ? '⏳ Refreshing...' : '↻ Refresh Data'}
          </button>
          <button style={styles.runBtn} onClick={handleRunForecast} disabled={running || !data}>
            {running ? '⏳ Calculating...' : '▶ Run Forecast'}
          </button>
          {results.length > 0 && (
            <button style={styles.exportBtn} onClick={exportToExcel}>
              ⬇ Export to Excel
            </button>
          )}
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {dataWarning && <div style={styles.warn}>⚠️ {dataWarning}</div>}
      {saveInfo && <div style={styles.saveInfo}>✅ {saveInfo}</div>}

      {results.length > 0 && (
        <>
          {/* Summary cards */}
          <div style={styles.summaryGrid}>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.qty_suggested > 0).length}</div>
              <div style={styles.summaryLabel}>SKUs to order</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{fmtCurrency(results.reduce((s, r) => s + (r.total_landed_cost || 0), 0))}</div>
              <div style={styles.summaryLabel}>Total landed cost</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.months_coverage_current != null && r.months_coverage_current <= 2).length}</div>
              <div style={styles.summaryLabel}>Critical SKUs (≤2 months)</div>
            </div>
            <div style={styles.summaryCard}>
              <div style={styles.summaryVal}>{results.filter(r => r.months_coverage_current == null || r.months_coverage_current === 0).length}</div>
              <div style={styles.summaryLabel}>No current coverage</div>
            </div>
          </div>

          {/* Filters */}
          <div style={styles.filters}>
            <input
              placeholder="Search SKU or name..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={styles.searchInput}
            />
            <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={styles.select}>
              {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div style={styles.skuFilter}>
              <button style={styles.skuFilterBtn} onClick={() => setSkuFilterOpen(o => !o)}>
                {activeFilterName
                  ? `Filter: ${activeFilterName} (${selectedCount} SKUs) ▾`
                  : `${selectedCount} of ${skuOptions.length} SKUs ▾`}
              </button>
              {skuFilterOpen && (
                <>
                  <div style={styles.skuBackdrop} onClick={() => setSkuFilterOpen(false)} />
                  <div style={styles.skuPopover}>
                    {savedFilters.length > 0 && (
                      <div style={styles.savedSection}>
                        <div style={styles.savedTitle}>Saved Filters</div>
                        <div style={styles.savedChips}>
                          {savedFilters.map(f => (
                            <span
                              key={f.name}
                              style={{
                                ...styles.savedChip,
                                ...(activeFilterName === f.name ? styles.savedChipActive : {}),
                              }}
                            >
                              <button
                                style={styles.savedChipLabel}
                                onClick={() => applySavedFilter(f)}
                                title={`Apply "${f.name}" (${f.skus.length} SKUs)`}
                              >
                                {f.name}
                              </button>
                              <button
                                style={styles.savedChipDelete}
                                onClick={() => deleteSavedFilter(f.name)}
                                title="Delete filter"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <input
                      placeholder="Search SKU or name..."
                      value={skuSearch}
                      onChange={e => setSkuSearch(e.target.value)}
                      style={styles.skuSearchInput}
                      autoFocus
                    />
                    <div style={styles.skuActions}>
                      <button style={styles.skuActionBtn} onClick={selectAllSkus}>Select all</button>
                      <button style={styles.skuActionBtn} onClick={clearAllSkus}>Clear all</button>
                    </div>
                    <div style={styles.skuList}>
                      {visibleSkuOptions.map(o => (
                        <label key={o.sku} style={styles.skuItem}>
                          <input
                            type="checkbox"
                            checked={isSkuSelected(o.sku)}
                            onChange={() => toggleSku(o.sku)}
                          />
                          <span style={styles.skuItemCode}>{o.sku}</span>
                          <span style={styles.skuItemName}>{o.name}</span>
                        </label>
                      ))}
                      {visibleSkuOptions.length === 0 && (
                        <div style={styles.skuEmpty}>No matches</div>
                      )}
                    </div>
                    <div style={styles.savedFooter}>
                      {savingFilter ? (
                        <div style={styles.saveRow}>
                          <input
                            placeholder="Filter name..."
                            value={newFilterName}
                            onChange={e => setNewFilterName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveCurrentFilter()
                              if (e.key === 'Escape') { setSavingFilter(false); setNewFilterName('') }
                            }}
                            style={styles.saveInput}
                            autoFocus
                          />
                          <button
                            style={styles.saveConfirmBtn}
                            onClick={saveCurrentFilter}
                            disabled={!newFilterName.trim()}
                          >
                            Save
                          </button>
                          <button
                            style={styles.saveCancelBtn}
                            onClick={() => { setSavingFilter(false); setNewFilterName('') }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          style={styles.saveFilterBtn}
                          onClick={() => setSavingFilter(true)}
                          disabled={savedFilters.length >= MAX_SAVED_FILTERS}
                          title={savedFilters.length >= MAX_SAVED_FILTERS
                            ? `Maximum ${MAX_SAVED_FILTERS} saved filters`
                            : 'Save current selection'}
                        >
                          + Save current filter
                          {savedFilters.length >= MAX_SAVED_FILTERS ? ` (${MAX_SAVED_FILTERS}/${MAX_SAVED_FILTERS})` : ''}
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={filterOnlyOrders}
                onChange={e => setFilterOnlyOrders(e.target.checked)}
              />
              &nbsp;Only with suggested order
            </label>
            {filterSupplier !== 'All' || filterOnlyOrders || search || selectedSkus !== null ? (
              <span style={styles.filterTotal}>
                {fmtCurrency(totalCost)} filtered total
              </span>
            ) : null}
          </div>

          {/* Ajuste rápido (what-if) — solo visible con resultados */}
          {results.length > 0 && (
            <div style={styles.quickBar}>
              <div style={styles.quickHint}>
                ⚡ Quick adjust — applies to all SKUs without saving to Parameters
              </div>
              <div style={styles.quickControls}>
                <label style={styles.quickField}>
                  <span style={styles.quickLabel}>Growth Factor</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0.5"
                    max="3"
                    value={quickGrowth}
                    onChange={e => setQuickGrowth(e.target.value)}
                    style={styles.quickInput}
                  />
                </label>
                <label style={styles.quickField}>
                  <span style={styles.quickLabel}>Lead Time (weeks)</span>
                  <input
                    type="number"
                    min="0"
                    value={quickLeadTime}
                    onChange={e => setQuickLeadTime(e.target.value)}
                    style={styles.quickInput}
                  />
                </label>
                <label style={styles.quickField}>
                  <span style={styles.quickLabel}>Coverage Target (months)</span>
                  <input
                    type="number"
                    min="0"
                    value={quickCoverage}
                    onChange={e => setQuickCoverage(e.target.value)}
                    style={styles.quickInput}
                  />
                </label>
                <button style={styles.quickApplyBtn} onClick={applyQuickAdjust}>
                  Apply to all and recalculate
                </button>
              </div>
            </div>
          )}

          {/* Table */}
          <div style={styles.tableWrap}>
            <table style={{ ...styles.table, width: totalWidth }}>
              <thead>
                <tr style={styles.thead}>
                  {COLUMNS.map(col => {
                    // Las dos primeras columnas quedan fijas a la izquierda; su `left`
                    // depende del ancho de la anterior, así que sigue al redimensionado.
                    const sticky = col.key === 'sku'
                      ? { ...styles.stickyHeadSku, left: 0 }
                      : col.key === 'name'
                      ? { ...styles.stickyHeadName, left: colWidths.sku }
                      : null
                    return (
                      <ResizableTh
                        key={col.key}
                        colKey={col.key}
                        resize={cols}
                        style={{
                          ...styles.th,
                          ...(col.param ? styles.thParam : null),
                          ...(sticky || null),
                          textAlign: col.align,
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                        onClick={() => handleSort(col.key)}
                        title={
                          col.key === 'qty_transit' ? 'Includes confirmed orders with status Ordered'
                          : col.key === 'available_coverage' ? 'Months of coverage from available stock only, excluding in-transit units'
                          : col.key === 'order_by_days' ? 'Deadline to place the order accounting for the supplier lead time'
                          : undefined
                        }
                      >
                        {col.label}
                        {col.key === 'qty_transit' ? ' *' : ''}
                        {col.key === 'order_by_days' ? ' ⓘ' : ''}
                        {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </ResizableTh>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => {
                  const rowBg = r.qty_suggested > 0 ? '#fffde7' : '#fff'
                  const days = r.days_of_inventory
                  return (
                    <tr key={r.sku} style={r.qty_suggested > 0 ? styles.trOrder : styles.tr}>
                      <td style={{ ...styles.td, ...styles.stickyColSku, left: 0, width: colWidths.sku, minWidth: colWidths.sku, maxWidth: colWidths.sku, background: rowBg, fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</td>
                      <td style={{ ...styles.td, ...styles.stickyColName, left: colWidths.sku, width: colWidths.name, minWidth: colWidths.name, maxWidth: colWidths.name, background: rowBg }}>{r.name}</td>
                      <td style={styles.td}>
                        <span style={styles.supplierBadge}>{r.supplier || '—'}</span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', padding: 0 }}>
                        <button
                          style={styles.avgCellBtn}
                          onClick={() => setBreakdownSku(r.sku)}
                          title={`Ver de dónde sale este promedio (ventana: ${r.avg_sales_months} meses)`}
                        >
                          {fmt(r.avg_monthly_sales_total)}
                        </button>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.projected_monthly_demand)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmt(r.qty_available_real)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmt(r.qty_transit)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, background: daysColor(days) }}>
                        {days != null ? days : '—'}
                      </td>
                      <td style={{ ...styles.td, ...styles.paramCell, textAlign: 'right' }}>
                        {r.growth_factor != null ? Number(r.growth_factor).toFixed(2) : '—'}
                      </td>
                      <td style={{ ...styles.td, ...styles.paramCell, textAlign: 'right' }}>{fmt(r.lead_time_weeks)}</td>
                      <td style={{ ...styles.td, ...styles.paramCell, textAlign: 'right' }}>{fmt(r.coverage_target_months)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        <span style={{ ...styles.coverageBadge, background: coverageColor(r.months_coverage_current) }}>
                          {r.months_coverage_current != null ? `${fmt(r.months_coverage_current)}m` : '—'}
                        </span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        <span style={{ ...styles.coverageBadge, background: coverageColor(r.available_coverage) }}>
                          {r.available_coverage != null ? `${r.available_coverage.toFixed(1)}m` : '—'}
                        </span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: r.qty_suggested > 0 ? 700 : 400 }}>
                        {r.qty_suggested > 0 ? r.qty_suggested : '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', color: r._orderBy.color, fontWeight: r._orderBy.bold ? 700 : 400 }}>
                        {r._orderBy.text}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {fmtCurrency(r.qty_suggested * (landedCostBySku[r.sku] || 0))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={styles.tableFooterRow}>
            <div style={styles.transitNote}>
              * In Transit includes confirmed orders with status Ordered (from the latest run), so it may exceed what is recorded in transit_orders.
            </div>
            <ResetWidthsButton resize={cols} />
          </div>
        </>
      )}

      {results.length === 0 && !loading && (
        <div style={styles.empty}>
          <p>Press "Run Forecast" to calculate suggested orders.</p>
          <p style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
            Make sure you have uploaded sales and inventory first.
          </p>
        </div>
      )}

      {/* Panel lateral: de dónde sale el Avg Sales/Mo */}
      {breakdown && (
        <>
          <div style={styles.drawerBackdrop} onClick={() => setBreakdownSku(null)} />
          <aside style={styles.drawer}>
            <div style={styles.drawerHeader}>
              <div>
                <div style={styles.drawerSku}>{breakdown.row.sku}</div>
                <div style={styles.drawerName}>{breakdown.row.name}</div>
              </div>
              <button style={styles.drawerClose} onClick={() => setBreakdownSku(null)} title="Cerrar (Esc)">
                ✕
              </button>
            </div>

            <div style={styles.drawerWindow}>
              <div>
                Promedio de los últimos <strong>{breakdown.stored.months_used} meses</strong>
                {breakdown.row.avg_sales_months_is_override
                  ? ' · ventana propia de este SKU'
                  : ' · ventana global'}
              </div>
              <div style={{ marginTop: 4 }}>
                Recorte de extremos: <strong>{breakdown.row.trim_extremes === 1 ? 'sí' : 'no'}</strong>
                {breakdown.row.trim_extremes_is_override
                  ? ' · valor propio de este SKU'
                  : ' · valor global'}
                {breakdown.row.trim_extremes === 1 && !breakdown.row.trim_applied
                  ? ' — pedido pero NO aplicado'
                  : ''}
              </div>
            </div>

            {breakdown.bomChanged && (
              <div style={styles.drawerWarn}>
                ⚠️ El BOM o las ventas cambiaron en la base después de la última corrida, así que
                este desglose puede no reflejar los datos actuales. Corré el forecast de nuevo
                para actualizarlo.
              </div>
            )}

            {!breakdown.reconciles && (
              <div style={styles.drawerWarn}>
                ⚠️ El desglose por kit no suma al total mostrado en la tabla. Es un síntoma de que
                el BOM cambió desde el último forecast run. Corré el forecast de nuevo.
              </div>
            )}

            <div style={styles.drawerRows}>
              <div style={styles.drawerRow}>
                <span style={styles.drawerRowLabel}>Venta directa</span>
                <span style={styles.drawerRowVal}>{fmt(breakdown.row.avg_monthly_sales_direct)}</span>
              </div>
              <div style={styles.drawerRow}>
                <span style={styles.drawerRowLabel}>Derivada de kits</span>
                <span style={styles.drawerRowVal}>{fmt(breakdown.row.avg_monthly_sales_derived)}</span>
              </div>
              <div style={{ ...styles.drawerRow, ...styles.drawerRowTotal }}>
                <span style={styles.drawerRowLabel}>Total (Avg Sales/Mo)</span>
                {/* Misma expresión que la celda de la tabla: así el número coincide siempre */}
                <span style={styles.drawerRowVal}>{fmt(breakdown.row.avg_monthly_sales_total)}</span>
              </div>
            </div>

            <div style={styles.drawerSectionTitle}>Serie mensual — venta directa del componente</div>
            <div style={styles.trimStatus}>{trimStatusText(breakdown.stored.direct_detail)}</div>
            <MonthStrip detail={breakdown.stored.direct_detail} />

            <div style={{ ...styles.drawerSectionTitle, marginTop: 22 }}>Desglose de la demanda derivada</div>

            {breakdown.stored.kit_lines.length === 0 ? (
              <div style={styles.drawerEmpty}>
                Este componente no figura en ningún kit del BOM: todo su promedio es venta directa.
              </div>
            ) : (
              <table style={styles.drawerTable}>
                <thead>
                  <tr>
                    <th style={styles.drawerTh}>Kit SKU</th>
                    <th style={styles.drawerTh}>Nombre</th>
                    <th style={{ ...styles.drawerTh, textAlign: 'right' }}>Ventas/mes</th>
                    <th style={{ ...styles.drawerTh, textAlign: 'right' }}>Qty/kit</th>
                    <th style={{ ...styles.drawerTh, textAlign: 'right' }}>Aporte</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.stored.kit_lines.map(l => {
                    const open = expandedKit === l.kit_sku
                    return (
                      <Fragment key={l.kit_sku}>
                        <tr
                          style={{ ...styles.drawerTr, ...styles.drawerTrClickable, ...(open ? styles.drawerTrOpen : null) }}
                          onClick={() => setExpandedKit(open ? null : l.kit_sku)}
                          title="Ver la serie mensual de este kit"
                        >
                          <td style={{ ...styles.drawerTd, fontFamily: 'monospace', fontSize: 11 }}>
                            <span style={styles.caret}>{open ? '▾' : '▸'}</span>{l.kit_sku}
                          </td>
                          <td style={styles.drawerTd} title={l.kit_name || ''}>{l.kit_name || '—'}</td>
                          <td style={{ ...styles.drawerTd, textAlign: 'right' }}>{fmt(l.kit_avg_monthly_sales)}</td>
                          <td style={{ ...styles.drawerTd, textAlign: 'right' }}>{fmt(l.qty_per_kit)}</td>
                          <td style={{ ...styles.drawerTd, textAlign: 'right', fontWeight: 600 }}>{fmt(l.contribution)}</td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={5} style={styles.drawerExpandCell}>
                              <div style={styles.trimStatus}>{trimStatusText(l.detail)}</div>
                              <MonthStrip detail={l.detail} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={styles.drawerTfoot} colSpan={4}>Total derivado</td>
                    <td style={{ ...styles.drawerTfoot, textAlign: 'right' }}>
                      {fmt(breakdown.row.avg_monthly_sales_derived)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}

            <div style={styles.drawerNote}>
              Los meses sin ventas cuentan como cero. No hay datos de stockout para excluirlos.
              Con el recorte activo, un mes en cero es un candidato normal a ser el extremo bajo.
              Clic en una fila de kit para ver su serie mensual.
            </div>
          </aside>
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
  headerControls: { display: 'flex', alignItems: 'center', gap: 16 },
  controlGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  controlLabel: { fontSize: 11, color: '#888', fontWeight: 600 },
  select: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff' },
  runBtn: { background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  refreshBtn: { background: '#fff', color: '#4455aa', border: '1.5px solid #c5ccea', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  exportBtn: { background: '#1F3864', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  error: { background: '#fff0f0', color: '#c00', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20, whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', border: '1.5px solid #f5c2c2', userSelect: 'text' },
  warn: { background: '#fff4e5', color: '#8a5200', padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20, whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', border: '1.5px solid #ffd9a0', userSelect: 'text' },
  saveInfo: { background: '#eaf7ef', color: '#1a7a4a', padding: '11px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20, border: '1.5px solid #bfe6cf' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 },
  summaryCard: { background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  summaryVal: { fontSize: 26, fontWeight: 700, color: '#1a1a2e' },
  summaryLabel: { fontSize: 12, color: '#888', marginTop: 2 },
  filters: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  searchInput: { padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, width: 240 },
  checkLabel: { fontSize: 13, color: '#555', display: 'flex', alignItems: 'center', cursor: 'pointer' },
  filterTotal: { fontSize: 13, fontWeight: 700, color: '#1a1a2e', marginLeft: 'auto' },
  skuFilter: { position: 'relative' },
  skuFilterBtn: { padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, background: '#fff', cursor: 'pointer', fontWeight: 600, color: '#333', whiteSpace: 'nowrap' },
  skuBackdrop: { position: 'fixed', inset: 0, zIndex: 10 },
  skuPopover: { position: 'absolute', top: '100%', left: 0, marginTop: 6, background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 10, width: 300, zIndex: 20 },
  skuSearchInput: { width: '100%', padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, marginBottom: 8, boxSizing: 'border-box' },
  skuActions: { display: 'flex', gap: 8, marginBottom: 8 },
  skuActionBtn: { flex: 1, padding: '6px 8px', border: '1px solid #e0e0e0', borderRadius: 6, background: '#f7f7f9', fontSize: 12, fontWeight: 600, color: '#4455aa', cursor: 'pointer' },
  skuList: { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 },
  skuItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 4, fontSize: 12, cursor: 'pointer' },
  skuItemCode: { fontFamily: 'monospace', color: '#333', whiteSpace: 'nowrap' },
  skuItemName: { color: '#999', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  skuEmpty: { padding: 14, color: '#999', fontSize: 12, textAlign: 'center' },
  savedSection: { marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #eee' },
  savedTitle: { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  savedChips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  savedChip: { display: 'inline-flex', alignItems: 'center', background: '#f0f1f5', borderRadius: 6, overflow: 'hidden', border: '1px solid #e0e0e0' },
  savedChipActive: { background: '#e7ebff', border: '1px solid #4455aa' },
  savedChipLabel: { border: 'none', background: 'transparent', padding: '4px 4px 4px 8px', fontSize: 12, fontWeight: 600, color: '#4455aa', cursor: 'pointer', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  savedChipDelete: { border: 'none', background: 'transparent', padding: '4px 7px', fontSize: 14, lineHeight: 1, color: '#999', cursor: 'pointer' },
  savedFooter: { marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee' },
  saveFilterBtn: { width: '100%', padding: '7px 8px', border: '1.5px dashed #4455aa', borderRadius: 6, background: '#f7f8ff', fontSize: 12, fontWeight: 600, color: '#4455aa', cursor: 'pointer' },
  saveRow: { display: 'flex', gap: 6, alignItems: 'center' },
  saveInput: { flex: 1, padding: '6px 8px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 12, boxSizing: 'border-box', minWidth: 0 },
  saveConfirmBtn: { padding: '6px 10px', border: 'none', borderRadius: 6, background: '#4455aa', fontSize: 12, fontWeight: 600, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
  saveCancelBtn: { padding: '6px 9px', border: '1px solid #e0e0e0', borderRadius: 6, background: '#fff', fontSize: 12, color: '#999', cursor: 'pointer' },
  quickBar: { background: '#fffbe9', border: '1.5px solid #f3e3a3', borderRadius: 10, padding: 12, marginBottom: 12 },
  quickHint: { fontSize: 12, fontWeight: 600, color: '#8a6d1a', marginBottom: 8 },
  quickControls: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 },
  quickField: { display: 'flex', flexDirection: 'column', gap: 4 },
  quickLabel: { fontSize: 11, fontWeight: 600, color: '#666' },
  quickInput: { width: 130, padding: '7px 9px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' },
  quickApplyBtn: { padding: '8px 16px', border: 'none', borderRadius: 8, background: '#1a1a2e', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  tableWrap: { overflowX: 'auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  transitNote: { fontSize: 11, color: '#888', fontStyle: 'italic' },
  tableFooterRow: { display: 'flex', alignItems: 'center', gap: 16, marginTop: 8, flexWrap: 'wrap' },
  table: { tableLayout: 'fixed', borderCollapse: 'collapse', background: '#fff', fontSize: 13 },
  thead: { background: '#1a1a2e' },
  th: { padding: '11px 14px', color: '#fff', fontWeight: 600, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' },
  // Header gris para columnas de input (parámetros), distinto del header oscuro de los outputs
  thParam: { background: '#c8cdd8', color: '#2a2f3a' },
  // Celdas de parámetros con fondo levemente gris para reforzar el agrupamiento
  paramCell: { background: '#f6f7fa' },
  // Columnas fijas a la izquierda (anchos explícitos para alinear thead/tbody)
  stickyColSku: { position: 'sticky', left: 0, zIndex: 1, width: 120, minWidth: 120, maxWidth: 120, boxSizing: 'border-box' },
  stickyColName: { position: 'sticky', left: 120, zIndex: 1, width: 200, minWidth: 200, maxWidth: 200, boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  stickyHeadSku: { position: 'sticky', left: 0, zIndex: 3, background: '#1a1a2e', width: 120, minWidth: 120, maxWidth: 120, boxSizing: 'border-box' },
  stickyHeadName: { position: 'sticky', left: 120, zIndex: 3, background: '#1a1a2e', width: 200, minWidth: 200, maxWidth: 200, boxSizing: 'border-box' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  trOrder: { borderBottom: '1px solid #f0f0f0', background: '#fffde7' },
  td: { padding: '9px 14px', color: '#333', verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  supplierBadge: { background: '#eef0ff', color: '#4455aa', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 },
  coverageBadge: { borderRadius: 4, padding: '2px 7px', fontSize: 12, fontWeight: 600 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#888', background: '#fff', borderRadius: 12 },
  overrideTag: { marginLeft: 6, background: '#ffe9a8', color: '#7a5c00', borderRadius: 4, padding: '1px 5px', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' },
  // Celda de Avg Sales/Mo: se ve como texto pero es un botón, ocupa toda la celda
  avgCellBtn: { width: '100%', padding: '9px 14px', border: 'none', background: 'transparent', font: 'inherit', fontSize: 13, color: '#2f4bbd', textAlign: 'right', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 },
  // Panel lateral del desglose
  drawerBackdrop: { position: 'fixed', inset: 0, background: 'rgba(20,22,40,0.34)', zIndex: 40 },
  drawer: { position: 'fixed', top: 0, right: 0, height: '100vh', width: 'min(560px, 100vw)', background: '#fff', boxShadow: '-6px 0 24px rgba(0,0,0,0.18)', zIndex: 50, padding: 22, overflowY: 'auto', boxSizing: 'border-box' },
  drawerHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  drawerSku: { fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: '#1a1a2e' },
  drawerName: { fontSize: 13, color: '#666', marginTop: 2 },
  drawerClose: { border: 'none', background: '#f0f1f5', borderRadius: 6, width: 30, height: 30, fontSize: 15, color: '#666', cursor: 'pointer', flexShrink: 0 },
  drawerWindow: { background: '#eef0ff', color: '#3a4a8a', borderRadius: 8, padding: '9px 12px', fontSize: 12, marginBottom: 14 },
  drawerWarn: { background: '#fff4e5', border: '1.5px solid #ffd9a0', color: '#8a5200', borderRadius: 8, padding: '10px 12px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 },
  drawerRows: { border: '1px solid #ececf0', borderRadius: 10, overflow: 'hidden', marginBottom: 22 },
  drawerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 14px', borderBottom: '1px solid #f2f2f5', fontSize: 13 },
  drawerRowTotal: { background: '#f7f8ff', fontWeight: 700, borderBottom: 'none', fontSize: 14 },
  drawerRowLabel: { color: '#555' },
  drawerRowVal: { fontVariantNumeric: 'tabular-nums', color: '#1a1a2e', fontWeight: 600 },
  drawerSectionTitle: { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  drawerEmpty: { fontSize: 12, color: '#888', background: '#fafafc', borderRadius: 8, padding: '14px 12px', lineHeight: 1.5 },
  drawerTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  drawerTh: { padding: '8px 9px', background: '#1a1a2e', color: '#fff', fontSize: 10, fontWeight: 600, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' },
  drawerTr: { borderBottom: '1px solid #f2f2f5' },
  drawerTd: { padding: '8px 9px', color: '#333', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  drawerTfoot: { padding: '9px', background: '#f7f8ff', fontWeight: 700, color: '#1a1a2e', fontSize: 12, borderTop: '1.5px solid #dfe3f5', fontVariantNumeric: 'tabular-nums' },
  trimStatus: { fontSize: 12, color: '#555', background: '#fafafc', borderRadius: 6, padding: '8px 10px', marginBottom: 10, lineHeight: 1.5 },
  strip: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  stripCell: { minWidth: 56, flex: '0 0 auto', border: '1.5px solid #dfe3f5', background: '#f7f8ff', borderRadius: 7, padding: '6px 7px', textAlign: 'center' },
  stripCellOut: { border: '1.5px dashed #d8d8dd', background: '#f4f4f6' },
  stripMonth: { fontSize: 9.5, color: '#8a90a8', textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap' },
  stripQty: { fontSize: 14, fontWeight: 700, color: '#1a1a2e', fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 },
  stripQtyOut: { color: '#b0b0b8', textDecoration: 'line-through' },
  stripMark: { fontSize: 8.5, color: '#9a8050', fontWeight: 700, height: 11, lineHeight: '11px', whiteSpace: 'nowrap' },
  stripMath: { marginTop: 9, fontSize: 12, color: '#3a4a8a', fontVariantNumeric: 'tabular-nums' },
  stripEmpty: { fontSize: 12, color: '#999', fontStyle: 'italic' },
  drawerTrClickable: { cursor: 'pointer' },
  drawerTrOpen: { background: '#f7f8ff' },
  caret: { display: 'inline-block', width: 12, color: '#8a90a8' },
  drawerExpandCell: { padding: '12px 10px 16px', background: '#fcfcfe', borderBottom: '1px solid #ececf0' },
  drawerNote: { marginTop: 16, fontSize: 11, color: '#888', fontStyle: 'italic', lineHeight: 1.5 },
}
