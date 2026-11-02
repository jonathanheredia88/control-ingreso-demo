// Utilidades compartidas: conexión a Supabase, sesión, escapado de HTML y pantalla de acceso.
export const CONFIG = {
  url: "https://fyfqvwvwqnowdzusggaw.supabase.co",
  // Clave publicable: es pública por diseño. La seguridad está en la base de datos
  // (todas las funciones exigen sesión y rol).
  key: "sb_publishable_kiPhw0fDyKdkMUd5k0cGaA_yTBteMLP",
  funcionAvisos: "https://fyfqvwvwqnowdzusggaw.supabase.co/functions/v1/cn-notificar",
  // Teléfono de coordinación que verán las familias en una alerta (dato demo)
  telefonoCoordinacion: "0990000000",
};

export const sb = window.supabase.createClient(CONFIG.url, CONFIG.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

export const $ = (id) => document.getElementById(id);

// Todo texto que venga del servidor o del usuario pasa por aquí antes de ir a innerHTML
export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const iniciales = (n) =>
  String(n || "?").trim().split(/\s+/).filter((p) => p && p.toLowerCase() !== "demo").slice(0, 2).map((p) => p[0]).join("").toUpperCase();

export function avatar(nombre, fotoUrl, grande = false) {
  const cls = "foto" + (grande ? " g" : "");
  if (fotoUrl && /^https:\/\//.test(fotoUrl)) return `<div class="${cls}"><img src="${esc(fotoUrl)}" alt=""></div>`;
  return `<div class="${cls}" aria-hidden="true">${esc(iniciales(nombre))}</div>`;
}

export async function rpc(fn, args) {
  let r;
  try { r = await sb.rpc(fn, args || {}); }
  catch { throw new Error("No se pudo conectar. Revisa tu conexión a internet e intenta de nuevo."); }
  if (r.error) {
    const m = r.error.message || "";
    if (r.error.code === "42501") throw new Error(m.includes("permission denied") ? "No tienes permiso para esta acción." : m);
    if (/JWT|token|session/i.test(m)) throw new Error("Tu sesión expiró. Vuelve a ingresar.");
    if (/fetch|network/i.test(m)) throw new Error("No se pudo conectar. Revisa tu conexión a internet e intenta de nuevo.");
    throw new Error(m || "Ocurrió un error inesperado.");
  }
  return r.data;
}

export function toast(texto, ms = 3200) {
  const t = document.createElement("div");
  t.className = "toast"; t.role = "status"; t.textContent = texto;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Sonido + vibración: el guardia no siempre mira la pantalla
let ctx;
export function senal(ok) {
  try { navigator.vibrate?.(ok ? 80 : [200, 80, 200, 80, 200]); } catch {}
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = ok ? "sine" : "square"; o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (ok ? 0.18 : 0.5));
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.2 : 0.5));
  } catch {}
}

export const fechaLarga = (d = new Date()) =>
  d.toLocaleDateString("es-EC", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Guayaquil" });

export const hoyISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
export const sumarDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// Arranca la app cuando hay sesión; si no, muestra el acceso por correo.
export function conSesion({ contenedor, titulo, subtitulo, alEntrar }) {
  let actual; // undefined: aún no se ha decidido qué pantalla mostrar
  sb.auth.onAuthStateChange((evento, sesion) => {
    const id = sesion?.user?.id ?? null;
    if (id === actual) return;
    actual = id;
    // setTimeout: no llamar a Supabase dentro del callback de auth
    setTimeout(() => (sesion ? alEntrar(sesion) : pantallaAcceso(contenedor, titulo, subtitulo)), 0);
  });
}

export async function salir() {
  await sb.auth.signOut();
  location.replace(location.pathname);
}

function pantallaAcceso(el, titulo, subtitulo) {
  document.querySelectorAll("[data-app]").forEach((n) => (n.hidden = true));
  el.hidden = false;
  el.innerHTML = `<div class="login"><div class="card">
    <div class="marca"><img src="icons/icon-192.png" alt=""><div><h1>${esc(titulo)}</h1><div class="small">${esc(subtitulo)}</div></div></div>
    <form id="f-acceso" novalidate>
      <div class="campo"><label for="acc-email">Tu correo</label>
        <input id="acc-email" type="email" inputmode="email" autocomplete="email" required placeholder="nombre@correo.com"></div>
      <button class="btn" style="width:100%" id="acc-btn">Enviarme un código de acceso</button>
      <p class="small">Sin contraseñas: te enviamos un código a tu correo.</p>
    </form>
    <div id="acc-enviado" hidden>
      <p><b>Revisa tu correo.</b> Enviamos un código a <span id="acc-a"></span>. Puede tardar un minuto; revisa también «No deseado».</p>
      <form id="f-codigo">
        <label for="acc-codigo">Escribe el código del correo</label>
        <div class="row">
          <input id="acc-codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" style="font-size:1.4rem;letter-spacing:.3em;text-align:center">
          <button class="btn" id="acc-entrar">Entrar</button>
        </div>
      </form>
      <p class="small">En la computadora también puedes tocar el enlace del correo. En el celular, mejor usa el código: así entras directo a la app.</p>
      <p class="row"><button class="btn sec chico" id="acc-reenviar">Reenviar código</button><button class="btn sec chico" id="acc-otro">Usar otro correo</button></p>
    </div>
    <div id="acc-err" class="error" hidden role="alert"></div>
  </div></div>`;
  const err = (m) => { $("acc-err").hidden = !m; $("acc-err").textContent = m || ""; };
  let email = "";
  const enviar = async () => {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (!error) return true;
    const espera = error.message.match(/(\d+)\s*seconds?/);
    err(/rate|limit|seconds/i.test(error.message)
      ? `Ya enviamos un código hace poco${espera ? ` (podrás pedir otro en ${espera[1]} segundos)` : ""}. Si ya te llegó, escríbelo en la casilla.`
      : "No pudimos enviar el código: " + error.message);
    return /rate|limit|seconds/i.test(error.message); // con límite igual mostramos la casilla del código
  };
  $("f-acceso").onsubmit = async (e) => {
    e.preventDefault(); err("");
    email = $("acc-email").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err("Escribe un correo válido.");
    $("acc-btn").disabled = true; $("acc-btn").textContent = "Enviando…";
    const ok = await enviar();
    $("acc-btn").disabled = false; $("acc-btn").textContent = "Enviarme un código de acceso";
    if (!ok) return;
    $("f-acceso").hidden = true; $("acc-enviado").hidden = false; $("acc-a").textContent = email;
    $("acc-codigo").focus();
  };
  $("acc-reenviar").onclick = async () => { err(""); if (await enviar()) toast("Te enviamos un código nuevo"); };
  $("f-codigo").onsubmit = async (e) => {
    e.preventDefault(); err("");
    const token = $("acc-codigo").value.replace(/\D/g, "");
    if (token.length < 6) return err("Escribe el código completo que llegó a tu correo.");
    $("acc-entrar").disabled = true;
    const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
    $("acc-entrar").disabled = false;
    if (error) err("El código no es válido o ya venció. Pide uno nuevo con «Reenviar código».");
  };
  $("acc-otro").onclick = () => { err(""); $("f-acceso").hidden = false; $("acc-enviado").hidden = true; };
}
