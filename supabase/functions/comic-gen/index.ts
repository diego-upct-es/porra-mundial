/**
 * comic-gen — Viñeta de grupo por jornada (v3)
 *
 * Flujo en dos pasos:
 *   1. gemini-2.5-flash (texto) → descripción detallada de la escena
 *   2. gemini-2.5-flash-image (imagen, "Nano Banana") → viñeta cómica
 *      pasando las fotos de referencia como partes inline.
 *
 * Input (POST JSON): { league_id: string, match_day: "YYYY-MM-DD" }
 * Output: { ok: true, url } | { ok: false, error }
 *
 * Llamado por:
 *   - El usuario manualmente (frontend → StandingsTab)
 *   - poll-results automáticamente al terminar todos los partidos del día
 *
 * Secrets: GEMINI_API_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TEXT_MODEL  = "gemini-2.5-flash";           // texto: descripción de escena
const IMAGE_MODEL = "gemini-2.5-flash-image";     // imagen: Nano Banana (gratuito, ref-images OK)
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true }, 200);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return respond({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    const { league_id, match_day } = await req.json();
    if (!league_id || !match_day) {
      return respond({ ok: false, error: "missing_params: league_id y match_day son obligatorios" }, 400);
    }

    const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (!geminiKey) throw new Error("Secret GEMINI_API_KEY no configurado.");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Comprobar si ya existe una viñeta para este día + liga ─
    { const { data: existing } = await supabase
        .from("daily_comics")
        .select("id, image_url")
        .eq("league_id", league_id)
        .eq("match_day", match_day)
        .maybeSingle();
      if (existing?.image_url) {
        console.log(`[comic-gen] Ya existe viñeta para ${league_id}/${match_day}. Devolviendo URL existente.`);
        return respond({ ok: true, url: existing.image_url, cached: true });
      }
    }

    // ── 2. Datos del día ──────────────────────────────────────────
    const dayStart = `${match_day}T00:00:00Z`;
    const dayEnd   = `${match_day}T23:59:59Z`;

    const [
      { data: dayMatches, error: matchErr },
      { data: members,   error: memErr   },
    ] = await Promise.all([
      supabase.from("matches")
        .select("id, home_team, away_team, home_goals, away_goals, kickoff")
        .eq("is_final", true)
        .gte("kickoff", dayStart)
        .lte("kickoff", dayEnd),
      supabase.from("league_members")
        .select("user_id, profiles(id, display_name, avatar_url)")
        .eq("league_id", league_id),
    ]);

    if (matchErr) throw new Error(`matches: ${matchErr.message}`);
    if (memErr)   throw new Error(`members: ${memErr.message}`);
    if (!dayMatches || dayMatches.length === 0) {
      return respond({ ok: false, error: "no_matches: sin partidos finalizados ese día" }, 404);
    }

    const membersList: Array<{ userId: string; name: string; avatar_url: string | null }> =
      (members ?? []).map((m: any) => ({
        userId:     m.user_id,
        name:       m.profiles?.display_name ?? m.user_id.slice(0, 8),
        avatar_url: m.profiles?.avatar_url ?? null,
      }));

    const matchIds = dayMatches.map((m: any) => m.id);
    const { data: preds } = await supabase
      .from("predictions")
      .select("user_id, match_id, home_goals, away_goals")
      .eq("league_id", league_id)
      .in("match_id", matchIds);

    // ── 3. Calcular puntos + racha por jugador ────────────────────
    type PlayerDay = {
      userId: string; name: string; avatar_url: string | null;
      pts: number; exacts: number; zeros: number; hasPreds: boolean;
    };
    const playerMap: Record<string, PlayerDay> = {};
    membersList.forEach(m => {
      playerMap[m.userId] = { ...m, pts: 0, exacts: 0, zeros: 0, hasPreds: false };
    });

    for (const p of (preds ?? [])) {
      const m = dayMatches.find((x: any) => x.id === p.match_id);
      if (!m || !playerMap[p.user_id]) continue;
      playerMap[p.user_id].hasPreds = true;
      if (p.home_goals === m.home_goals && p.away_goals === m.away_goals) {
        playerMap[p.user_id].pts    += 3;
        playerMap[p.user_id].exacts += 1;
      } else if (p.home_goals === m.home_goals || p.away_goals === m.away_goals) {
        playerMap[p.user_id].pts += 1;
      } else {
        playerMap[p.user_id].zeros += 1;
      }
    }

    // Solo jugadores que predijeron algo ese día
    const activePlayers = Object.values(playerMap)
      .filter(p => p.hasPreds)
      .sort((a, b) => b.pts - a.pts);

    if (activePlayers.length === 0) {
      return respond({ ok: false, error: "no_predictions: ningún jugador predijo ese día" }, 404);
    }

    // Calcular rachas históricas (últimos partidos finalizados antes del día)
    const { data: recentPreds } = await supabase
      .from("predictions")
      .select("user_id, match_id, home_goals, away_goals")
      .eq("league_id", league_id);

    const { data: recentMatches } = await supabase
      .from("matches")
      .select("id, home_goals, away_goals, kickoff, is_final")
      .eq("is_final", true)
      .lt("kickoff", dayStart)
      .order("kickoff", { ascending: false })
      .limit(60);

    const streakMap: Record<string, string> = {};
    for (const player of activePlayers) {
      const playerHistPreds = (recentPreds ?? []).filter((p: any) => p.user_id === player.userId);
      const lastMatches = (recentMatches ?? []).slice(0, 5);
      let streak = "";
      for (const m of lastMatches) {
        const p = playerHistPreds.find((pp: any) => pp.match_id === m.id);
        if (!p) break;
        if (p.home_goals === m.home_goals && p.away_goals === m.away_goals) streak += "✓";
        else if (p.home_goals === m.home_goals || p.away_goals === m.away_goals) streak += "~";
        else streak += "✗";
      }
      streakMap[player.userId] = streak || "—";
    }

    // ── 4. Gemini texto → descripción de escena ──────────────────
    const matchSummary = dayMatches
      .map((m: any) => `${m.home_team} ${m.home_goals}-${m.away_goals} ${m.away_team}`)
      .join(", ");

    const playerSummary = activePlayers.map((p, i) => {
      const predLine = (preds ?? [])
        .filter((pred: any) => pred.user_id === p.userId)
        .map((pred: any) => {
          const m = dayMatches.find((x: any) => x.id === pred.match_id);
          if (!m) return "";
          return `${(m as any).home_team} ${pred.home_goals}-${pred.away_goals} ${(m as any).away_team}`;
        })
        .filter(Boolean)
        .join("; ");
      const rank   = i + 1;
      const racha  = streakMap[p.userId] || "—";
      const foto   = p.avatar_url ? "tiene foto" : "sin foto";
      return `${rank}. ${p.name} [${foto}]: ${p.pts}pts (${p.exacts} exactos, ${p.zeros} ceros). Racha: ${racha}. Pronosticó: ${predLine || "nada"}`;
    }).join("\n");

    const textPrompt = `Eres el guionista de una viñeta cómica de una porra del Mundial 2026, estilo cómic español, humor negro y sarcástico tipo Twitter Fútbol.

RESULTADOS DEL DÍA:
${matchSummary}

JUGADORES (de mejor a peor del día):
${playerSummary}
(racha: ✓=exacto, ~=parcial, ✗=cero)

Escribe una descripción detallada de UNA SOLA viñeta cómica grupal con todos los jugadores:
- ${activePlayers[0]?.name} (1º) aparece triunfante, eufórico, en posición central o elevada
- ${activePlayers[activePlayers.length - 1]?.name} (último) aparece hundido, avergonzado, ridiculizado
- Los intermedios en posiciones acordes
- Bocadillos de diálogo cortos y sarcásticos (máx 6 palabras cada uno, en español)
- Fondo: estadio del Mundial 2026
- Los jugadores sin foto se representan como siluetas con su nombre en el bocadillo
- Que interactúen entre sí con burlas, celebraciones o lamentos

Sé muy específico sobre poses, expresiones y bocadillos exactos. Máximo 200 palabras. Solo descripción visual.`;

    const textRes = await fetch(
      `${GEMINI_BASE}/models/${TEXT_MODEL}:generateContent?key=${geminiKey}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: textPrompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 1.0 },
        }),
      }
    );
    if (!textRes.ok) {
      const errBody = await textRes.text();
      throw new Error(`Gemini ${TEXT_MODEL} ${textRes.status}: ${errBody.slice(0, 300)}`);
    }
    const textData = await textRes.json();
    const sceneDesc = textData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!sceneDesc) throw new Error("Gemini texto devolvió respuesta vacía.");
    console.log("[comic-gen] escena generada:", sceneDesc.slice(0, 100) + "…");

    // ── 5. Fotos de referencia (base64) ──────────────────────────
    type InlineData = { inlineData: { mimeType: string; data: string } };
    const photoParts: InlineData[] = [];
    const photoNames: string[] = [];

    for (const p of activePlayers) {
      if (!p.avatar_url) continue;
      try {
        const imgRes = await fetch(p.avatar_url);
        if (!imgRes.ok) {
          console.warn(`[comic-gen] foto de ${p.name} no accesible (${imgRes.status})`);
          continue;
        }
        const buf  = await imgRes.arrayBuffer();
        const b64  = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const mime = imgRes.headers.get("content-type") || "image/jpeg";
        photoParts.push({ inlineData: { mimeType: mime, data: b64 } });
        photoNames.push(p.name);
      } catch (e) {
        console.warn(`[comic-gen] no se pudo descargar foto de ${p.name}:`, e);
      }
    }

    console.log(`[comic-gen] fotos de referencia: ${photoNames.length}/${activePlayers.length} (${photoNames.join(", ") || "ninguna"})`);

    // ── 6. gemini-2.5-flash-image → viñeta ───────────────────────
    const withPhotos = photoNames.length > 0;
    const refNote = withPhotos
      ? `Usa las ${photoNames.length} foto(s) de referencia adjuntas para representar a: ${photoNames.join(", ")}. Para el resto, usa siluetas con el nombre visible.`
      : `Ningún jugador tiene foto; usa siluetas caricaturizadas con etiquetas de nombre.`;

    const imagePrompt = `European comic strip panel style: thick outlines, vibrant flat colors, exaggerated expressions, speech bubbles in Spanish.
One single square panel with all players in one scene.

${sceneDesc}

${refNote}

No extra panels. No watermarks. No text outside speech bubbles.`;

    const imageParts: Array<{ text: string } | InlineData> = [
      ...photoParts,          // fotos de referencia primero (si las hay)
      { text: imagePrompt },
    ];

    const imageRes = await fetch(
      `${GEMINI_BASE}/models/${IMAGE_MODEL}:generateContent?key=${geminiKey}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: imageParts }],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"],
            temperature: 1.0,
          },
        }),
      }
    );

    if (!imageRes.ok) {
      const errText = await imageRes.text();
      console.error(`[comic-gen] ${IMAGE_MODEL} error ${imageRes.status}:`, errText.slice(0, 400));
      return respond({
        ok:     false,
        error:  "image_model_unavailable",
        status: imageRes.status,
        hint:   `Modelo ${IMAGE_MODEL} no disponible o quota agotada. Verifica API key de Google AI Studio.`,
        detail: errText.slice(0, 300),
      }, 503);
    }

    const imageData = await imageRes.json();

    // La imagen puede venir en candidates[0].content.parts[].inlineData o en parts directamente
    const candidates = imageData?.candidates ?? [];
    let imgPart: any = null;
    for (const c of candidates) {
      imgPart = (c?.content?.parts ?? []).find(
        (part: any) => part?.inlineData?.mimeType?.startsWith("image/")
      );
      if (imgPart) break;
    }

    if (!imgPart?.inlineData?.data) {
      console.error("[comic-gen] No se encontró imagen en la respuesta:", JSON.stringify(imageData).slice(0, 500));
      return respond({ ok: false, error: "no_image_in_response" }, 500);
    }

    const imgB64  = imgPart.inlineData.data;
    const imgMime = imgPart.inlineData.mimeType || "image/png";
    const imgExt  = imgMime.includes("png") ? "png" : "jpg";

    // ── 7. Subir a Storage ────────────────────────────────────────
    const binary = Uint8Array.from(atob(imgB64), c => c.charCodeAt(0));
    const path   = `comics/${league_id}/${match_day}.${imgExt}`;

    const { error: uploadErr } = await supabase.storage
      .from("avatars")
      .upload(path, binary, { contentType: imgMime, upsert: true });

    if (uploadErr) throw new Error(`Storage upload: ${uploadErr.message}`);

    const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);
    const url = `${publicUrl}?t=${Date.now()}`;

    // ── 8. Guardar en daily_comics ────────────────────────────────
    await supabase.from("daily_comics").upsert(
      { league_id, match_day, image_url: url, created_at: new Date().toISOString() },
      { onConflict: "league_id,match_day" }
    );

    console.log(`[comic-gen] ✓ viñeta para ${league_id}/${match_day}: ${url}`);
    return respond({ ok: true, url, players: activePlayers.length, photos: photoNames.length });

  } catch (err: any) {
    console.error("[comic-gen] error fatal:", err);
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
