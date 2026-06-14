-- =============================================================
-- FK hardening: predictions y scorer_picks → RESTRICT en match_id
-- =============================================================
-- Regla de oro: ninguna operación puede eliminar predicciones ni
-- puntos de usuario. Cambiar ON DELETE CASCADE → ON DELETE RESTRICT
-- garantiza que borrar o reemplazar un match falle con error explícito
-- en lugar de eliminar silenciosamente todo lo relacionado.
--
-- La cascade desde leagues (league_id) se mantiene: si el admin
-- borra su propia liga intencionalmente, todo lo de esa liga cae.
-- =============================================================

-- ── predictions.match_id ─────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname    = 'predictions_match_id_fkey'
       AND conrelid   = 'public.predictions'::regclass
  ) THEN
    ALTER TABLE public.predictions
      DROP CONSTRAINT predictions_match_id_fkey;
  END IF;

  ALTER TABLE public.predictions
    ADD CONSTRAINT predictions_match_id_fkey
    FOREIGN KEY (match_id)
    REFERENCES public.matches(id)
    ON DELETE RESTRICT;
END $$;

-- ── scorer_picks.match_id ─────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname    = 'scorer_picks_match_id_fkey'
       AND conrelid   = 'public.scorer_picks'::regclass
  ) THEN
    ALTER TABLE public.scorer_picks
      DROP CONSTRAINT scorer_picks_match_id_fkey;
  END IF;

  ALTER TABLE public.scorer_picks
    ADD CONSTRAINT scorer_picks_match_id_fkey
    FOREIGN KEY (match_id)
    REFERENCES public.matches(id)
    ON DELETE RESTRICT;
END $$;

-- ── Verificación (ejecutar tras aplicar la migración) ─────────
-- SELECT conname, confdeltype
-- FROM   pg_constraint
-- WHERE  conrelid IN (
--          'public.predictions'::regclass,
--          'public.scorer_picks'::regclass
--        )
--   AND  contype = 'f'
--   AND  conname LIKE '%match_id%';
-- Esperado: confdeltype = 'r' (RESTRICT) en ambas filas.
