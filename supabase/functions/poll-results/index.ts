/**
 * poll-results — Actualiza resultados desde API-Football (api-sports.io v3)
 *
 * Cada 30 min (cron):
 *   1. Descarga fixtures del día anterior y del día actual en Europe/Madrid
 *   2. Actualiza home_goals, away_goals, is_final en matches
 *   3. Detecta jornadas completas (todos los partidos de un día Madrid
 *      ya están finalizados) y dispara comic-gen en paralelo para cada
 *      liga activa que no tenga viñeta de ese día.
 *
 * Secrets: APISPORTS_KEY, WC_LEAGUE_ID (default 1), WC_SEASON (default 2026)
 *
 * Nota: la actualización de goleadores se gestiona en un step separado.
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
    // Tomamos el día anterior y el actual en horario de Madrid para
    // cubrir los partidos que empezaron ayer en Madrid pero aún
    // pueden estar sin finalizar (p.ej. un partido de las 23:00 Madrid).
    const todayMadrid     = madridDateStr(now);
    const yesterdayDate   = new Date(now);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayMadrid = madridDateStr(yesterdayDate);

    // Para la query a la API usamos fechas UTC con un día de margen
    // (API-Football filtra por fixture.date que está en UTC).
    const dateFrom = yesterdayMadrid; // ayer Madrid ≈ ayer UTC (pequeño desfase OK)
    const dateTo   = todayMadrid;     // hoy Madrid ≈ hoy UTC

    console.log(`[poll] Ventana: ${dateFrom} → ${dateTo} (Europe/Madrid)`);

    // ── LLAMADA: fixtures de la ventana ──────────────────────
    const url = `${API_BASE}/fixtures?league=${leagueId}&season=${season}&from=${dateFrom}&to=${dateTo}`;
    const fxRes = await fetch(url, { headers: apiHeaders });

    let matchesResult: Record<string, unknown> = { window: { from: dateFrom, to: dateTo } };
    // Días Madrid cuya jornada ha quedado completamente finalizada en esta ejecución
    const newlyFinishedDays: string[] = [];

    if (!fxRes.ok) {
      const body = await fxRes.text();
      matchesResult = { error: `HTTP ${fxRes.status}: ${body.slice(0, 200)}` };
      console.error("[poll] Error API:", matchesResult.error);
    } else {
      const fxJson = await fxRes.json();
      const fixtures: any[] = fxJson.response ?? [];

      let updated = 0, errors = 0;

      // Agrupa por día Madrid (para detectar jornadas completas)
      // key = "YYYY-MM-DD" en Europe/Madrid
      const byDay: Record<string, { total: number; finalCount: number }> = {};

      for (const f of fixtures) {
        const status  = (f.fixture?.status?.short ?? "NS") as string;
        const isFinal = FINAL_STATUSES.has(status);
        const isLive  = LIVE_STATUSES.has(status);

        const isStarted = isFinal || isLive;
        const homeGoals = isStarted ? (f.goals?.home  ?? null) : null;
        const awayGoals = isStarted ? (f.goals?.away  ?? null) : null;

        // Día en Madrid del kickoff UTC
        const kickoffUTC = new Date(f.fixture.date);
        const day = madridDateStr(kickoffUTC);

        if (!byDay[day]) byDay[day] = { total: 0, finalCount: 0 };
        byDay[day].total++;
        if (isFinal) byDay[day].finalCount++;

        const { error } = await supabase
          .from("matches")
          .update({
            home_goals: homeGoals,
            away_goals: awayGoals,
            is_final:   isFinal,
            updated_at: now.toISOString(),
          })
          .eq("id", String(f.fixture.id));

        if (error) {
          // El partido puede no existir si import-fixtures aún no se ha ejecutado.
          console.error(`[poll] partido ${f.fixture.id}:`, error.message);
          errors++;
        } else {
          updated++;
        }
      }

      // ── Detectar jornadas Madrid recién completadas ───────
      // Para cada día con partidos en la ventana, verificamos en la BD que
      // TODOS los partidos de ese día (no solo los devueltos por la API)
      // son ya is_final. Esto evita falsos positivos si la API devuelve
      // una ventana parcial.
      for (const [day] of Object.entries(byDay)) {
        // Buscamos en la BD todos los partidos cuyo kickoff cae en ese día Madrid
        // usando una ventana UTC conservadora: D-1T20:00Z → D+1T04:00Z
        const refDate   = new Date(day + "T12:00:00Z");
        const winStart  = new Date(refDate);
        const winEnd    = new Date(refDate);
        winStart.setUTCDate(winStart.getUTCDate() - 1);
        winStart.setUTCHours(20, 0, 0, 0);
        winEnd.setUTCDate(winEnd.getUTCDate() + 1);
        winEnd.setUTCHours(4, 0, 0, 0);

        const { data: dayRows } = await supabase
          .from("matches")
          .select("id, is_final, kickoff")
          .gte("kickoff", winStart.toISOString())
          .lt("kickoff",  winEnd.toISOString());

        // Filtrar solo los que caen en este día Madrid exacto
        const dayMatches = (dayRows ?? []).filter(
          (m: any) => madridDateStr(new Date(m.kickoff)) === day,
        );

        if (dayMatches.length > 0 && dayMatches.every((m: any) => m.is_final)) {
          newlyFinishedDays.push(day);
          console.log(
            `[poll] Jornada ${day} (Madrid) completa: ` +
            `${dayMatches.length} partidos finalizados.`,
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
      };
    }

    // ── Auto-generación de viñetas ────────────────────────────
    // Se mantiene igual: cuando una jornada queda completamente finalizada,
    // se dispara comic-gen para cada liga que aún no tenga viñeta de ese día.
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
