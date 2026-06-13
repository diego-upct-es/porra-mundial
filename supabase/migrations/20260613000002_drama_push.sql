-- =============================================================
-- Drama push — tabla de snapshots de clasificación por liga
-- =============================================================
-- Guarda la última posición (rank) de cada usuario en cada liga.
-- La Edge Function drama-push la consulta para detectar adelantos.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.standings_snapshots (
  league_id uuid   NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  user_id   uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rank      int    NOT NULL,
  pts       int    NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, user_id)
);

-- Solo la service role escribe; authenticated puede leer su propio registro.
ALTER TABLE public.standings_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "snapshots: service role full access"
  ON public.standings_snapshots
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.standings_snapshots TO authenticated;
