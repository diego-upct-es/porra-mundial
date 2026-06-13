-- =============================================================
-- Fase 2: Trigger de auto-creación de perfil
-- =============================================================
-- Al insertar un usuario en auth.users (signup), crea automáticamente
-- su fila en profiles usando el display_name del metadata del registro.
-- Usar security definer para que el trigger pueda escribir en profiles
-- aunque el usuario aún no tenga sesión activa (no hay auth.uid() todavía).
-- =============================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;  -- idempotente por si el frontend reintenta
  return new;
end;
$$;

-- Disparar DESPUÉS del INSERT para que el usuario ya exista al hacer la inserción
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
