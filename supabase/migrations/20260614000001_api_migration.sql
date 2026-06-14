-- =============================================================
-- Migración de proveedor de datos: football-data.org → API-Football
-- =============================================================
--
-- Añade una función auxiliar que vacía matches + predictions en
-- una sola transacción. La usa import-fixtures con ?truncate=true
-- para la migración inicial (los IDs de API-Football son distintos
-- a los de football-data.org, por lo que hay que reemplazar todo).
--
-- Solo invocable por el service_role (Edge Functions).
-- =============================================================

CREATE OR REPLACE FUNCTION public.truncate_fixtures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  pred_count integer;
  match_count integer;
BEGIN
  SELECT count(*) INTO pred_count  FROM public.predictions;
  SELECT count(*) INTO match_count FROM public.matches;

  TRUNCATE TABLE public.predictions CASCADE;
  TRUNCATE TABLE public.matches    CASCADE;

  RETURN jsonb_build_object(
    'ok',              true,
    'predictions_del', pred_count,
    'matches_del',     match_count
  );
END;
$$;

-- El anon / authenticated no puede invocarla directamente
REVOKE ALL   ON FUNCTION public.truncate_fixtures() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.truncate_fixtures() TO service_role;
