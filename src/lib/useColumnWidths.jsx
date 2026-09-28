/**
 * Redimensionado de columnas reutilizable para todas las tablas de la app.
 *
 * Extraído de la implementación original de ForecastView para no duplicarla en
 * cada pantalla. Provee:
 *   - useColumnWidths(storageKey, defaults) -> estado de anchos + persistencia
 *   - <ResizableTh>  -> un <th> que ya trae el ancho aplicado y el handle de arrastre
 *   - <ResetWidthsButton> -> botón para volver a los anchos por defecto
 *
 * REQUISITO DE LA TABLA: el redimensionado necesita `tableLayout: 'fixed'` y un
 * `width` explícito en la <table> (usar el totalWidth que devuelve el hook). Sin
 * eso el navegador reparte los anchos según el contenido e ignora los nuestros.
 */
import { useState, useCallback, useMemo } from 'react'

/** Ancho mínimo al que se puede encoger una columna arrastrando. */
export const MIN_COL_WIDTH = 60

/** Ancho que se usa si una columna no tiene default declarado. */
const FALLBACK_COL_WIDTH = 100

/** Prefijo de las claves de localStorage. */
const STORAGE_PREFIX = 'pm_colwidths_'

/**
 * Tope de columnas guardadas por tabla. Las tablas de Sales History tienen una
 * columna por mes, así que el set de claves crece con el tiempo; el tope evita
 * que localStorage se infle sin límite después de años de historial.
 */
const MAX_STORED_KEYS = 300

function storageKeyFor(tableKey) {
  return STORAGE_PREFIX + tableKey
}

/**
 * Lee los anchos guardados. Descarta cualquier valor que no sea un número usable:
 * si el storage quedó corrupto o con datos de una versión anterior, preferimos
 * volver a los defaults antes que romper el layout.
 */
function readStored(tableKey) {
  try {
    const raw = localStorage.getItem(storageKeyFor(tableKey))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean = {}
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v)
      if (Number.isFinite(n) && n >= MIN_COL_WIDTH) clean[k] = n
    }
    return clean
  } catch {
    // localStorage bloqueado (modo privado) o JSON inválido: seguimos con defaults
    return {}
  }
}

function writeStored(tableKey, widths) {
  try {
    const entries = Object.entries(widths)
    // Si se pasó del tope, conservamos las últimas claves (las más recientes)
    const trimmed = entries.length > MAX_STORED_KEYS
      ? Object.fromEntries(entries.slice(-MAX_STORED_KEYS))
      : widths
    localStorage.setItem(storageKeyFor(tableKey), JSON.stringify(trimmed))
  } catch {
    // Storage lleno o no disponible: el ancho igual queda aplicado en memoria
  }
}

/**
 * Estado de anchos de columna de una tabla, persistido en localStorage.
 *
 * @param tableKey identificador estable de la tabla (entra en la clave de storage)
 * @param defaults { [colKey]: anchoPx }. El ORDEN de las claves define el orden de
 *   las columnas para calcular totalWidth. En tablas con columnas dinámicas (una por
 *   mes) hay que construirlo con useMemo: alcanza con que la columna nueva aparezca
 *   acá para que tome su ancho por defecto, sin tocar lo que ya está guardado.
 */
export function useColumnWidths(tableKey, defaults) {
  // Los overrides del usuario se guardan APARTE de los defaults. Así una columna
  // nueva (un mes nuevo) toma su default sin que haya que migrar el storage, y un
  // cambio en los defaults del código se refleja en las columnas no tocadas.
  const [overrides, setOverrides] = useState(() => readStored(tableKey))
  const [hoverKey, setHoverKey] = useState(null)

  const widths = useMemo(() => {
    const out = {}
    for (const [key, def] of Object.entries(defaults || {})) {
      out[key] = overrides[key] ?? def ?? FALLBACK_COL_WIDTH
    }
    return out
  }, [defaults, overrides])

  const totalWidth = useMemo(
    () => Object.values(widths).reduce((sum, w) => sum + w, 0),
    [widths]
  )

  // ¿Hay algún override que aplique a una columna visible? Solo entonces tiene
  // sentido ofrecer el reset: overrides de meses que ya no se muestran no cuentan.
  const isCustomized = useMemo(
    () => Object.keys(defaults || {}).some(k => overrides[k] != null),
    [defaults, overrides]
  )

  const startResize = useCallback((e, colKey) => {
    e.preventDefault()
    e.stopPropagation() // no disparar el sort del th al arrastrar
    const startX = e.clientX
    const startWidth = widths[colKey] ?? defaults?.[colKey] ?? FALLBACK_COL_WIDTH

    function onMove(ev) {
      const next = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX))
      setOverrides(prev => ({ ...prev, [colKey]: next }))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      // Persistimos al soltar, no en cada pixel del arrastre
      setOverrides(prev => {
        writeStored(tableKey, prev)
        return prev
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none' // evita seleccionar texto durante el drag
  }, [widths, defaults, tableKey])

  const reset = useCallback(() => {
    setOverrides({})
    try {
      localStorage.removeItem(storageKeyFor(tableKey))
    } catch {
      // nada que hacer: el estado en memoria ya volvió a los defaults
    }
  }, [tableKey])

  return { widths, totalWidth, startResize, reset, isCustomized, hoverKey, setHoverKey }
}

const handleStyle = {
  position: 'absolute',
  top: 0,
  right: 0,
  height: '100%',
  width: 4,
  cursor: 'col-resize',
}

/**
 * <th> con el ancho aplicado y el handle de arrastre en el borde derecho.
 *
 * Cualquier prop extra (onClick, title, colSpan…) se pasa al <th>. El `style` que
 * se recibe se respeta; solo se le suman los anchos y `position: relative` cuando
 * no trae una posición propia (los headers sticky ya vienen con position: sticky,
 * que también sirve de contexto para posicionar el handle).
 */
export function ResizableTh({ colKey, resize, style, children, handleColor, ...rest }) {
  const w = resize.widths[colKey]
  const hovered = resize.hoverKey === colKey
  return (
    <th
      {...rest}
      style={{
        ...style,
        width: w,
        minWidth: w,
        maxWidth: w,
        overflow: 'hidden',
        position: style?.position || 'relative',
      }}
    >
      {children}
      <span
        onMouseDown={e => resize.startResize(e, colKey)}
        onClick={e => e.stopPropagation()}
        onMouseEnter={() => resize.setHoverKey(colKey)}
        onMouseLeave={() => resize.setHoverKey(null)}
        style={{
          ...handleStyle,
          background: hovered
            ? 'rgba(120,150,230,0.9)'
            : (handleColor || 'rgba(255,255,255,0.18)'),
        }}
      />
    </th>
  )
}

const resetBtnStyle = {
  background: '#fff',
  color: '#4455aa',
  border: '1.5px solid #c5ccea',
  borderRadius: 6,
  padding: '5px 10px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * Botón para volver a los anchos por defecto. No se renderiza hasta que el usuario
 * redimensionó algo, así que no ocupa lugar en una tabla que nadie tocó.
 */
export function ResetWidthsButton({ resize, style, label = '↔ Reset column widths' }) {
  if (!resize.isCustomized) return null
  return (
    <button
      type="button"
      onClick={resize.reset}
      style={{ ...resetBtnStyle, ...style }}
      title="Volver a los anchos de columna por defecto"
    >
      {label}
    </button>
  )
}
