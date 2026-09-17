-- ============================================================
-- PM FORECAST — TABLAS DE LA PÁGINA ADMIN
-- Copiar y pegar TODO este archivo en el SQL Editor de Supabase y ejecutar.
-- Es seguro correrlo más de una vez: no borra ni pisa datos existentes.
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
