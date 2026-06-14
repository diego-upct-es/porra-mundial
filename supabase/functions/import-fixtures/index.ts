/**
 * import-fixtures — API-Football (api-sports.io v3)
 *
 * Descarga todos los partidos del Mundial y hace upsert en matches.
 *
 * Secrets requeridos:
 *   APISPORTS_KEY   — clave de api-sports.io (header x-apisports-key)
 *
 * Secrets opcionales (se auto-descubren si no están):
 *   WC_LEAGUE_ID    — ID de liga en API-Football (World Cup)
 *   WC_SEASON       — Temporada (por defecto: 2026)
 *
 * Invocar manualmente:
 *   # Primera vez: borrar fixtures anteriores (IDs distintos) y recargar
 *   curl -X POST https://<ref>.supabase.co/functions/v1/import-fixtures \
 *        -H "Authorization: Bearer <anon-key>" \
 *        -H "Content-Type: application/json" \
 *        -d '{"truncate":true}'
 *
 *   # Actualizaciones posteriores (upsert sin borrar)
 *   curl -X POST https://<ref>.supabase.co/functions/v1/import-fixtures \
 *        -H "Authorization: Bearer <anon-key>"
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_BASE   = "https://v3.football.api-sports.io";
const BATCH_SIZE = 50;

// Statuses que indican partido terminado definitivamente
const FINAL_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO"]);
// Statuses que indican partido en curso
const LIVE_STATUSES  = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true }, 200);

  try {
    const body: Record<string, unknown> =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const truncate: boolean = body.truncate === true;

    // ── Secrets ───────────────────────────────────────────────
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

    // ── PASO 0: Resolver league ID + season ──────────────────
    let leagueId = Number(Deno.env.get("WC_LEAGUE_ID") ?? "0");
    let season   = Number(Deno.env.get("WC_SEASON")    ?? "2026");

    if (!leagueId) {
      console.log("[import] WC_LEAGUE_ID no configurado — auto-descubriendo…");
      const lgRes = await fetch(
        `${API_BASE}/leagues?name=World+Cup&type=Cup`,
        { headers: apiHeaders },
      );
      if (!lgRes.ok) throw new Error(`/leagues HTTP ${lgRes.status}`);
      const lgJson = await lgRes.json();

      // Buscamos la liga "World Cup" cuyo country.name = "World"
      const wc = (lgJson.response ?? []).find(
        (r: any) => r.country?.name === "World" && r.league?.type === "Cup",
      );
      if (!wc) {
        throw new Error(
          "No se encontró 'World Cup' (country=World) en API-Football. " +
          "Respuesta: " + JSON.stringify(lgJson).slice(0, 400),
        );
      }
      leagueId = wc.league.id;

      // Temporada actual o la más alta disponible
      const seasons: any[] = wc.seasons ?? [];
      const currentYear = seasons.find((s: any) => s.current)?.year
        ?? seasons.reduce((mx: number, s: any) => Math.max(mx, s.year), 0);
      if (currentYear) season = currentYear;

      console.log(`[import] ✓ Descubierto: WC_LEAGUE_ID=${leagueId} WC_SEASON=${season}`);
      console.log(
        `[import] → Guarda como secret permanente:\n` +
        `  npx supabase secrets set WC_LEAGUE_ID=${leagueId} WC_SEASON=${season}`,
      );
    }

    // ── PASO 1: Grupos (standings) → teamId → letra de grupo ─
    // Si el torneo no ha comenzado puede que aún no existan standings.
    // En ese caso grp = null para los partidos de grupos.
    console.log(`[import] Consultando standings para letras de grupo…`);
    const teamGroup: Record<number, string> = {};
    try {
      const sgRes = await fetch(
        `${API_BASE}/standings?league=${leagueId}&season=${season}`,
        { headers: apiHeaders },
      );
      if (sgRes.ok) {
        const sgJson = await sgRes.json();
        const standingsGroups: any[][] =
          sgJson.response?.[0]?.league?.standings ?? [];
        for (const group of standingsGroups) {
          for (const entry of group) {
            // entry.group = "Group A", "Group B", …
            const raw = (entry.group ?? "") as string;
            const letter = raw.replace(/^Group\s+/i, "").trim();
            const teamId: number = entry.team?.id ?? 0;
            if (letter && teamId) teamGroup[teamId] = letter;
          }
        }
        console.log(`[import] ${Object.keys(teamGroup).length} equipos con grupo asignado.`);
      } else {
        console.warn(
          `[import] standings HTTP ${sgRes.status} — grp=null en partidos de grupos.`,
        );
      }
    } catch (e) {
      console.warn("[import] standings error (no crítico):", (e as Error).message);
    }

    // ── PASO 2: Descargar todos los fixtures del Mundial ──────
    console.log(`[import] Descargando fixtures (league=${leagueId}, season=${season})…`);
    const fxRes = await fetch(
      `${API_BASE}/fixtures?league=${leagueId}&season=${season}`,
      { headers: apiHeaders },
    );
    if (!fxRes.ok) {
      const txt = await fxRes.text();
      throw new Error(`/fixtures HTTP ${fxRes.status}: ${txt.slice(0, 300)}`);
    }
    const fxJson = await fxRes.json();
    const fixtures: any[] = fxJson.response ?? [];

    if (fixtures.length === 0) {
      return respond(
        {
          ok: false,
          error: "La API no devolvió fixtures.",
          hint: "Verifica APISPORTS_KEY y que WC_LEAGUE_ID/WC_SEASON son correctos.",
          leagueId,
          season,
          raw: fxJson,
        },
        404,
      );
    }
    console.log(`[import] ${fixtures.length} fixtures recibidos. Transformando…`);

    // ── PASO 3: Transformar al esquema de matches ────────────
    const rows = fixtures.map((f: any) => {
      const round   = (f.league?.round ?? "") as string;
      const isGroup = /group stage/i.test(round);
      const status  = (f.fixture?.status?.short ?? "NS") as string;
      const isFinal = FINAL_STATUSES.has(status);
      const isLive  = LIVE_STATUSES.has(status);

      // Goles: goals.home/away es el marcador en curso o final.
      // score.fulltime.home/away solo se rellena al terminar el tiempo reglamentario.
      // Usamos goals para tener el marcador real (incluye ET, excluye penaltis).
      const isStarted = isFinal || isLive;
      const homeGoals = isStarted ? (f.goals?.home  ?? null) : null;
      const awayGoals = isStarted ? (f.goals?.away  ?? null) : null;

      // Letra de grupo: viene de standings map; null si no disponible
      const homeTeamId: number = f.teams?.home?.id ?? 0;
      const grpValue = isGroup
        ? (teamGroup[homeTeamId] ?? null)
        : parseRound(round);

      return {
        id:         String(f.fixture.id),          // fixture.id de API-Football
        phase:      isGroup ? "grupos" : "eliminatorias",
        grp:        grpValue,
        home_team:  f.teams?.home?.name  ?? "TBD",
        away_team:  f.teams?.away?.name  ?? "TBD",
        home_logo:  f.teams?.home?.logo  ?? null,  // URL de escudo real
        away_logo:  f.teams?.away?.logo  ?? null,
        kickoff:    f.fixture.date,                // ISO 8601 UTC
        home_goals: homeGoals,
        away_goals: awayGoals,
        is_final:   isFinal,
        updated_at: new Date().toISOString(),
      };
    });

    // ── PASO 4 (opcional): Vaciar fixtures previos ───────────
    // Necesario en la migración inicial porque los IDs de API-Football
    // son distintos a los de football-data.org.
    // Las predicciones también se eliminan (foreign key cascade).
    if (truncate) {
      console.log("[import] truncate=true — vaciando matches y predictions…");
      const { data: tData, error: tErr } = await supabase.rpc("truncate_fixtures");
      if (tErr) throw new Error(`truncate_fixtures RPC: ${tErr.message}`);
      console.log("[import] Vaciado:", JSON.stringify(tData));
    }

    // ── PASO 5: Upsert en lotes de 50 ───────────────────────
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("matches")
        .upsert(batch, { onConflict: "id" });
      if (error) {
        throw new Error(`Upsert lote ${i}–${i + batch.length - 1}: ${error.message}`);
      }
      upserted += batch.length;
      console.log(`[import] Upserted ${upserted}/${rows.length}…`);
    }

    const grouped  = rows.filter(r => r.phase === "grupos").length;
    const knockout = rows.filter(r => r.phase === "eliminatorias").length;
    const finales  = rows.filter(r => r.is_final).length;
    const conGrp   = rows.filter(r => r.phase === "grupos" && r.grp !== null).length;

    return respond({
      ok:     true,
      source: "api-football",
      leagueId,
      season,
      fixtures: fixtures.length,
      upserted,
      desglose: {
        grupos:        grouped,
        eliminatorias: knockout,
        finalizados:   finales,
        con_grupo:     conGrp,
      },
    });

  } catch (err: any) {
    console.error("[import] error:", err);
    return respond({ ok: false, error: err.message }, 500);
  }
});

// ── Helpers ───────────────────────────────────────────────────

/**
 * Mapea el campo league.round de eliminatorias al label guardado en grp.
 * API-Football usa: "Round of 32", "Round of 16", "Quarter-finals",
 * "Semi-finals", "3rd Place Final", "Final".
 */
function parseRound(round: string): string {
  const map: Record<string, string> = {
    "round of 32":     "Round of 32",
    "round of 16":     "Round of 16",
    "quarter-finals":  "Quarter-finals",
    "semi-finals":     "Semi-finals",
    "3rd place final": "Third place",
    "final":           "Final",
  };
  return map[round.toLowerCase()] ?? round;
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
