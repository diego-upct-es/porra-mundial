-- =============================================================
-- Configuración de cron jobs (Fase 5 + Fase 8)
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- =============================================================
-- La anon key ya está rellena abajo.
-- =============================================================


-- ── PASO 1: Habilitar extensiones ────────────────────────────
-- pg_cron viene habilitado por defecto en Supabase.
-- pg_net permite hacer llamadas HTTP desde Postgres.

CREATE EXTENSION IF NOT EXISTS pg_net;


-- ── PASO 2: Programar poll-results cada 30 minutos ───────────

SELECT cron.schedule(
  'poll-results-30min',            -- nombre del job (único)
  '*/30 * * * *',                  -- cada 30 min, toda la semana
  $$
    SELECT net.http_post(
      url     := 'https://eflomqqolasqiixbsnbf.supabase.co/functions/v1/poll-results',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer sb_publishable_KWbMr9Rf252tBegwQTa3lg_iy0J9TSh'
      ),
      body    := '{}'::jsonb
    );
  $$
);


-- ── PASO 3: Verificar que el job está creado ─────────────────

SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'poll-results-30min';


-- =============================================================
-- Comandos útiles para operar el cron
-- =============================================================

-- Ver todas las ejecuciones recientes:
-- SELECT jobid, status, start_time, end_time, return_message
-- FROM cron.job_run_details
-- ORDER BY start_time DESC
-- LIMIT 20;

-- Ver las respuestas HTTP de pg_net:
-- SELECT id, status_code, content, created
-- FROM net._http_response
-- ORDER BY created DESC
-- LIMIT 5;

-- Ejecutar poll-results manualmente ahora (para probar):
-- SELECT net.http_post(
--   url     := 'https://eflomqqolasqiixbsnbf.supabase.co/functions/v1/poll-results',
--   headers := jsonb_build_object(
--     'Content-Type',  'application/json',
--     'Authorization', 'Bearer TU_ANON_KEY'
--   ),
--   body    := '{}'::jsonb
-- );

-- Eliminar el job si hace falta recrearlo:
-- SELECT cron.unschedule('poll-results-30min');


-- =============================================================
-- FASE 8: Aviso diario a las 9:00 CEST (07:00 UTC)
-- =============================================================

-- ── PASO 4: Programar daily-alert a las 07:00 UTC ────────────

SELECT cron.schedule(
  'daily-alert-9am',               -- nombre del job (único)
  '0 7 * * *',                     -- 07:00 UTC = 09:00 CEST cada día
  $$
    SELECT net.http_post(
      url     := 'https://eflomqqolasqiixbsnbf.supabase.co/functions/v1/daily-alert',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer sb_publishable_KWbMr9Rf252tBegwQTa3lg_iy0J9TSh'
      ),
      body    := '{}'::jsonb
    );
  $$
);


-- ── PASO 5: Verificar ────────────────────────────────────────

SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'daily-alert-9am';


-- Ejecutar daily-alert manualmente ahora (para probar):
-- SELECT net.http_post(
--   url     := 'https://eflomqqolasqiixbsnbf.supabase.co/functions/v1/daily-alert',
--   headers := jsonb_build_object(
--     'Content-Type',  'application/json',
--     'Authorization', 'Bearer sb_publishable_KWbMr9Rf252tBegwQTa3lg_iy0J9TSh'
--   ),
--   body    := '{}'::jsonb
-- );

-- Eliminar el job si hace falta recrearlo:
-- SELECT cron.unschedule('daily-alert-9am');


-- =============================================================
-- FEAT: Drama push — aviso cuando alguien te adelanta
-- Se lanza 5 minutos después de cada poll-results (*/30 + 5 min)
-- =============================================================

-- ── PASO 6: Programar drama-push cada 30 min (offset +5 min) ─

SELECT cron.schedule(
  'drama-push-30min',
  '5,35 * * * *',                  -- :05 y :35 de cada hora
  $$
    SELECT net.http_post(
      url     := 'https://eflomqqolasqiixbsnbf.supabase.co/functions/v1/drama-push',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer sb_publishable_KWbMr9Rf252tBegwQTa3lg_iy0J9TSh'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Verificar:
-- SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'drama-push-30min';

-- Ejecutar manualmente:
-- SELECT net.http_post(
--   url     := 'https://eflomqqolasqiixbsnbf.supabase.co/functions/v1/drama-push',
--   headers := jsonb_build_object(
--     'Content-Type',  'application/json',
--     'Authorization', 'Bearer sb_publishable_KWbMr9Rf252tBegwQTa3lg_iy0J9TSh'
--   ),
--   body    := '{}'::jsonb
-- );

-- Eliminar:
-- SELECT cron.unschedule('drama-push-30min');
