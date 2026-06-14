/**
 * test-push — Envía una notificación de prueba a TODAS las suscripciones.
 *
 * Útil para verificar que el canal VAPID funciona y para limpiar suscripciones
 * caducadas antes del inicio del torneo.
 *
 * POST /functions/v1/test-push  (Bearer service-role key)
 * Respuesta: { ok, enviadas, falladas, borradas }
 *
 * Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
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

    const { data: subs, error: subErr } = await supabase
      .from("push_subscriptions")
      .select("id, subscription");

    if (subErr) throw new Error(subErr.message);

    if (!subs || subs.length === 0) {
      return respond({
        ok: true,
        message: "Sin suscripciones registradas.",
        enviadas: 0, falladas: 0, borradas: 0,
      });
    }

    const payload = JSON.stringify({
      title: "🔔 Prueba de avisos",
      body:  "Si ves esto, los push funcionan correctamente.",
    });

    let enviadas = 0, falladas = 0;
    const expiredIds: string[] = [];

    await Promise.allSettled(
      subs.map(async (sub: any) => {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          enviadas++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            expiredIds.push(sub.id);
          }
          console.error(`[test-push] Sub ${sub.id}:`, err.statusCode ?? err.message);
          falladas++;
        }
      }),
    );

    const borradas = expiredIds.length;
    if (expiredIds.length > 0) {
      await supabase.from("push_subscriptions").delete().in("id", expiredIds);
      console.log(`[test-push] ${borradas} suscripción(es) caducada(s) eliminada(s).`);
    }

    console.log(`[test-push] Enviadas ${enviadas}, falladas ${falladas}, borradas ${borradas}.`);
    return respond({ ok: true, enviadas, falladas, borradas });

  } catch (err: any) {
    console.error("[test-push] error:", err);
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
