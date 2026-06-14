-- =============================================================
-- Añade IDs de equipo a matches (para cruzar con squads)
-- =============================================================
-- home_team_id / away_team_id = team.id de API-Football.
-- Los rellena import-fixtures en cada upsert.
-- Los usa import-squads para saber qué plantillas descargar.
-- =============================================================

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS home_team_id int,
  ADD COLUMN IF NOT EXISTS away_team_id int;
