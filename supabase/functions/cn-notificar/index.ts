// Control de Ingreso · Campus Norte — envío de avisos a las familias
//
// GET  → devuelve la llave pública VAPID (la crea la primera vez y guarda la
//        privada en Supabase Vault; nunca sale del servidor).
// POST → procesa la bandeja campus_norte.notificaciones (correo + push).
//        No recibe datos del cliente: solo envía lo que ya está pendiente, así
//        que llamarla de más no tiene efectos indeseados.
//
// Configuración (Vault o variables de entorno de la función):
//   cn_resend_api_key / RESEND_API_KEY   API key de https://resend.com
//   cn_mail_from      / MAIL_FROM        "Campus Norte <avisos@tu-dominio>"
//   cn_portal_url     / PORTAL_URL       URL pública de padre.html
//   cn_vapid_subject  / VAPID_SUBJECT    "mailto:coordinacion@tu-dominio"

import postgres from "npm:postgres@3.4.5";
import webpush from "npm:web-push@3.6.7";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function secretos(): Promise<Record<string, string>> {
  const rows = await sql`select name, decrypted_secret from vault.decrypted_secrets where name like 'cn\_%'`;
  return Object.fromEntries(rows.map((r) => [r.name as string, r.decrypted_secret as string]));
}

const b64url = (buf: Uint8Array) =>
  btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function llavesVapid(): Promise<{ pub: string; priv: string }> {
  const s = await secretos();
  if (s.cn_vapid_public && s.cn_vapid_private) return { pub: s.cn_vapid_public, priv: s.cn_vapid_private };
  return await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('cn_vapid'))`;
    const ya = await tx`select name, decrypted_secret from vault.decrypted_secrets where name in ('cn_vapid_public','cn_vapid_private')`;
    const m = Object.fromEntries(ya.map((r) => [r.name, r.decrypted_secret]));
    if (m.cn_vapid_public && m.cn_vapid_private) return { pub: m.cn_vapid_public, priv: m.cn_vapid_private };
    const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", par.privateKey);
    const raw = new Uint8Array(65);
    raw[0] = 4; raw.set(deB64url(jwk.x!), 1); raw.set(deB64url(jwk.y!), 33);
    const pub = b64url(raw), priv = jwk.d!;
    await tx`select vault.create_secret(${pub}, 'cn_vapid_public', 'Control de Ingreso: llave pública VAPID')`;
    await tx`select vault.create_secret(${priv}, 'cn_vapid_private', 'Control de Ingreso: llave privada VAPID')`;
    return { pub, priv };
  });
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function htmlCorreo(asunto: string, cuerpo: string, urgente: boolean, portal: string) {
  const color = urgente ? "#c2362b" : "#0f4c81";
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f3f6f8;font-family:Arial,Helvetica,sans-serif;color:#14232e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #d9e2e8">
<tr><td style="background:${color};color:#fff;padding:16px 20px;font-size:14px;font-weight:bold">ANAI · Campus Norte${urgente ? " · AVISO IMPORTANTE" : ""}</td></tr>
<tr><td style="padding:20px">
<h1 style="font-size:20px;margin:0 0 10px;color:${color}">${esc(asunto)}</h1>
<p style="font-size:16px;line-height:1.5;margin:0 0 20px">${esc(cuerpo)}</p>
<a href="${esc(portal)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">Abrir el portal de familias</a>
</td></tr>
<tr><td style="padding:14px 20px;font-size:12px;color:#5b6b77;border-top:1px solid #d9e2e8">
Recibes este correo porque eres representante registrado. Puedes cambiar tus avisos desde el portal, en la sección «Avisos».
</td></tr></table></td></tr></table></body></html>`;
}

async function procesar() {
  const s = await secretos();
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? s.cn_resend_api_key;
  const from = Deno.env.get("MAIL_FROM") ?? s.cn_mail_from ?? "Campus Norte <onboarding@resend.dev>";
  const portal = Deno.env.get("PORTAL_URL") ?? s.cn_portal_url ??
    "https://jonathanheredia88.github.io/control-ingreso-demo/padre.html";
  const subject = Deno.env.get("VAPID_SUBJECT") ?? s.cn_vapid_subject ?? "mailto:avisos@campusnorte.example";

  const lote = await sql`
    update campus_norte.notificaciones n set estado = 'procesando', intentos = intentos + 1
     where id in (select id from campus_norte.notificaciones
                   where (estado = 'pendiente' or (estado = 'procesando' and creado_en < now() - interval '5 minutes'))
                     and intentos < 3
                   order by id limit 50 for update skip locked)
    returning n.id, n.canal, n.destino, n.asunto, n.cuerpo, n.urgente`;
  if (!lote.length) return { procesadas: 0 };

  let vapid: { pub: string; priv: string } | null = null;
  if (lote.some((n) => n.canal === "push")) {
    vapid = await llavesVapid();
    webpush.setVapidDetails(subject, vapid.pub, vapid.priv);
  }

  const resumen = { enviadas: 0, errores: 0, omitidas: 0 };
  for (const n of lote) {
    let estado = "enviada", error: string | null = null;
    try {
      if (n.canal === "email") {
        if (!resendKey) {
          estado = "omitida"; error = "Correo no configurado: falta cn_resend_api_key";
        } else {
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from, to: [n.destino], subject: (n.urgente ? "⚠️ " : "") + n.asunto,
              html: htmlCorreo(n.asunto, n.cuerpo, n.urgente, portal),
              text: `${n.asunto}\n\n${n.cuerpo}\n\nPortal de familias: ${portal}`,
            }),
          });
          if (!r.ok) { estado = "error"; error = `Resend ${r.status}: ${(await r.text()).slice(0, 300)}`; }
        }
      } else {
        const [sub] = await sql`select endpoint, p256dh, auth from campus_norte.push_suscripciones where endpoint = ${n.destino}`;
        if (!sub) {
          estado = "omitida"; error = "El dispositivo ya no está suscrito";
        } else {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title: n.asunto, body: n.cuerpo, urgente: n.urgente, url: "./padre.html", tag: `cn-${n.id}` }),
            { TTL: n.urgente ? 3600 : 21600, urgency: n.urgente ? "high" : "normal" },
          );
        }
      }
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (n.canal === "push" && (status === 404 || status === 410)) {
        await sql`delete from campus_norte.push_suscripciones where endpoint = ${n.destino}`;
        estado = "omitida"; error = "Suscripción vencida: se eliminó el dispositivo";
      } else {
        estado = "error"; error = String((e as Error)?.message ?? e).slice(0, 300);
      }
    }
    // Reintento: un error transitorio vuelve a 'pendiente' hasta 3 intentos
    const final = estado === "error" ? sql`case when intentos < 3 then 'pendiente' else 'error' end` : estado;
    await sql`update campus_norte.notificaciones
                 set estado = ${final}, error = ${error},
                     enviado_en = ${estado === "enviada" ? sql`now()` : null}
               where id = ${n.id}`;
    resumen[estado === "enviada" ? "enviadas" : estado === "omitida" ? "omitidas" : "errores"]++;
  }
  return { procesadas: lote.length, ...resumen };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    if (req.method === "GET") return json({ vapid_public: (await llavesVapid()).pub });
    if (req.method === "POST") return json(await procesar());
    return json({ error: "Método no permitido" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Error interno" }, 500);
  }
});
