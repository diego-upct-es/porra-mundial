-- =============================================================
-- Changelog modal: rastrea la última versión vista por cada usuario
-- =============================================================
-- Cuando last_seen_version < APP_VERSION del frontend, se muestra
-- el modal de novedades al entrar en la app.
-- =============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_version text;
