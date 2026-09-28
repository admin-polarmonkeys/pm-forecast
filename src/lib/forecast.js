/**
 * PM Forecast Engine
 * Calcula la orden sugerida por componente considerando:
 * - Ventas directas del SKU
 * - Demanda derivada de kits (BOM explosion)
 * - Inventario disponible real (físico - unfulfilled con stock)
 * - Inventario en tránsito
 * - Parámetros editables (lead time, cobertura, growth factor, ventana de promedio)
 */

/** Ventana de meses usada si no hay override por SKU ni valor global en app_settings. */
export const DEFAULT_AVG_SALES_MONTHS = 12

/** Clave de app_settings donde vive la ventana global. */
export const AVG_SALES_MONTHS_KEY = 'avg_sales_months'

/**
 * Normaliza un valor de ventana: devuelve un entero >= 1 o null si el valor
 * está vacío / no es numérico (null = "no hay override, seguí bajando en la cadena").
 */
function normalizeMonths(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n)
  return rounded >= 1 ? rounded : null
}

/**
 * Resuelve la ventana de meses del promedio de ventas con esta precedencia:
 *   1. skuOverride   -> purchase_params.avg_sales_months (override por SKU)
 *   2. globalSetting -> app_settings.avg_sales_months (default global)
 *   3. DEFAULT_AVG_SALES_MONTHS (12)
 * Esta es LA única función que decide la ventana: tanto el forecast como el panel
 * de desglose la usan, así que nunca pueden quedar desalineados.
 */
export function resolveAvgSalesMonths({ skuOverride, globalSetting } = {}) {
  return normalizeMonths(skuOverride)
    ?? normalizeMonths(globalSetting)
    ?? DEFAULT_AVG_SALES_MONTHS
}

/** Recorte de extremos por default: 0 = sin recorte. */
export const DEFAULT_TRIM_EXTREMES = 0

/** Clave de app_settings donde vive el recorte global. */
export const TRIM_EXTREMES_KEY = 'trim_extremes'

/**
 * Mínimo de meses que tienen que QUEDAR después de recortar.
 * Con menos que esto el recorte se saltea: promediar 2 meses o menos después de
 * tirar los dos extremos no describe nada.
 */
export const TRIM_MIN_KEPT_MONTHS = 3

/**
 * Normaliza un valor de recorte: 0 o 1, o null si está vacío / no es numérico.
 *
 * OJO — a diferencia de normalizeMonths, acá el 0 es un valor VÁLIDO y explícito:
 * un SKU con trim_extremes = 0 significa "no recortar este SKU" y tiene que ganarle
 * al global. Si devolviéramos null para el 0, el override caería al siguiente nivel
 * de la cadena y un 1 global pisaría la decisión explícita del SKU.
 */
function normalizeTrim(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n) >= 1 ? 1 : 0
}

/**
 * Resuelve el recorte de extremos con la misma precedencia que la ventana:
 *   1. skuOverride   -> purchase_params.trim_extremes
 *   2. globalSetting -> app_settings.trim_extremes
 *   3. DEFAULT_TRIM_EXTREMES (0)
 */
export function resolveTrimExtremes({ skuOverride, globalSetting } = {}) {
  const sku = normalizeTrim(skuOverride)
  if (sku != null) return sku
  const global = normalizeTrim(globalSetting)
  if (global != null) return global
  return DEFAULT_TRIM_EXTREMES
}

/**
 * Convierte (year, month) a un número de período comparable: año*12 + mes.
 * Permite ordenar y restar meses sin pelear con objetos Date.
 */
function toPeriod(year, month) {
  return year * 12 + month
}

/** Inversa de toPeriod: número de período -> { year, month } con month 1..12. */
function fromPeriod(period) {
  return {
    year: Math.floor((period - 1) / 12),
    month: ((period - 1) % 12) + 1,
  }
}

/**
 * Índice de ventas: { bySku: Map<sku, Map<period, qty>>, anchor }
 *
 * `anchor` = el período MÁS RECIENTE presente en todo el historial (no por SKU).
 * Es global a propósito: si un SKU dejó de venderse hace 8 meses, anclar en su
 * propio último mes con ventas le daría un promedio alto de un producto muerto.
 * Con el ancla global, esos meses sin ventas entran como cero y el promedio baja,
 * que es el comportamiento correcto para decidir compras.
 */
export function buildSalesIndex(salesHistory) {
  const bySku = new Map()
  let anchor = null

  for (const r of salesHistory || []) {
    const period = toPeriod(r.year, r.month)
    if (anchor === null || period > anchor) anchor = period

    let months = bySku.get(r.sku)
    if (!months) {
      months = new Map()
      bySku.set(r.sku, months)
    }
    months.set(period, (months.get(period) || 0) + (r.qty_fulfilled || 0))
  }

  return { bySku, anchor }
}

/** Acepta indistintamente un array de sales_history o un índice ya construido. */
function asSalesIndex(salesHistoryOrIndex) {
  if (salesHistoryOrIndex && salesHistoryOrIndex.bySku instanceof Map) return salesHistoryOrIndex
  return buildSalesIndex(salesHistoryOrIndex)
}

/**
 * Serie mensual de un SKU sobre la ventana, con recorte de extremos opcional.
 *
 * Devuelve TODO lo que necesita el panel de desglose para explicar el número:
 * la serie mes a mes, qué meses se recortaron, y si no se recortó, por qué.
 *
 * Reglas:
 * - Los meses sin ventas cuentan como CERO. El divisor es el tamaño de la ventana,
 *   no la cantidad de meses con registro en sales_history. No hay datos de inventario
 *   histórico ni de unfulfilled por mes, así que no se pueden detectar stockouts.
 * - Con recorte se quita UN valor de cada extremo (el más alto y el más bajo), no un
 *   porcentaje. Los meses en cero son candidatos normales a ser el extremo bajo.
 * - Regla de piso: si después de recortar quedarían menos de TRIM_MIN_KEPT_MONTHS (3),
 *   no se recorta. Eso implica que con ventana <= 4 nunca se recorta.
 *
 * @param salesHistoryOrIndex array de sales_history o índice de buildSalesIndex
 * @param sku                 SKU a promediar
 * @param monthsBack          tamaño de la ventana en meses
 * @param trimExtremes        0 = sin recorte, 1 = quitar el mes más alto y el más bajo
 */
export function calcMonthlySalesDetail(
  salesHistoryOrIndex,
  sku,
  monthsBack = DEFAULT_AVG_SALES_MONTHS,
  trimExtremes = DEFAULT_TRIM_EXTREMES
) {
  const index = asSalesIndex(salesHistoryOrIndex)
  const months = normalizeMonths(monthsBack) ?? DEFAULT_AVG_SALES_MONTHS
  const trimRequested = normalizeTrim(trimExtremes) ?? DEFAULT_TRIM_EXTREMES

  const empty = {
    months_used: months,
    trim_requested: trimRequested,
    trim_applied: false,
    trim_skipped_reason: trimRequested === 1 ? 'no_data' : 'config',
    series: [],
    kept_count: 0,
    kept_total: 0,
    avg: 0,
  }

  // Sin ningún registro de ventas en toda la base no hay ancla posible.
  if (index.anchor == null) return empty

  // Serie completa de la ventana, rellenando con cero los meses sin registro.
  const monthsForSku = index.bySku.get(sku)
  const firstPeriod = index.anchor - (months - 1)
  const series = []
  for (let period = firstPeriod; period <= index.anchor; period++) {
    const { year, month } = fromPeriod(period)
    series.push({
      year,
      month,
      period,
      qty: monthsForSku?.get(period) || 0,
      trimmed: null, // 'high' | 'low' cuando se recorta
    })
  }

  // ¿Se puede recortar? Se quitan 2 valores, así que quedan months - 2.
  let trimApplied = false
  let trimSkippedReason = null
  if (trimRequested !== 1) {
    trimSkippedReason = 'config'
  } else if (months - 2 < TRIM_MIN_KEPT_MONTHS) {
    trimSkippedReason = 'floor'
  } else {
    // Orden por cantidad, y por período para desempatar: con meses de igual valor
    // el resultado tiene que ser siempre el mismo, no depender del orden de llegada.
    const ordered = [...series].sort((a, b) => (a.qty - b.qty) || (a.period - b.period))
    ordered[0].trimmed = 'low'
    ordered[ordered.length - 1].trimmed = 'high'
    trimApplied = true
  }

  const kept = series.filter(m => m.trimmed === null)
  const keptTotal = kept.reduce((sum, m) => sum + m.qty, 0)

  return {
    months_used: months,
    trim_requested: trimRequested,
    trim_applied: trimApplied,
    trim_skipped_reason: trimSkippedReason,
    series,
    kept_count: kept.length,
    kept_total: keptTotal,
    // Divisor = meses que efectivamente entraron (months, o months - 2 si se recortó)
    avg: kept.length > 0 ? keptTotal / kept.length : 0,
  }
}

/**
 * Promedio de ventas mensuales de un SKU. Envoltorio de calcMonthlySalesDetail
 * para los llamadores que solo necesitan el número.
 */
export function calcAvgMonthlySales(
  salesHistoryOrIndex,
  sku,
  monthsBack = DEFAULT_AVG_SALES_MONTHS,
  trimExtremes = DEFAULT_TRIM_EXTREMES
) {
  return calcMonthlySalesDetail(salesHistoryOrIndex, sku, monthsBack, trimExtremes).avg
}

/**
 * Explota el BOM: dado un kit_sku y su qty vendida,
 * retorna la demanda derivada por componente
 */
export function explodeBOM(bomRows, kitSku, qtyKitSold) {
  return bomRows
    .filter(r => r.kit_sku === kitSku)
    .map(r => ({
      component_sku: r.component_sku,
      derived_demand: r.qty_per_kit * qtyKitSold
    }))
}

/**
 * Calcula la demanda total de un componente: ventas directas + demanda derivada
 * de todos los kits que lo usan, y devuelve además el desglose línea por línea
 * que alimenta el panel de "¿de dónde sale este Avg Sales/Mo?".
 *
 * El desglose sale de ESTE mismo cálculo (no de una versión paralela), así que
 * por construcción `direct + Σ kit_lines.contribution === total`.
 *
 * La ventana `monthsBack` del componente se aplica también al promedio de cada
 * kit: el número de la tabla representa una única ventana temporal, mezclar
 * ventanas distintas en la misma suma haría que el total no signifique nada.
 *
 * @param nameBySku mapa opcional sku -> nombre, para etiquetar los kits
 */
export function calcTotalComponentDemand(
  salesHistoryOrIndex,
  bomRows,
  componentSku,
  monthsBack = DEFAULT_AVG_SALES_MONTHS,
  nameBySku = null,
  trimExtremes = DEFAULT_TRIM_EXTREMES
) {
  const index = asSalesIndex(salesHistoryOrIndex)
  const months = normalizeMonths(monthsBack) ?? DEFAULT_AVG_SALES_MONTHS
  const trim = normalizeTrim(trimExtremes) ?? DEFAULT_TRIM_EXTREMES

  // Demanda directa, con su serie mensual para el panel
  const directDetail = calcMonthlySalesDetail(index, componentSku, months, trim)

  // Demanda derivada: una línea por kit que usa este componente.
  // Recorremos bom una sola vez; si el BOM tuviera el mismo par (kit, componente)
  // duplicado, la constraint UNIQUE(kit_sku, component_sku) lo impide en la DB.
  const kitLines = []
  let derivedDemand = 0

  for (const row of bomRows || []) {
    if (row.component_sku !== componentSku) continue

    // El recorte se aplica también al promedio del kit, con la misma ventana y el
    // mismo trim que el componente: un solo criterio temporal para toda la suma.
    const kitDetail = calcMonthlySalesDetail(index, row.kit_sku, months, trim)
    const qtyPerKit = Number(row.qty_per_kit) || 0
    const contribution = kitDetail.avg * qtyPerKit
    derivedDemand += contribution

    kitLines.push({
      kit_sku: row.kit_sku,
      kit_name: nameBySku?.[row.kit_sku] || null,
      kit_avg_monthly_sales: kitDetail.avg,
      qty_per_kit: qtyPerKit,
      contribution,
      detail: kitDetail,
    })
  }

  // Kits con más aporte primero: lo que mueve la aguja arriba.
  kitLines.sort((a, b) => b.contribution - a.contribution)

  return {
    months_used: months,
    trim_requested: trim,
    // trim_applied refleja lo que pasó en la serie del componente; cada kit trae
    // el suyo en detail, porque todos usan la misma ventana y caen igual en la
    // regla de piso (que depende solo de months, no de los datos del SKU).
    trim_applied: directDetail.trim_applied,
    trim_skipped_reason: directDetail.trim_skipped_reason,
    direct: directDetail.avg,
    direct_detail: directDetail,
    derived: derivedDemand,
    total: directDetail.avg + derivedDemand,
    kit_lines: kitLines,
  }
}

/**
 * Calcula la orden sugerida para un componente
 */
export function calcSuggestedOrder(params) {
  const {
    avgMonthlyDemand,
    growthFactor,
    coverageTargetMonths,
    leadTimeWeeks,
    qtyAvailableReal,
    qtyTransit,
    moq
  } = params

  const projectedMonthlyDemand = avgMonthlyDemand * growthFactor
  const leadTimeMonths = leadTimeWeeks / 4.33

  // Stock necesario para cubrir el período de cobertura + lead time
  const targetStock = projectedMonthlyDemand * (coverageTargetMonths + leadTimeMonths)

  // Stock actual efectivo (disponible + en tránsito)
  const currentStock = qtyAvailableReal + qtyTransit

  // Cantidad a ordenar
  const rawOrder = Math.max(0, targetStock - currentStock)

  // Redondear al MOQ
  const suggestedOrder = rawOrder === 0 ? 0 : Math.max(moq, Math.ceil(rawOrder / moq) * moq)

  // Meses de cobertura actuales
  const monthsCoverageCurrent = projectedMonthlyDemand > 0
    ? currentStock / projectedMonthlyDemand
    : null

  return {
    projectedMonthlyDemand: Math.round(projectedMonthlyDemand * 100) / 100,
    targetStock: Math.round(targetStock * 100) / 100,
    currentStock,
    monthsCoverageCurrent: monthsCoverageCurrent ? Math.round(monthsCoverageCurrent * 100) / 100 : null,
    suggestedOrder
  }
}

/**
 * Corre el forecast completo para todos los componentes
 *
 * @param avgSalesMonthsGlobal ventana global (app_settings.avg_sales_months).
 *   Cada componente puede pisarla con purchase_params.avg_sales_months.
 */
export function runForecast({
  products,
  bomRows,
  salesHistory,
  inventorySnapshot,
  purchaseParams,
  transitOrders = [],
  avgSalesMonthsGlobal = null,
  trimExtremesGlobal = null,
}) {
  // Solo componentes comprables (type = component con purchase_params)
  const components = products.filter(p => p.type === 'component')

  // Índice de ventas construido UNA vez y reusado por todos los componentes y kits.
  const salesIndex = buildSalesIndex(salesHistory)

  // sku -> nombre, para etiquetar los kits en el desglose
  const nameBySku = {}
  for (const p of products) nameBySku[p.sku] = p.name

  // Tránsito en tiempo real: transit_orders es la fuente de verdad.
  // Sumamos qty por SKU. Si hay CUALQUIER dato en transit_orders, esa tabla manda por completo:
  // los SKUs sin entrada quedan en qty_transit = 0 (así un borrado se refleja al instante, sin
  // re-subir el CSV de inventario). Solo si transit_orders está vacía usamos el snapshot como fallback.
  const transitBySku = {}
  for (const t of transitOrders) {
    transitBySku[t.sku] = (transitBySku[t.sku] || 0) + (t.qty || 0)
  }
  const hasTransitData = transitOrders.length > 0

  const mergedInventory = inventorySnapshot.map(inv =>
    hasTransitData ? { ...inv, qty_transit: transitBySku[inv.sku] || 0 } : inv
  )

  // SKUs con tránsito pero sin registro de inventario -> crear uno con físico 0
  const snapshotSkus = new Set(inventorySnapshot.map(i => i.sku))
  for (const [sku, qty] of Object.entries(transitBySku)) {
    if (!snapshotSkus.has(sku)) {
      mergedInventory.push({ sku, qty_physical: 0, qty_available_real: 0, qty_transit: qty })
    }
  }

  const results = []

  for (const component of components) {
    const params = purchaseParams.find(p => p.sku === component.sku)
    if (!params) continue

    // Ventana de este componente: override por SKU > global > 12
    const monthsUsed = resolveAvgSalesMonths({
      skuOverride: params.avg_sales_months,
      globalSetting: avgSalesMonthsGlobal,
    })

    // Recorte de extremos: misma cadena de precedencia, default 0
    const trimUsed = resolveTrimExtremes({
      skuOverride: params.trim_extremes,
      globalSetting: trimExtremesGlobal,
    })

    // Demanda total (directa + derivada) + desglose por kit
    const demand = calcTotalComponentDemand(
      salesIndex,
      bomRows,
      component.sku,
      monthsUsed,
      nameBySku,
      trimUsed
    )

    // Inventario actual (con tránsito ya mergeado desde transit_orders)
    const inv = mergedInventory.find(i => i.sku === component.sku) || {
      qty_available_real: 0,
      qty_transit: 0
    }

    // Orden sugerida
    const order = calcSuggestedOrder({
      avgMonthlyDemand: demand.total,
      growthFactor: params.growth_factor,
      coverageTargetMonths: params.coverage_target_months,
      leadTimeWeeks: params.lead_time_weeks,
      qtyAvailableReal: inv.qty_available_real,
      qtyTransit: inv.qty_transit,
      moq: params.moq
    })

    const totalLandedCost = params.landed_cost_usd
      ? order.suggestedOrder * params.landed_cost_usd
      : null

    results.push({
      sku: component.sku,
      name: component.name,
      supplier: params.supplier,
      avg_monthly_sales_direct: Math.round(demand.direct * 100) / 100,
      avg_monthly_sales_derived: Math.round(demand.derived * 100) / 100,
      avg_monthly_sales_total: Math.round(demand.total * 100) / 100,
      // Ventana efectiva de este SKU y si vino de un override (para el panel de desglose)
      avg_sales_months: monthsUsed,
      avg_sales_months_is_override: normalizeMonths(params.avg_sales_months) != null,
      // Recorte efectivo: lo pedido, si se aplicó de verdad, y si vino de un override
      trim_extremes: trimUsed,
      trim_extremes_is_override: normalizeTrim(params.trim_extremes) != null,
      trim_applied: demand.trim_applied,
      trim_skipped_reason: demand.trim_skipped_reason,
      // Desglose sin redondear: el panel lo formatea y verifica que cierre contra el total
      avg_sales_breakdown: demand,
      projected_monthly_demand: order.projectedMonthlyDemand,
      qty_available_real: inv.qty_available_real,
      qty_transit: inv.qty_transit,
      months_coverage_current: order.monthsCoverageCurrent,
      qty_suggested: order.suggestedOrder,
      landed_cost_usd: params.landed_cost_usd,
      total_landed_cost: totalLandedCost,
      lead_time_weeks: params.lead_time_weeks,
      coverage_target_months: params.coverage_target_months,
      growth_factor: params.growth_factor,
      moq: params.moq
    })
  }

  // Ordenar: primero los que necesitan orden, luego por nombre
  return results.sort((a, b) => {
    if (b.qty_suggested !== a.qty_suggested) return b.qty_suggested - a.qty_suggested
    return a.name.localeCompare(b.name)
  })
}

/**
 * Agrupa ventas por variant_group para la vista por familia
 */
export function calcKitFamilySales(
  salesHistory,
  bomRows,
  products,
  monthsBack = DEFAULT_AVG_SALES_MONTHS,
  trimExtremes = DEFAULT_TRIM_EXTREMES
) {
  const salesIndex = buildSalesIndex(salesHistory)
  const kits = products.filter(p => p.type === 'kit')
  const families = {}

  for (const kit of kits) {
    const bomRow = bomRows.find(r => r.kit_sku === kit.sku)
    if (!bomRow) continue

    const vgroup = bomRow.variant_group
    if (!families[vgroup]) {
      families[vgroup] = { variant_group: vgroup, kits: [], total_avg_monthly: 0 }
    }

    const avg = calcAvgMonthlySales(salesIndex, kit.sku, monthsBack, trimExtremes)
    families[vgroup].kits.push({
      sku: kit.sku,
      name: kit.name,
      avg_monthly_sales: Math.round(avg * 100) / 100
    })
    families[vgroup].total_avg_monthly += avg
  }

  return Object.values(families)
    .map(f => ({ ...f, total_avg_monthly: Math.round(f.total_avg_monthly * 100) / 100 }))
    .sort((a, b) => b.total_avg_monthly - a.total_avg_monthly)
}
