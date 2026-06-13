-- =============================================================
-- Corrección: recursión infinita 42P17 en RLS
-- =============================================================
-- Causa: las políticas de league_members consultaban league_members
-- con RLS activo → cada evaluación lanzaba otra evaluación → ciclo.
-- Lo mismo pasaba con las políticas de leagues, predictions y
-- profiles que hacían subselects sobre league_members.
--
-- Solución: dos funciones SECURITY DEFINER que leen league_members
-- sin aplicar RLS (el search_path fijo evita ataques de sustitución).
-- Las políticas usan esas funciones en lugar de subselects directos.
-- =============================================================


-- ── PASO 1: Funciones auxiliares ─────────────────────────────

-- Devuelve true si el usuario actual es miembro de la liga indicada.
-- Al ser security definer consulta league_members sin RLS → rompe
-- la recursión en todas las políticas que llamen a esta función.
create or replace function public.is_league_member(_league_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.league_members
    where league_id = _league_id
      and user_id   = auth.uid()
  )
$$;

-- Devuelve true si el usuario actual comparte al menos una liga con
-- _other_user_id. Usada en la política de SELECT de profiles.
create or replace function public.shares_league_with(_other_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.league_members lm1
    join   public.league_members lm2 on lm2.league_id = lm1.league_id
    where  lm1.user_id = auth.uid()
      and  lm2.user_id = _other_user_id
  )
$$;

-- Permisos de ejecución
grant execute on function public.is_league_member(uuid)   to authenticated, anon;
grant execute on function public.shares_league_with(uuid) to authenticated, anon;


-- ── PASO 2: Eliminar las políticas que causan la recursión ────

-- profiles
drop policy if exists "profiles: select league members" on public.profiles;

-- leagues
drop policy if exists "leagues: select as member" on public.leagues;

-- league_members (única política de SELECT, la más crítica)
drop policy if exists "league_members: select as member" on public.league_members;

-- predictions
drop policy if exists "predictions: select member or own" on public.predictions;
drop policy if exists "predictions: insert own"           on public.predictions;


-- ── PASO 3: Recrear las políticas sin recursión ───────────────

-- ── PROFILES ─────────────────────────────────────────────────
-- "profiles: select own" no tocaba league_members → se mantiene tal cual.
-- Solo recreamos la política de compañeros de liga:
create policy "profiles: select league members"
  on public.profiles for select
  using (public.shares_league_with(profiles.id));
-- shares_league_with usa security definer → lee league_members sin RLS ✓


-- ── LEAGUES ──────────────────────────────────────────────────
create policy "leagues: select as member"
  on public.leagues for select
  using (public.is_league_member(leagues.id));
-- is_league_member usa security definer → sin recursión ✓


-- ── LEAGUE_MEMBERS ───────────────────────────────────────────
-- Una sola política cubre dos casos:
--   a) user_id = auth.uid() → la propia fila, evaluación directa, sin función.
--   b) is_league_member(league_id) → otras filas del mismo grupo,
--      la función lee sin RLS → el ciclo no se forma.
create policy "league_members: select as member"
  on public.league_members for select
  using (
    user_id = auth.uid()                         -- propia fila: sin llamada a función
    or public.is_league_member(league_id)        -- compañeros: sin recursión
  );


-- ── PREDICTIONS ──────────────────────────────────────────────
create policy "predictions: select member or own"
  on public.predictions for select
  using (
    -- Siempre puedes ver las tuyas
    auth.uid() = user_id
    or
    -- Las ajenas: solo si eres miembro y el partido ya comenzó
    (
      public.is_league_member(predictions.league_id)
      and exists (
        select 1 from public.matches
        where id = predictions.match_id and kickoff <= now()
      )
    )
  );

create policy "predictions: insert own"
  on public.predictions for insert
  with check (
    auth.uid() = user_id
    and public.is_league_member(predictions.league_id)
  );


-- ── MATCHES, PLAYER_STATS, PUSH_SUBSCRIPTIONS ────────────────
-- Sus políticas no referencian league_members directamente:
--   • matches: select authenticated → solo comprueba auth.uid() is not null ✓
--   • matches: update as league admin → subconsulta a leagues, que a su vez
--     usa is_league_member (security definer) → sin recursión ✓
--   • player_stats y push_subscriptions → sin relación con league_members ✓
-- No requieren cambios.
