# PM Forecast — Deploy Instructions

## PASO 1: Supabase — Crear tablas

1. Ve a supabase.com → tu proyecto pm-forecast
2. Click en "SQL Editor" en el menú izquierdo
3. Copia y pega el contenido de `supabase/schema.sql`
4. Click "Run"
5. Deberías ver "Success" — 7 tablas creadas

## PASO 2: Supabase — Cargar datos (BOM + Productos + Parámetros)

1. En el SQL Editor, abre una nueva query
2. Copia y pega el contenido de `supabase/seed.sql`
3. Click "Run"
4. Deberías ver los registros insertados

## PASO 3: Supabase — Crear usuario

1. Ve a Authentication → Users
2. Click "Add User" → "Create New User"
3. Email: elizabeth@polarmonkeys.com
4. Crea una contraseña segura
5. Click "Create User"

## PASO 4: Subir código a GitHub

En Terminal, dentro de la carpeta pm-forecast:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/pm-forecast.git
git push -u origin main
```

## PASO 5: Configurar variables de entorno en Vercel

1. Ve a Vercel → proyecto pm-forecast → Settings → Environment Variables
2. Agrega estas dos variables:

   Name: VITE_SUPABASE_URL
   Value: https://pahdnsxnjoxcjaotbtxn.supabase.co

   Name: VITE_SUPABASE_ANON_KEY
   Value: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

3. Click "Save" en cada una
4. Ve a Deployments → click "Redeploy"

## PASO 6: Dominio personalizado

1. Ve a Vercel → proyecto → Settings → Domains
2. Agrega: forecast.polarmonkeys.info
3. Vercel te da un CNAME — agrégalo en tu DNS (donde manejes polarmonkeys.info)
4. En ~5 minutos el dominio está activo

## PASO 7: Primer uso

1. Ve a forecast.polarmonkeys.info
2. Login con elizabeth@polarmonkeys.com
3. Ve a "Upload Data" → sube el CSV de Report Pundit + CSV de NetSuite
4. Ve a "Purchase Forecast" → click "Correr Forecast"

