/**
 * poll-results — Fase 5 + 6 + auto-comic
 *
 * Cada 30 min:
 *   1. Actualiza resultados del día ± 1 desde football-data.org
 *   2. Actualiza goleadores
 *   3. Detecta si alguna jornada acaba de quedar completa (todos is_final)
 *      y, si no existe viñeta para ese día, dispara comic-gen en paralelo
 *      para cada liga activa.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_BASE = "https://api.football-data.org/v4";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true }, 200);

  try {
    const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
    if (!token) {
      throw new Error(
        "Secret FOOTBALL_DATA_TOKEN no configurado. " +
          "Ejecuta: npx supabase secrets set FOOTBALL_DATA_TOKEN=<tu-token>",
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── LLAMADA 1: Resultados del día ± 1 ────────────────────────
    const now       = new Date();
    const yesterday = new Date(now); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const tomorrow  = new Date(now); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const dateFrom  = yesterday.toISOString().slice(0, 10);
    const dateTo    = tomorrow.toISOString().slice(0, 10);

    console.log(`[matches] Consultando ${dateFrom} → ${dateTo}…`);

    const matchRes = await fetch(
      `${API_BASE}/competitions/WC/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      { headers: { "X-Auth-Token": token } },
    );

    let matchesResult: Record<string, unknown> = { window: { dateFrom, dateTo } };
    // Días recién completados en esta ejecución (todos sus partidos is_final)
    const newlyFinishedDays: string[] = [];

    if (!matchRes.ok) {
      const body = await matchRes.text();
      matchesResult = { error: `HTTP ${matchRes.status}: ${body}` };
      console.error("[matches] Error:", matchesResult.error);
    } else {
      const json: any      = await matchRes.json();
      const matches: any[] = json.matches ?? [];
      let updated = 0, errors = 0;
      const finished: string[] = [];

      // Agrupa partidos de la ventana por día (para detectar jornadas completas)
      const byDay: Record<string, { total: number; finalCount: number }> = {};

      for (const m of matches) {
        const day       = (m.utcDate as string).slice(0, 10);
        const homeGoals = m.score?.fullTime?.home ?? null;
        const awayGoals = m.score?.fullTime?.away ?? null;
        const isFinal   = m.status === "FINISHED";

        // Acumular stats por día
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
          .eq("id", String(m.id));

        if (error) { console.error(`[matches] partido ${m.id}:`, error.message); errors++; }
        else {
          updated++;
          if (isFinal && homeGoals !== null) {
            finished.push(`${m.homeTeam?.name ?? m.id} ${homeGoals}–${awayGoals} ${m.awayTeam?.name ?? ""}`);
          }
        }
      }

      // Detectar días en la ventana donde TODOS los partidos ya son finales
      for (const [day, { total, finalCount }] of Object.entries(byDay)) {
        if (total > 0 && total === finalCount) {
          newlyFinishedDays.push(day);
          console.log(`[matches] Jornada ${day} completada: ${total}/${total} partidos finales.`);
        }
      }

      console.log(`[matches] ${updated} actualizados, ${errors} errores.`);
      matchesResult = { window: { dateFrom, dateTo }, in_window: matches.length, updated, errors, finished };
    }

    // ── LLAMADA 2: Goleadores del Mundial ─────────────────────────
    console.log("[scorers] Consultando máximos goleadores…");

    let scorersResult: Record<string, unknown> = {};

    try {
      const scorersRes = await fetch(
        `${API_BASE}/competitions/WC/scorers?limit=50`,
        { headers: { "X-Auth-Token": token } },
      );

      if (!scorersRes.ok) {
        const body = await scorersRes.text();
        throw new Error(`HTTP ${scorersRes.status}: ${body}`);
      }

      const scorersJson: any = await scorersRes.json();
      const scorers: any[]   = scorersJson.scorers ?? [];

      if (scorers.length > 0) {
        const rows = scorers.map((s: any) => ({
          ext_player_id: s.player?.id ?? null,
          player_name:   s.player?.name ?? "Desconocido",
          team:          s.team?.name   ?? "",
          team_logo:     s.team?.crest  ?? null,
          goals:         s.goals ?? 0,
          assists:       0,
          updated_at:    now.toISOString(),
        })).filter((r: any) => r.ext_player_id !== null);

        const { error } = await supabase
          .from("player_stats")
          .upsert(rows, { onConflict: "ext_player_id" });

        if (error) throw new Error(error.message);

        console.log(`[scorers] ${rows.length} goleadores actualizados.`);
        scorersResult = { upserted: rows.length, top: rows.slice(0, 3).map(r => `${r.player_name} ${r.goals}g`) };
      } else {
        scorersResult = { upserted: 0, message: "Sin goleadores todavía." };
      }
    } catch (scorerErr: any) {
      console.error("[scorers] Error:", scorerErr.message);
      scorersResult = { error: scorerErr.message };
    }

    // ── LLAMADA 3: Auto-generación de viñetas ─────────────────────
    let comicsResult: Record<string, unknown> = { triggered: 0 };

    if (newlyFinishedDays.length > 0) {
      const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
      if (!geminiKey) {
        console.log("[comics] GEMINI_API_KEY no configurado, saltando auto-comic.");
        comicsResult = { skipped: "GEMINI_API_KEY no configurado" };
      } else {
        // Ligas activas (con miembros)
        const { data: leagues } = await supabase
          .from("leagues")
          .select("id, name");

        const leagueList: { id: string; name: string }[] = leagues ?? [];

        // Para cada par (liga, día recién terminado), verificar si ya hay viñeta
        const pending: { league_id: string; league_name: string; match_day: string }[] = [];

        for (const day of newlyFinishedDays) {
          const { data: existingComics } = await supabase
            .from("daily_comics")
            .select("league_id")
            .eq("match_day", day)
            .in("league_id", leagueList.map(l => l.id));

          const alreadyDone = new Set((existingComics ?? []).map((c: any) => c.league_id));

          for (const lg of leagueList) {
            if (!alreadyDone.has(lg.id)) {
              pending.push({ league_id: lg.id, league_name: lg.name, match_day: day });
            }
          }
        }

        if (pending.length === 0) {
          console.log("[comics] Todas las viñetas ya existen. Nada que generar.");
          comicsResult = { triggered: 0, message: "Viñetas ya existentes." };
        } else {
          console.log(`[comics] Disparando ${pending.length} viñeta(s): ${pending.map(p => `${p.league_name}/${p.match_day}`).join(", ")}`);

          const comicGenUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/comic-gen`;
          const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

          // Lanzar en paralelo (fire-and-await: es un job nocturno, el tiempo no importa)
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
                  console.log(`[comics] ✓ ${league_name}/${match_day}: ${json.url?.slice(-30)}`);
                } else if (json.cached) {
                  console.log(`[comics] cached ${league_name}/${match_day}`);
                } else {
                  console.warn(`[comics] ✗ ${league_name}/${match_day}: ${json.error}`);
                }
                return json;
              } catch (e: any) {
                console.error(`[comics] fetch error ${league_name}/${match_day}:`, e.message);
                return { ok: false, error: e.message };
              }
            })
          );

          const ok  = comicResults.filter(r => r.status === "fulfilled" && (r.value as any)?.ok).length;
          const err = comicResults.length - ok;
          comicsResult = { triggered: comicResults.length, ok, errors: err };
        }
      }
    }

    return respond({
      ok:      true,
      matches: matchesResult,
      scorers: scorersResult,
      comics:  comicsResult,
    });

  } catch (err: any) {
    console.error("poll-results error:", err);
    return respond({ ok: false, error: err.message }, 500);
  }
});

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    },
  });
}
