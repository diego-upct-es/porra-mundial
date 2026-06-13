-- =============================================================
-- Viñeta de grupo por jornada
-- =============================================================
-- Sustituye los comics individuales (migration 004) por una
-- única viñeta generada por Gemini por cada jornada + liga.
-- =============================================================

-- ── 1. Foto de referencia en el perfil (opcional) ─────────────
-- El usuario la sube desde la app; se usa como input para Gemini.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url text;

-- La columna comic_url (migration 004) se queda pero ya no se usa.

-- ── 2. Tabla de viñetas de grupo ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_comics (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid        NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  match_day   date        NOT NULL,     -- YYYY-MM-DD de la jornada
  image_url   text        NOT NULL,     -- URL pública en Storage
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, match_day)
);

-- RLS: miembros de la liga pueden leer su viñeta.
ALTER TABLE public.daily_comics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_comics: member read"
  ON public.daily_comics
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.league_members lm
      WHERE lm.league_id = daily_comics.league_id
        AND lm.user_id   = auth.uid()
    )
  );

GRANT SELECT ON public.daily_comics TO authenticated;

-- ── 3. RLS de profiles: actualizar avatar_url propio ──────────
-- La política "profiles: update own" ya existe (migration 004).
-- Si no existe, se crea aquí.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'profiles: update own'
  ) THEN
    CREATE POLICY "profiles: update own"
      ON public.profiles
      FOR UPDATE
      USING     (auth.uid() = id)
      WITH CHECK (auth.uid() = id);
  END IF;
END
$$;
