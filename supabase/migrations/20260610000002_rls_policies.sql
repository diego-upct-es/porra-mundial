-- =============================================================
-- Fase 1: Row Level Security — Porra Mundial 2026
-- =============================================================
-- Principio general:
--   • Lectura: solo si eres miembro de la liga o es tu propio registro.
--   • Escritura de datos propios: solo tú.
--   • Escritura de matches/player_stats: solo service role (ingesta)
--     o el admin de la liga (override de emergencia).
-- =============================================================

-- ── Activar RLS en todas las tablas ──────────────────────────
alter table profiles          enable row level security;
alter table leagues            enable row level security;
alter table league_members     enable row level security;
alter table predictions        enable row level security;
alter table matches            enable row level security;
alter table player_stats       enable row level security;
alter table push_subscriptions enable row level security;

-- =============================================================
-- PROFILES
-- =============================================================

-- Leer tu propio perfil
create policy "profiles: select own"
  on profiles for select
  using (auth.uid() = id);

-- Leer perfiles de compañeros de liga (para mostrar nombres en clasificación)
create policy "profiles: select league members"
  on profiles for select
  using (
    exists (
      select 1 from league_members lm1
      join   league_members lm2 on lm2.league_id = lm1.league_id
      where  lm1.user_id = auth.uid()
        and  lm2.user_id = profiles.id
    )
  );

-- Crear perfil (solo el propio usuario, justo tras el signup)
create policy "profiles: insert own"
  on profiles for insert
  with check (auth.uid() = id);

-- Actualizar tu propio perfil
create policy "profiles: update own"
  on profiles for update
  using (auth.uid() = id);

-- =============================================================
-- LEAGUES
-- =============================================================

-- Ver ligas en las que estás
create policy "leagues: select as member"
  on leagues for select
  using (
    exists (
      select 1 from league_members
      where league_id = leagues.id and user_id = auth.uid()
    )
  );

-- Crear liga (cualquier usuario autenticado)
create policy "leagues: insert authenticated"
  on leagues for insert
  with check (auth.uid() is not null and auth.uid() = admin_id);

-- Actualizar solo el admin de la liga
create policy "leagues: update as admin"
  on leagues for update
  using (auth.uid() = admin_id);

-- =============================================================
-- LEAGUE_MEMBERS
-- =============================================================

-- Ver miembros de ligas en las que estás
create policy "league_members: select as member"
  on league_members for select
  using (
    exists (
      select 1 from league_members self
      where self.league_id = league_members.league_id
        and self.user_id   = auth.uid()
    )
  );

-- Unirse a una liga (insertarte a ti mismo)
create policy "league_members: insert own"
  on league_members for insert
  with check (auth.uid() = user_id);

-- Actualizar tu propio registro (champion_pick)
create policy "league_members: update own"
  on league_members for update
  using (auth.uid() = user_id);

-- Salir de una liga (borrar tu propia membresía)
create policy "league_members: delete own"
  on league_members for delete
  using (auth.uid() = user_id);

-- =============================================================
-- PREDICTIONS
-- =============================================================

-- Ver predicciones de partidos YA iniciados (histórico)
-- y las propias (para saber qué has puesto antes del partido)
create policy "predictions: select member or own"
  on predictions for select
  using (
    -- Siempre puedes ver las tuyas
    auth.uid() = user_id
    or
    -- Puedes ver las de otros solo si el partido ya empezó
    (
      exists (
        select 1 from league_members
        where league_id = predictions.league_id and user_id = auth.uid()
      )
      and exists (
        select 1 from matches
        where id = predictions.match_id and kickoff <= now()
      )
    )
  );

-- Insertar predicción: solo la tuya, solo en partidos futuros
-- (el trigger check_prediction_window añade una segunda capa)
create policy "predictions: insert own"
  on predictions for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from league_members
      where league_id = predictions.league_id and user_id = auth.uid()
    )
  );

-- Actualizar predicción: solo la tuya (el trigger controla la ventana)
create policy "predictions: update own"
  on predictions for update
  using (auth.uid() = user_id);

-- Borrar predicción: solo la tuya (y solo si el partido no ha empezado;
-- el trigger también lo protege en el update)
create policy "predictions: delete own"
  on predictions for delete
  using (
    auth.uid() = user_id
    and exists (
      select 1 from matches
      where id = predictions.match_id and kickoff > now()
    )
  );

-- =============================================================
-- MATCHES
-- =============================================================

-- Cualquier usuario autenticado puede leer partidos
create policy "matches: select authenticated"
  on matches for select
  using (auth.uid() is not null);

-- Escritura solo para service role (ingesta automática).
-- El service role bypassa RLS por definición; estas policies
-- cubren el caso en que alguien use el admin dashboard con JWT normal.
-- El admin de CUALQUIER liga puede corregir resultados (override manual).
create policy "matches: update as league admin"
  on matches for update
  using (
    exists (
      select 1 from leagues
      where admin_id = auth.uid()
    )
  );

-- INSERT/DELETE de matches: solo service role (no hay policy → denegado para JWT normal)

-- =============================================================
-- PLAYER_STATS
-- =============================================================

-- Lectura pública para autenticados
create policy "player_stats: select authenticated"
  on player_stats for select
  using (auth.uid() is not null);

-- Escritura solo service role (no policy para JWT normal → denegado)

-- =============================================================
-- PUSH_SUBSCRIPTIONS
-- =============================================================

-- Ver solo tus propias suscripciones
create policy "push_subscriptions: select own"
  on push_subscriptions for select
  using (auth.uid() = user_id);

-- Registrar tu propia suscripción
create policy "push_subscriptions: insert own"
  on push_subscriptions for insert
  with check (auth.uid() = user_id);

-- Borrar tu propia suscripción (des-suscribirse)
create policy "push_subscriptions: delete own"
  on push_subscriptions for delete
  using (auth.uid() = user_id);

-- =============================================================
-- STANDINGS (vista)
-- La vista hereda RLS de las tablas subyacentes, pero para
-- que sea consultable necesita SECURITY INVOKER (por defecto)
-- y que el usuario tenga acceso a predictions y matches.
-- No hace falta policy extra: si puedes leer las tablas base,
-- puedes leer la vista.
-- =============================================================
