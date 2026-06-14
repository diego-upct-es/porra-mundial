-- =============================================================
-- Goleador por partido
-- =============================================================
-- squads      : plantilla de cada equipo (API-Football /players/squads)
-- match_goals : goles marcados en cada partido (/fixtures/events)
-- scorer_picks: predicción de goleador por usuario/liga/partido
-- =============================================================

-- ── Plantillas ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.squads (
  ext_team_id   int  NOT NULL,
  ext_player_id int  NOT NULL,
  player_name   text NOT NULL,
  position      text NOT NULL,   -- 'Goalkeeper'|'Defender'|'Midfielder'|'Attacker'
  shirt_number  int,
  updated_at    timestamptz DEFAULT now(),
  PRIMARY KEY (ext_team_id, ext_player_id)
);

-- ── Goles por partido ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.match_goals (
  match_id      text NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  ext_player_id int  NOT NULL,
  player_name   text NOT NULL,
  team_id       int  NOT NULL,
  minute        int  NOT NULL,
  is_own_goal   boolean DEFAULT false,
  PRIMARY KEY (match_id, ext_player_id, minute)
);

-- ── Predicciones de goleador ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scorer_picks (
  league_id     uuid NOT NULL REFERENCES public.leagues(id)  ON DELETE CASCADE,
  match_id      text NOT NULL REFERENCES public.matches(id)  ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ext_player_id int  NOT NULL,
  player_name   text NOT NULL,
  team_name     text NOT NULL,
  position      text NOT NULL,
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (league_id, match_id, user_id)
);

-- ── Trigger: bloqueo de ventana ──────────────────────────────
-- Rechaza INSERT/UPDATE si el partido ya empezó (kickoff <= now()).
CREATE OR REPLACE FUNCTION public.check_scorer_pick_window()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_kickoff timestamptz;
BEGIN
  SELECT kickoff INTO v_kickoff FROM public.matches WHERE id = NEW.match_id;
  IF v_kickoff IS NOT NULL AND v_kickoff <= now() THEN
    RAISE EXCEPTION 'scorer_pick_locked'
      USING HINT = 'El partido ya ha empezado; no se puede cambiar el goleador.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER scorer_picks_window_check
  BEFORE INSERT OR UPDATE ON public.scorer_picks
  FOR EACH ROW
  EXECUTE FUNCTION public.check_scorer_pick_window();

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.squads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_goals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scorer_picks ENABLE ROW LEVEL SECURITY;

-- squads: lectura para todos los autenticados; escritura solo service_role
CREATE POLICY "squads_read_auth" ON public.squads
  FOR SELECT USING (auth.role() = 'authenticated');

-- match_goals: lectura para todos los autenticados
CREATE POLICY "match_goals_read_auth" ON public.match_goals
  FOR SELECT USING (auth.role() = 'authenticated');

-- scorer_picks: lectura para miembros de la liga
CREATE POLICY "scorer_picks_read_members" ON public.scorer_picks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.league_members lm
      WHERE lm.league_id = scorer_picks.league_id
        AND lm.user_id   = auth.uid()
    )
  );

-- scorer_picks: el propio usuario inserta/actualiza su pick
CREATE POLICY "scorer_picks_insert_own" ON public.scorer_picks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "scorer_picks_update_own" ON public.scorer_picks
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
