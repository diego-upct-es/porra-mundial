/**
 * daily-alert — Fase 8
 *
 * Enviada por pg_cron a las 07:00 UTC (09:00 CEST).
 * Comprueba si hay partidos en las próximas 36 h y, si los hay,
 * envía una Web Push a todos los registros de push_subscriptions.
 * Las suscripciones caducadas (410/404) se eliminan automáticamente.
 *
 * Secrets necesarios (supabase secrets set):
 *   VAPID_PUBLIC_KEY   — clave pública VAPID (base64url, sin =)
 *   VAPID_PRIVATE_KEY  — clave privada VAPID (base64url, sin =)
 *   VAPID_SUBJECT      — mailto:tu@email.com  (o https://tu-dominio.com)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";

/** Garantiza base64url estricto: sin padding =, sin + ni / */
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
      throw new Error(
        "Secrets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configurados. " +
        "Ejecuta: npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...",
      );
    }

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Partidos en las próximas 36 h (ventana hoy + mañana) ──
    const now       = new Date();
    const windowEnd = new Date(now);
    windowEnd.setUTCHours(windowEnd.getUTCHours() + 36);

    const { data: upcoming, error: matchErr } = await supabase
      .from("matches")
      .select("id, home_team, away_team, kickoff")
      .gt("kickoff", now.toISOString())
      .lte("kickoff", windowEnd.toISOString())
      .eq("is_final", false)
      .order("kickoff");

    if (matchErr) throw new Error(matchErr.message);

    if (!upcoming || upcoming.length === 0) {
      console.log("[daily-alert] Sin partidos próximos. Sin envío.");
      return respond({ ok: true, message: "Sin partidos próximos. Sin envío." });
    }

    console.log(`[daily-alert] ${upcoming.length} partido(s) próximos.`);

    // ── Suscripciones push ────────────────────────────────────
    const { data: subs, error: subErr } = await supabase
      .from("push_subscriptions")
      .select("id, subscription");

    if (subErr) throw new Error(subErr.message);
    if (!subs || subs.length === 0) {
      console.log("[daily-alert] Sin suscripciones registradas.");
      return respond({ ok: true, message: "Sin suscripciones registradas." });
    }

    // Construye el cuerpo del mensaje
    const matchNames = upcoming
      .slice(0, 3)
      .map((m: any) => `${m.home_team} vs ${m.away_team}`)
      .join(", ");
    const extra = upcoming.length > 3 ? ` y ${upcoming.length - 3} más` : "";

    const payload = JSON.stringify({
      title: "¡Hora de predecir! ⚽",
      body:  `Partidos hoy/mañana: ${matchNames}${extra}`,
    });

    // ── Envío en paralelo ─────────────────────────────────────
    let sent = 0, failed = 0;
    const expiredIds: string[] = [];

    await Promise.allSettled(
      subs.map(async (sub: any) => {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          sent++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            expiredIds.push(sub.id);
          }
          console.error(`[daily-alert] Push ${sub.id}:`, err.statusCode ?? err.message);
          failed++;
        }
      }),
    );

    // Limpia suscripciones caducadas
    if (expiredIds.length > 0) {
      await supabase.from("push_subscriptions").delete().in("id", expiredIds);
      console.log(`[daily-alert] ${expiredIds.length} suscripción(es) caducada(s) eliminada(s).`);
    }

    console.log(`[daily-alert] Enviadas ${sent}, falladas ${failed}.`);
    return respond({
      ok:      true,
      matches: upcoming.length,
      subs:    subs.length,
      sent,
      failed,
      expired: expiredIds.length,
    });

  } catch (err: any) {
    console.error("daily-alert error:", err);
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
