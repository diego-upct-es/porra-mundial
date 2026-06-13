-- =============================================================
-- Corrección: INSERT en leagues + flujo crear/unirse a liga
-- =============================================================
-- Problema 1 (42501): faltaba o era inaccesible la política INSERT
--   en leagues y league_members.
--
-- Problema 2 (chicken-and-egg): incluso con la política INSERT
--   correcta, el SELECT posterior al INSERT falla porque la política
--   SELECT de leagues exige is_league_member(), pero el usuario
--   aún no está en league_members.
--
-- Problema 3 (unirse con código): un no-miembro no puede hacer
--   SELECT en leagues (política solo permite a miembros), así que
--   nunca encuentra la liga por código para luego unirse.
--
-- Solución: dos funciones SECURITY DEFINER atómicas.
--   • create_league  → inserta liga + membresía del admin en un paso.
--   • join_league_by_code → localiza liga sin RLS + inserta membresía.
-- Las políticas INSERT se mantienen como red de seguridad para
-- accesos directos a las tablas (Supabase Studio, service role, etc.).
-- =============================================================


-- ── 1. Políticas INSERT (red de seguridad) ────────────────────

-- leagues: un usuario puede insertar si se pone a sí mismo como admin.
drop policy if exists "leagues: insert authenticated" on public.leagues;
drop policy if exists "leagues: insert"               on public.leagues;
create policy "leagues: insert"
  on public.leagues for insert
  with check (auth.uid() = admin_id);

-- league_members: un usuario solo puede insertarse a sí mismo.
drop policy if exists "league_members: insert own" on public.league_members;
create policy "league_members: insert own"
  on public.league_members for insert
  with check (user_id = auth.uid());


-- ── 2. Función: crear liga ────────────────────────────────────
-- Inserta en leagues + league_members en una sola transacción.
-- Al ser security definer evita el problema del SELECT posterior
-- (que fallaría porque el usuario aún no sería miembro).
-- Devuelve jsonb: { ok: true, league_id: uuid } | { error: 'code_taken' }
create or replace function public.create_league(
  _name  text,
  _code  text,
  _theme text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id uuid;
begin
  -- Inserta la liga con el usuario actual como admin
  insert into public.leagues (name, code, theme, admin_id)
  values (
    trim(_name),
    upper(trim(_code)),
    _theme,
    auth.uid()
  )
  returning id into v_league_id;

  -- Añade al admin como primer miembro
  insert into public.league_members (league_id, user_id)
  values (v_league_id, auth.uid());

  return jsonb_build_object('ok', true, 'league_id', v_league_id);

exception
  when unique_violation then
    -- El código de liga ya existe; el frontend reintenta con otro código
    return jsonb_build_object('error', 'code_taken');
  when others then
    return jsonb_build_object('error', sqlerrm);
end;
$$;

grant execute on function public.create_league(text, text, text) to authenticated;


-- ── 3. Función: unirse con código ─────────────────────────────
-- Un no-miembro no puede hacer SELECT en leagues (RLS lo bloquea),
-- así que no puede localizar la liga por código antes de unirse.
-- Esta función security definer resuelve el chicken-and-egg:
-- busca la liga sin RLS e inserta la membresía atómicamente.
-- Devuelve jsonb:
--   { ok: true,  league_id: uuid }   → unido correctamente
--   { error: 'not_found' }           → código inexistente
--   { error: 'already_member', league_id: uuid } → ya era miembro
--   { error: <mensaje> }             → otro error de Postgres
create or replace function public.join_league_by_code(_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id uuid;
begin
  -- Busca la liga sin RLS (security definer lo omite)
  select id into v_league_id
  from public.leagues
  where code = upper(trim(_code));

  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  -- Inserta la membresía; si ya existe captura la violación UNIQUE
  begin
    insert into public.league_members (league_id, user_id)
    values (v_league_id, auth.uid());
  exception
    when unique_violation then
      return jsonb_build_object('error', 'already_member', 'league_id', v_league_id);
  end;

  return jsonb_build_object('ok', true, 'league_id', v_league_id);

exception
  when others then
    return jsonb_build_object('error', sqlerrm);
end;
$$;

grant execute on function public.join_league_by_code(text) to authenticated;


-- ── 4. Perfil de co-miembros: verificar y reforzar ────────────
-- shares_league_with ya fue creada en la migración anterior.
-- La recreamos para asegurar que está activa y tiene los permisos
-- correctos (idempotente gracias a CREATE OR REPLACE).
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

grant execute on function public.shares_league_with(uuid) to authenticated, anon;

-- La política de SELECT de profiles para co-miembros usa esta función.
-- La recreamos para asegurar que apunta a la versión actualizada.
drop policy if exists "profiles: select league members" on public.profiles;
create policy "profiles: select league members"
  on public.profiles for select
  using (public.shares_league_with(profiles.id));
