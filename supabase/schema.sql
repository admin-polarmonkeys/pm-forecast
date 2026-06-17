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
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. FORECAST_RUNS — cada vez que corres el análisis
CREATE TABLE IF NOT EXISTS forecast_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  snapshot_date DATE NOT NULL,
  months_history INT NOT NULL DEFAULT 6,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
