/**
 * comic-gen — Viñeta de grupo por jornada
 *
 * Flujo en dos pasos:
 *   1. Gemini texto (gemini-1.5-flash) → descripción detallada de la escena:
 *      quién triunfó, quién hizo el ridículo, interacciones cómicas,
 *      estilo Twitter Fútbol España.
 *   2. Gemini imagen (gemini-2.0-flash-exp, responseModalities IMAGE) →
 *      viñeta de cómic con bocadillos, pasando las fotos de referencia
 *      de los jugadores que las tengan subidas.
 *
 * Input (POST JSON): { league_id: string, match_day: string "YYYY-MM-DD" }
 * Output: { ok: true, url: string } | { ok: false, error: string }
 *
 * Secrets necesarios:
 *   GEMINI_API_KEY   — Google AI Studio (mismo para texto e imagen)
 *
 * NO usa Imagen 3 ni gemini-3-pro-image-preview.
 *
 * Modelo de imagen: gemini-2.0-flash-exp con responseModalities: ["IMAGE"]
 * → gratuito, acepta imágenes de entrada (fotos de referencia) y genera imagen.
 * Si el modelo no está disponible, devuelve { ok: false, error: "image_model_unavailable" }.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const IMAGE_MODEL = "gemini-2.0-flash-exp";
const TEXT_MODEL  = "gemini-1.5-flash";
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

    // ── 1. Datos del día: partidos + miembros + predicciones ──
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

    const matchIds    = dayMatches.map((m: any) => m.id);
    const membersList = (members ?? []).map((m: any) => ({
      userId:     m.user_id,
      name:       m.profiles?.display_name ?? m.user_id.slice(0, 8),
      avatar_url: m.profiles?.avatar_url ?? null,
    }));

    const { data: preds } = await supabase
      .from("predictions")
      .select("user_id, match_id, home_goals, away_goals")
      .eq("league_id", league_id)
      .in("match_id", matchIds);

    // ── 2. Calcular puntos por jugador ese día ────────────────
    type PlayerDay = {
      userId: string; name: string; avatar_url: string | null;
      pts: number; exacts: number; zeros: number; total: number;
    };
    const playerMap: Record<string, PlayerDay> = {};
    membersList.forEach(m => {
      playerMap[m.userId] = { ...m, pts: 0, exacts: 0, zeros: 0, total: dayMatches.length };
    });

    for (const p of (preds ?? [])) {
      const m = dayMatches.find((x: any) => x.id === p.match_id);
      if (!m || !playerMap[p.user_id]) continue;
      if (p.home_goals === m.home_goals && p.away_goals === m.away_goals) {
        playerMap[p.user_id].pts    += 3;
        playerMap[p.user_id].exacts += 1;
      } else if (p.home_goals === m.home_goals || p.away_goals === m.away_goals) {
        playerMap[p.user_id].pts += 1;
      } else {
        playerMap[p.user_id].zeros += 1;
      }
    }

    const players = Object.values(playerMap).sort((a, b) => b.pts - a.pts);

    // ── 3. Gemini texto → descripción de la escena ────────────
    const matchSummary = dayMatches.map((m: any) =>
      `${m.home_team} ${m.home_goals}-${m.away_goals} ${m.away_team}`
    ).join(", ");

    const playerSummary = players.map(p => {
      const predLine = (preds ?? [])
        .filter((pred: any) => pred.user_id === p.userId)
        .map((pred: any) => {
          const m = dayMatches.find((x: any) => x.id === pred.match_id);
          if (!m) return "";
          return `${m.home_team} ${pred.home_goals}-${pred.away_goals} ${m.away_team}`;
        })
        .filter(Boolean)
        .join("; ");
      return `${p.name}: ${p.pts} pts (${p.exacts} exactos, ${p.zeros} ceros). Pronosticó: ${predLine || "nada"}`;
    }).join("\n");

    const textPrompt = `Eres el guionista de una viñeta cómica de una porra del Mundial 2026, estilo cómic español, humor negro y sarcástico tipo Twitter Fútbol.

RESULTADOS DEL DÍA:
${matchSummary}

JUGADORES (de mejor a peor):
${playerSummary}

Escribe una descripción detallada de UNA SOLA viñeta cómica grupal con todos los jugadores juntos:
- El primero (${players[0]?.name}) aparece triunfante, eufórico, en posición central o elevada
- El último (${players[players.length - 1]?.name}) aparece hundido, avergonzado, ridiculizado
- Los demás en posiciones intermedias acordes a sus puntos
- Incluye bocadillos de diálogo con frases cortas y sarcásticas (en español, máx 6 palabras cada una)
- Fondo: estadio de fútbol con pancartas del Mundial 2026
- Estilo: viñeta de cómic europeo con líneas gruesas, colores vibrantes, expresiones exageradas
- Que los personajes interactúen entre sí (burlas, celebraciones, lamentos)

Sé muy específico: describe poses, expresiones faciales, bocadillos exactos, composición.
Máximo 200 palabras. Solo la descripción visual, sin título ni intro.`;

    const textRes = await fetch(
      `${GEMINI_BASE}/models/${TEXT_MODEL}:generateContent?key=${geminiKey}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          contents: [{ parts: [{ text: textPrompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 1.0 },
        }),
      }
    );
    if (!textRes.ok) throw new Error(`Gemini texto ${textRes.status}: ${await textRes.text()}`);
    const textData = await textRes.json();
    const sceneDesc = textData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!sceneDesc) throw new Error("Gemini texto devolvió respuesta vacía.");
    console.log("[comic-gen] escena:", sceneDesc.slice(0, 120) + "…");

    // ── 4. Recoger fotos de referencia (base64) ───────────────
    type PhotoPart = { inlineData: { mimeType: string; data: string } };
    const photoParts: PhotoPart[] = [];
    const photoNames: string[] = [];

    for (const p of players) {
      if (!p.avatar_url) continue;
      try {
        const imgRes = await fetch(p.avatar_url);
        if (!imgRes.ok) { console.warn(`[comic-gen] foto de ${p.name} no accesible (${imgRes.status})`); continue; }
        const buf  = await imgRes.arrayBuffer();
        const b64  = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const mime = imgRes.headers.get("content-type") || "image/jpeg";
        photoParts.push({ inlineData: { mimeType: mime, data: b64 } });
        photoNames.push(p.name);
      } catch (e) {
        console.warn(`[comic-gen] no se pudo descargar foto de ${p.name}:`, e);
      }
    }

    // ── 5. Gemini imagen → viñeta PNG ─────────────────────────
    const refNote = photoNames.length > 0
      ? `Usa las siguientes ${photoNames.length} fotos de referencia para representar a: ${photoNames.join(", ")}. Para los jugadores sin foto, usa siluetas con el nombre.`
      : "Ningún jugador tiene foto de referencia; usa siluetas caricaturizadas con nombres y motes.";

    const imagePrompt = `Comic strip panel in European comic style (clear outlines, vibrant colors, exaggerated expressions, speech bubbles in Spanish). One single panel, square format.

${sceneDesc}

Players: ${players.map(p => p.name).join(", ")}.
${refNote}

Important: no watermarks, no extra panels, one unified scene with all characters interacting.`;

    const imageParts: Array<{ text: string } | PhotoPart> = [
      ...photoParts,
      { text: imagePrompt },
    ];

    const imageRes = await fetch(
      `${GEMINI_BASE}/models/${IMAGE_MODEL}:generateContent?key=${geminiKey}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
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
      console.error("[comic-gen] Gemini imagen error:", imageRes.status, errText);
      // Errores esperados: modelo no disponible, quota, etc.
      return respond({
        ok:    false,
        error: "image_model_unavailable",
        hint:  `Gemini ${IMAGE_MODEL} no disponible con esta API key o excedida la quota. Status ${imageRes.status}.`,
        detail: errText.slice(0, 300),
      }, 503);
    }

    const imageData = await imageRes.json();
    const imagePart = imageData?.candidates?.[0]?.content?.parts?.find(
      (part: any) => part.inlineData?.mimeType?.startsWith("image/")
    );

    if (!imagePart?.inlineData?.data) {
      console.error("[comic-gen] Gemini imagen no devolvió imagen. Respuesta:", JSON.stringify(imageData).slice(0, 500));
      return respond({ ok: false, error: "no_image_in_response" }, 500);
    }

    const imgB64 = imagePart.inlineData.data;
    const imgMime = imagePart.inlineData.mimeType || "image/png";
    const imgExt  = imgMime.includes("png") ? "png" : "jpg";

    // ── 6. Subir a Storage ────────────────────────────────────
    const binary = Uint8Array.from(atob(imgB64), c => c.charCodeAt(0));
    const path   = `comics/${league_id}/${match_day}.${imgExt}`;

    const { error: uploadErr } = await supabase.storage
      .from("avatars")
      .upload(path, binary, { contentType: imgMime, upsert: true });

    if (uploadErr) throw new Error(`Storage upload: ${uploadErr.message}`);

    const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);
    const url = `${publicUrl}?t=${Date.now()}`;

    // ── 7. Guardar en daily_comics ────────────────────────────
    await supabase.from("daily_comics").upsert(
      { league_id, match_day, image_url: url, created_at: new Date().toISOString() },
      { onConflict: "league_id,match_day" }
    );

    console.log(`[comic-gen] viñeta generada: ${url}`);
    return respond({ ok: true, url, scene: sceneDesc.slice(0, 100) });

  } catch (err: any) {
    console.error("[comic-gen] error:", err);
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
