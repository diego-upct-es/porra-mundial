import { useState, useMemo, useEffect, createContext, useContext } from "react";
import AuthScreen from "./components/AuthScreen.jsx";
import { supabase } from "./lib/supabase.js";

/* ============================================================
   PORRA MUNDIAL 2026 — Frontend
   Fase 5: poll-results automático + override de admin.
   ============================================================ */

// ─── Contexto de usuario ──────────────────────────────────────
// Proporciona datos globales a todos los componentes sin prop-drilling.
const UserContext = createContext(null);
const useUser = () => useContext(UserContext);

/* Temas tipo "city poster" del Mundial 26 — uno por liga */
const THEMES = {
  guadalajara: { bg: "#6B2AB8", deep: "#3D156E", accent: "#F4E84B", accent2: "#EE4A6B", on: "#FFFFFF", label: "Guadalajara" },
  mexico:      { bg: "#2E9E4F", deep: "#12421F", accent: "#C7F24A", accent2: "#F0476B", on: "#FFFFFF", label: "Ciudad de México" },
  monterrey:   { bg: "#16164F", deep: "#0B0B2E", accent: "#27B9B0", accent2: "#EE4A6B", on: "#FFFFFF", label: "Monterrey" },
  electric:    { bg: "#2D4ED8", deep: "#15246F", accent: "#FF7A2F", accent2: "#FFE14D", on: "#FFFFFF", label: "Eléctrico" },
};
const THEME_KEYS = Object.keys(THEMES);

// ISO2 + NAME — solo para ChampionCard (equipos hardcodeados como candidatos)
const NAME = {
  MEX: "México", BRA: "Brasil", ARG: "Argentina", FRA: "Francia",
  ENG: "Inglaterra", GER: "Alemania", POR: "Portugal", ESP: "España",
  USA: "EE. UU.", MAR: "Marruecos", NED: "Países Bajos", URU: "Uruguay",
};
const ISO2 = {
  MEX: "mx", BRA: "br", ARG: "ar", FRA: "fr",
  ENG: "gb-eng", GER: "de", POR: "pt", ESP: "es",
  USA: "us", MAR: "ma", NED: "nl", URU: "uy",
};

// Estadísticas mock eliminadas: la Fase 6 carga player_stats desde Supabase.

/* ─── Helpers ───────────────────────────────────────────────── */

/**
 * Calcula el estado del partido a partir de sus datos reales de la DB.
 * - finished: is_final = true
 * - locked:   kickoff pasado pero aún no finalizado
 * - open:     kickoff futuro dentro de la ventana hoy + mañana
 * - soon:     kickoff futuro más allá de mañana
 */
function getMatchState(m) {
  if (m.is_final) return "finished";
  const now = new Date();
  const kickoff = new Date(m.kickoff);
  if (kickoff <= now) return "locked";
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 1);
  cutoff.setHours(23, 59, 59, 999);
  return kickoff <= cutoff ? "open" : "soon";
}

/** Formatea el kickoff UTC al locale del usuario. */
function formatKickoff(kickoff) {
  const d = new Date(kickoff);
  const day  = d.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}

/** Puntúa una predicción contra el resultado real del partido. */
function scorePrediction(pred, match) {
  if (!match || match.home_goals === null || match.away_goals === null) return null;
  if (pred.home_goals === match.home_goals && pred.away_goals === match.away_goals) return 3;
  if (pred.home_goals === match.home_goals || pred.away_goals === match.away_goals) return 1;
  return 0;
}

/** Suma de puntos de userId en las predicciones dadas, filtradas por fase. */
function totalPoints(predictions, matchById, userId, phase = "general") {
  return predictions.reduce((sum, p) => {
    if (p.user_id !== userId) return sum;
    const m = matchById[p.match_id];
    if (!m || !m.is_final) return sum;
    if (phase !== "general" && m.phase !== phase) return sum;
    return sum + (scorePrediction(p, m) || 0);
  }, 0);
}

/** Cuenta exactos (+3) de userId en las predicciones dadas. */
function countExacts(predictions, matchById, userId, phase = "general") {
  return predictions.reduce((n, p) => {
    if (p.user_id !== userId) return n;
    const m = matchById[p.match_id];
    if (!m || !m.is_final) return n;
    if (phase !== "general" && m.phase !== phase) return n;
    return n + (scorePrediction(p, m) === 3 ? 1 : 0);
  }, 0);
}

/**
 * Días en los que userId acertó TODOS los marcadores exactos (≥1 partido finalizado).
 * Devuelve { bonus: number, sweeps: number }.
 * Solo se aplica en vista "general" (no filtra por fase).
 */
function calcDailySweeps(predictions, matchById, userId) {
  // Agrupa partidos finalizados por día UTC (YYYY-MM-DD)
  const byDay = {};
  Object.values(matchById).forEach(m => {
    if (!m.is_final || m.home_goals === null) return;
    const day = m.kickoff.slice(0, 10);
    (byDay[day] = byDay[day] || []).push(m);
  });

  let sweeps = 0;
  for (const dayMatches of Object.values(byDay)) {
    const allExact = dayMatches.every(m => {
      const p = predictions.find(pp => pp.match_id === m.id && pp.user_id === userId);
      return p && p.home_goals === m.home_goals && p.away_goals === m.away_goals;
    });
    if (allExact) sweeps++;
  }
  return { sweeps, bonus: sweeps * 3 };
}

/**
 * Asigna un mote estilo Twitter Fútbol (humor negro) según rendimiento.
 * Devuelve { emoji, label, title } o null si no hay datos suficientes.
 */
function getUserBadge(predictions, matchById, userId) {
  const preds = predictions.filter(p => p.user_id === userId);
  const finished = preds.filter(p => {
    const m = matchById[p.match_id];
    return m && m.is_final;
  });
  if (finished.length < 3) return null; // sin datos suficientes

  const exacts   = finished.filter(p => scorePrediction(p, matchById[p.match_id]) === 3).length;
  const partials = finished.filter(p => scorePrediction(p, matchById[p.match_id]) === 1).length;
  const zeros    = finished.filter(p => scorePrediction(p, matchById[p.match_id]) === 0).length;
  const pctExact = exacts / finished.length;
  const pctZero  = zeros / finished.length;

  if (pctExact >= 0.5)  return { emoji: "🎯", label: "Oráculo",       title: "Acierta la mitad o más con marcador exacto. Inquietante." };
  if (pctExact >= 0.3)  return { emoji: "🧙", label: "Vidente",       title: "No sabe cómo lo hace. Él tampoco." };
  if (pctExact >= 0.15 && partials >= 3)
                        return { emoji: "📊", label: "Analista",       title: "Tiene los datos. Los datos no le tienen a él." };
  if (pctZero >= 0.6)   return { emoji: "💀", label: "El Gafe",        title: "Cuando predice, el balón huye." };
  if (pctZero >= 0.45)  return { emoji: "🪦", label: "Elogio Fúnebre", title: "Sus predicciones son un requiem en dos goles." };
  if (zeros >= 5 && exacts === 0)
                        return { emoji: "🤡", label: "El Regalito",    title: "Dona puntos sin querer. Generoso él." };
  if (exacts >= 2 && zeros > exacts * 2)
                        return { emoji: "🎲", label: "Ruleta Rusa",    title: "O clava el marcador o ni se acerca. Sin término medio." };
  if (partials > exacts + zeros)
                        return { emoji: "🤝", label: "Empate Moral",   title: "Siempre cerca pero nunca dentro. Filosofía de vida." };
  return { emoji: "👻", label: "Fantasma",       title: "Predice. Está entre nosotros. No puntúa." };
}

/** Genera un código de invitación a partir del nombre de la liga. */
function generateLeagueCode(name) {
  const base = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase().padEnd(4, "X");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return base + rand;
}

/* ============================================================
   App — componente raíz
   ============================================================ */
export default function App() {
  // session: undefined = cargando; null = sin sesión; object = sesión activa
  const [session,       setSession]       = useState(undefined);
  const [profile,       setProfile]       = useState(null);
  const [profiles,      setProfiles]      = useState({});   // userId → { name }
  const [leagues,       setLeagues]       = useState([]);
  const [leaguesLoading,setLeaguesLoading]= useState(false);

  // Partidos globales (mismos para todas las ligas)
  const [matches, setMatches] = useState([]);

  // Predicciones de TODOS los miembros para la liga activa (para marcadores pillados + histórico + clasificación)
  const [leaguePredictions, setLeaguePredictions] = useState([]);

  // Predicciones propias a través de todas las ligas (para el marcador de puntos en la tarjeta de liga)
  const [myPredictions, setMyPredictions] = useState([]);

  const [view,     setView]     = useState("home");
  const [leagueId, setLeagueId] = useState(null);
  const [tab,      setTab]      = useState("prediccion");
  const [modal,    setModal]    = useState(null); // 'create' | 'join'

  // null = sin comprobar | 'granted' | 'denied' | 'unsupported'
  const [pushGranted, setPushGranted] = useState(null);
  const [pushError,   setPushError]   = useState(null);

  /** Mapa id → match, recalculado solo cuando cambia matches. */
  const matchById = useMemo(
    () => Object.fromEntries(matches.map(m => [m.id, m])),
    [matches],
  );

  // ── Auth listener ────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) { loadProfile(session.user.id); loadMatches(); }
      else setSession(null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        loadProfile(session.user.id);
        loadMatches();
      } else {
        setProfile(null); setProfiles({}); setLeagues([]);
        setMatches([]); setLeaguePredictions([]); setMyPredictions([]);
        setView("home"); setLeagueId(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Realtime: predictions de la liga activa ──────────────────
  // Al entrar a una liga: carga inicial + suscripción Realtime.
  // Cuando cualquier miembro guarda una predicción, el resto ve
  // al instante el marcador como "pillado" sin recargar.
  // Limpieza automática al cambiar de liga o volver al home.
  useEffect(() => {
    if (view !== "league" || !leagueId) {
      setLeaguePredictions([]);
      return;
    }

    let cancelled = false;

    // Función de recarga reutilizada por la carga inicial y el handler RT
    function reload() {
      supabase.from("predictions").select("*").eq("league_id", leagueId)
        .then(({ data }) => { if (!cancelled && data) setLeaguePredictions(data); });
    }

    reload(); // carga inicial

    // Suscripción filtrada por league_id: solo llegan cambios de esta liga
    const channel = supabase
      .channel(`predictions-${leagueId}`)
      .on(
        "postgres_changes",
        {
          event:  "*",
          schema: "public",
          table:  "predictions",
          filter: `league_id=eq.${leagueId}`,
        },
        reload, // re-fetch completo al recibir cualquier INSERT/UPDATE/DELETE
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [view, leagueId]);

  // ── Realtime: matches (global) ───────────────────────────────
  // Cuando el cron actualiza resultados (home_goals, is_final…),
  // los tabs Clasificación y Resultados se recalculan solos.
  useEffect(() => {
    if (!session?.user?.id) return;

    const channel = supabase
      .channel("matches-global")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "matches" },
        () => {
          supabase.from("matches").select("*").order("kickoff")
            .then(({ data }) => { if (data) setMatches(data); });
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id]); // se recrea solo si cambia el usuario (login/logout)

  // ── Carga de partidos ────────────────────────────────────────
  async function loadMatches() {
    const { data } = await supabase.from("matches").select("*").order("kickoff");
    setMatches(data || []);
  }

  // ── Carga de perfil ──────────────────────────────────────────
  async function loadProfile(userId) {
    let data = null;
    for (let i = 0; i < 3 && !data; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 400));
      const { data: row } = await supabase
        .from("profiles").select("*").eq("id", userId).maybeSingle();
      data = row;
    }
    setProfile(data);
    if (data) {
      setProfiles(prev => ({ ...prev, [userId]: { name: data.display_name } }));
      loadLeagues(userId);
    }
  }

  // ── Carga de ligas + mis predicciones ───────────────────────
  async function loadLeagues(userId) {
    setLeaguesLoading(true);

    const [{ data, error }, { data: myPreds }] = await Promise.all([
      supabase.from("league_members").select(`
        champion_pick,
        leagues (
          id, name, code, theme, admin_id,
          league_members (
            user_id, champion_pick,
            profiles ( id, display_name )
          )
        )
      `).eq("user_id", userId),

      // Mis predicciones en todas las ligas — para calcular puntos en las tarjetas
      supabase.from("predictions")
        .select("league_id, match_id, user_id, home_goals, away_goals")
        .eq("user_id", userId),
    ]);

    if (!error && data) {
      const newProfiles = {};
      const newLeagues = data
        .map(membership => {
          const lg = membership.leagues;
          if (!lg) return null;
          const members = lg.league_members || [];
          members.forEach(m => {
            if (m.profiles) newProfiles[m.user_id] = { name: m.profiles.display_name };
          });
          const champion = {};
          members.forEach(m => { if (m.champion_pick) champion[m.user_id] = m.champion_pick; });
          return {
            id: lg.id, name: lg.name, code: lg.code,
            theme: lg.theme, admin_id: lg.admin_id,
            members: members.map(m => m.user_id),
            champion,
          };
        })
        .filter(Boolean);

      setLeagues(newLeagues);
      setProfiles(prev => ({ ...prev, ...newProfiles }));
    }

    setMyPredictions(myPreds || []);
    setLeaguesLoading(false);
  }

  // ── Acciones ─────────────────────────────────────────────────

  /**
   * Guarda la predicción del usuario en Supabase.
   * Devuelve 'ok' | 'taken' | 'error'.
   * 'taken' → el marcador exacto ya lo pilló otro miembro de la liga (error 23505).
   */
  async function upsertPrediction(matchId, h, a) {
    const uid = session?.user.id;
    const { error } = await supabase.from("predictions").upsert({
      league_id:  leagueId,
      match_id:   matchId,
      user_id:    uid,
      home_goals: h,
      away_goals: a,
    }, { onConflict: "league_id,match_id,user_id" });

    if (error) return error.code === "23505" ? "taken" : "error";

    // Refresca predicciones de la liga activa y las propias
    const [{ data: lgPreds }, { data: myPreds }] = await Promise.all([
      supabase.from("predictions").select("*").eq("league_id", leagueId),
      supabase.from("predictions")
        .select("league_id, match_id, user_id, home_goals, away_goals")
        .eq("user_id", uid),
    ]);
    setLeaguePredictions(lgPreds || []);
    setMyPredictions(myPreds || []);
    return "ok";
  }

  /**
   * Override de admin: corrige el resultado de un partido.
   * Llama a admin_update_match (SECURITY DEFINER) que valida
   * que el usuario sea admin de al menos una liga.
   * Devuelve 'ok' | 'not_admin' | 'match_not_found' | 'error'.
   */
  async function updateMatch(matchId, homeGoals, awayGoals, isFinal) {
    const { data, error } = await supabase.rpc("admin_update_match", {
      _match_id:   matchId,
      _home_goals: homeGoals,
      _away_goals: awayGoals,
      _is_final:   isFinal,
    });
    if (error) return "error";
    if (data?.error) return data.error;
    await loadMatches(); // refresca matches → clasificación y resultados se recalculan
    return "ok";
  }

  // ── Push notifications ───────────────────────────────────────

  // Comprueba si la suscripción está guardada en la BD.
  // "Avisos activados" solo si hay fila real, no solo con el permiso del navegador.
  useEffect(() => {
    if (!session?.user?.id) return;
    if (!('Notification' in window)) { setPushGranted('unsupported'); return; }
    if (Notification.permission === 'denied') { setPushGranted('denied'); return; }

    supabase
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        // Solo mostramos "Avisos activados" si hay fila real en la BD
        if (data) setPushGranted('granted');
        // Si no hay fila (aunque el permiso esté concedido) mostramos el botón
      });
  }, [session?.user?.id]);

  /** Convierte la clave VAPID base64url a Uint8Array para PushManager. */
  function urlBase64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushGranted('unsupported'); return;
    }
    setPushError(null);
    try {
      // 1. Service worker
      console.log('[push] Esperando serviceWorker.ready…');
      const reg = await navigator.serviceWorker.ready;
      console.log('[push] SW listo — scope:', reg.scope, '| estado:', reg.active?.state);

      // 2. Permiso de notificaciones
      const permission = await Notification.requestPermission();
      console.log('[push] Permiso:', permission);
      if (permission !== 'granted') { setPushGranted('denied'); return; }

      // 3. Suscripción PushManager
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      console.log('[push] VAPID public key (primeros 20):', vapidKey?.slice(0, 20));
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      console.log('[push] PushSubscription endpoint (primeros 50):', sub.endpoint.slice(0, 50));

      // 4. Guardar en push_subscriptions
      console.log('[push] Guardando suscripción en BD…');
      const { data, error } = await supabase.from('push_subscriptions').upsert(
        { user_id: session.user.id, subscription: sub.toJSON() },
        { onConflict: 'user_id' },
      );
      console.log('[push] Upsert → data:', data, '| error:', error);
      if (error) throw new Error(error.message);

      // Solo marcamos "activado" tras confirmar que la fila está en la BD
      setPushGranted('granted');
      console.log('[push] Suscripción guardada — OK');
    } catch (err) {
      console.error('[push] Error en subscribeToPush:', err);
      setPushError(err.message || 'Error al activar los avisos');
    }
  }

  // Borra la liga. Solo funciona si auth.uid() === admin_id (validado en DB).
  async function deleteLeague(lgId) {
    const { data, error } = await supabase.rpc('delete_league', { _league_id: lgId });
    if (error) return 'error';
    if (data?.error) return data.error;
    setLeagues(prev => prev.filter(l => l.id !== lgId));
    setLeagueId(null);
    setView('home');
    return 'ok';
  }

  // El campeón se guarda directamente en league_members.
  async function setChampion(teamCode) {
    const uid = session?.user.id;
    const { error } = await supabase.from("league_members")
      .update({ champion_pick: teamCode })
      .eq("league_id", leagueId)
      .eq("user_id", uid);
    if (error) { console.error("setChampion:", error); return; }
    setLeagues(prev =>
      prev.map(l => l.id !== leagueId ? l : { ...l, champion: { ...l.champion, [uid]: teamCode } })
    );
  }

  // Crea liga + añade al admin como miembro en una sola llamada RPC atómica.
  async function createLeague(name, themeKey) {
    const uid = session?.user.id;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateLeagueCode(name);
      const { data, error } = await supabase.rpc("create_league", { _name: name, _code: code, _theme: themeKey });
      if (error) return "Error al crear la liga. Inténtalo de nuevo.";
      if (data?.error === "code_taken") continue;
      if (data?.error) return "Error al crear la liga. Inténtalo de nuevo.";
      await loadLeagues(uid);
      setModal(null); setLeagueId(data.league_id); setView("league"); setTab("prediccion");
      return null;
    }
    return "No se pudo generar un código único. Inténtalo de nuevo.";
  }

  // Localiza la liga por código e inserta la membresía (RPC security definer).
  async function joinLeague(code) {
    const uid = session?.user.id;
    const { data, error } = await supabase.rpc("join_league_by_code", { _code: code });
    if (error) return "error";
    if (data?.error === "not_found")      return "not_found";
    if (data?.error === "already_member") return "already_member";
    if (data?.error) return "error";
    await loadLeagues(uid);
    setModal(null); setLeagueId(data.league_id); setView("league"); setTab("prediccion");
    return "ok";
  }

  // ── Render ───────────────────────────────────────────────────
  const league = leagues.find(l => l.id === leagueId) || null;
  const theme  = league ? (THEMES[league.theme] || THEMES.electric) : THEMES.electric;
  const userId = session?.user.id;

  if (session === undefined) return <LoadingScreen />;
  if (!session || !profile)  return <AuthScreen />;

  return (
    <UserContext.Provider value={{
      userId, profile, profiles,
      matches, matchById,
      leaguePredictions, myPredictions,
      refreshMatches: loadMatches,   // para el botón ↺ en ResultsTab / StandingsTab
    }}>
      <div className="pm-root" style={themeVars(theme)}>
        <style>{CSS}</style>
        <div className="pm-phone">
          {view === "home" && (
            <LeaguesHome
              leagues={leagues}
              loading={leaguesLoading}
              onOpen={id => { setLeagueId(id); setView("league"); setTab("prediccion"); }}
              onCreate={() => setModal("create")}
              onJoin={() => setModal("join")}
              onSignOut={() => supabase.auth.signOut()}
              pushGranted={pushGranted}
              pushError={pushError}
              onSubscribePush={subscribeToPush}
            />
          )}
          {view === "league" && league && (
            <LeagueView
              league={league}
              theme={theme}
              tab={tab}
              setTab={setTab}
              onBack={() => setView("home")}
              upsertPrediction={upsertPrediction}
              setChampion={setChampion}
              updateMatch={updateMatch}
              deleteLeague={deleteLeague}
            />
          )}
        </div>

        {modal === "create" && <CreateModal onClose={() => setModal(null)} onCreate={createLeague} />}
        {modal === "join"   && <JoinModal   onClose={() => setModal(null)} onJoin={joinLeague} />}
      </div>
    </UserContext.Provider>
  );
}

/* ── Pantalla de carga ───────────────────────────────────────── */
function LoadingScreen() {
  return (
    <div style={{ fontFamily: "'Inter',system-ui,sans-serif", background: "#0c0b22", minHeight: "100vh", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 430, minHeight: "100vh", background: "#15246F", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontFamily: "'Fredoka',sans-serif", fontSize: 72, fontWeight: 700, color: "#FF7A2F", opacity: 0.25 }}>26</div>
      </div>
    </div>
  );
}

/* ─── Home: Mis ligas ─────────────────────────────────────── */
function LeaguesHome({ leagues, loading, onOpen, onCreate, onJoin, onSignOut, pushGranted, pushError, onSubscribePush }) {
  const { userId, profile, myPredictions, matchById } = useUser();
  return (
    <div className="pm-screen">
      <header className="pm-hero">
        <div className="pm-hero-mark">26</div>
        <div style={{ flex: 1 }}>
          <div className="pm-eyebrow">Porra Mundial</div>
          <h1 className="pm-h1">Mis ligas</h1>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 12, opacity: .75, marginBottom: 6, fontWeight: 600 }}>
            {profile?.display_name}
          </div>
          <button
            className="pm-btn pm-btn-ghost"
            style={{ padding: "6px 12px", fontSize: 12, borderRadius: 10 }}
            onClick={onSignOut}
          >
            Salir
          </button>
        </div>
      </header>

      <div className="pm-stack">
        {loading && (
          <div className="pm-note" style={{ textAlign: "center", padding: "28px 0" }}>Cargando ligas…</div>
        )}
        {!loading && leagues.length === 0 && (
          <div className="pm-note" style={{ textAlign: "center", padding: "28px 0" }}>
            Aún no estás en ninguna liga.<br />Crea una o únete con un código de invitación.
          </div>
        )}
        {leagues.map(l => {
          const t = THEMES[l.theme] || THEMES.electric;
          const myLeaguePreds = myPredictions.filter(p => p.league_id === l.id);
          const pts = totalPoints(myLeaguePreds, matchById, userId);
          return (
            <button key={l.id} className="pm-leaguecard" style={posterVars(t)} onClick={() => onOpen(l.id)}>
              <div className="pm-poster-rays" />
              <div className="pm-leaguecard-top">
                <span className="pm-chip">{l.members.length} jugadores</span>
                <span className="pm-chip pm-chip-pts">{pts} pts</span>
              </div>
              <div className="pm-leaguecard-name">{l.name}</div>
              <div className="pm-leaguecard-foot">
                <span className="pm-code">#{l.code}</span>
                <span className="pm-go">Entrar →</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="pm-actions">
        <button className="pm-btn pm-btn-primary" onClick={onCreate}>Crear liga</button>
        <button className="pm-btn pm-btn-ghost"   onClick={onJoin}>Unirme con código</button>

        {/* Botón de avisos push — oculto si ya está concedido o no soportado */}
        {pushGranted !== 'unsupported' && pushGranted !== 'granted' && (
          <button
            className="pm-btn pm-push-btn"
            onClick={onSubscribePush}
            disabled={pushGranted === 'denied'}
            title={pushGranted === 'denied' ? 'Desbloquea las notificaciones en ajustes del navegador' : ''}
          >
            {pushGranted === 'denied'
              ? 'Notificaciones bloqueadas en ajustes'
              : 'Activar avisos de las 9:00'}
          </button>
        )}
        {pushGranted === 'granted' && (
          <div className="pm-push-ok">Avisos activados</div>
        )}
        {pushError && (
          <div className="pm-push-err">{pushError}</div>
        )}
      </div>
    </div>
  );
}

/* ─── Vista de liga ───────────────────────────────────────── */
function LeagueView({ league, theme, tab, setTab, onBack, upsertPrediction, setChampion, updateMatch, deleteLeague }) {
  const { userId, myPredictions, matchById } = useUser();
  const myLeaguePreds = myPredictions.filter(p => p.league_id === league.id);
  const myPts = totalPoints(myLeaguePreds, matchById, userId);
  const isAdmin = userId === league.admin_id;
  const [adminOpen, setAdminOpen] = useState(false);

  return (
    <div className="pm-screen pm-screen-league">
      <header className="pm-lg-header">
        <button className="pm-back" onClick={onBack} aria-label="Volver">←</button>
        <div className="pm-lg-title">
          <div className="pm-lg-name">{league.name}</div>
          <div className="pm-lg-sub">#{league.code}</div>
        </div>
        <div className="pm-lg-pts"><span>{myPts}</span><small>pts</small></div>
        {isAdmin && (
          <button
            className="pm-admin-btn"
            onClick={() => setAdminOpen(true)}
            title="Override de admin"
            aria-label="Panel de administrador"
          >
            ⚙
          </button>
        )}
      </header>

      <div className="pm-tabbody">
        {tab === "prediccion"    && <PredictionTab  league={league} upsertPrediction={upsertPrediction} setChampion={setChampion} />}
        {tab === "clasificacion" && <StandingsTab   league={league} />}
        {tab === "resultados"    && <ResultsTab />}
        {tab === "historico"     && <HistoryTab />}
      </div>

      <nav className="pm-nav">
        {[
          ["prediccion",    "Predecir",   "◎"],
          ["clasificacion", "Clasif.",    "≣"],
          ["resultados",    "Resultados", "⚽"],
          ["historico",     "Histórico",  "↺"],
        ].map(([key, label, icon]) => (
          <button key={key} className={"pm-navbtn" + (tab === key ? " is-active" : "")} onClick={() => setTab(key)}>
            <span className="pm-navicon">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {adminOpen && (
        <AdminModal
          onClose={() => setAdminOpen(false)}
          onUpdate={updateMatch}
          onDelete={() => deleteLeague(league.id)}
          leagueName={league.name}
        />
      )}
    </div>
  );
}

/* ─── Predicción ─────────────────────────────────────────── */
function PredictionTab({ league, upsertPrediction, setChampion }) {
  const { matches } = useUser();
  const open = matches.filter(m => getMatchState(m) === "open");
  const soon = matches.filter(m => getMatchState(m) === "soon");

  return (
    <div className="pm-pad">
      <ChampionCard league={league} setChampion={setChampion} />
      <SectionTitle k="Hoy y mañana" v="Abiertos a predicción" />
      {open.length === 0 && (
        <div className="pm-note">No hay partidos abiertos en este momento.</div>
      )}
      {open.map(m => (
        <Scoreboard key={m.id} match={m} upsertPrediction={upsertPrediction} />
      ))}
      <SectionTitle k="Próximamente" v="Se abrirán el día anterior" />
      {soon.slice(0, 8).map(m => (
        <div key={m.id} className="pm-soon">
          <div className="pm-soon-teams">
            <TeamLogo src={m.home_logo} name={m.home_team} size={15} />{" "}
            {m.home_team} <span>vs</span> {m.away_team}{" "}
            <TeamLogo src={m.away_logo} name={m.away_team} size={15} />
          </div>
          <div className="pm-soon-when">{formatKickoff(m.kickoff)}</div>
        </div>
      ))}
    </div>
  );
}

function ChampionCard({ league, setChampion }) {
  const { userId, matches } = useUser();
  const mine = league.champion[userId];
  const [search, setSearch] = useState('');

  // Lista de equipos únicos extraída de los partidos reales, ordenada alfabéticamente
  const teams = useMemo(() => {
    const map = {};
    matches.forEach(m => {
      if (m.home_team) map[m.home_team] = m.home_logo;
      if (m.away_team) map[m.away_team] = m.away_logo;
    });
    return Object.entries(map)
      .map(([name, logo]) => ({ name, logo }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [matches]);

  const myTeam = teams.find(t => t.name === mine);
  const q = search.trim().toLowerCase();
  const filtered = q ? teams.filter(t => t.name.toLowerCase().includes(q)) : teams;

  return (
    <div className="pm-champ">
      <div className="pm-champ-head">
        <span className="pm-trophy">🏆</span> Campeón del Mundial <em>+5 pts</em>
      </div>
      {mine ? (
        <div className="pm-champ-current">
          <TeamLogo src={myTeam?.logo} name={mine} size={22} />
          <span className="pm-champ-current-name">{mine}</span>
          <button className="pm-champ-change" onClick={() => setChampion(null)}>cambiar</button>
        </div>
      ) : (
        <>
          <input
            className="pm-input pm-champ-search"
            placeholder="Buscar selección…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="pm-champ-scroll">
            {filtered.length === 0 && (
              <div className="pm-note" style={{ padding: '8px 0' }}>Sin resultados.</div>
            )}
            {filtered.map(t => (
              <button key={t.name} className="pm-champ-opt" onClick={() => setChampion(t.name)}>
                <TeamLogo src={t.logo} name={t.name} size={16} />{t.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Scoreboard — tarjeta de predicción de un partido ────── */
function Scoreboard({ match, upsertPrediction }) {
  const { userId, profiles, leaguePredictions } = useUser();

  // Predicción existente del usuario para este partido
  const existing = leaguePredictions.find(
    p => p.match_id === match.id && p.user_id === userId,
  );

  const [h, setH]       = useState(0);
  const [a, setA]       = useState(0);
  const [inited, setInited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warn,   setWarn]   = useState(null);
  const [flash,  setFlash]  = useState(false);

  // Inicializa h/a con la predicción guardada la primera vez que llega del servidor
  useEffect(() => {
    if (!inited && existing) {
      setH(existing.home_goals);
      setA(existing.away_goals);
      setInited(true);
    }
  }, [inited, existing]);

  // Marcadores ya pillados por otros miembros en este partido/liga
  const takenByOthers = useMemo(() => {
    const map = {};
    leaguePredictions.forEach(p => {
      if (p.match_id === match.id && p.user_id !== userId) {
        map[`${p.home_goals}-${p.away_goals}`] = profiles[p.user_id]?.name || "Alguien";
      }
    });
    return map;
  }, [leaguePredictions, match.id, userId, profiles]);

  const key       = `${h}-${a}`;
  const blockedBy = takenByOthers[key];
  // saved: el valor actual coincide exactamente con lo guardado en DB
  const saved     = !!(existing && existing.home_goals === h && existing.away_goals === a);
  const takenList = Object.keys(takenByOthers);

  async function commit() {
    if (blockedBy) {
      setWarn(`Ese ${h}–${a} ya lo pilló ${blockedBy}. Elige otro.`);
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
      return;
    }
    setWarn(null);
    setSaving(true);
    const result = await upsertPrediction(match.id, h, a);
    setSaving(false);
    if (result === "taken") {
      setWarn("Ese marcador ya está pillado. Elige otro.");
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    }
    // Si result === 'ok', leaguePredictions se refresca en el contexto
    // y `existing` se actualiza → `saved` pasa a true automáticamente.
  }

  const groupStr = match.phase === "grupos" ? `Grupo ${match.grp}` : (match.grp || "");

  return (
    <div className="pm-board">
      <div className="pm-board-meta">{formatKickoff(match.kickoff)} · {groupStr}</div>
      <div className="pm-board-grid">
        <Side label="HOME" name={match.home_team} logo={match.home_logo} val={h}
              setVal={n => { setH(n); setWarn(null); }} />
        <div className="pm-board-mid"><div className="pm-board-vs">VS</div></div>
        <Side label="AWAY" name={match.away_team} logo={match.away_logo} val={a}
              setVal={n => { setA(n); setWarn(null); }} />
      </div>

      {takenList.length > 0 && (
        <div className="pm-taken">
          <span>Pillados:</span>
          {takenList.map(k => (
            <span key={k} className="pm-taken-chip">{k.replace("-", "–")}</span>
          ))}
        </div>
      )}

      {warn && (
        <div className={"pm-warn" + (flash ? " is-flash" : "")}>{warn}</div>
      )}

      <button
        className={"pm-final" + (saved ? " is-saved" : "") + (blockedBy || saving ? " is-disabled" : "")}
        onClick={commit}
        disabled={saving}
      >
        {saving ? "Guardando…" : saved ? `✓ Guardado: ${h}–${a}` : "Guardar predicción"}
      </button>
    </div>
  );
}

function Side({ label, name, logo, val, setVal }) {
  return (
    <div className="pm-side">
      <div className="pm-side-label">{label}</div>
      <div className="pm-side-flag"><TeamLogo src={logo} name={name} size={30} /></div>
      <div className="pm-side-team">{name}</div>
      <button className="pm-chev" onClick={() => setVal(val + 1)} aria-label="Más goles">▲</button>
      <div className="pm-led">{val}</div>
      <button className="pm-chev" onClick={() => setVal(Math.max(0, val - 1))} aria-label="Menos goles">▼</button>
    </div>
  );
}

/* ─── Clasificación ──────────────────────────────────────── */
function StandingsTab({ league }) {
  const { userId, profiles, leaguePredictions, matchById, refreshMatches } = useUser();
  const [phase,      setPhase]      = useState("general");
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo(() => {
    return league.members
      .map(u => {
        const { sweeps, bonus } = calcDailySweeps(leaguePredictions, matchById, u);
        const base  = totalPoints(leaguePredictions, matchById, u, phase);
        const badge = getUserBadge(leaguePredictions, matchById, u);
        return {
          u,
          name:   profiles[u]?.name || u.slice(0, 8),
          pts:    base + (phase === "general" ? bonus : 0),
          base,
          exacts: countExacts(leaguePredictions, matchById, u, phase),
          sweeps,
          badge,
        };
      })
      .sort((x, y) => y.pts - x.pts || y.exacts - x.exacts);
  }, [league.members, leaguePredictions, matchById, phase, profiles]);

  async function handleRefresh() {
    setRefreshing(true);
    await refreshMatches();
    setRefreshing(false);
  }

  return (
    <div className="pm-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <div className="pm-seg" style={{ flex: 1, marginBottom: 0 }}>
          {[["general", "General"], ["grupos", "Grupos"], ["eliminatorias", "Eliminatorias"]].map(([k, l]) => (
            <button key={k} className={"pm-seg-btn" + (phase === k ? " is-on" : "")} onClick={() => setPhase(k)}>{l}</button>
          ))}
        </div>
        <button className="pm-refresh-btn" onClick={handleRefresh} disabled={refreshing} title="Refrescar clasificación">
          {refreshing ? "…" : "↺"}
        </button>
      </div>
      <div className="pm-table">
        {rows.map((r, i) => (
          <div key={r.u} className={"pm-row" + (r.u === userId ? " is-me" : "")}>
            <div className="pm-rank">{i + 1}</div>
            <div className="pm-rowname">
              {r.name}{r.u === userId && <span className="pm-tu">tú</span>}
              {r.sweeps > 0 && phase === "general" && (
                <span className="pm-sweep-badge" title={`${r.sweeps} pleno${r.sweeps > 1 ? "s" : ""} del día (+${r.sweeps * 3} pts)`}>
                  🔥{r.sweeps}
                </span>
              )}
              {r.badge && (
                <span className="pm-badge" title={r.badge.title}>
                  {r.badge.emoji} {r.badge.label}
                </span>
              )}
            </div>
            <div className="pm-rowexact">{r.exacts}× exacto</div>
            <div className="pm-rowpts">{r.pts}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Resultados ─────────────────────────────────────────── */
function ResultsTab() {
  const { matches, refreshMatches } = useUser();
  const [refreshing, setRefreshing] = useState(false);
  const [scorers,    setScorers]    = useState([]);

  // Carga goleadores desde player_stats al montar el componente
  useEffect(() => {
    supabase
      .from("player_stats")
      .select("ext_player_id, player_name, team, team_logo, goals")
      .order("goals", { ascending: false })
      .limit(20)
      .then(({ data }) => setScorers(data || []));
  }, []);

  const played = matches
    .filter(m => m.is_final)
    .sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));

  async function handleRefresh() {
    setRefreshing(true);
    const [, { data }] = await Promise.all([
      refreshMatches(),
      supabase
        .from("player_stats")
        .select("ext_player_id, player_name, team, team_logo, goals")
        .order("goals", { ascending: false })
        .limit(20),
    ]);
    if (data) setScorers(data);
    setRefreshing(false);
  }

  return (
    <div className="pm-pad">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "22px 2px 12px" }}>
        <div><span className="pm-sec-k">Resultados</span><br /><span className="pm-sec-v">Partidos jugados</span></div>
        <button className="pm-refresh-btn" onClick={handleRefresh} disabled={refreshing} title="Refrescar">
          {refreshing ? "…" : "↺"}
        </button>
      </div>
      {played.length === 0 && (
        <div className="pm-note">Aún no hay partidos finalizados.</div>
      )}
      {played.map(m => (
        <div key={m.id} className="pm-result">
          <div className="pm-result-side">
            <TeamLogo src={m.home_logo} name={m.home_team} size={16} />{" "}{m.home_team}
          </div>
          <div className="pm-result-score">{m.home_goals}<span>–</span>{m.away_goals}</div>
          <div className="pm-result-side pm-result-side-r">
            {m.away_team}{" "}<TeamLogo src={m.away_logo} name={m.away_team} size={16} />
          </div>
        </div>
      ))}

      <SectionTitle k="Pichichi" v="Máximos goleadores" />
      {scorers.length === 0
        ? <div className="pm-note">Aún no hay goleadores registrados.</div>
        : <ScorersList rows={scorers} />
      }
    </div>
  );
}

/** Lista de goleadores con escudo del equipo desde player_stats. */
function ScorersList({ rows }) {
  return (
    <div className="pm-stats">
      {rows.map((r, i) => (
        <div key={r.ext_player_id ?? r.player_name} className="pm-stat">
          <div className="pm-stat-rank">{i + 1}</div>
          <div className="pm-stat-name">
            <TeamLogo src={r.team_logo} name={r.team} size={16} />
            {r.player_name}
          </div>
          <div className="pm-stat-n">{r.goals} <small>goles</small></div>
        </div>
      ))}
    </div>
  );
}

/* ─── Histórico ──────────────────────────────────────────── */
function HistoryTab() {
  const { userId, profiles, matchById, leaguePredictions } = useUser();

  // Partidos iniciados (locked o finished), más recientes primero
  const revealable = Object.values(matchById)
    .filter(m => { const s = getMatchState(m); return s === "finished" || s === "locked"; })
    .sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));

  return (
    <div className="pm-pad">
      <SectionTitle k="Histórico" v="Quién predijo qué" />
      <div className="pm-note">Las predicciones se revelan al pitido inicial de cada partido.</div>
      {revealable.length === 0 && (
        <div className="pm-note">Aún no ha comenzado ningún partido.</div>
      )}
      {revealable.map(m => {
        const preds = leaguePredictions
          .filter(p => p.match_id === m.id)
          .map(p => ({
            ...p,
            displayName: profiles[p.user_id]?.name || p.user_id.slice(0, 8),
            pts: scorePrediction(p, m),
          }))
          .sort((x, y) => (y.pts ?? -1) - (x.pts ?? -1));

        if (preds.length === 0) return null;

        return (
          <div key={m.id} className="pm-hist">
            <div className="pm-hist-head">
              <span>
                {m.home_team}{" "}
                {m.is_final ? `${m.home_goals}–${m.away_goals}` : "(en juego)"}{" "}
                {m.away_team}
              </span>
            </div>
            {preds.map(p => (
              <div key={p.user_id} className="pm-hist-row">
                <span className="pm-hist-name">
                  {p.displayName}{p.user_id === userId && <span className="pm-tu">tú</span>}
                </span>
                <span className="pm-hist-pred">{p.home_goals}–{p.away_goals}</span>
                {m.is_final && p.pts !== null && (
                  <span className={"pm-hist-pts pm-pts-" + p.pts}>+{p.pts}</span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Modales ────────────────────────────────────────────── */
function CreateModal({ onClose, onCreate }) {
  const [name,     setName]     = useState("");
  const [themeKey, setThemeKey] = useState("guadalajara");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  async function handleCreate() {
    setLoading(true);
    setError(null);
    const err = await onCreate(name.trim(), themeKey);
    if (err) { setError(err); setLoading(false); }
  }

  return (
    <Modal title="Crear liga" onClose={onClose}>
      <label className="pm-field-label">Nombre de la liga</label>
      <input
        className="pm-input"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Los del finde"
        maxLength={28}
        autoFocus
      />
      <label className="pm-field-label">Estilo</label>
      <div className="pm-theme-row">
        {THEME_KEYS.map(k => (
          <button
            key={k}
            className={"pm-theme-dot" + (themeKey === k ? " is-on" : "")}
            style={{ background: THEMES[k].bg }}
            onClick={() => setThemeKey(k)}
            aria-label={THEMES[k].label}
          />
        ))}
      </div>
      {error && <div className="pm-warn">{error}</div>}
      <button
        className="pm-btn pm-btn-primary pm-btn-full"
        disabled={!name.trim() || loading}
        onClick={handleCreate}
      >
        {loading ? "Creando…" : "Crear y entrar"}
      </button>
    </Modal>
  );
}

function JoinModal({ onClose, onJoin }) {
  const [code,    setCode]    = useState("");
  const [err,     setErr]     = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleJoin() {
    setLoading(true);
    setErr(null);
    const result = await onJoin(code);
    if      (result === "not_found")     setErr("No existe ninguna liga con ese código.");
    else if (result === "already_member") setErr("Ya eres miembro de esa liga.");
    else if (result !== "ok")             setErr("Error al unirte. Inténtalo de nuevo.");
    setLoading(false);
  }

  return (
    <Modal title="Unirme a una liga" onClose={onClose}>
      <label className="pm-field-label">Código de invitación</label>
      <input
        className="pm-input"
        value={code}
        onChange={e => { setCode(e.target.value); setErr(null); }}
        placeholder="FINDE7KM2"
        autoFocus
      />
      {err && <div className="pm-warn">{err}</div>}
      <button
        className="pm-btn pm-btn-primary pm-btn-full"
        disabled={!code.trim() || loading}
        onClick={handleJoin}
      >
        {loading ? "Buscando…" : "Unirme"}
      </button>
    </Modal>
  );
}

/* ─── Modal de override de admin ─────────────────────────── */
function AdminModal({ onClose, onUpdate, onDelete, leagueName }) {
  const { matches } = useUser();

  // Partidos ordenados: primero los iniciados (locked/finished), después los próximos
  const stateOrder = { finished: 0, locked: 1, open: 2, soon: 3 };
  const sorted = [...matches].sort((a, b) => {
    const diff = (stateOrder[getMatchState(a)] ?? 4) - (stateOrder[getMatchState(b)] ?? 4);
    if (diff !== 0) return diff;
    return new Date(a.kickoff) - new Date(b.kickoff);
  });

  const [matchId,   setMatchId]   = useState(sorted[0]?.id || "");
  const [homeGoals, setHomeGoals] = useState(0);
  const [awayGoals, setAwayGoals] = useState(0);
  const [isFinal,   setIsFinal]   = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [feedback,  setFeedback]  = useState(null); // { ok: bool, msg: string }
  const [delStep,   setDelStep]   = useState(0);    // 0 = oculto, 1 = confirmar, 2 = borrando

  const selected = matches.find(m => m.id === matchId);

  // Al cambiar de partido, rellena los valores actuales de la DB
  useEffect(() => {
    if (!selected) return;
    setHomeGoals(selected.home_goals ?? 0);
    setAwayGoals(selected.away_goals ?? 0);
    setIsFinal(selected.is_final ?? false);
    setFeedback(null);
  }, [matchId]);

  async function handleUpdate() {
    if (!matchId) return;
    setSaving(true);
    setFeedback(null);
    const result = await onUpdate(matchId, homeGoals, awayGoals, isFinal);
    setSaving(false);
    if (result === "ok") {
      setFeedback({ ok: true, msg: "✓ Resultado actualizado. Clasificación recalculada." });
    } else if (result === "not_admin") {
      setFeedback({ ok: false, msg: "Sin permisos de administrador." });
    } else if (result === "match_not_found") {
      setFeedback({ ok: false, msg: "Partido no encontrado en la base de datos." });
    } else {
      setFeedback({ ok: false, msg: "Error al actualizar. Inténtalo de nuevo." });
    }
  }

  return (
    <Modal title="Override admin" onClose={onClose}>
      <div className="pm-note" style={{ margin: "0 0 12px" }}>
        Solo para emergencias: corrección manual de resultado cuando la API falla.
      </div>

      <label className="pm-field-label">Partido</label>
      <select
        className="pm-input"
        value={matchId}
        onChange={e => setMatchId(e.target.value)}
        style={{ appearance: "auto", WebkitAppearance: "auto" }}
      >
        {sorted.map(m => (
          <option key={m.id} value={m.id}>
            {formatKickoff(m.kickoff)} — {m.home_team} vs {m.away_team}
            {m.is_final ? ` (${m.home_goals}–${m.away_goals} ✓)` : ""}
          </option>
        ))}
      </select>

      {selected && (
        <>
          <div style={{ display: "flex", gap: 12, marginTop: 14, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label className="pm-field-label">{selected.home_team}</label>
              <input
                className="pm-input"
                type="number"
                min={0}
                value={homeGoals}
                onChange={e => setHomeGoals(Number(e.target.value))}
              />
            </div>
            <div style={{ paddingBottom: 14, opacity: .4, fontWeight: 700, fontSize: 20, lineHeight: "47px" }}>–</div>
            <div style={{ flex: 1 }}>
              <label className="pm-field-label">{selected.away_team}</label>
              <input
                className="pm-input"
                type="number"
                min={0}
                value={awayGoals}
                onChange={e => setAwayGoals(Number(e.target.value))}
              />
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={isFinal}
              onChange={e => setIsFinal(e.target.checked)}
              style={{ width: 18, height: 18, accentColor: "var(--accent)" }}
            />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Marcar como partido finalizado (is_final)</span>
          </label>
        </>
      )}

      {feedback && (
        <div className="pm-warn" style={feedback.ok ? { background: "rgba(31,158,87,.2)", borderColor: "#1f9e57", color: "#a8ffd4" } : {}}>
          {feedback.msg}
        </div>
      )}

      <button
        className="pm-btn pm-btn-primary pm-btn-full"
        disabled={!matchId || saving}
        onClick={handleUpdate}
      >
        {saving ? "Guardando…" : "Actualizar resultado"}
      </button>

      {/* ── Zona peligrosa: borrar liga ── */}
      <div className="pm-danger-zone">
        <div className="pm-danger-title">Zona peligrosa</div>
        {delStep === 0 && (
          <button className="pm-btn pm-btn-danger" onClick={() => setDelStep(1)}>
            Borrar liga…
          </button>
        )}
        {delStep === 1 && (
          <div>
            <div className="pm-danger-warn">
              Esto borra <strong>{leagueName}</strong>, todos sus miembros y todas sus predicciones. Sin vuelta atrás.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="pm-btn pm-btn-ghost" style={{ flex: 1 }} onClick={() => setDelStep(0)}>
                Cancelar
              </button>
              <button
                className="pm-btn pm-btn-danger"
                style={{ flex: 1 }}
                onClick={async () => {
                  setDelStep(2);
                  const r = await onDelete();
                  if (r !== 'ok') { setDelStep(1); setFeedback({ ok: false, msg: 'Error al borrar la liga.' }); }
                  // Si ok: App navega a home automáticamente, el modal desaparece
                }}
              >
                Sí, borrar para siempre
              </button>
            </div>
          </div>
        )}
        {delStep === 2 && <div className="pm-note" style={{ textAlign: 'center' }}>Borrando…</div>}
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="pm-overlay" onClick={onClose}>
      <div className="pm-modal" onClick={e => e.stopPropagation()}>
        <div className="pm-modal-head">
          <h3>{title}</h3>
          <button className="pm-x" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SectionTitle({ k, v }) {
  return <div className="pm-sec"><span className="pm-sec-k">{k}</span><span className="pm-sec-v">{v}</span></div>;
}

/** Logo de equipo — si no hay URL muestra las iniciales del nombre. */
function TeamLogo({ src, name, size = 30 }) {
  return src
    ? <img className="pm-flag" src={src} alt={name || ""} style={{ height: size }}
           onError={e => { e.currentTarget.style.visibility = "hidden"; }} />
    : <span style={{ fontSize: Math.max(10, size * 0.45), opacity: 0.6, fontWeight: 700 }}>
        {name?.slice(0, 3) || "?"}
      </span>;
}

/** Bandera por código ISO3 — solo se usa en ChampionCard y StatList. */
function Flag({ code, size = 18 }) {
  const iso = ISO2[code];
  if (!iso) return null;
  return (
    <img
      className="pm-flag"
      src={`https://flagcdn.com/${iso}.svg`}
      alt={NAME[code] || code}
      style={{ height: size }}
      onError={e => { e.currentTarget.style.visibility = "hidden"; }}
    />
  );
}

/* ─── CSS helpers ───────────────────────────────────────── */
function themeVars(t) {
  return { ["--bg"]: t.bg, ["--deep"]: t.deep, ["--accent"]: t.accent, ["--accent2"]: t.accent2, ["--on"]: t.on };
}
function posterVars(t) {
  return { ["--p-bg"]: t.bg, ["--p-deep"]: t.deep, ["--p-accent"]: t.accent, ["--p-accent2"]: t.accent2 };
}

/* ─── CSS ───────────────────────────────────────────────── */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap');

.pm-root{--bg:#2D4ED8;--deep:#15246F;--accent:#FF7A2F;--accent2:#FFE14D;--on:#fff;
  font-family:'Inter',system-ui,sans-serif;background:#0c0b22;min-height:100vh;display:flex;justify-content:center;
  color:var(--on);-webkit-font-smoothing:antialiased;}
.pm-root *{box-sizing:border-box;}
.pm-phone{width:100%;max-width:430px;min-height:100vh;background:var(--deep);position:relative;overflow:hidden;}
.pm-screen{display:flex;flex-direction:column;min-height:100vh;}

/* fuentes display */
.pm-h1,.pm-hero-mark,.pm-leaguecard-name,.pm-lg-name,.pm-led,.pm-board-vs,.pm-sec-k,
.pm-side-label,.pm-rank,.pm-result-score,.pm-lg-pts span,.pm-chip,.pm-final,.pm-btn{font-family:'Fredoka','Inter',sans-serif;}

/* ---- Home hero ---- */
.pm-hero{padding:46px 22px 18px;display:flex;align-items:center;gap:16px;background:var(--bg);}
.pm-hero-mark{font-size:58px;font-weight:700;line-height:.8;color:var(--accent);
  -webkit-text-stroke:3px var(--deep);letter-spacing:-2px;}
.pm-eyebrow{font-size:12px;letter-spacing:3px;text-transform:uppercase;opacity:.85;font-weight:600;}
.pm-h1{margin:2px 0 0;font-size:34px;font-weight:700;letter-spacing:-.5px;}

.pm-stack{padding:18px 16px;display:flex;flex-direction:column;gap:14px;background:var(--deep);flex:1;}
.pm-leaguecard{--p-bg:#6B2AB8;--p-deep:#3D156E;--p-accent:#F4E84B;--p-accent2:#EE4A6B;
  position:relative;text-align:left;border:none;cursor:pointer;color:#fff;overflow:hidden;
  background:var(--p-bg);border-radius:26px;padding:18px 18px 16px;box-shadow:0 10px 0 var(--p-deep);}
.pm-leaguecard:active{transform:translateY(4px);box-shadow:0 6px 0 var(--p-deep);}
.pm-poster-rays{position:absolute;inset:0;background:
  radial-gradient(120% 90% at 110% -10%, var(--p-accent) 0 12%, transparent 12.5%),
  radial-gradient(90% 70% at -10% 120%, var(--p-accent2) 0 10%, transparent 10.5%);opacity:.5;}
.pm-leaguecard-top{position:relative;display:flex;justify-content:space-between;}
.pm-chip{font-size:11px;font-weight:600;background:rgba(0,0,0,.28);padding:5px 10px;border-radius:30px;}
.pm-chip-pts{background:var(--p-accent);color:#111;}
.pm-leaguecard-name{position:relative;font-size:28px;font-weight:700;margin:16px 0 14px;line-height:1;letter-spacing:-.5px;}
.pm-leaguecard-foot{position:relative;display:flex;justify-content:space-between;align-items:center;}
.pm-code{font-size:12px;letter-spacing:1px;opacity:.85;font-weight:600;}
.pm-go{font-size:14px;font-weight:700;}

.pm-actions{padding:6px 16px 26px;display:flex;flex-direction:column;gap:10px;background:var(--deep);}
.pm-btn{border:none;border-radius:18px;padding:16px;font-size:16px;font-weight:600;cursor:pointer;}
.pm-btn-primary{background:var(--accent);color:#161122;}
.pm-btn-ghost{background:rgba(255,255,255,.1);color:#fff;}
.pm-btn-full{width:100%;margin-top:8px;}
.pm-btn:disabled{opacity:.4;}

/* ---- League header / nav ---- */
.pm-screen-league{background:var(--deep);}
.pm-lg-header{display:flex;align-items:center;gap:12px;padding:42px 16px 16px;background:var(--bg);}
.pm-back{width:40px;height:40px;border-radius:14px;border:none;background:rgba(0,0,0,.25);color:#fff;font-size:20px;cursor:pointer;flex:none;}
.pm-lg-title{flex:1;}
.pm-lg-name{font-size:22px;font-weight:700;letter-spacing:-.3px;line-height:1;}
.pm-lg-sub{font-size:11px;opacity:.8;letter-spacing:1px;margin-top:3px;}
.pm-lg-pts{background:var(--accent);color:#161122;border-radius:16px;padding:7px 13px;text-align:center;}
.pm-lg-pts span{font-size:22px;font-weight:700;display:block;line-height:1;}
.pm-lg-pts small{font-size:10px;font-weight:700;text-transform:uppercase;}
.pm-tabbody{flex:1;overflow-y:auto;padding-bottom:84px;}
.pm-pad{padding:16px;}
.pm-admin-btn{width:36px;height:36px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#fff;font-size:16px;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;}
.pm-admin-btn:hover{background:rgba(255,255,255,.2);}
.pm-refresh-btn{width:36px;height:36px;border-radius:12px;border:none;background:rgba(255,255,255,.1);color:rgba(255,255,255,.7);font-size:18px;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;font-family:'Fredoka';}
.pm-refresh-btn:not(:disabled):hover{background:rgba(255,255,255,.18);color:#fff;}
.pm-refresh-btn:disabled{opacity:.4;cursor:default;}

.pm-nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;
  display:flex;background:#0c0b22;border-top:1px solid rgba(255,255,255,.08);padding:8px 6px calc(8px + env(safe-area-inset-bottom));}
.pm-navbtn{flex:1;background:none;border:none;color:rgba(255,255,255,.5);display:flex;flex-direction:column;align-items:center;gap:3px;
  font-size:11px;font-weight:600;cursor:pointer;padding:6px 2px;border-radius:12px;font-family:'Inter';}
.pm-navbtn.is-active{color:var(--accent);}
.pm-navicon{font-size:19px;}

/* ---- Section title ---- */
.pm-sec{margin:22px 2px 12px;display:flex;flex-direction:column;}
.pm-sec-k{font-size:20px;font-weight:700;letter-spacing:-.3px;}
.pm-sec-v{font-size:12px;opacity:.65;font-weight:500;}
.pm-note{font-size:12px;opacity:.6;margin:-4px 2px 12px;line-height:1.4;}

/* ---- Champion ---- */
.pm-champ{background:rgba(0,0,0,.22);border-radius:22px;padding:16px;margin-top:6px;}
.pm-champ-head{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;margin-bottom:12px;}
.pm-champ-head em{margin-left:auto;background:var(--accent2);color:#161122;font-style:normal;font-size:12px;font-weight:700;padding:3px 9px;border-radius:20px;}
.pm-trophy{font-size:20px;}
.pm-champ-search{margin:8px 0;padding:10px 12px;font-size:14px;}
.pm-champ-scroll{max-height:190px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-top:4px;}
.pm-champ-scroll::-webkit-scrollbar{width:4px;}.pm-champ-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:4px;}
.pm-champ-opt{background:rgba(255,255,255,.07);border:none;color:#fff;border-radius:12px;padding:9px 12px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:'Inter';text-align:left;}
.pm-champ-opt:hover{background:rgba(255,255,255,.13);}
.pm-champ-current{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.1);border-radius:14px;padding:12px 14px;margin:6px 0;}
.pm-champ-current-name{flex:1;font-size:15px;font-weight:600;}
.pm-champ-change{font-size:12px;background:none;border:1px solid rgba(255,255,255,.3);color:rgba(255,255,255,.8);border-radius:10px;padding:5px 10px;cursor:pointer;}

/* ---- Scoreboard ---- */
.pm-board{background:#100f28;border:2px solid rgba(255,255,255,.07);border-radius:24px;padding:16px 14px 14px;margin-bottom:14px;box-shadow:0 8px 0 rgba(0,0,0,.35);}
.pm-board-meta{text-align:center;font-size:11px;letter-spacing:1px;opacity:.6;text-transform:uppercase;margin-bottom:12px;font-weight:600;}
.pm-board-grid{display:grid;grid-template-columns:1fr auto 1fr;align-items:start;gap:6px;}
.pm-side{display:flex;flex-direction:column;align-items:center;gap:6px;}
.pm-side-label{font-size:12px;font-weight:700;letter-spacing:2px;color:var(--accent2);}
.pm-side-flag{height:30px;display:flex;align-items:center;justify-content:center;}
.pm-flag{display:inline-block;vertical-align:middle;border-radius:3px;box-shadow:0 0 0 1px rgba(0,0,0,.2);width:auto;}
.pm-side-team{font-size:13px;font-weight:600;text-align:center;min-height:32px;}
.pm-chev{width:48px;height:30px;border:none;border-radius:10px;background:rgba(255,255,255,.1);color:var(--accent);font-size:13px;cursor:pointer;}
.pm-chev:active{background:rgba(255,255,255,.2);}
.pm-led{font-size:52px;font-weight:700;line-height:1;color:var(--accent2);width:72px;height:64px;display:flex;align-items:center;justify-content:center;
  background:#06060f;border-radius:12px;text-shadow:0 0 14px var(--accent2);margin:2px 0;}
.pm-board-mid{align-self:center;padding-top:42px;}
.pm-board-vs{font-size:14px;font-weight:700;opacity:.4;}

.pm-taken{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:14px;font-size:11px;opacity:.7;}
.pm-taken span:first-child{font-weight:600;}
.pm-taken-chip{background:rgba(255,255,255,.07);padding:3px 8px;border-radius:8px;color:rgba(255,255,255,.5);font-weight:600;}
.pm-warn{margin-top:10px;background:rgba(238,74,107,.15);border:1px solid var(--accent2);color:#ffd2dc;font-size:12px;padding:9px 11px;border-radius:12px;}
.pm-warn.is-flash{animation:pmshake .4s;}
@keyframes pmshake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
.pm-final{width:100%;margin-top:14px;border:none;border-radius:16px;padding:15px;font-size:16px;font-weight:700;background:var(--accent);color:#161122;cursor:pointer;}
.pm-final.is-saved{background:#1f9e57;color:#fff;}
.pm-final.is-disabled{opacity:.45;}

.pm-soon{background:rgba(255,255,255,.05);border-radius:16px;padding:13px 15px;margin-bottom:9px;}
.pm-soon-teams{font-size:14px;font-weight:600;display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.pm-soon-teams span{opacity:.4;margin:0 3px;font-size:12px;}
.pm-soon-when{font-size:11px;opacity:.55;margin-top:3px;}

/* ---- Standings ---- */
.pm-seg{display:flex;gap:6px;background:rgba(0,0,0,.25);padding:5px;border-radius:16px;margin-bottom:14px;}
.pm-seg-btn{flex:1;border:none;background:none;color:rgba(255,255,255,.6);font-size:13px;font-weight:600;padding:9px;border-radius:12px;cursor:pointer;}
.pm-seg-btn.is-on{background:var(--accent);color:#161122;}
.pm-table{display:flex;flex-direction:column;gap:8px;}
.pm-row{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.05);border-radius:16px;padding:13px 15px;}
.pm-row.is-me{background:rgba(255,255,255,.13);outline:2px solid var(--accent);}
.pm-rank{font-size:18px;font-weight:700;width:22px;color:var(--accent);}
.pm-rowname{flex:1;font-size:15px;font-weight:600;display:flex;align-items:center;gap:7px;}
.pm-tu{font-size:9px;background:var(--accent);color:#161122;padding:2px 6px;border-radius:10px;font-weight:700;text-transform:uppercase;}
.pm-sweep-badge{font-size:11px;margin-left:5px;background:rgba(255,160,0,.18);color:#ffb300;padding:1px 5px;border-radius:8px;font-weight:700;cursor:default;}
.pm-badge{font-size:10px;margin-left:5px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.65);padding:1px 6px;border-radius:8px;font-weight:600;cursor:default;white-space:nowrap;}
.pm-rowexact{font-size:11px;opacity:.55;}
.pm-rowpts{font-size:20px;font-weight:700;font-family:'Fredoka';min-width:34px;text-align:right;}

/* ---- Results ---- */
.pm-result{display:flex;align-items:center;background:rgba(255,255,255,.05);border-radius:16px;padding:13px 15px;margin-bottom:9px;}
.pm-result-side{flex:1;font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;}
.pm-result-side-r{justify-content:flex-end;}
.pm-result-score{font-size:24px;font-weight:700;font-family:'Fredoka';padding:0 14px;white-space:nowrap;}
.pm-result-score span{opacity:.4;margin:0 3px;font-size:18px;}
.pm-stats{display:flex;flex-direction:column;gap:7px;}
.pm-stat{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.05);border-radius:14px;padding:11px 14px;}
.pm-stat-rank{font-weight:700;color:var(--accent);width:18px;}
.pm-stat-name{flex:1;font-size:14px;font-weight:500;}
.pm-stat-n{font-size:16px;font-weight:700;}
.pm-stat-n small{font-size:11px;font-weight:500;opacity:.6;}

/* ---- History ---- */
.pm-hist{background:rgba(255,255,255,.05);border-radius:18px;padding:13px 15px;margin-bottom:11px;}
.pm-hist-head{font-size:14px;font-weight:700;margin-bottom:10px;}
.pm-hist-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid rgba(255,255,255,.06);}
.pm-hist-name{flex:1;font-size:14px;display:flex;align-items:center;gap:7px;}
.pm-hist-pred{font-size:14px;font-weight:700;font-family:'Fredoka';}
.pm-hist-pts{font-size:12px;font-weight:700;border-radius:10px;padding:2px 8px;}
.pm-pts-3{background:#1f9e57;color:#fff;}
.pm-pts-1{background:var(--accent2);color:#161122;}
.pm-pts-0{background:rgba(255,255,255,.1);color:rgba(255,255,255,.6);}

/* ---- Modals ---- */
.pm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;z-index:50;}
.pm-modal{width:100%;max-width:430px;background:var(--deep);border-radius:26px 26px 0 0;padding:22px 18px calc(26px + env(safe-area-inset-bottom));}
.pm-modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
.pm-modal-head h3{margin:0;font-size:22px;font-family:'Fredoka';font-weight:700;}
.pm-x{background:rgba(255,255,255,.1);border:none;color:#fff;width:34px;height:34px;border-radius:12px;cursor:pointer;font-size:14px;}
.pm-field-label{display:block;font-size:12px;font-weight:600;opacity:.7;margin:12px 0 7px;text-transform:uppercase;letter-spacing:1px;}
.pm-input{width:100%;background:rgba(0,0,0,.3);border:2px solid rgba(255,255,255,.1);color:#fff;border-radius:14px;padding:14px;font-size:16px;font-family:'Inter';}
.pm-input:focus{outline:none;border-color:var(--accent);}
.pm-theme-row{display:flex;gap:12px;}
.pm-theme-dot{width:46px;height:46px;border-radius:50%;border:3px solid transparent;cursor:pointer;}
.pm-theme-dot.is-on{border-color:#fff;transform:scale(1.08);}

.pm-btn-danger{background:rgba(200,30,30,.25);border:1.5px solid rgba(255,80,80,.5);color:#ff9a9a;font-weight:700;}
.pm-btn-danger:hover{background:rgba(200,30,30,.4);}
.pm-danger-zone{margin-top:22px;border-top:1px solid rgba(255,255,255,.08);padding-top:16px;}
.pm-danger-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;opacity:.4;margin-bottom:10px;}
.pm-danger-warn{font-size:13px;background:rgba(200,30,30,.15);border:1px solid rgba(255,80,80,.3);color:#ffbaba;border-radius:12px;padding:11px 13px;}
button:focus-visible,input:focus-visible{outline:2px solid #fff;outline-offset:2px;}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important;}}

/* ---- Push ---- */
.pm-push-btn{background:rgba(255,255,255,.08);border:1.5px solid rgba(255,255,255,.2);color:rgba(255,255,255,.85);font-size:13px;font-weight:600;border-radius:16px;padding:13px;cursor:pointer;transition:background .15s;}
.pm-push-btn:hover:not(:disabled){background:rgba(255,255,255,.14);}
.pm-push-btn:disabled{opacity:.45;cursor:default;}
.pm-push-ok{text-align:center;font-size:13px;opacity:.6;padding:4px 0;}
.pm-push-err{font-size:12px;color:#ff7a7a;background:rgba(255,80,80,.1);border-radius:12px;padding:10px 12px;}
`;
