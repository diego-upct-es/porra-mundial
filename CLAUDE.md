# Porra Mundial 2026 — Spec de backend (para Claude Code)

Especificación para montar el backend de la app de porra. El **frontend** ya existe (React, `porra-mundial-2026.jsx`); esto cubre lo que el frontend no puede hacer solo: **estado compartido, regla de marcador único, clasificación, y la ingesta AUTOMÁTICA de calendario + resultados + estadísticas, además del aviso a las 9:00**.

> Pásale este fichero a Claude Code como contexto (vale como `CLAUDE.md` del backend) y construid por fases en el orden del final.

---

## 1. Stack

- **Supabase** (Postgres + Auth + Realtime + Edge Functions + `pg_cron`). Plan gratuito sobra para un grupo de amigos.
- **Frontend**: el React actual, desplegado como **PWA** (Vite + `vite-plugin-pwa`) en Vercel/Netlify. La PWA permite instalar en el móvil y recibir push.
- **Push**: Web Push estándar con claves **VAPID**, enviado desde una Edge Function.
- **Datos de fútbol**: **API-Football** (api-sports.io). De ahí salen, automáticamente, el calendario, los resultados y los goleadores/asistentes. Nadie teclea nada a mano.

Por qué Supabase y no "un servidor": la regla de marcador único es una **restricción `UNIQUE` de Postgres**, así que la propia base de datos garantiza la exclusividad de forma atómica, sin código de bloqueo ni condiciones de carrera.

Por qué no hay trabajo manual diario: **solo el backend llama a API-Football**, unas pocas veces al día, y cachea todo en la base de datos. Los amigos leen de la base de datos, no de la API → uso muy ligero, lejos de los límites del plan.

---

## 2. Esquema de base de datos

```sql
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null,          -- apodo elegido al unirse
  created_at timestamptz default now()
);

create table leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,           -- código de invitación
  theme text not null default 'guadalajara',
  admin_id uuid not null references profiles(id),
  created_at timestamptz default now()
);

create table league_members (
  league_id uuid references leagues(id) on delete cascade,
  user_id   uuid references profiles(id) on delete cascade,
  champion_pick text,
  joined_at timestamptz default now(),
  primary key (league_id, user_id)
);

-- Calendario, RELLENADO POR LA INGESTA (no a mano). id = fixture id de API-Football.
create table matches (
  id text primary key,                 -- fixture.id de API-Football (como texto)
  phase text not null,                 -- 'grupos' | 'eliminatorias' (derivado de league.round)
  grp text,                            -- 'A'..'L' o ronda
  home_team text not null,             -- nombre del equipo (de la API)
  away_team text not null,
  home_logo text, away_logo text,      -- URLs de escudo (la API las da)
  kickoff timestamptz not null,        -- fixture.date (clave para abrir/bloquear)
  home_goals int, away_goals int,      -- null hasta que la ingesta los rellena
  is_final boolean default false,      -- status FT/AET/PEN
  updated_at timestamptz default now()
);

-- Predicciones. UNIQUE => la REGLA de marcador único.
create table predictions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid references leagues(id) on delete cascade,
  match_id  text references matches(id) on delete cascade,
  user_id   uuid references profiles(id) on delete cascade,
  home_goals int not null, away_goals int not null,
  created_at timestamptz default now(),
  unique (league_id, match_id, user_id),                          -- 1 predicción por persona/partido
  unique (league_id, match_id, home_goals, away_goals)            -- *** marcador exacto exclusivo por liga/partido ***
);

-- Estadísticas, RELLENADAS POR LA INGESTA.
create table player_stats (
  id uuid primary key default gen_random_uuid(),
  ext_player_id int unique,            -- player.id de API-Football
  player_name text not null,
  team text not null, team_logo text,
  goals int default 0, assists int default 0,
  updated_at timestamptz default now()
);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz default now()
);
```

> Nota frontend: el React de ejemplo usa códigos ISO3 + emoji de bandera. Al cablear, cambia a **`home_team`/`home_logo`** que llegan de la API (escudos reales). Es un retoque pequeño en `Scoreboard`, `ResultsTab` e `HistoryTab`.

---

## 3. Ingesta automática (API-Football)

**Alta**: registra una cuenta en api-sports.io, copia la API key y guárdala como **secret** de Supabase (`API_FOOTBALL_KEY`). NUNCA en el frontend. Base URL `https://v3.football.api-sports.io`, cabecera `x-apisports-key: <KEY>`.

**Identificar la competición (una vez, en config)**:
```
GET /leagues?search=world cup
-> localiza el league id del "FIFA World Cup" y la season 2026. Guárdalos como WC_LEAGUE_ID y WC_SEASON.
```
(No hardcodees el id a ciegas; confírmalo con esta llamada.)

### Tres trabajos programados (Edge Functions + `pg_cron`)

**a) `import-fixtures`** — calendario (1 vez al alta + 1 vez al día por si cambia algo)
```
GET /fixtures?league={WC_LEAGUE_ID}&season={WC_SEASON}
para cada fixture: upsert en matches {
  id        = fixture.id,
  kickoff   = fixture.date,
  home_team = teams.home.name, home_logo = teams.home.logo,
  away_team = teams.away.name, away_logo = teams.away.logo,
  grp       = parse(league.round),
  phase     = league.round contiene 'Group' ? 'grupos' : 'eliminatorias',
  home_goals/away_goals/is_final = según status (FT/AET/PEN => is_final true)
}
```
Esto **rellena los 104 partidos solo**. El calendario deja de ser un problema.

**b) `poll-results`** — resultados (cada 15–30 min dentro de la ventana de partidos)
```
GET /fixtures?league={WC_LEAGUE_ID}&season={WC_SEASON}&date={hoy}   (o &live=all)
actualiza goals + is_final de los partidos terminados/en juego.
```
Como los partidos se juegan de tarde/noche en América (= noche/madrugada en España), programa este job aprox. entre las 16:00 y las 08:00.

**c) `poll-stats`** — goleadores y asistentes (1–2 veces al día)
```
GET /players/topscorers?league={WC_LEAGUE_ID}&season={WC_SEASON}
GET /players/topassists?league={WC_LEAGUE_ID}&season={WC_SEASON}
upsert en player_stats por ext_player_id (goals / assists).
```

### Recálculo de puntos
La clasificación es una **vista** (sección 4): en cuanto `poll-results` marca un partido `is_final`, los puntos se recalculan solos. **Cero intervención.**

### Coste / límites
Uso real ≈ unas decenas de llamadas al día (solo el backend). Cabe de sobra en planes pequeños. Si la temporada del Mundial no estuviera disponible en el plan gratuito, contrata Pro un solo mes (el torneo dura ~1 mes).

### Respaldo manual (no diario)
Deja en el panel de admin un botón para **corregir un resultado a mano** por si la API tuviera un hueco puntual. Es una red de seguridad, no una rutina.

---

## 4. Lógica de puntuación

```sql
create view standings as
select p.league_id, p.user_id,
  sum(case
        when m.home_goals = p.home_goals and m.away_goals = p.away_goals then 3
        when m.home_goals = p.home_goals or  m.away_goals = p.away_goals then 1
        else 0 end) as points,
  count(*) filter (where m.home_goals = p.home_goals and m.away_goals = p.away_goals) as exacts
from predictions p
join matches m on m.id = p.match_id and m.is_final = true
group by p.league_id, p.user_id;
```
- Exacto **+3**, un equipo **+1**, ninguno **0**.
- Bonus campeón **+5** si `champion_pick` = campeón real (se resuelve al final del torneo).
- Por fase: añade filtro `m.phase` a la vista.

**Apertura/bloqueo de predicciones**: abierto si `kickoff > now()` y dentro de la ventana "hoy + mañana" (zona horaria del usuario; importante por los partidos de madrugada). Un trigger/RLS rechaza `insert/update` de predicción con `kickoff <= now()`. El histórico solo revela predicciones de partidos ya iniciados.

---

## 5. Aviso a las 9:00 (cron + push)

1. `pg_cron` lanza a diario a las 09:00 una Edge Function `daily-alert`.
2. `daily-alert`: calcula partidos con `kickoff` en la ventana **[hoy, mañana]** aún no iniciados; si hay ≥1, envía Web Push (VAPID) a cada registro de `push_subscriptions`: *"Ya puedes predecir los partidos de hoy y mañana"*. Email de respaldo opcional (Resend) para quien no tenga push.

**Push real**: en iPhone hay que *añadir a pantalla de inicio* + aceptar permiso (iOS 16.4+) y abrir en Safari/Chrome real (no dentro de Instagram/WhatsApp). El email de respaldo cubre al resto.

---

## 6. RLS (seguridad por filas)

- `profiles`: cada uno el suyo.
- `leagues`/`league_members`/`predictions`/`standings`: visibles solo si `auth.uid()` es miembro de la liga.
- `predictions`: `insert/update` solo del propio usuario y solo con `kickoff > now()`.
- `matches`/`player_stats`: lectura para miembros; **escritura solo por la ingesta (service role)** y por el admin (override).

---

## 7. Acciones del frontend a cablear

| Acción | Operación |
|---|---|
| Registro / login | Supabase Auth + crear `profile` con apodo |
| Crear liga | insert `leagues` + `league_members` (admin) |
| Unirse con código | buscar `leagues.code` + insert `league_members` |
| Mis ligas | select `league_members` join `leagues` |
| Marcadores pillados | select `predictions` de esa liga/partido (realtime) |
| Guardar predicción | upsert `predictions` (capturar error 23505 → "ya pillado") |
| Elegir campeón | update `league_members.champion_pick` |
| Clasificación | select `standings` (+ filtro de fase) |
| Resultados / stats | select `matches` (is_final) + `player_stats` |
| Histórico | select `predictions` de partidos iniciados |
| Calendario, resultados, stats | **automático** (jobs de la sección 3) |
| Admin override | update `matches` manual (solo emergencias) |

---

## 8. Orden de trabajo (fases para Claude Code)

1. **Supabase + esquema** (sección 2) + RLS (sección 6).
2. **Auth + perfiles + crear/unirse a liga** → pantalla "Mis ligas".
3. **Ingesta `import-fixtures`** → tabla `matches` poblada con el calendario real (verifica que aparecen los partidos).
4. **Predicciones con la regla única** → cablear el marcador; probar el error 23505 con dos usuarios.
5. **`poll-results` + vista `standings`** → Clasificación y Resultados en vivo, recálculo automático. Botón de override de admin.
6. **`poll-stats`** → goleadores y asistentes.
7. **Realtime** en marcadores pillados y clasificación.
8. **PWA + push**: manifest, service worker, suscripción, `daily-alert` + `pg_cron`.
9. **Email de respaldo** (opcional) y pulido.

Con el frontend hecho y la ingesta automática, lo realista es tener las fases 1–6 funcionando en uno o dos días, y a partir de ahí no tocar nada cada día.
