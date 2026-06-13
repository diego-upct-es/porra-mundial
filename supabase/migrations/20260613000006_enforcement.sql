-- =============================================================
-- Reglas de negocio: enforcement en base de datos
-- =============================================================

-- ── REGLA 1: Campeón del Mundial — inmutable una vez elegido ──
-- El trigger rechaza cualquier UPDATE de champion_pick cuando el
-- valor anterior ya era NOT NULL, independientemente de lo que
-- intente el cliente (RLS, PostgREST, función RPC…).
-- La única excepción: pasar de NULL a un valor (la primera elección).
-- =============================================================

CREATE OR REPLACE FUNCTION public.lock_champion_pick()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.champion_pick IS NOT NULL
     AND NEW.champion_pick IS DISTINCT FROM OLD.champion_pick
  THEN
    RAISE EXCEPTION 'champion_locked'
      USING HINT = 'El campeón ya fue elegido y no puede modificarse.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER league_members_champion_lock
  BEFORE UPDATE ON public.league_members
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_champion_pick();

-- ── REGLA 2: Predicciones bloqueadas al empezar el partido ───
-- Ya existe desde migration 001 (check_prediction_window).
-- Nada que añadir en la BD.
-- =============================================================

-- ── REGLA 3: Sin predicción = ausencia (no 99-99) ─────────────
-- La vista standings ya usa JOIN (no LEFT JOIN), por lo que
-- un partido sin predicción no genera puntos. Correcto.
-- El trigger de ventana impide insertar una predicción falsa.
-- Nada que añadir en la BD.
-- =============================================================
