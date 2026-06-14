/**
 * import-squads — Descarga plantillas desde API-Football (/players/squads)
 *
 * Para cada equipo con partidos en matches (home_team_id / away_team_id),
 * llama a /players/squads y hace upsert en la tabla squads.
 *
 * Invocar manualmente una vez antes del torneo y tras cambios de plantilla:
 *   curl -X POST https://<ref>.supabase.co/functions/v1/import-squads \
 *        -H "Authorization: Bearer <anon-key>"
 *
 * Secrets: APISPORTS_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_BASE = "https://v3.football.api-sports.io";

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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const apiHeaders = { "x-apisports-key": apiKey };

    // ── Recopilar todos los team IDs distintos de matches ────
    const { data: matchRows, error: matchErr } = await supabase
      .from("matches")
      .select("home_team_id, away_team_id");
    if (matchErr) throw new Error(`matches query: ${matchErr.message}`);

    const teamIds = new Set<number>();
    for (const r of (matchRows ?? [])) {
      if (r.home_team_id) teamIds.add(r.home_team_id);
      if (r.away_team_id) teamIds.add(r.away_team_id);
    }

    if (teamIds.size === 0) {
      return respond({
        ok:   false,
        error: "Sin equipos en matches. Ejecuta import-fixtures primero.",
      }, 404);
    }

    console.log(`[import-squads] ${teamIds.size} equipos a procesar.`);

    let totalPlayers = 0, errors = 0;

    for (const teamId of teamIds) {
      const url = `${API_BASE}/players/squads?team=${teamId}`;
      const res = await fetch(url, { headers: apiHeaders });

      if (!res.ok) {
        console.error(`[import-squads] team ${teamId}: HTTP ${res.status}`);
        errors++;
        continue;
      }

      const json = await res.json();
      const players: any[] = json.response?.[0]?.players ?? [];

      if (players.length === 0) {
        console.warn(`[import-squads] team ${teamId}: sin jugadores en la respuesta`);
        continue;
      }

      const rows = players.map((p: any) => ({
        ext_team_id:   teamId,
        ext_player_id: p.id,
        player_name:   p.name,
        position:      p.position,  // 'Goalkeeper'|'Defender'|'Midfielder'|'Attacker'
        shirt_number:  p.number ?? null,
        updated_at:    new Date().toISOString(),
      }));

      const { error: upsertErr } = await supabase
        .from("squads")
        .upsert(rows, { onConflict: "ext_team_id,ext_player_id" });

      if (upsertErr) {
        console.error(`[import-squads] team ${teamId} upsert:`, upsertErr.message);
        errors++;
      } else {
        totalPlayers += rows.length;
        console.log(`[import-squads] team ${teamId}: ${rows.length} jugadores`);
      }

      // Pausa mínima para no saturar la cuota de la API
      await new Promise(r => setTimeout(r, 120));
    }

    return respond({ ok: true, teams: teamIds.size, players: totalPlayers, errors });

  } catch (err: any) {
    console.error("[import-squads] error:", err);
    return respond({ ok: false, error: err.message }, 500);
  }
});

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
