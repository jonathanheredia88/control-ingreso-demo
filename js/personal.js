// App del personal: guardia (ingreso/salida/panel) y coordinación (además, carnets y demo).
import { $, esc, rpc, avatar, senal, toast, conSesion, salir } from "./comun.js";

let yo = null;
let estudiantes = [];
let pendiente = null;
let timerPanel = null;

conSesion({
  contenedor: $("acceso"),
  titulo: "Control de Ingreso",
  subtitulo: "Acceso para personal de Campus Norte",
  alEntrar: iniciar,
});

async function iniciar() {
  try { yo = await rpc("cn_yo"); }
  catch (e) { return mostrarBloqueo(e.message); }
  if (!yo.rol) {
    return mostrarBloqueo(
      `Tu correo (${yo.email}) no tiene acceso al control de ingreso.` +
      (yo.es_padre ? " Si eres representante, entra al portal de familias." : " Pide a coordinación que te registre."),
      yo.es_padre);
  }
  $("acceso").hidden = true;
  document.querySelector("[data-app]").hidden = false;
  $("quien").textContent = `${yo.nombre} · ${yo.rol === "coordinacion" ? "Coordinación" : "Guardia"}`;
  document.querySelectorAll("[data-rol]").forEach((n) => (n.hidden = n.dataset.rol !== yo.rol));
  $("salir").onclick = salir;
  await cargarEstudiantes();
}

function mostrarBloqueo(msg, irPortal) {
  const el = $("acceso");
  el.hidden = false;
  el.innerHTML = `<div class="login"><div class="card"><h2>Sin acceso</h2><p>${esc(msg)}</p>
    <div class="row">${irPortal ? `<a class="btn" href="padre.html" style="text-align:center;text-decoration:none">Ir al portal de familias</a>` : ""}
    <button class="btn sec" id="b-salir">Cerrar sesión</button></div></div></div>`;
  $("b-salir").onclick = salir;
}

async function cargarEstudiantes() {
  try { estudiantes = await rpc("cn_estudiantes"); } catch (e) { return toast(e.message); }
  const etiqueta = { presente: " · en el campus", retirado: " · ya salió", ausente: "" };
  const porGrado = {};
  estudiantes.forEach((e) => (porGrado[e.grado] ??= []).push(e));
  const opciones = (filtro) => `<option value="">Elige un estudiante…</option>` +
    Object.entries(porGrado).map(([g, lista]) => `<optgroup label="${esc(g)}">` +
      lista.filter(filtro).map((e) => `<option value="${esc(e.codigo)}">${esc(e.nombre)}${etiqueta[e.estado]}</option>`).join("") +
      `</optgroup>`).join("");
  const sel1 = $("est1").value, sel2 = $("est2").value;
  $("est1").innerHTML = opciones(() => true);
  // En salida, primero los que están en el campus
  $("est2").innerHTML = opciones((e) => e.estado === "presente") .replace("Elige un estudiante…", "Estudiantes en el campus…") +
    `<optgroup label="Sin ingreso o ya retirados">` +
    estudiantes.filter((e) => e.estado !== "presente").map((e) => `<option value="${esc(e.codigo)}">${esc(e.nombre)}${etiqueta[e.estado]}</option>`).join("") +
    `</optgroup>`;
  $("est1").value = sel1; $("est2").value = sel2;
}

// ---------- Navegación ----------
document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("main>section").forEach((s) => (s.hidden = s.id !== "v-" + b.dataset.v));
  clearInterval(timerPanel);
  if (b.dataset.v === "panel") { cargarPanel(); timerPanel = setInterval(() => !document.hidden && cargarPanel(), 20000); }
  if (b.dataset.v === "carnets") cargarCarnets();
  if (b.dataset.v === "salida" || b.dataset.v === "ingreso") cargarEstudiantes();
}));

function mostrar(el, clase, html) {
  el.className = "res " + clase;
  el.innerHTML = html;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

const fichaEst = (e) => `<div class="persona">${avatar(e.nombres + " " + e.apellidos, e.foto_url, true)}<div>
  <b>${esc(e.nombres)} ${esc(e.apellidos)}</b><br>${esc(e.grado)}
  ${e.notas_salud ? `<br><span class="salud">⚠ ${esc(e.notas_salud)}</span>` : ""}</div></div>`;

// ---------- Ingreso: paso 1 consultar, paso 2 registrar ----------
async function consultar(codigo) {
  if (!codigo) return;
  try {
    const d = await rpc("cn_escanear", { p_codigo: codigo, p_tipo: "consulta" });
    if (!d.ok) { pendiente = null; senal(false); return mostrar($("r1"), "bad", `<div class="big">✕ Rechazado</div><p>${esc(d.mensaje)}</p>`); }
    pendiente = codigo;
    const e = d.estudiante;
    const estado = d.estado === "presente"
      ? `<div class="aviso" style="margin-top:12px">Ya registró ingreso hoy a las ${esc(d.hora_estado)}. No se enviará otro aviso.</div>`
      : d.estado === "retirado" ? `<div class="aviso" style="margin-top:12px">Salió hoy a las ${esc(d.hora_estado)}. Registrar ingreso indica que volvió al campus.</div>` : "";
    mostrar($("r1"), "neutro", `<div class="small">${d.manual ? "<b>Ingreso manual:</b> confirme la identidad del estudiante." : "Verifique que la foto coincide con el estudiante."}</div>
      ${fichaEst(e)}${estado}
      <div class="row" style="margin-top:14px"><button class="btn ok" id="conf1">Registrar ingreso</button><button class="btn sec" id="canc1">Cancelar</button></div>`);
    $("conf1").onclick = registrar;
    $("canc1").onclick = () => { pendiente = null; $("r1").className = "res"; };
    $("conf1").focus();
  } catch (err) { mostrar($("r1"), "bad", `<div class="big">Sin conexión</div><p>${esc(err.message)}</p>`); }
}

async function registrar() {
  if (!pendiente) return;
  const codigo = pendiente; pendiente = null;
  $("conf1").disabled = true;
  try {
    const d = await rpc("cn_escanear", { p_codigo: codigo, p_tipo: "ingreso" });
    if (!d.ok) { senal(false); return mostrar($("r1"), "bad", `<div class="big">✕ Rechazado</div><p>${esc(d.mensaje)}</p>`); }
    senal(true);
    const e = d.estudiante;
    mostrar($("r1"), "ok", d.ya_registrado
      ? `<div class="big">✓ Ya estaba registrado (${esc(d.hora)})</div>${fichaEst(e)}<p class="small">No se duplicó el registro ni el aviso a la familia.</p>`
      : `<div class="big">✓ Ingreso registrado ${esc(d.hora)}</div>${fichaEst(e)}
         <div class="msg"><div class="small">${d.avisados ? "Aviso enviado a la familia por correo y notificación" : "Este estudiante no tiene representantes con avisos activos"}</div>
         <p style="margin:6px 0 0"><b>Campus Norte:</b> ${esc(e.nombres)} ingresó al campus a las ${esc(d.hora)}.</p></div>`);
    cargarEstudiantes();
  } catch (err) { mostrar($("r1"), "bad", `<div class="big">Sin conexión</div><p>${esc(err.message)}</p>`); }
}
$("buscar1").onclick = () => $("est1").value ? consultar($("est1").value) : $("est1").focus();

let lector = null, ultimo = "", tUlt = 0;
$("cam1").onclick = async () => {
  if (lector) { await lector.stop().catch(() => {}); lector = null; $("cam1").textContent = "Abrir cámara"; return; }
  try {
    lector = new Html5Qrcode("lector");
    await lector.start({ facingMode: "environment" }, { fps: 10, qrbox: 220 }, (txt) => {
      const now = Date.now();
      if (txt === ultimo && now - tUlt < 4000) return;
      ultimo = txt; tUlt = now; consultar(txt);
    });
    $("cam1").textContent = "Cerrar cámara";
  } catch {
    lector = null;
    mostrar($("r1"), "bad", `<div class="big">Cámara no disponible</div><p>Permite el acceso a la cámara o usa el ingreso manual.</p>`);
  }
};

// ---------- Salida segura ----------
$("ced2").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10)));
$("f-salida").onsubmit = async (ev) => {
  ev.preventDefault();
  const ced = $("ced2").value.trim(), codigo = $("est2").value;
  if (!codigo) return $("est2").focus();
  if (!/^\d{10}$/.test(ced)) { $("ced2").focus(); return mostrar($("r2"), "bad", `<div class="big">Cédula incompleta</div><p>Debe tener 10 dígitos.</p>`); }
  $("ver2").disabled = true;
  try {
    const d = await rpc("cn_verificar_salida", { p_estudiante: codigo, p_cedula: ced });
    const e = d.estudiante;
    if (d.ok) {
      senal(true);
      mostrar($("r2"), "ok", `<div class="big">✓ RETIRO AUTORIZADO · ${esc(d.hora)}</div>
        ${e ? fichaEst(e) : ""}
        <div class="persona">${avatar(d.adulto, d.foto_url)}<div><span class="small">Adulto que retira</span><br><b>${esc(d.adulto)}</b> · ${esc(d.parentesco)}</div></div>
        ${d.temporal ? `<div class="aviso" style="margin-top:12px"><b>Pase temporal creado por la familia.</b> Compare el nombre con la cédula física antes de entregar.</div>`
                     : `<p>Confirme que la persona coincide con la foto y con su cédula.</p>`}
        <p class="small">La familia ya recibió el aviso de salida.</p>`);
      $("ced2").value = "";
    } else if (d.invalido) {
      senal(false);
      mostrar($("r2"), "bad", `<div class="big">No se puede registrar la salida</div>${e ? fichaEst(e) : ""}<p>${esc(d.mensaje)}</p>`);
    } else {
      senal(false);
      const contactos = (d.contactos || []).map((c) =>
        `<li><span><b>${esc(c.nombre)}</b> · ${esc(c.parentesco)}</span>${c.telefono ? `<a class="btn chico" href="tel:${esc(c.telefono)}">Llamar</a>` : ""}</li>`).join("");
      mostrar($("r2"), "bad", `<div class="big">✕ NO AUTORIZADO</div>${e ? fichaEst(e) : ""}
        <p><b>${esc(d.mensaje)}</b> Mantenga al estudiante en el campus y avise a coordinación. La familia ya fue alertada y el intento quedó registrado.</p>
        ${contactos ? `<h3>Contactar a la familia</h3><ul class="lista">${contactos}</ul>` : ""}`);
    }
    cargarEstudiantes();
  } catch (err) { mostrar($("r2"), "bad", `<div class="big">Sin conexión</div><p>${esc(err.message)}</p>`); }
  finally { $("ver2").disabled = false; }
};

// ---------- Panel ----------
async function cargarPanel() {
  try {
    const d = await rpc("cn_panel");
    const pres = d.grados.reduce((a, g) => a + g.presentes, 0), ret = d.grados.reduce((a, g) => a + g.retirados, 0);
    $("k-pres").textContent = pres;
    $("k-ret").textContent = ret;
    $("k-aus").textContent = d.total - pres - ret;
    $("k-rech").textContent = d.rechazos;
    $("k-rech-box").classList.toggle("alerta", d.rechazos > 0);
    $("k-act").textContent = "Actualizado " + new Date().toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" }) + " · se actualiza solo cada 20 segundos.";
    $("t-grados").innerHTML = d.grados.map((g) => `<tr><td>${esc(g.nombre)}</td><td>${g.presentes} / ${g.total}</td>
      <td><div class="bar"><i style="width:${g.total ? Math.round(g.presentes / g.total * 100) : 0}%"></i></div></td><td>${g.retirados}</td></tr>`).join("");
    const et = { ingreso: "Ingreso", salida: "Salida", intento_rechazado: "Alerta" };
    $("t-mov").innerHTML = d.recientes.length
      ? d.recientes.map((m) => `<tr><td>${esc(m.hora)}</td><td><span class="pill p-${esc(m.tipo)}">${esc(et[m.tipo] || m.tipo)}</span></td>
          <td>${esc(m.estudiante)}${m.adulto ? `<br><span class="small">con ${esc(m.adulto)}</span>` : ""}${m.observacion ? `<br><span class="small">${esc(m.observacion)}</span>` : ""}</td></tr>`).join("")
      : `<tr><td class="small">Aún no hay movimientos hoy.</td></tr>`;
  } catch (err) { $("t-grados").innerHTML = `<tr><td>${esc(err.message)}</td></tr>`; }
}
$("refrescar").onclick = cargarPanel;
$("reiniciar").onclick = async () => {
  if (!confirm("¿Borrar todos los movimientos de hoy y reactivar los carnets? Solo para la demo.")) return;
  try { await rpc("cn_demo_reiniciar"); toast("Demo reiniciada"); cargarPanel(); cargarEstudiantes(); }
  catch (e) { toast(e.message); }
};

// ---------- Carnets (coordinación) ----------
async function cargarCarnets() {
  try {
    const lista = await rpc("cn_carnets");
    $("carnets").innerHTML = lista.map((c, i) => `<div class="carnet ${c.activa ? "" : "inactivo"}">
      <b>${esc(c.nombre)}</b><div class="small">${esc(c.grado)}</div>
      <div class="qr" id="qr${i}"></div>
      <div class="small">${esc(c.codigo)} ${c.activa ? "" : "· <b style='color:var(--bad)'>DESACTIVADO</b>"}</div>
      <div class="acciones">
        ${c.activa ? `<button class="btn sec chico" data-perder="${esc(c.codigo)}">Reportar extraviado</button>` : ""}
        <button class="btn sec chico" data-reemitir="${esc(c.codigo)}">Reemitir carnet</button>
      </div></div>`).join("");
    lista.forEach((c, i) => c.qr && new QRCode($("qr" + i), { text: c.qr, width: 128, height: 128 }));
  } catch (e) { $("carnets").innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
$("carnets").onclick = async (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.perder) {
      const r = await rpc("cn_carnet_extraviado", { p_codigo: b.dataset.perder });
      toast(r.ok ? "Carnet desactivado. Si alguien lo escanea, será rechazado y la familia recibirá una alerta." : "El carnet ya estaba desactivado");
    } else if (b.dataset.reemitir) {
      if (!confirm("Se generará un QR nuevo y el anterior dejará de funcionar. ¿Continuar?")) { b.disabled = false; return; }
      await rpc("cn_carnet_reemitir", { p_codigo: b.dataset.reemitir });
      toast("Carnet nuevo emitido");
    }
    cargarCarnets();
  } catch (e) { toast(e.message); b.disabled = false; }
};
$("imprimir").onclick = () => window.print();
