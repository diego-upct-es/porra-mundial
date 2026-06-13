-- =============================================================
-- Comic — avatares de caricatura por usuario
-- =============================================================
-- Almacena la URL pública del comic/caricatura generada por Gemini Imagen.
-- Se guarda en el perfil de usuario.
-- =============================================================

-- Añadir columna comic_url a profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS comic_url text;

-- Storage bucket para avatares originales y comics
-- (Crear en Dashboard → Storage → New bucket "avatars", Public)
-- El bucket se crea manualmente; aquí solo la política RLS de profiles.

-- Permitir que cada usuario actualice su propio comic_url
DROP POLICY IF EXISTS "profiles: update own" ON public.profiles;
CREATE POLICY "profiles: update own"
  ON public.profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
