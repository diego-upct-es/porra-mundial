/**
 * daily-roast — Crónica diaria generada por Gemini
 *
 * Llamada por pg_cron a las 23:30 UTC (01:30 CEST).
 * Busca el ÚLTIMO día con partidos finalizados que tenga predicciones
 * registradas (no asume que sea "hoy"). Genera la crónica para cada
 * liga activa con predicciones en ese día.
 *
 * Secrets necesarios:
 *   GEMINI_API_KEY      — Google AI Studio
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

    // ── 1. Buscar el último día con partidos finalizados ───────
    // Usa los últimos 3 días para evitar buscar en toda la historia.
    const { data: recentMatches, error: matchErr } = await supabase
      .from("matches")
      .select("id, home_team, away_team, home_goals, away_goals, kickoff")
      .eq("is_final", true)
      .order("kickoff", { ascending: false })
      .limit(50);

    if (matchErr) throw new Error(`matches: ${matchErr.message}`);

    if (!recentMatches || recentMatches.length === 0) {
      console.log("[daily-roast] Sin partidos finalizados en la BD. Nada que hacer.");
      return respond({ ok: true, message: "Sin partidos finalizados." });
    }

    // Agrupar por día y coger el más reciente
    const dayMap: Record<string, typeof recentMatches> = {};
    for (const m of recentMatches) {
      const day = (m.kickoff as string).slice(0, 10);
      (dayMap[day] = dayMap[day] || []).push(m);
    }
    const allDays = Object.keys(dayMap).sort().reverse(); // más reciente primero

    console.log(`[daily-roast] Días con partidos finalizados: ${allDays.join(", ")}`);

    // ── 2. Predicciones del periodo reciente por liga ──────────
    const recentMatchIds = recentMatches.map((m: any) => m.id);
    const { data: preds, error: predErr } = await supabase
      .from("predictions")
      .select("league_id, user_id, match_id, home_goals, away_goals")
      .in("match_id", recentMatchIds);

    if (predErr) throw new Error(`predicciones: ${predErr.message}`);

    if (!preds || preds.length === 0) {
      console.log("[daily-roast] Sin predicciones para los partidos recientes. Puede que aún no se hayan registrado.");
      return respond({ ok: true, message: "Sin predicciones para partidos recientes." });
    }

    // Buscar qué días tienen predicciones
    const predMatchIds = new Set(preds.map((p: any) => p.match_id));
    let targetDay: string | null = null;

    for (const day of allDays) {
      const dayMatchIds = dayMap[day].map((m: any) => m.id);
      const hasPreds    = dayMatchIds.some(id => predMatchIds.has(id));
      if (hasPreds) {
        targetDay = day;
        console.log(`[daily-roast] Día objetivo: ${targetDay} (${dayMap[day].length} partidos, con predicciones)`);
        break;
      }
      console.log(`[daily-roast] Día ${day}: ${dayMap[day].length} partidos, 0 predicciones → saltando`);
    }

    if (!targetDay) {
      console.log("[daily-roast] Ningún día reciente tiene predicciones. Sin recaps.");
      return respond({ ok: true, message: "Sin predicciones en días recientes." });
    }

    const todayMatches = dayMap[targetDay];

    // ── 3. Ligas con predicciones ese día ─────────────────────
    const dayMatchIds = todayMatches.map((m: any) => m.id);
    const dayPreds    = preds.filter((p: any) => dayMatchIds.includes(p.match_id));
    const leagueIds   = [...new Set(dayPreds.map((p: any) => p.league_id as string))];

    if (leagueIds.length === 0) {
      console.log(`[daily-roast] El día ${targetDay} no tiene predicciones registradas.`);
      return respond({ ok: true, message: `Día ${targetDay} sin predicciones.` });
    }

    const { data: leagues, error: lgErr } = await supabase
      .from("leagues")
      .select("id, name")
      .in("id", leagueIds);
    if (lgErr) throw new Error(`ligas: ${lgErr.message}`);

    console.log(`[daily-roast] Generando para ${leagues?.length ?? 0} liga(s): ${leagues?.map((l: any) => l.name).join(", ")}`);

    // ── 4. Perfiles de jugadores ───────────────────────────────
    const userIds = [...new Set(dayPreds.map((p: any) => p.user_id as string))];
    let profileMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", userIds);
      (profs ?? []).forEach((p: any) => { profileMap[p.id] = p.display_name; });
    }

    const results: { league_id: string; recap: string }[] = [];

    for (const lg of (leagues ?? [])) {
      const lgPreds = dayPreds.filter((p: any) => p.league_id === lg.id);
      if (lgPreds.length === 0) {
        console.log(`[daily-roast] Liga "${lg.name}" sin predicciones ese día.`);
        continue;
      }

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
Partidos del día ${targetDay}:
${matchLines}

Escribe la crónica del día. Destaca al que más puntuó (¿merecido o chiripa?), ridiculiza con cariño al que menos, menciona algún error concreto. Sin emojis en exceso. Sin título "Crónica de...". Empieza directamente.`;

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
        console.error(`[daily-roast] Gemini error ${geminiRes.status} para "${lg.name}":`, await geminiRes.text());
        continue;
      }

      const geminiData = await geminiRes.json();
      const recap = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!recap) {
        console.error(`[daily-roast] Gemini devolvió texto vacío para liga "${lg.name}".`);
        continue;
      }

      await supabase.from("daily_recaps").upsert(
        { league_id: lg.id, recap_date: targetDay, content: recap, created_at: new Date().toISOString() },
        { onConflict: "league_id,recap_date" }
      );

      results.push({ league_id: lg.id, recap });
      console.log(`[daily-roast] Recap guardado para liga "${lg.name}" (${targetDay}).`);
    }

    // ── 5. Push a suscriptores ────────────────────────────────
    let sent = 0;
    const expiredIds: string[] = [];

    if (pushEnabled && results.length > 0) {
      const lgIds = results.map(r => r.league_id);
      const { data: members } = await supabase
        .from("league_members")
        .select("user_id")
        .in("league_id", lgIds);

      const memberUserIds = [...new Set((members ?? []).map((m: any) => m.user_id))];
      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, user_id, subscription")
        .in("user_id", memberUserIds);

      await Promise.allSettled(
        (subs ?? []).map(async (sub: any) => {
          try {
            await webpush.sendNotification(sub.subscription, JSON.stringify({
              title: "🗞️ Crónica del día lista",
              body:  "¿Fuiste el héroe o el desastre de hoy? Lee la crónica de tu porra.",
            }));
            sent++;
          } catch (err: any) {
            if (err.statusCode === 410 || err.statusCode === 404) expiredIds.push(sub.id);
            console.error("[daily-roast] push:", err.statusCode ?? err.message);
          }
        }),
      );

      if (expiredIds.length > 0) {
        await supabase.from("push_subscriptions").delete().in("id", expiredIds);
        console.log(`[daily-roast] ${expiredIds.length} suscripción(es) caducada(s) eliminada(s).`);
      }
    }

    console.log(`[daily-roast] Día ${targetDay}: ${results.length} recap(s) generado(s), ${sent} push enviado(s).`);
    return respond({
      ok:        true,
      target_day: targetDay,
      recaps:    results.length,
      sent,
      expired:   expiredIds.length,
    });

  } catch (err: any) {
    console.error("[daily-roast] error fatal:", err);
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
