-- =============================================================
-- Daily recaps — crónica diaria generada por Gemini
-- =============================================================

CREATE TABLE IF NOT EXISTS public.daily_recaps (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id  uuid        NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  recap_date date        NOT NULL,             -- día al que corresponde (YYYY-MM-DD)
  content    text        NOT NULL,             -- texto generado por Gemini
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, recap_date)
);

-- Solo service role escribe; miembros autenticados leen.
ALTER TABLE public.daily_recaps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recaps: member read"
  ON public.daily_recaps
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.league_members lm
      WHERE lm.league_id = daily_recaps.league_id
        AND lm.user_id   = auth.uid()
    )
  );

-- Service role (la Edge Function) puede insertar/actualizar.
-- No necesita política RLS porque service role bypassea RLS.

GRANT SELECT ON public.daily_recaps TO authenticated;
