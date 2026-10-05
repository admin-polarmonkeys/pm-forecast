/**
 * Lectura paginada de una tabla completa.
 *
 * Supabase (PostgREST) devuelve como máximo `max_rows` filas por consulta (1.000 por
 * defecto) y corta el resto SIN error. Un select sin paginar sobre una tabla que crece
 * (sales_history, inventory_snapshots, purchase_orders…) empieza a perder datos en
 * silencio el día que pasa ese tope: los números se ven válidos y no lo son.
 *
 * fetchAll trae la tabla en tandas hasta tener todas las filas. Devuelve la misma forma
 * que una consulta de supabase-js ({ data, error }), así que en los call sites alcanza
 * con reemplazar la consulta dentro del Promise.all.
 *
 * Cómo sabe cuándo terminar: pide `count: 'exact'` y sigue hasta juntar `count` filas.
 * Avanza según las filas que realmente llegaron (no según pageSize), así funciona aunque
 * el proyecto tenga configurado un max_rows menor a pageSize.
 *
 * Orden estable: la paginación por rango necesita un orden total, si no una fila puede
 * repetirse o saltearse entre tandas. Por eso siempre se agrega `id` como desempate.
 */
import { supabase } from './supabase'

const DEFAULT_PAGE_SIZE = 1000

/**
 * @param table    nombre de la tabla
 * @param columns  columnas del select (igual que en .select())
 * @param options.orderBy  [[columna, { ascending }], …] — orden pedido por el call site
 * @param options.pageSize filas por tanda
 * @returns {Promise<{ data: any[] | null, error: any }>}
 */
export async function fetchAll(table, columns = '*', { orderBy = [], pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const rows = []
  for (;;) {
    let q = supabase.from(table).select(columns, { count: 'exact' })
    for (const [col, opts] of orderBy) q = q.order(col, opts)
    q = q.order('id', { ascending: true }).range(rows.length, rows.length + pageSize - 1)

    const { data, error, count } = await q
    if (error) return { data: null, error }

    const page = data || []
    rows.push(...page)
    if (page.length === 0) break
    if (count != null ? rows.length >= count : page.length < pageSize) break
  }
  return { data: rows, error: null }
}
