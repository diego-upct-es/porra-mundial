/**
 * poll-results — Actualiza resultados y goles desde API-Football (api-sports.io v3)
 *
 * Cada 30 min (cron):
 *   1. Descarga fixtures del día anterior y del día actual en Europe/Madrid
 *   2. Actualiza home_goals, away_goals, is_final en matches
 *   3. Para los partidos recién finalizados, upserta goles en match_goals
 *   4. Detecta jornadas completas (ventana 09:00-09:00 Europe/Madrid) y dispara
 *      comic-gen en paralelo para cada liga activa que no tenga viñeta de ese día.
 *
 * Secrets: APISPORTS_KEY, WC_LEAGUE_ID (default 1), WC_SEASON (default 2026)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_BASE = "https://v3.football.api-sports.io";

// Statuses terminados definitivamente
const FINAL_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO"]);
// Statuses en curso
const LIVE_STATUSES  = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true }, 200);

  try {
    const apiKey = Deno.env.get("APISPORTS_KEY");
    if (!apiKey) {
      throw new Error(
        "Secret APISPORTS_KEY no configurado. " +
        "Ejecuta: npx supabase secrets set APISPORTS_KEY=<tu-key>",
      );
    }

    const leagueId = Deno.env.get("WC_LEAGUE_ID") ?? "1";
    const season   = Deno.env.get("WC_SEASON")    ?? "2026";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const apiHeaders = { "x-apisports-key": apiKey };
    const now = new Date();

    // ── Calcular ventana en Europe/Madrid ────────────────────
    const todayMadrid     = madridDateStr(now);
    const yesterdayDate   = new Date(now);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayMadrid = madridDateStr(yesterdayDate);

    const dateFrom = yesterdayMadrid;
    const dateTo   = todayMadrid;

    console.log(`[poll] Ventana: ${dateFrom} → ${dateTo} (Europe/Madrid)`);

    // ── LLAMADA: fixtures de la ventana ──────────────────────
    const url = `${API_BASE}/fixtures?league=${leagueId}&season=${season}&from=${dateFrom}&to=${dateTo}`;
    const fxRes = await fetch(url, { headers: apiHeaders });

    let matchesResult: Record<string, unknown> = { window: { from: dateFrom, to: dateTo } };
    // Jornadas Madrid (09:00-09:00) recién completadas
    const newlyFinishedDays: string[] = [];
    // IDs de partidos recién marcados is_final (para buscar eventos de goles)
    const newlyFinishedIds: string[] = [];

    if (!fxRes.ok) {
      const body = await fxRes.text();
      matchesResult = { error: `HTTP ${fxRes.status}: ${body.slice(0, 200)}` };
      console.error("[poll] Error API:", matchesResult.error);
    } else {
      const fxJson = await fxRes.json();
      const fixtures: any[] = fxJson.response ?? [];

      let updated = 0, errors = 0;

      // Agrupa por jornada (09:00-09:00 Europe/Madrid)
      // key = "YYYY-MM-DD" de la jornada a la que pertenece el partido
      const byJornada: Record<string, { total: number; finalCount: number }> = {};

      for (const f of fixtures) {
        const status  = (f.fixture?.status?.short ?? "NS") as string;
        const isFinal = FINAL_STATUSES.has(status);
        const isLive  = LIVE_STATUSES.has(status);

        const isStarted = isFinal || isLive;
        const homeGoals = isStarted ? (f.goals?.home  ?? null) : null;
        const awayGoals = isStarted ? (f.goals?.away  ?? null) : null;

        // Jornada (09:00-09:00 Madrid) del kickoff UTC
        const kickoffUTC = new Date(f.fixture.date);
        const jday = jornadaKey(kickoffUTC);

        if (!byJornada[jday]) byJornada[jday] = { total: 0, finalCount: 0 };
        byJornada[jday].total++;
        if (isFinal) byJornada[jday].finalCount++;

        const fixtureId = String(f.fixture.id);

        const { error } = await supabase
          .from("matches")
          .update({
            home_goals: homeGoals,
            away_goals: awayGoals,
            is_final:   isFinal,
            updated_at: now.toISOString(),
          })
          .eq("id", fixtureId)
          .eq("is_final", false);  // solo actualiza si aún no era final (evita re-fetch de eventos)

        if (error) {
          // .eq("is_final",false) filtra filas ya finales → error o 0 rows → no es crítico.
          // Puede ser que el partido no exista (import-fixtures aún no ejecutado).
          if (!error.message.includes("0 rows")) {
            console.error(`[poll] partido ${fixtureId}:`, error.message);
            errors++;
          }
        } else {
          updated++;
          if (isFinal) newlyFinishedIds.push(fixtureId);
        }
      }

      // Actualiza también partidos ya-final (solo goals, no is_final) para cubrir correcciones
      for (const f of fixtures) {
        const status  = (f.fixture?.status?.short ?? "NS") as string;
        const isFinal = FINAL_STATUSES.has(status);
        if (!isFinal) continue;
        const fixtureId = String(f.fixture.id);
        await supabase
          .from("matches")
          .update({
            home_goals: f.goals?.home ?? null,
            away_goals: f.goals?.away ?? null,
            is_final:   true,
            updated_at: now.toISOString(),
          })
          .eq("id", fixtureId)
          .eq("is_final", true);
      }

      // ── Goles de los partidos recién finalizados ──────────
      // Llama a /fixtures/events solo si match_goals aún no tiene entradas.
      if (newlyFinishedIds.length > 0) {
        console.log(`[poll] Buscando goles de ${newlyFinishedIds.length} partido(s) nuevo(s)…`);
        for (const matchId of newlyFinishedIds) {
          // Idempotencia: si ya hay goles guardados, no re-fetch
          const { count } = await supabase
            .from("match_goals")
            .select("*", { count: "exact", head: true })
            .eq("match_id", matchId);

          if ((count ?? 0) > 0) {
            console.log(`[poll] match ${matchId}: goles ya registrados — skip`);
            continue;
          }

          const evUrl = `${API_BASE}/fixtures/events?fixture=${matchId}&type=Goal`;
          const evRes = await fetch(evUrl, { headers: apiHeaders });
          if (!evRes.ok) {
            console.error(`[poll] events ${matchId}: HTTP ${evRes.status}`);
            continue;
          }
          const evJson  = await evRes.json();
          const events: any[] = evJson.response ?? [];

          const goalRows = events
            .filter((e: any) => e.detail !== "Missed Penalty")
            .map((e: any) => ({
              match_id:      matchId,
              ext_player_id: e.player?.id   ?? 0,
              player_name:   e.player?.name ?? "Desconocido",
              team_id:       e.team?.id     ?? 0,
              minute:        e.time?.elapsed ?? 0,
              is_own_goal:   e.detail === "Own Goal",
            }));

          if (goalRows.length > 0) {
            const { error: goalErr } = await supabase
              .from("match_goals")
              .upsert(goalRows, { onConflict: "match_id,ext_player_id,minute" });
            if (goalErr) {
              console.error(`[poll] match_goals upsert ${matchId}:`, goalErr.message);
            } else {
              console.log(`[poll] match ${matchId}: ${goalRows.length} gol(es) registrados`);
            }
          } else {
            console.log(`[poll] match ${matchId}: sin goles en la respuesta`);
          }

          // Pausa mínima para no saturar la cuota
          await new Promise(r => setTimeout(r, 80));
        }
      }

      // ── Detectar jornadas Madrid recién completadas ───────
      for (const [jday] of Object.entries(byJornada)) {
        // Ventana UTC conservadora para la jornada (09:00-09:00 Madrid):
        // del día anterior a las 20:00 UTC hasta el día siguiente a las 10:00 UTC
        const refDate  = new Date(jday + "T12:00:00Z");
        const winStart = new Date(refDate);
        const winEnd   = new Date(refDate);
        winStart.setUTCDate(winStart.getUTCDate() - 1);
        winStart.setUTCHours(20, 0, 0, 0);
        winEnd.setUTCDate(winEnd.getUTCDate() + 1);
        winEnd.setUTCHours(10, 0, 0, 0);  // 10 UTC cubre 09:00 Madrid en cualquier DST

        const { data: dayRows } = await supabase
          .from("matches")
          .select("id, is_final, kickoff")
          .gte("kickoff", winStart.toISOString())
          .lt("kickoff",  winEnd.toISOString());

        // Filtrar solo los que pertenecen a esta jornada exacta
        const jornadaMatches = (dayRows ?? []).filter(
          (m: any) => jornadaKey(new Date(m.kickoff)) === jday,
        );

        if (jornadaMatches.length > 0 && jornadaMatches.every((m: any) => m.is_final)) {
          newlyFinishedDays.push(jday);
          console.log(
            `[poll] Jornada ${jday} (Madrid 09-09) completa: ` +
            `${jornadaMatches.length} partidos finalizados.`,
          );
        }
      }

      console.log(
        `[poll] ${updated} actualizados, ${errors} errores. ` +
        `${fixtures.length} fixtures en ventana.`,
      );
      matchesResult = {
        window:    { from: dateFrom, to: dateTo },
        in_window: fixtures.length,
        updated,
        errors,
        new_goals_matches: newlyFinishedIds.length,
      };
    }

    // ── Auto-generación de viñetas ────────────────────────────
    let comicsResult: Record<string, unknown> = { triggered: 0 };

    if (newlyFinishedDays.length > 0) {
      const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
      if (!geminiKey) {
        console.log("[comics] GEMINI_API_KEY no configurado, saltando auto-comic.");
        comicsResult = { skipped: "GEMINI_API_KEY no configurado" };
      } else {
        const { data: leagues } = await supabase
          .from("leagues")
          .select("id, name");
        const leagueList: { id: string; name: string }[] = leagues ?? [];

        const pending: { league_id: string; league_name: string; match_day: string }[] = [];

        for (const day of newlyFinishedDays) {
          const { data: existingComics } = await supabase
            .from("daily_comics")
            .select("league_id")
            .eq("match_day", day)
            .in("league_id", leagueList.map(l => l.id));

          const alreadyDone = new Set(
            (existingComics ?? []).map((c: any) => c.league_id),
          );

          for (const lg of leagueList) {
            if (!alreadyDone.has(lg.id)) {
              pending.push({ league_id: lg.id, league_name: lg.name, match_day: day });
            }
          }
        }

        if (pending.length === 0) {
          console.log("[comics] Todas las viñetas ya existen.");
          comicsResult = { triggered: 0, message: "Viñetas ya existentes." };
        } else {
          console.log(
            `[comics] Disparando ${pending.length} viñeta(s): ` +
            pending.map(p => `${p.league_name}/${p.match_day}`).join(", "),
          );

          const comicGenUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/comic-gen`;
          const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

          const comicResults = await Promise.allSettled(
            pending.map(async ({ league_id, league_name, match_day }) => {
              try {
                const res  = await fetch(comicGenUrl, {
                  method:  "POST",
                  headers: {
                    "Content-Type":  "application/json",
                    "Authorization": `Bearer ${serviceKey}`,
                  },
                  body: JSON.stringify({ league_id, match_day }),
                });
                const json = await res.json();
                if (json.ok) {
                  console.log(`[comics] ✓ ${league_name}/${match_day}`);
                } else if (json.cached) {
                  console.log(`[comics] cached ${league_name}/${match_day}`);
                } else {
                  console.warn(`[comics] ✗ ${league_name}/${match_day}: ${json.error}`);
                }
                return json;
              } catch (e: any) {
                console.error(
                  `[comics] fetch error ${league_name}/${match_day}:`, e.message,
                );
                return { ok: false, error: e.message };
              }
            }),
          );

          const ok  = comicResults.filter(
            r => r.status === "fulfilled" && (r.value as any)?.ok,
          ).length;
          const err = comicResults.length - ok;
          comicsResult = { triggered: comicResults.length, ok, errors: err };
        }
      }
    }

    return respond({ ok: true, matches: matchesResult, comics: comicsResult });

  } catch (err: any) {
    console.error("[poll] error fatal:", err);
    return respond({ ok: false, error: err.message }, 500);
  }
});

// ── Helpers ───────────────────────────────────────────────────

/**
 * Devuelve "YYYY-MM-DD" para la fecha dada en Europe/Madrid.
 * DST-safe: usa Intl.DateTimeFormat con en-CA (que da formato ISO).
 */
function madridDateStr(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  }).formatToParts(date);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const d = parts.find(p => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/**
 * Clave de jornada (09:00-09:00 Europe/Madrid).
 * Antes de las 09:00 Madrid → pertenece a la jornada del día anterior.
 * Así, un partido a las 01:00 Madrid del día D+1 cuenta para la jornada D.
 */
function jornadaKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-u-hc-h23", {
    timeZone: "Europe/Madrid",
    hour:     "2-digit",
  }).formatToParts(date);
  const h = Number(parts.find(p => p.type === "hour")!.value);

  if (h < 9) {
    // Antes de las 09:00 Madrid → jornada del día anterior
    const prev = new Date(date);
    prev.setUTCDate(prev.getUTCDate() - 1);
    return madridDateStr(prev);
  }
  return madridDateStr(date);
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    },
  });
}
