/**
 * drama-push
 *
 * Llamada por pg_cron tras cada actualización de resultados (poll-results).
 * Calcula la clasificación actual de cada liga, la compara con el snapshot
 * anterior y envía un Web Push al usuario que acaba de ser adelantado.
 *
 * Formato del mensaje:
 *   "¡@Nombre te ha adelantado! Estás en el puesto N 😤"
 *
 * Secrets necesarios (mismos que daily-alert):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";

function toBase64Url(s: string): string {
  return s.trim().replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true }, 200);

  try {
    const vapidPublicKey  = toBase64Url(Deno.env.get("VAPID_PUBLIC_KEY")  ?? "");
    const vapidPrivateKey = toBase64Url(Deno.env.get("VAPID_PRIVATE_KEY") ?? "");
    const vapidSubject    = (Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com").trim();

    if (!vapidPublicKey || !vapidPrivateKey) {
      throw new Error("Secrets VAPID no configurados.");
    }

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Obtener todas las ligas activas ────────────────────
    const { data: leagues, error: leagueErr } = await supabase
      .from("leagues")
      .select("id, name");
    if (leagueErr) throw new Error(leagueErr.message);
    if (!leagues || leagues.length === 0) return respond({ ok: true, message: "Sin ligas." });

    // ── 2. Para cada liga, calcular clasificación actual ──────
    // Reutiliza la misma lógica que la vista standings:
    // pts = exactos*3 + parciales*1
    const { data: allPreds, error: predErr } = await supabase
      .from("predictions")
      .select("league_id, user_id, match_id, home_goals, away_goals");
    if (predErr) throw new Error(predErr.message);

    const { data: allMatches, error: matchErr } = await supabase
      .from("matches")
      .select("id, home_goals, away_goals, is_final")
      .eq("is_final", true);
    if (matchErr) throw new Error(matchErr.message);

    const matchMap: Record<string, { home_goals: number; away_goals: number }> = {};
    (allMatches ?? []).forEach((m: any) => { matchMap[m.id] = m; });

    // Para cada liga calculamos { userId → { pts, rank } }
    const leagueStandings: Record<string, { userId: string; pts: number; rank: number }[]> = {};
    for (const lg of leagues) {
      const lgPreds = (allPreds ?? []).filter((p: any) => p.league_id === lg.id);
      const userMap: Record<string, number> = {};
      for (const p of lgPreds) {
        const m = matchMap[p.match_id];
        if (!m) continue;
        let pts = 0;
        if (p.home_goals === m.home_goals && p.away_goals === m.away_goals) pts = 3;
        else if (p.home_goals === m.home_goals || p.away_goals === m.away_goals) pts = 1;
        userMap[p.user_id] = (userMap[p.user_id] ?? 0) + pts;
      }
      const sorted = Object.entries(userMap)
        .sort(([, a], [, b]) => b - a)
        .map(([userId, pts], i) => ({ userId, pts, rank: i + 1 }));
      leagueStandings[lg.id] = sorted;
    }

    // ── 3. Comparar con snapshot anterior ────────────────────
    const { data: snapshots, error: snapErr } = await supabase
      .from("standings_snapshots")
      .select("league_id, user_id, rank, pts");
    if (snapErr) throw new Error(snapErr.message);

    const snapMap: Record<string, Record<string, { rank: number; pts: number }>> = {};
    (snapshots ?? []).forEach((s: any) => {
      (snapMap[s.league_id] = snapMap[s.league_id] || {})[s.user_id] = { rank: s.rank, pts: s.pts };
    });

    // ── 4. Detectar adelantos y recopilar notificaciones ──────
    interface Notif { userId: string; leagueName: string; overtakerName: string; newRank: number }
    const notifs: Notif[] = [];
    const profiles: Record<string, string> = {};

    // Cargamos nombres de perfil de todos los usuarios involucrados
    const allUserIds = [...new Set(
      Object.values(leagueStandings).flat().map(r => r.userId)
    )];
    if (allUserIds.length > 0) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", allUserIds);
      (profs ?? []).forEach((p: any) => { profiles[p.id] = p.display_name; });
    }

    for (const lg of leagues) {
      const current = leagueStandings[lg.id] ?? [];
      const prevByUser = snapMap[lg.id] ?? {};

      for (const row of current) {
        const prev = prevByUser[row.userId];
        if (!prev) continue; // primera vez, no hay comparación
        if (row.rank > prev.rank) {
          // Este usuario bajó de posición — alguien le adelantó
          // Buscar quién le adelantó (alguien cuyo rank actual sea == row.rank - no relevante;
          // simplemente decimos que alguien le adelantó)
          const overtaker = current.find(r => r.rank === row.rank - 1);
          if (!overtaker) continue;
          const overtakerName = profiles[overtaker.userId] || "Alguien";
          notifs.push({
            userId:       row.userId,
            leagueName:   lg.name,
            overtakerName,
            newRank:      row.rank,
          });
        }
      }
    }

    // ── 5. Enviar notificaciones ──────────────────────────────
    let sent = 0;
    const expiredIds: string[] = [];

    if (notifs.length > 0) {
      const targetUserIds = [...new Set(notifs.map(n => n.userId))];
      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, user_id, subscription")
        .in("user_id", targetUserIds);

      await Promise.allSettled(
        (subs ?? []).map(async (sub: any) => {
          const notif = notifs.find(n => n.userId === sub.user_id);
          if (!notif) return;
          const payload = JSON.stringify({
            title: `📉 ¡Te han adelantado en ${notif.leagueName}!`,
            body:  `${notif.overtakerName} te ha superado. Ahora eres ${notif.newRank}º. ¿Traición? No, fútbol.`,
          });
          try {
            await webpush.sendNotification(sub.subscription, payload);
            sent++;
          } catch (err: any) {
            if (err.statusCode === 410 || err.statusCode === 404) expiredIds.push(sub.id);
            console.error(`[drama-push] push ${sub.id}:`, err.statusCode ?? err.message);
          }
        }),
      );
    }

    // Limpia suscripciones caducadas
    if (expiredIds.length > 0) {
      await supabase.from("push_subscriptions").delete().in("id", expiredIds);
    }

    // ── 6. Actualizar snapshots ───────────────────────────────
    const upsertRows = Object.entries(leagueStandings).flatMap(([leagueId, rows]) =>
      rows.map(r => ({
        league_id:  leagueId,
        user_id:    r.userId,
        rank:       r.rank,
        pts:        r.pts,
        updated_at: new Date().toISOString(),
      }))
    );
    if (upsertRows.length > 0) {
      await supabase
        .from("standings_snapshots")
        .upsert(upsertRows, { onConflict: "league_id,user_id" });
    }

    console.log(`[drama-push] adelantos detectados: ${notifs.length}, enviados: ${sent}`);
    return respond({ ok: true, overtakes: notifs.length, sent, expired: expiredIds.length });

  } catch (err: any) {
    console.error("[drama-push] error:", err);
    return respond({ ok: false, error: err.message }, 500);
  }
});

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}
