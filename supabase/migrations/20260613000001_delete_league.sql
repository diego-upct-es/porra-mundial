-- =============================================================
-- Borrar liga — solo el admin_id puede eliminar su liga
-- =============================================================
-- La tabla leagues ya tiene:
--   league_members  → ON DELETE CASCADE
--   predictions     → ON DELETE CASCADE  (a través de league_id)
-- Así que DELETE en leagues borra en cascada a miembros y predicciones.
-- =============================================================

-- ── 1. Política RLS de DELETE en leagues ─────────────────────
DROP POLICY IF EXISTS "leagues: admin delete" ON public.leagues;

CREATE POLICY "leagues: admin delete"
  ON public.leagues
  FOR DELETE
  USING (auth.uid() = admin_id);


-- ── 2. RPC SECURITY DEFINER para borrado seguro ───────────────
-- Valida que el llamante sea el admin_id antes de borrar.
-- Devuelve { ok: true } o { error: 'not_admin' }.
CREATE OR REPLACE FUNCTION public.delete_league(_league_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.leagues
    WHERE id = _league_id AND admin_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('error', 'not_admin');
  END IF;

  DELETE FROM public.leagues WHERE id = _league_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_league(uuid) TO authenticated;
