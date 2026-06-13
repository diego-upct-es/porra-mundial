-- =============================================================
-- Fase 7: Realtime en predictions y matches
-- =============================================================
--
-- PARTE 1 — Publicación Realtime
--   Añade las dos tablas a supabase_realtime para que Postgres
--   emita cambios a los clientes suscritos.
--   Usa DO $$ para ser idempotente (no falla si ya están en la pub).
--
-- PARTE 2 — Corrección de la política SELECT de predictions
--   La política anterior bloqueaba ver predicciones ajenas en
--   partidos futuros (kickoff > now()). Eso impedía:
--     • El panel de "marcadores pillados" (Scoreboard)
--     • Los eventos Realtime de predicciones ajenas
--   La restricción temporal se mantiene en el FRONTEND:
--     • HistoryTab solo muestra predicciones de partidos iniciados.
--     • Scoreboard no revela el user_id al mostrar "pillados"
--       (solo muestra el marcador en gris; el nombre solo aparece
--        en el aviso de colisión al intentar guardar el mismo marcador).
-- =============================================================


-- ── PARTE 1: Realtime ─────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'predictions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.predictions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'matches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
  END IF;
END $$;


-- ── PARTE 2: Corrección RLS predictions ──────────────────────

-- Elimina la política anterior que restringía por kickoff
DROP POLICY IF EXISTS "predictions: select member or own" ON public.predictions;

-- Nueva política: miembro de la liga puede ver TODAS las predicciones
-- de esa liga, independientemente de si el partido ya comenzó.
-- La lógica temporal (revelar quién apostó qué) la gestiona el frontend.
CREATE POLICY "predictions: select member or own"
  ON public.predictions FOR SELECT
  USING (
    auth.uid() = user_id                             -- siempre ves las tuyas
    OR public.is_league_member(predictions.league_id) -- o eres miembro de la liga
  );
