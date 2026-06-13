-- =============================================================
-- Admin override: función SECURITY DEFINER para que un admin
-- de cualquier liga pueda corregir resultados de partidos.
-- =============================================================
-- Diseño:
--   • La función valida que auth.uid() sea admin_id de al
--     menos una liga antes de actualizar.
--   • Al ser SECURITY DEFINER no necesita una política UPDATE
--     en la tabla matches (que sería global y difícil de
--     acotar correctamente).
--   • El frontend llama a supabase.rpc('admin_update_match', …)
-- =============================================================

create or replace function public.admin_update_match(
  _match_id   text,
  _home_goals int,
  _away_goals int,
  _is_final   boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Solo pueden actualizar los admins de al menos una liga
  if not exists (
    select 1 from public.leagues
    where admin_id = auth.uid()
  ) then
    return jsonb_build_object('error', 'not_admin');
  end if;

  update public.matches
     set home_goals = _home_goals,
         away_goals = _away_goals,
         is_final   = _is_final,
         updated_at = now()
   where id = _match_id;

  if not found then
    return jsonb_build_object('error', 'match_not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.admin_update_match(text, int, int, boolean)
  to authenticated;
