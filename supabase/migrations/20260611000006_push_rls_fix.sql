-- =============================================================
-- Fase 8 (fix): push_subscriptions — GRANT + política INSERT explícita
-- =============================================================
-- La migración 005 creó un FOR ALL policy que cubre todo en teoría,
-- pero PostgREST necesita que el rol authenticated tenga GRANT
-- explícito Y política INSERT separada para que upsert funcione.
-- =============================================================

-- ── GRANT al rol authenticated ───────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.push_subscriptions TO authenticated;

-- ── Política INSERT explícita ─────────────────────────────────
-- Complementa la FOR ALL de 005; en PostgreSQL las políticas
-- permisivas se aplican en OR, así que no hay conflicto.
DROP POLICY IF EXISTS "push_subscriptions: insert own"
  ON public.push_subscriptions;

CREATE POLICY "push_subscriptions: insert own"
  ON public.push_subscriptions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);
