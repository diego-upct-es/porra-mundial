/**
 * comic-gen — Genera una caricatura futbolística del usuario
 *
 * Flujo:
 *   1. Recibe { user_id, badge, name, pts, exacts } del frontend
 *   2. Construye un prompt de imagen para Gemini Imagen 3
 *   3. Guarda el PNG en Storage (bucket "avatars", carpeta "comics/")
 *   4. Actualiza profiles.comic_url con la URL pública
 *   5. Devuelve { ok: true, url }
 *
 * Secrets necesarios:
 *   GEMINI_API_KEY  — Google AI Studio (debe tener acceso a Imagen 3)
 *
 * NOTA: Gemini Imagen 3 puede no estar disponible en todos los planes.
 * Si falla, la función devuelve { ok: false, error: "imagen_unavailable" }
 * y el frontend muestra un mensaje de aviso.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true }, 200);

  // Solo POST autenticado
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return respond({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    const { user_id, badge, name, pts, exacts } = await req.json();
    if (!user_id || !name) return respond({ ok: false, error: "missing_params" }, 400);

    const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (!geminiKey) throw new Error("Secret GEMINI_API_KEY no configurado.");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Construir prompt ───────────────────────────────────
    const badgeDesc = badge
      ? `Su mote es "${badge.label}" (${badge.title}).`
      : "Es un participante ordinario de la porra.";

    const prompt = [
      `Comic book style caricature of a football fan named "${name}".`,
      badgeDesc,
      `Stats: ${pts} points, ${exacts} exact scores.`,
      "Style: vibrant colors, exaggerated features, stadium background, football World Cup 2026 theme.",
      "Square format, no text overlays.",
    ].join(" ");

    // ── 2. Llamar a Gemini Imagen 3 ───────────────────────────
    const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiKey}`;
    const imagenRes = await fetch(imagenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: "1:1" },
      }),
    });

    if (!imagenRes.ok) {
      const errText = await imagenRes.text();
      console.error("[comic-gen] Imagen error:", imagenRes.status, errText);
      // Imagen puede no estar disponible en el plan gratuito
      return respond({ ok: false, error: "imagen_unavailable", detail: errText }, 503);
    }

    const imagenData = await imagenRes.json();
    const b64 = imagenData?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return respond({ ok: false, error: "no_image_returned" }, 500);

    // ── 3. Decodificar y subir a Storage ─────────────────────
    const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const path   = `comics/${user_id}.png`;

    const { error: uploadErr } = await supabase.storage
      .from("avatars")
      .upload(path, binary, {
        contentType: "image/png",
        upsert: true,
      });

    if (uploadErr) throw new Error(`Storage upload: ${uploadErr.message}`);

    // ── 4. Obtener URL pública ────────────────────────────────
    const { data: { publicUrl } } = supabase.storage
      .from("avatars")
      .getPublicUrl(path);

    // Añadir cache-buster para forzar recarga si ya existía
    const url = `${publicUrl}?t=${Date.now()}`;

    // ── 5. Guardar en perfil ──────────────────────────────────
    await supabase
      .from("profiles")
      .update({ comic_url: url })
      .eq("id", user_id);

    console.log(`[comic-gen] comic generado para ${name}: ${url}`);
    return respond({ ok: true, url });

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
