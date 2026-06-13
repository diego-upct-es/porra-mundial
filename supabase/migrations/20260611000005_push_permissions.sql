-- =============================================================
-- Fase 8: RLS para push_subscriptions
-- =============================================================
-- push_subscriptions ya existe (creado en la migración inicial).
-- Este fichero:
--   1. Habilita RLS en la tabla.
--   2. Añade restricción UNIQUE(user_id) para poder hacer upsert.
--   3. Crea política: cada usuario gestiona solo sus suscripciones.
-- =============================================================


-- ── 1: RLS ──────────────────────────────────────────────────
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;


-- ── 2: UNIQUE por usuario (una suscripción activa por persona) ─
-- Es idempotente: si ya existe la constraint no hace nada.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'push_subscriptions_user_id_unique'
      AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    ALTER TABLE public.push_subscriptions
      ADD CONSTRAINT push_subscriptions_user_id_unique UNIQUE (user_id);
  END IF;
END $$;


-- ── 3: Política — cada usuario solo ve/modifica las suyas ────
-- El service role (daily-alert) bypasa RLS → puede leer todas.
DROP POLICY IF EXISTS "push_subscriptions: own" ON public.push_subscriptions;

CREATE POLICY "push_subscriptions: own"
  ON public.push_subscriptions
  FOR ALL
  USING     (auth.uid() = user_id)
  WITH CHECK(auth.uid() = user_id);
