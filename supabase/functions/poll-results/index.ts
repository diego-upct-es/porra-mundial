/**
 * poll-results — Fase 5 + 6
 *
 * En cada ejecución hace DOS llamadas a football-data.org:
 *   1. Resultados del día ± 1  →  actualiza matches (home_goals, away_goals, is_final)
 *   2. Goleadores del Mundial  →  actualiza player_stats (ext_player_id, goals, team_logo…)
 *
 * Usa el mismo token FOOTBALL_DATA_TOKEN y el mismo cron (cada 30 min).
 * Los goleadores se actualizan en el plan gratuito; assists viene null y se ignora.
 *
 * Invocación manual:
 *   curl -X POST https://<project-ref>.supabase.co/functions/v1/poll-results \
 *        -H "Authorization: Bearer <anon-key>"
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

    // Service role: bypasa RLS → puede escribir en matches y player_stats
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── LLAMADA 1: Resultados del día ± 1 ────────────────────
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

    if (!matchRes.ok) {
      const body = await matchRes.text();
      matchesResult = { error: `HTTP ${matchRes.status}: ${body}` };
      console.error("[matches] Error:", matchesResult.error);
    } else {
      const json: any        = await matchRes.json();
      const matches: any[]   = json.matches ?? [];
      let updated = 0, errors = 0;
      const finished: string[] = [];

      for (const m of matches) {
        const homeGoals = m.score?.fullTime?.home ?? null;
        const awayGoals = m.score?.fullTime?.away ?? null;
        const isFinal   = m.status === "FINISHED";

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

      console.log(`[matches] ${updated} actualizados, ${errors} errores.`);
      matchesResult = { window: { dateFrom, dateTo }, in_window: matches.length, updated, errors, finished };
    }

    // ── LLAMADA 2: Goleadores del Mundial ─────────────────────
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
          assists:       0,  // null en plan gratuito — forzamos 0
          updated_at:    now.toISOString(),
        })).filter((r: any) => r.ext_player_id !== null);

        // Upsert por ext_player_id (columna UNIQUE)
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
      // Un error en goleadores no cancela la respuesta principal
      console.error("[scorers] Error:", scorerErr.message);
      scorersResult = { error: scorerErr.message };
    }

    return respond({
      ok:      true,
      matches: matchesResult,
      scorers: scorersResult,
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
