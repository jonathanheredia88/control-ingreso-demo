// Portal de familias: estado del día, historial, pases temporales y avisos (correo + push).
import { $, esc, rpc, avatar, toast, conSesion, salir, fechaLarga, hoyISO, sumarDias, CONFIG, sb } from "./comun.js";

let datos = null;
let vista = "hoy";
let histHijo = null;
let paseHijos = new Set();
let paseFecha = hoyISO();
let swReg = null;

conSesion({
  contenedor: $("acceso"),
  titulo: "Campus Norte · Familias",
  subtitulo: "Entérate al instante de cada ingreso y salida de tus hijos",
  alEntrar: iniciar,
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch(() => {});
  // Cuando llega un push con la app abierta, refrescamos los datos
  navigator.serviceWorker.addEventListener("message", (e) => e.data?.tipo === "aviso" && cargar());
}

async function iniciar() {
  $("acceso").hidden = true;
  document.querySelector("[data-app]").hidden = false;
  $("fecha").textContent = fechaLarga();
  $("salir").onclick = salir;
  await cargar();
  setInterval(() => !document.hidden && cargar(), 30000);
  document.addEventListener("visibilitychange", () => !document.hidden && cargar());
}

async function cargar() {
  try { datos = await rpc("cn_padre_inicio"); }
  catch (e) { return toast(e.message); }
  if (!datos.ok) {
    $("hijos").innerHTML = `<div class="card"><h2>Tu cuenta aún no está activa</h2><p>${esc(datos.mensaje)}</p>
      <p class="small">Correo con el que entraste: ${esc((await sb.auth.getUser()).data?.user?.email || "")}</p>
      <button class="btn sec" id="salir2">Entrar con otro correo</button></div>`;
    $("salir2").onclick = salir;
    document.querySelector(".bottom").hidden = true;
    return;
  }
  const a = datos.adulto;
  $("saludo").textContent = `Hola, ${a.nombres}`;
  $("cuenta").textContent = `${a.nombres} ${a.apellidos} · ${a.email}`;
  $("pref-correo").textContent = a.email;
  $("pref-email").checked = a.avisos_email;
  $("pref-push").checked = a.avisos_push;
  if (!histHijo && datos.hijos[0]) histHijo = datos.hijos[0].codigo;
  if (!paseHijos.size && datos.hijos.length === 1) paseHijos.add(datos.hijos[0].codigo);
  pintarAlertas(); pintarHoy(); pintarRetiros(); pintarFormularioPase(); estadoPush();
  if (vista === "historial") cargarHistorial();
}

// ---------- Hoy ----------
const ICONO = { ingreso: "🟢", salida: "👋", intento_rechazado: "⚠️" };

function textoEstado(h) {
  const ult = [...h.hoy].reverse().find((m) => m.tipo === "ingreso" || m.tipo === "salida");
  if (h.estado === "presente") return { ico: "🏫", t: "Está en el campus", s: `Llegó a las ${ult?.hora}` };
  if (h.estado === "retirado") return { ico: "🏠", t: `Salió a las ${ult?.hora}`, s: (ult?.detalle || "").replace(/^.*? salió a las \d\d:\d\d /, "") };
  return { ico: "⏳", t: "Aún sin registro de ingreso hoy", s: "Te avisaremos apenas llegue." };
}

function pintarAlertas() {
  const urg = datos.hijos.flatMap((h) => h.hoy.filter((m) => m.urgente).map((m) => ({ ...m, hijo: h })));
  $("alertas").innerHTML = urg.map((m) => `<div class="urgente" role="alert">
      <b>⚠️ ${esc(m.titulo)} · ${esc(m.hora)}</b><p style="margin:6px 0 0">${esc(m.detalle)}</p>
      <div class="row"><a class="btn peligro" href="tel:${esc(CONFIG.telefonoCoordinacion)}" style="text-align:center;text-decoration:none">Llamar a coordinación</a>
      <button class="btn sec" data-ir="retiros">Crear pase temporal</button></div></div>`).join("");
}

function pintarHoy() {
  if (!datos.hijos.length) {
    $("hijos").innerHTML = `<div class="card"><p>No hay estudiantes vinculados a tu cuenta. Comunícate con secretaría.</p></div>`;
    return;
  }
  $("hijos").innerHTML = datos.hijos.map((h) => {
    const e = textoEstado(h);
    const pasesHoy = h.pases.filter((p) => p.fecha === hoyISO() && !p.usado);
    return `<article class="card hijo">
      <div class="cab">${avatar(h.nombres + " " + h.apellidos, h.foto_url, true)}
        <div><b>${esc(h.nombres)} ${esc(h.apellidos)}</b><span class="small">${esc(h.grado)}</span></div></div>
      <div class="estado ${esc(h.estado)}"><span class="ico" aria-hidden="true">${e.ico}</span><div>${esc(e.t)}<small>${esc(e.s)}</small></div></div>
      ${pasesHoy.length ? `<div class="aviso">Hoy puede retirarlo con pase temporal: ${pasesHoy.map((p) => `<b>${esc(p.nombre)}</b>`).join(", ")}</div>` : ""}
      ${h.hoy.length ? `<div><h3>Hoy</h3><ol class="linea">${h.hoy.map((m) =>
          `<li class="${esc(m.tipo)}"><i></i><span class="h">${esc(m.hora)}</span>${esc(m.detalle)}</li>`).join("")}</ol></div>` : ""}
      ${h.notas_salud ? `<p class="small" style="margin:0">Ficha de salud registrada: <span class="salud">${esc(h.notas_salud)}</span></p>` : ""}
    </article>`;
  }).join("");
}

// ---------- Historial ----------
async function cargarHistorial() {
  $("hist-hijos").innerHTML = datos.hijos.length > 1 ? datos.hijos.map((h) =>
    `<button class="chip ${h.codigo === histHijo ? "on" : ""}" data-hist="${esc(h.codigo)}">${esc(h.nombres)}</button>`).join("") : "";
  try {
    const dias = await rpc("cn_padre_historial", { p_codigo: histHijo, p_dias: 30 });
    const asistio = dias.filter((d) => d.entrada).length;
    const hijo = datos.hijos.find((h) => h.codigo === histHijo);
    $("hist-resumen").textContent = dias.length
      ? `${hijo?.nombres} asistió ${asistio} ${asistio === 1 ? "día" : "días"} en los últimos 30 días.`
      : "Todavía no hay registros en los últimos 30 días.";
    $("hist-tabla").innerHTML = dias.map((d) => {
      const f = new Date(d.fecha + "T12:00:00").toLocaleDateString("es-EC", { weekday: "short", day: "numeric", month: "short" });
      return `<tr><td>${esc(f)}${d.alertas ? ` <span class="pill p-intento_rechazado">alerta</span>` : ""}</td>
        <td>${esc(d.entrada || "—")}</td><td>${esc(d.salida || "—")}${d.salio_con ? `<br><span class="small">con ${esc(d.salio_con)}</span>` : ""}</td></tr>`;
    }).join("");
  } catch (e) { $("hist-tabla").innerHTML = `<tr><td colspan="3">${esc(e.message)}</td></tr>`; }
}
$("hist-hijos").onclick = (e) => { const b = e.target.closest("[data-hist]"); if (b) { histHijo = b.dataset.hist; cargarHistorial(); } };

// ---------- Retiros ----------
function pintarRetiros() {
  $("retiros-lista").innerHTML = datos.hijos.map((h) => `<div class="card">
    <h2>${esc(h.nombres)}</h2>
    <h3>Pases temporales</h3>
    ${h.pases.length ? `<ul class="lista">${h.pases.map((p) => `<li><span><b>${esc(p.nombre)}</b>${p.parentesco ? " · " + esc(p.parentesco) : ""}<br>
        <span class="small">${esc(fechaCorta(p.fecha))} · cédula ${esc(p.cedula)}${p.usado ? ` · <b>usado a las ${esc(p.hora_uso)}</b>` : ""}</span></span>
        ${p.usado ? "" : `<button class="btn sec chico" data-anular="${esc(p.id)}">Anular</button>`}</li>`).join("")}</ul>`
      : `<p class="small">No hay pases activos.</p>`}
    <h3 style="margin-top:12px">Autorizados permanentes</h3>
    <ul class="lista">${h.autorizados.map((a) => `<li><span>${esc(a.nombre)} · ${esc(a.parentesco)}</span>${a.es_representante ? `<span class="pill p-salida">representante</span>` : ""}</li>`).join("")}</ul>
    <p class="small">Para agregar o quitar autorizados permanentes, comunícate con secretaría (se requiere copia de cédula y foto).</p>
  </div>`).join("");
}
const fechaCorta = (iso) => iso === hoyISO() ? "Hoy" : iso === sumarDias(hoyISO(), 1) ? "Mañana"
  : new Date(iso + "T12:00:00").toLocaleDateString("es-EC", { weekday: "long", day: "numeric", month: "short" });

$("retiros-lista").onclick = async (e) => {
  const b = e.target.closest("[data-anular]"); if (!b) return;
  if (!confirm("¿Anular este pase? La persona ya no podrá retirar a tu hijo con él.")) return;
  b.disabled = true;
  try { const r = await rpc("cn_padre_anular_pase", { p_id: b.dataset.anular }); toast(r.ok ? "Pase anulado" : "Ese pase ya no se puede anular"); cargar(); }
  catch (err) { toast(err.message); b.disabled = false; }
};

function pintarFormularioPase() {
  $("pase-hijos-box").hidden = datos.hijos.length < 2;
  $("pase-hijos").innerHTML = datos.hijos.map((h) =>
    `<button type="button" class="chip ${paseHijos.has(h.codigo) ? "on" : ""}" data-hijo="${esc(h.codigo)}" aria-pressed="${paseHijos.has(h.codigo)}">${esc(h.nombres)}</button>`).join("");
  const hoy = hoyISO(), man = sumarDias(hoy, 1);
  $("pase-dias").innerHTML = [[hoy, "Hoy"], [man, "Mañana"]].map(([f, t]) =>
    `<button type="button" class="chip ${paseFecha === f ? "on" : ""}" data-fecha="${f}">${t}</button>`).join("");
  $("pase-fecha").min = hoy; $("pase-fecha").max = sumarDias(hoy, 7);
  $("pase-fecha").value = paseFecha !== hoy && paseFecha !== man ? paseFecha : "";
}
$("pase-hijos").onclick = (e) => {
  const b = e.target.closest("[data-hijo]"); if (!b) return;
  paseHijos.has(b.dataset.hijo) ? paseHijos.delete(b.dataset.hijo) : paseHijos.add(b.dataset.hijo);
  pintarFormularioPase();
};
$("pase-dias").onclick = (e) => { const b = e.target.closest("[data-fecha]"); if (b) { paseFecha = b.dataset.fecha; pintarFormularioPase(); } };
$("pase-fecha").onchange = (e) => { if (e.target.value) { paseFecha = e.target.value; pintarFormularioPase(); } };
$("pase-cedula").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10)));

$("f-pase").onsubmit = async (e) => {
  e.preventDefault();
  const err = (m) => { $("pase-err").hidden = !m; $("pase-err").textContent = m || ""; };
  err("");
  const nombre = $("pase-nombre").value.trim(), cedula = $("pase-cedula").value.trim(), par = $("pase-par").value.trim();
  if (!paseHijos.size) return err("Elige a qué hijo retirará.");
  if (nombre.split(/\s+/).length < 2) return err("Escribe nombre y apellido, tal como aparece en la cédula.");
  if (!/^\d{10}$/.test(cedula)) return err("La cédula debe tener 10 dígitos.");
  $("pase-btn").disabled = true;
  try {
    for (const codigo of paseHijos) {
      const r = await rpc("cn_padre_crear_pase", { p_codigo: codigo, p_nombre: nombre, p_cedula: cedula, p_parentesco: par, p_fecha: paseFecha });
      if (!r.ok) return err(r.mensaje);
    }
    toast(`Listo. ${nombre.split(" ")[0]} podrá retirar a tu hijo ${fechaCorta(paseFecha).toLowerCase()} presentando su cédula.`, 5000);
    $("f-pase").reset(); paseFecha = hoyISO();
    await cargar();
  } catch (x) { err(x.message); }
  finally { $("pase-btn").disabled = false; }
};

// ---------- Avisos y push ----------
const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const instalada = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const soportaPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function suscripcionActual() {
  if (!soportaPush) return null;
  const reg = swReg || (await navigator.serviceWorker.ready);
  return reg.pushManager.getSubscription();
}

async function estadoPush() {
  const btn = $("push-btn"), txt = $("push-estado");
  $("ios-ayuda").hidden = !(esIOS && !instalada);
  if (!soportaPush) {
    btn.hidden = true;
    txt.textContent = esIOS && !instalada ? "Para recibir notificaciones en iPhone, instala primero el portal." : "Este navegador no admite notificaciones push. Seguirás recibiendo avisos por correo.";
    return;
  }
  const sub = await suscripcionActual();
  if (Notification.permission === "denied") {
    btn.hidden = true; txt.textContent = "Bloqueaste las notificaciones para este sitio. Puedes habilitarlas desde la configuración del navegador.";
  } else if (sub) {
    btn.hidden = false; btn.textContent = "Desactivar en este celular"; btn.className = "btn sec";
    txt.textContent = "✅ Activadas en este dispositivo. Te avisaremos al instante.";
  } else {
    btn.hidden = false; btn.textContent = "Activar notificaciones"; btn.className = "btn";
    txt.textContent = "Recibe un aviso en el celular en el momento en que tu hijo entra o sale.";
  }
}

const b64ToBytes = (b) => { const p = "=".repeat((4 - (b.length % 4)) % 4); const s = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

$("push-btn").onclick = async () => {
  const btn = $("push-btn"); btn.disabled = true;
  try {
    const actual = await suscripcionActual();
    if (actual) {
      await rpc("cn_padre_push_borrar", { p_endpoint: actual.endpoint });
      await actual.unsubscribe();
      toast("Notificaciones desactivadas en este celular");
    } else {
      const permiso = await Notification.requestPermission();
      if (permiso !== "granted") { toast("No se activaron las notificaciones"); return; }
      const { vapid_public } = await (await fetch(CONFIG.funcionAvisos)).json();
      const reg = swReg || (await navigator.serviceWorker.ready);
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapid_public) });
      const j = sub.toJSON();
      await rpc("cn_padre_push_guardar", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_agente: navigator.userAgent });
      if (!$("pref-push").checked) { $("pref-push").checked = true; await guardarPreferencias(); }
      toast("¡Listo! Notificaciones activadas");
    }
  } catch (e) { toast("No se pudo cambiar: " + e.message); }
  finally { btn.disabled = false; estadoPush(); }
};

async function guardarPreferencias() {
  try { await rpc("cn_padre_preferencias", { p_email: $("pref-email").checked, p_push: $("pref-push").checked }); toast("Preferencias guardadas"); }
  catch (e) { toast(e.message); }
}
$("pref-email").onchange = guardarPreferencias;
$("pref-push").onchange = guardarPreferencias;

$("prueba").onclick = async () => {
  $("prueba").disabled = true;
  try {
    const r = await rpc("cn_padre_prueba");
    toast(r.ok ? (r.push ? "Aviso de prueba enviado a tu correo y a tus dispositivos" : "Aviso de prueba enviado a tu correo") : r.mensaje, 4500);
  } catch (e) { toast(e.message); }
  finally { setTimeout(() => ($("prueba").disabled = false), 5000); }
};

// ---------- Navegación e instalación ----------
function irA(v) {
  vista = v;
  document.querySelectorAll(".bottom button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  document.querySelectorAll("main>section").forEach((s) => (s.hidden = s.id !== "v-" + v));
  $("alertas").hidden = v !== "hoy";
  if (v === "historial") cargarHistorial();
  scrollTo({ top: 0 });
}
document.querySelectorAll(".bottom button").forEach((b) => (b.onclick = () => irA(b.dataset.v)));
document.addEventListener("click", (e) => { const b = e.target.closest("[data-ir]"); if (b) irA(b.dataset.ir); });

let promptInstalar = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); promptInstalar = e; $("instalar").hidden = false; });
$("instalar").onclick = async () => { if (!promptInstalar) return; promptInstalar.prompt(); await promptInstalar.userChoice; promptInstalar = null; $("instalar").hidden = true; };
