/**
 * PM Forecast Engine
 * Calcula la orden sugerida por componente considerando:
 * - Ventas directas del SKU
 * - Demanda derivada de kits (BOM explosion)
 * - Inventario disponible real (físico - unfulfilled con stock)
 * - Inventario en tránsito
 * - Parámetros editables (lead time, cobertura, growth factor)
 */

/**
 * Calcula el promedio de ventas mensuales para un SKU
 * usando los últimos N meses de historial
 */
export function calcAvgMonthlySales(salesHistory, sku, monthsBack = 6) {
  const records = salesHistory
    .filter(r => r.sku === sku)
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year
      return b.month - a.month
    })
    .slice(0, monthsBack)

  if (records.length === 0) return 0
  const total = records.reduce((sum, r) => sum + r.qty_fulfilled, 0)
  return total / records.length
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
 * Calcula la demanda total de un componente:
 * ventas directas + demanda derivada de todos los kits que lo usan
 */
export function calcTotalComponentDemand(salesHistory, bomRows, componentSku, monthsBack = 6) {
  // Demanda directa
  const directDemand = calcAvgMonthlySales(salesHistory, componentSku, monthsBack)

  // Demanda derivada: buscar todos los kits que usan este componente
  const kitsUsingComponent = bomRows
    .filter(r => r.component_sku === componentSku)
    .map(r => r.kit_sku)

  const uniqueKits = [...new Set(kitsUsingComponent)]

  let derivedDemand = 0
  for (const kitSku of uniqueKits) {
    const kitAvgSales = calcAvgMonthlySales(salesHistory, kitSku, monthsBack)
    const bomRow = bomRows.find(r => r.kit_sku === kitSku && r.component_sku === componentSku)
    if (bomRow) {
      derivedDemand += kitAvgSales * bomRow.qty_per_kit
    }
  }

  return {
    direct: directDemand,
    derived: derivedDemand,
    total: directDemand + derivedDemand
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
 */
export function runForecast({ products, bomRows, salesHistory, inventorySnapshot, purchaseParams, transitOrders = [], monthsBack = 6 }) {
  // Solo componentes comprables (type = component con purchase_params)
  const components = products.filter(p => p.type === 'component')

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

    // Demanda total (directa + derivada)
    const demand = calcTotalComponentDemand(salesHistory, bomRows, component.sku, monthsBack)

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
export function calcKitFamilySales(salesHistory, bomRows, products, monthsBack = 6) {
  const kits = products.filter(p => p.type === 'kit')
  const families = {}

  for (const kit of kits) {
    const bomRow = bomRows.find(r => r.kit_sku === kit.sku)
    if (!bomRow) continue

    const vgroup = bomRow.variant_group
    if (!families[vgroup]) {
      families[vgroup] = { variant_group: vgroup, kits: [], total_avg_monthly: 0 }
    }

    const avg = calcAvgMonthlySales(salesHistory, kit.sku, monthsBack)
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
