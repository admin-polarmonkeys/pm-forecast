-- ============================================================
-- PM FORECAST — SCHEMA COMPLETO
-- Ejecutar en Supabase SQL Editor en este orden
-- ============================================================

-- 1. PRODUCTS — catálogo master
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('kit', 'component')),
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. BOM — bill of materials
CREATE TABLE IF NOT EXISTS bom (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  kit_sku TEXT NOT NULL REFERENCES products(sku),
  component_sku TEXT NOT NULL REFERENCES products(sku),
  qty_per_kit NUMERIC NOT NULL DEFAULT 1,
  variant_group TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(kit_sku, component_sku)
);

-- 3. SALES_HISTORY — ventas mensuales desde Report Pundit
CREATE TABLE IF NOT EXISTS sales_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- sku no tiene FK a products: permitimos cargar ventas de SKUs que aún no existen en el catálogo
  sku TEXT NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  qty_fulfilled INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sku, year, month)
);

-- 4. INVENTORY_SNAPSHOTS — snapshot mensual desde NetSuite
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES products(sku),
  snapshot_date DATE NOT NULL,
  qty_physical INT NOT NULL DEFAULT 0,
  qty_transit INT NOT NULL DEFAULT 0,
  qty_unfulfilled_with_stock INT NOT NULL DEFAULT 0,
  qty_available_real INT GENERATED ALWAYS AS (qty_physical - qty_unfulfilled_with_stock) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sku, snapshot_date)
);

-- 5. PURCHASE_PARAMS — parámetros editables por SKU
CREATE TABLE IF NOT EXISTS purchase_params (
  sku TEXT PRIMARY KEY REFERENCES products(sku),
  lead_time_weeks INT NOT NULL DEFAULT 12,
  coverage_target_months NUMERIC NOT NULL DEFAULT 3,
  growth_factor NUMERIC NOT NULL DEFAULT 1.40,
  moq INT NOT NULL DEFAULT 1,
  supplier TEXT,
  landed_cost_usd NUMERIC,
  -- Ventana de meses para el promedio de ventas de ESTE SKU.
  -- NULL = usar el default global de app_settings('avg_sales_months').
  avg_sales_months INT,
  -- Recorte de extremos de ESTE SKU: 0 = no recortar, 1 = quitar el mes más alto y el más bajo.
  -- NULL = usar el default global de app_settings('trim_extremes').
  -- OJO: 0 NO es lo mismo que NULL. El 0 es una decisión explícita de no recortar este SKU
  -- y le gana al global; NULL significa "seguí la cadena hacia el global".
  trim_extremes INT,
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migración para bases ya creadas
ALTER TABLE purchase_params ADD COLUMN IF NOT EXISTS avg_sales_months INT;
ALTER TABLE purchase_params ADD COLUMN IF NOT EXISTS trim_extremes INT;

-- 6. FORECAST_RUNS — cada vez que corres el análisis
CREATE TABLE IF NOT EXISTS forecast_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  snapshot_date DATE NOT NULL,
  months_history INT NOT NULL DEFAULT 6,
  -- Ventana GLOBAL del promedio de ventas usada en esta corrida.
  -- Los SKUs con purchase_params.avg_sales_months propio no usaron este valor.
  avg_sales_months INT,
  -- Recorte GLOBAL de extremos usado en esta corrida (0/1).
  -- Los SKUs con purchase_params.trim_extremes propio no usaron este valor.
  trim_extremes INT,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migración para bases ya creadas
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS avg_sales_months INT;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS trim_extremes INT;

-- 7. PURCHASE_ORDERS — output calculado por run
CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
  sku TEXT NOT NULL REFERENCES products(sku),
  avg_monthly_sales NUMERIC,
  projected_monthly_demand NUMERIC,
  qty_available_real INT,
  qty_transit INT,
  months_coverage_current NUMERIC,
  qty_suggested INT,
  total_landed_cost NUMERIC,
  supplier TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY — solo usuarios autenticados
-- ============================================================
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

-- Policies: solo autenticados pueden leer y escribir
CREATE POLICY "auth_only" ON products FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_only" ON bom FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_only" ON sales_history FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_only" ON inventory_snapshots FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_only" ON purchase_params FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_only" ON forecast_runs FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_only" ON purchase_orders FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- INDEXES para performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_bom_kit_sku ON bom(kit_sku);
CREATE INDEX IF NOT EXISTS idx_bom_component_sku ON bom(component_sku);
CREATE INDEX IF NOT EXISTS idx_sales_sku_year_month ON sales_history(sku, year, month);
CREATE INDEX IF NOT EXISTS idx_inventory_sku_date ON inventory_snapshots(sku, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_po_run_id ON purchase_orders(run_id);

-- ============================================================
-- TABLAS DE LA PAGINA ADMIN (ver supabase/admin_setup.sql)
-- ============================================================

-- 8. SUPPLIERS — catálogo de proveedores (code = el mismo texto que usa purchase_params.supplier)
CREATE TABLE IF NOT EXISTS suppliers (
  code TEXT PRIMARY KEY,
  name TEXT,
  is_china BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. APP_SETTINGS — configuración global clave/valor (blackout de China, etc.)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ventana global (en meses) del promedio de ventas. Default 12.
-- Precedencia: purchase_params.avg_sales_months > este valor > 12 (hardcodeado en forecast.js).
INSERT INTO app_settings (key, value)
VALUES ('avg_sales_months', '12')
ON CONFLICT (key) DO NOTHING;

-- Recorte global de extremos: 0 = sin recorte, 1 = quitar el mes más alto y el más bajo.
-- Precedencia: purchase_params.trim_extremes > este valor > 0 (hardcodeado en forecast.js).
-- Regla de piso: si después de recortar quedarían menos de 3 meses, no se recorta
-- (es decir, con una ventana de 4 meses o menos nunca se aplica).
INSERT INTO app_settings (key, value)
VALUES ('trim_extremes', '0')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- ROW LEVEL SECURITY — solo usuarios autenticados
-- ============================================================
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Postgres no soporta CREATE POLICY IF NOT EXISTS, así que se envuelve en un bloque DO
-- que primero chequea pg_policies. Sin esto, la segunda corrida tira error 42710.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'suppliers' AND policyname = 'auth_only'
  ) THEN
    CREATE POLICY "auth_only" ON suppliers FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_settings' AND policyname = 'auth_only'
  ) THEN
    CREATE POLICY "auth_only" ON app_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
