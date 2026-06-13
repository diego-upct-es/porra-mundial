/**
 * daily-roast — Crónica diaria de la porra generada por Gemini
 *
 * Llamada por pg_cron a las 23:30 UTC (01:30 CEST) para resumir
 * los partidos del día con humor negro estilo Twitter Fútbol.
 *
 * Para cada liga activa que tenga partidos jugados hoy:
 *   1. Recoge resultados del día + predicciones de los miembros
 *   2. Llama a Gemini Flash para generar la crónica
 *   3. Guarda en daily_recaps
 *   4. Envía Web Push a los miembros suscritos
 *
 * Secrets necesarios:
 *   GEMINI_API_KEY      — Google AI Studio → API key
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
    const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (!geminiKey) throw new Error("Secret GEMINI_API_KEY no configurado.");

    const vapidPublicKey  = toBase64Url(Deno.env.get("VAPID_PUBLIC_KEY")  ?? "");
    const vapidPrivateKey = toBase64Url(Deno.env.get("VAPID_PRIVATE_KEY") ?? "");
    const vapidSubject    = (Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com").trim();
    const pushEnabled     = vapidPublicKey && vapidPrivateKey;
    if (pushEnabled) webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Partidos finalizados HOY ───────────────────────────
    const today     = new Date().toISOString().slice(0, 10);
    const todayStart = `${today}T00:00:00Z`;
    const todayEnd   = `${today}T23:59:59Z`;

    const { data: todayMatches, error: matchErr } = await supabase
      .from("matches")
      .select("id, home_team, away_team, home_goals, away_goals, kickoff")
      .eq("is_final", true)
      .gte("kickoff", todayStart)
      .lte("kickoff", todayEnd);

    if (matchErr) throw new Error(matchErr.message);
    if (!todayMatches || todayMatches.length === 0) {
      console.log("[daily-roast] Sin partidos finalizados hoy. Sin recap.");
      return respond({ ok: true, message: "Sin partidos hoy." });
    }

    // ── 2. Ligas activas ──────────────────────────────────────
    const { data: leagues, error: lgErr } = await supabase
      .from("leagues")
      .select("id, name");
    if (lgErr) throw new Error(lgErr.message);
    if (!leagues || leagues.length === 0) return respond({ ok: true, message: "Sin ligas." });

    // ── 3. Predicciones del día por liga ──────────────────────
    const matchIds = todayMatches.map((m: any) => m.id);
    const { data: preds, error: predErr } = await supabase
      .from("predictions")
      .select("league_id, user_id, match_id, home_goals, away_goals")
      .in("match_id", matchIds);
    if (predErr) throw new Error(predErr.message);

    // Perfiles de usuarios
    const userIds = [...new Set((preds ?? []).map((p: any) => p.user_id))];
    let profileMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", userIds);
      (profs ?? []).forEach((p: any) => { profileMap[p.id] = p.display_name; });
    }

    const results: { league_id: string; recap: string }[] = [];

    for (const lg of leagues) {
      const lgPreds = (preds ?? []).filter((p: any) => p.league_id === lg.id);
      if (lgPreds.length === 0) continue; // liga sin predicciones hoy

      // Construir contexto para Gemini
      const matchLines = todayMatches.map((m: any) => {
        const result = `${m.home_team} ${m.home_goals}-${m.away_goals} ${m.away_team}`;
        const predLines = lgPreds
          .filter((p: any) => p.match_id === m.id)
          .map((p: any) => {
            const name = profileMap[p.user_id] || "Alguien";
            const pts = p.home_goals === m.home_goals && p.away_goals === m.away_goals ? 3
                      : p.home_goals === m.home_goals || p.away_goals === m.away_goals ? 1 : 0;
            return `  - ${name}: ${p.home_goals}-${p.away_goals} (${pts} pts)`;
          }).join("\n");
        return `${result}\n${predLines || "  (sin predicciones)"}`;
      }).join("\n\n");

      const prompt = `Eres el cronista de una porra de amigos del Mundial 2026, con estilo Twitter Fútbol España: sarcástico, humor negro, referencias a fútbol, directo, máximo 5 párrafos breves.
Liga: "${lg.name}"
Partidos de hoy con predicciones:
${matchLines}

Escribe la crónica del día. Destaca al que más puntuó (¿merecido o chiripa?), ridiculiza con cariño al que menos, menciona algún error concreto. Sin emojis en exceso. Sin título "Crónica de...". Empieza directamente.`;

      // Llamada a Gemini Flash
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.9 },
        }),
      });
      if (!geminiRes.ok) {
        console.error(`[daily-roast] Gemini error ${geminiRes.status}:`, await geminiRes.text());
        continue;
      }
      const geminiData = await geminiRes.json();
      const recap = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!recap) { console.error("[daily-roast] Gemini devolvió texto vacío."); continue; }

      // Guardar recap
      await supabase.from("daily_recaps").upsert(
        { league_id: lg.id, recap_date: today, content: recap, created_at: new Date().toISOString() },
        { onConflict: "league_id,recap_date" }
      );

      results.push({ league_id: lg.id, recap });
    }

    // ── 4. Push a suscriptores ────────────────────────────────
    let sent = 0;
    const expiredIds: string[] = [];

    if (pushEnabled && results.length > 0) {
      const lgIds = results.map(r => r.league_id);

      // Miembros de esas ligas con suscripción push
      const { data: members } = await supabase
        .from("league_members")
        .select("user_id, league_id")
        .in("league_id", lgIds);

      const memberUserIds = [...new Set((members ?? []).map((m: any) => m.user_id))];
      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, user_id, subscription")
        .in("user_id", memberUserIds);

      await Promise.allSettled(
        (subs ?? []).map(async (sub: any) => {
          const payload = JSON.stringify({
            title: "🗞️ Crónica del día lista",
            body:  "¿Fuiste el héroe o el desastre de hoy? Lee la crónica de tu porra.",
          });
          try {
            await webpush.sendNotification(sub.subscription, payload);
            sent++;
          } catch (err: any) {
            if (err.statusCode === 410 || err.statusCode === 404) expiredIds.push(sub.id);
            console.error("[daily-roast] push:", err.statusCode ?? err.message);
          }
        }),
      );

      if (expiredIds.length > 0) {
        await supabase.from("push_subscriptions").delete().in("id", expiredIds);
      }
    }

    console.log(`[daily-roast] recaps generados: ${results.length}, push enviados: ${sent}`);
    return respond({ ok: true, recaps: results.length, sent, expired: expiredIds.length });

  } catch (err: any) {
    console.error("[daily-roast] error:", err);
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
