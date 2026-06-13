-- =============================================================
-- Fase 1: Esquema inicial — Porra Mundial 2026
-- =============================================================

-- ------------------------------------------------------------
-- PROFILES
-- Un perfil por usuario auth; se crea justo tras el signup.
-- ------------------------------------------------------------
create table profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text        not null,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- LEAGUES
-- Cada porra (grupo de amigos). code = código de invitación.
-- ------------------------------------------------------------
create table leagues (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  code       text        not null unique,
  theme      text        not null default 'guadalajara',
  admin_id   uuid        not null references profiles(id),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- LEAGUE_MEMBERS
-- Relación N:M usuario ↔ liga + elección de campeón.
-- ------------------------------------------------------------
create table league_members (
  league_id      uuid        not null references leagues(id)  on delete cascade,
  user_id        uuid        not null references profiles(id) on delete cascade,
  champion_pick  text,
  joined_at      timestamptz not null default now(),
  primary key (league_id, user_id)
);

-- ------------------------------------------------------------
-- MATCHES
-- Rellenado exclusivamente por la ingesta (import-fixtures /
-- poll-results). id = fixture.id de API-Football como texto.
-- ------------------------------------------------------------
create table matches (
  id         text        primary key,
  phase      text        not null check (phase in ('grupos', 'eliminatorias')),
  grp        text,                          -- 'A'..'L' en fase de grupos; nombre de ronda en eliminatorias
  home_team  text        not null,
  away_team  text        not null,
  home_logo  text,
  away_logo  text,
  kickoff    timestamptz not null,
  home_goals int,
  away_goals int,
  is_final   boolean     not null default false,
  updated_at timestamptz not null default now()
);

-- Índice para las consultas frecuentes por fecha (poll-results, daily-alert)
create index matches_kickoff_idx on matches (kickoff);

-- Función auxiliar: actualiza updated_at automáticamente
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger matches_updated_at
  before update on matches
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- PREDICTIONS
-- Las dos restricciones UNIQUE son el núcleo de las reglas:
--   1. Un usuario, una predicción por partido/liga.
--   2. Un marcador exacto por partido/liga (no se repite).
-- ------------------------------------------------------------
create table predictions (
  id         uuid        primary key default gen_random_uuid(),
  league_id  uuid        not null references leagues(id)  on delete cascade,
  match_id   text        not null references matches(id)  on delete cascade,
  user_id    uuid        not null references profiles(id) on delete cascade,
  home_goals int         not null check (home_goals >= 0),
  away_goals int         not null check (away_goals >= 0),
  created_at timestamptz not null default now(),

  -- Regla 1: 1 predicción por usuario/partido/liga
  unique (league_id, match_id, user_id),

  -- Regla 2: marcador exacto exclusivo dentro de la misma liga/partido
  unique (league_id, match_id, home_goals, away_goals)
);

-- Bloquea insertar/actualizar predicciones con kickoff ya pasado.
-- El trigger se dispara ANTES del insert/update para rechazarlo limpiamente.
create or replace function check_prediction_window()
returns trigger language plpgsql as $$
declare
  v_kickoff timestamptz;
begin
  select kickoff into v_kickoff from matches where id = new.match_id;
  if v_kickoff <= now() then
    raise exception 'prediction_window_closed'
      using hint = 'El partido ya ha comenzado o ha terminado.';
  end if;
  return new;
end;
$$;

create trigger predictions_window_check
  before insert or update on predictions
  for each row execute function check_prediction_window();

-- ------------------------------------------------------------
-- PLAYER_STATS
-- Rellenado por poll-stats. ext_player_id = player.id de la API.
-- ------------------------------------------------------------
create table player_stats (
  id             uuid    primary key default gen_random_uuid(),
  ext_player_id  int     unique,
  player_name    text    not null,
  team           text    not null,
  team_logo      text,
  goals          int     not null default 0,
  assists        int     not null default 0,
  updated_at     timestamptz not null default now()
);

create trigger player_stats_updated_at
  before update on player_stats
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- PUSH_SUBSCRIPTIONS
-- Objeto Web Push serializado en JSONB (endpoint + keys).
-- ------------------------------------------------------------
create table push_subscriptions (
  id           uuid    primary key default gen_random_uuid(),
  user_id      uuid    not null references profiles(id) on delete cascade,
  subscription jsonb   not null,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- STANDINGS (vista)
-- Puntuación calculada en tiempo real sobre predicciones y
-- partidos finalizados (is_final = true).
--   Exacto   → +3 puntos
--   1 equipo → +1 punto
--   Fallo    →  0 puntos
-- El bonus de campeón (+5) se aplica en la consulta del frontend
-- porque depende de un valor externo (campeón real) que aún no
-- está en el esquema; se añadirá en la fase de cierre del torneo.
-- ------------------------------------------------------------
create view standings as
select
  p.league_id,
  p.user_id,
  sum(
    case
      when m.home_goals = p.home_goals and m.away_goals = p.away_goals then 3
      when m.home_goals = p.home_goals or  m.away_goals = p.away_goals then 1
      else 0
    end
  )::int                                                                    as points,
  count(*) filter (
    where m.home_goals = p.home_goals and m.away_goals = p.away_goals
  )::int                                                                    as exacts,
  count(*)::int                                                             as total_predictions
from predictions p
join matches m on m.id = p.match_id and m.is_final = true
group by p.league_id, p.user_id;
