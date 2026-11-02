# Control de Ingreso · ANAI Campus Norte

Demo con datos ficticios. Dos aplicaciones web sobre Supabase:

| Página | Para quién | Qué hace |
|---|---|---|
| `index.html` | Guardias y coordinación | Ingreso por QR o manual, salida segura con cédula, panel del día en vivo, carnets (solo coordinación) |
| `padre.html` | Padres y representantes | Estado del día de cada hijo, historial, pases temporales de retiro, avisos por correo y push. Se instala como app (PWA) |

## Seguridad

- **Acceso con sesión**: enlace mágico al correo (sin contraseñas). Ninguna función es ejecutable sin sesión.
- **Roles por correo**: `campus_norte.personal` (guardia / coordinación) y `campus_norte.adultos.email` (familias).
  Una familia solo ve a los estudiantes donde `autorizaciones.acceso_portal = true`.
- **QR aleatorios** (`CN1-…`): no se pueden adivinar ni recorrer. Reportar un carnet como extraviado lo bloquea al instante; reemitirlo crea un código nuevo.
- **Las cédulas nunca llegan al navegador.** Ante una cédula no autorizada, el sistema no revela de quién es.
- **Todo texto se escapa** antes de mostrarse (se corrigió una vulnerabilidad XSS en el panel).
- Un estudiante no puede salir si no registró ingreso hoy ni salir dos veces. El ingreso duplicado no genera un segundo aviso.

## Avisos a las familias

Cada ingreso, salida o intento rechazado dispara un trigger que llena la bandeja `campus_norte.notificaciones`.
Luego la función Edge `cn-notificar` envía:

- **Correo** con [Resend](https://resend.com) (plan gratuito: 3 000 correos al mes).
- **Notificación push** (Web Push con llaves VAPID que la función genera y guarda en Supabase Vault).

Las alertas de seguridad (retiro no autorizado, carnet extraviado usado) se envían siempre, aunque la familia haya desactivado los avisos.

## Puesta en marcha

1. **Base de datos**: aplicar `supabase/migrations/*.sql`, ya aplicada en el proyecto demo.
2. **Función**: desplegar `supabase/functions/cn-notificar` con `verify_jwt = false`. La función no recibe datos; solo procesa la bandeja.
3. **Auth → URL Configuration** en Supabase: pon como *Site URL* la dirección pública de la app y agrega a *Redirect URLs*
   `https://<tu-sitio>/index.html` y `https://<tu-sitio>/padre.html`.
4. **Correo de avisos**: crea una API key en Resend y guárdala en el SQL Editor:
   ```sql
   select vault.create_secret('re_xxx', 'cn_resend_api_key');
   select vault.create_secret('Campus Norte <avisos@tu-dominio.com>', 'cn_mail_from');   -- requiere dominio verificado en Resend
   select vault.create_secret('https://<tu-sitio>/padre.html', 'cn_portal_url');
   ```
   Sin dominio verificado, Resend solo entrega a la dirección dueña de la cuenta (sirve para probar).
5. **Correo de acceso (login)**: el SMTP incluido en Supabase solo envía a miembros del equipo y tiene un límite bajo por hora.
   Para familias reales, configura un SMTP propio en *Auth → SMTP Settings*; Resend también ofrece SMTP.
   Opcional: en *Auth → Email Templates → Magic Link* agrega `{{ .Token }}` para que llegue también un código de 6 dígitos.
   Es útil en iPhone cuando la app está instalada.

## Dar de alta personas

```sql
-- Personal
insert into campus_norte.personal(email, nombre, rol) values ('guardia@colegio.edu.ec', 'Luis Pérez', 'guardia');
-- Familia: registra su correo en el adulto
update campus_norte.adultos set email = 'madre@correo.com' where cedula = '09xxxxxxxx';
```

## Probar la demo

1. Entra a `index.html` con un correo de coordinación y registra el ingreso de Valentina (manual o escaneando su carnet).
2. En **Salida segura**, prueba la cédula `0900000009` (no autorizada). La familia recibe una alerta urgente.
3. En `padre.html` (con el correo de María, la representante de Valentina) crea un pase temporal y úsalo en la salida.
4. **Panel → Reiniciar demo** borra los movimientos del día.
