/**
 * import-fixtures — Fase 3 (football-data.org v4)
 *
 * Una sola llamada a /v4/competitions/WC/matches devuelve todos los
 * partidos del Mundial (fixtures + resultados). Se hace upsert en matches.
 *
 * Invocar manualmente con curl (ver README o CLAUDE.md):
 *   curl -X POST https://<project-ref>.supabase.co/functions/v1/import-fixtures \
 *        -H "Authorization: Bearer <anon-key>"
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_BASE   = "https://api.football-data.org/v4";
const BATCH_SIZE = 50; // lotes para no superar límites de payload de PostgREST

// ── Handler ───────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return respond({ ok: true }, 200);
  }

  try {
    // ── Secrets ──────────────────────────────────────────────
    const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
    if (!token) {
      throw new Error(
        "Secret FOOTBALL_DATA_TOKEN no configurado. " +
          "Ejecuta: npx supabase secrets set FOOTBALL_DATA_TOKEN=<tu-token>",
      );
    }

    // Service role: bypasa RLS → puede escribir en matches
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── PASO 1: Descargar todos los partidos del Mundial ─────
    // Una sola llamada; football-data.org devuelve fixtures y resultados juntos.
    console.log("Descargando partidos WC de football-data.org…");
    const res = await fetch(`${API_BASE}/competitions/WC/matches`, {
      headers: { "X-Auth-Token": token },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `football-data.org respondió HTTP ${res.status}: ${body}`,
      );
    }

    const json = await res.json();
    const matches: any[] = json.matches ?? [];

    if (matches.length === 0) {
      return respond(
        {
          ok: false,
          error: "La API no devolvió partidos para WC.",
          hint: "Comprueba que el token es válido y tiene acceso al Mundial.",
          raw: json,
        },
        404,
      );
    }

    console.log(`${matches.length} partidos recibidos. Transformando…`);

    // ── PASO 2: Transformar al esquema de matches ────────────
    const rows = matches.map((m: any) => {
      const isGroup = m.stage === "GROUP_STAGE";

      return {
        id:         String(m.id),
        phase:      isGroup ? "grupos" : "eliminatorias",
        grp:        isGroup ? parseGroup(m.group) : humanizeStage(m.stage),
        home_team:  m.homeTeam?.name  ?? "TBD",
        away_team:  m.awayTeam?.name  ?? "TBD",
        home_logo:  m.homeTeam?.crest ?? null,
        away_logo:  m.awayTeam?.crest ?? null,
        kickoff:    m.utcDate,                          // ISO 8601 UTC
        home_goals: m.score?.fullTime?.home ?? null,    // null si no jugado
        away_goals: m.score?.fullTime?.away ?? null,
        is_final:   m.status === "FINISHED",
        updated_at: new Date().toISOString(),
      };
    });

    // ── PASO 3: Upsert en lotes ──────────────────────────────
    // onConflict: "id" → actualiza si el partido ya existe
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("matches")
        .upsert(batch, { onConflict: "id" });
      if (error) {
        throw new Error(
          `Upsert lote ${i}–${i + batch.length - 1}: ${error.message}`,
        );
      }
      upserted += batch.length;
      console.log(`Upserted ${upserted}/${rows.length}…`);
    }

    const grouped  = rows.filter((r) => r.phase === "grupos").length;
    const knockout = rows.filter((r) => r.phase === "eliminatorias").length;

    return respond({
      ok:           true,
      competition:  json.competition?.name,
      season:       json.filters?.season,
      matches_found: matches.length,
      upserted,
      desglose:     { grupos: grouped, eliminatorias: knockout },
    });

  } catch (err: any) {
    console.error("import-fixtures error:", err);
    return respond({ ok: false, error: err.message }, 500);
  }
});

// ── Helpers ───────────────────────────────────────────────────

/**
 * "GROUP_A" → "A" | "GROUP_L" → "L"
 * Para grupos del formato football-data.org.
 */
function parseGroup(group: string | null): string | null {
  if (!group) return null;
  const m = group.match(/^GROUP_([A-Z]+)$/);
  return m ? m[1] : group;
}

/**
 * Convierte el stage code de eliminatorias a un nombre legible
 * que se almacena en el campo grp.
 * WC 2026 introduce LAST_32 (ronda de 32).
 */
function humanizeStage(stage: string): string {
  const labels: Record<string, string> = {
    LAST_32:        "Round of 32",
    LAST_16:        "Round of 16",
    QUARTER_FINALS: "Quarter-finals",
    SEMI_FINALS:    "Semi-finals",
    THIRD_PLACE:    "Third place",
    FINAL:          "Final",
  };
  return labels[stage] ?? stage;
}

/** Respuesta JSON uniforme con cabeceras CORS. */
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
