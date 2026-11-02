-- =====================================================================
-- Control de Ingreso · Campus Norte
-- Seguridad (acceso con login y roles) + Portal del padre + avisos
-- =====================================================================
-- Principios:
--  * Ninguna función es ejecutable por el rol anónimo. Todo requiere sesión.
--  * Los roles se resuelven por correo: campus_norte.personal (guardia /
--    coordinacion) y campus_norte.adultos.email (padres y representantes).
--  * Las tablas siguen con RLS activo y sin políticas: solo se accede por
--    las funciones de abajo (SECURITY DEFINER), que validan el rol.
--  * Los QR pasan a ser tokens aleatorios (no adivinables ni secuenciales).
--  * Nunca se devuelven cédulas al navegador.
-- =====================================================================

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Tablas y columnas nuevas
-- ---------------------------------------------------------------------
create table if not exists campus_norte.personal(
  email      text primary key check (email = lower(email)),
  nombre     text not null,
  rol        text not null check (rol in ('guardia','coordinacion')),
  activo     boolean not null default true,
  creado_en  timestamptz not null default now()
);
alter table campus_norte.personal enable row level security;

alter table campus_norte.adultos
  add column if not exists avisos_email boolean not null default true,
  add column if not exists avisos_push  boolean not null default true;
create unique index if not exists adultos_email_uq on campus_norte.adultos (lower(email)) where email is not null;

-- Quién puede entrar al portal y recibir avisos de cada estudiante
alter table campus_norte.autorizaciones
  add column if not exists acceso_portal boolean not null default false;
update campus_norte.autorizaciones
   set acceso_portal = true
 where es_representante or parentesco in ('Madre','Padre');

create table if not exists campus_norte.pases_temporales(
  id             uuid primary key default gen_random_uuid(),
  estudiante_id  uuid not null references campus_norte.estudiantes(id) on delete cascade,
  cedula         text not null check (cedula ~ '^[0-9]{10}$'),
  nombre         text not null check (char_length(nombre) between 3 and 80),
  parentesco     text check (char_length(parentesco) <= 40),
  fecha          date not null,
  creado_por     uuid references campus_norte.adultos(id) on delete set null,
  creado_en      timestamptz not null default now(),
  usado_en       timestamptz,
  anulado        boolean not null default false
);
alter table campus_norte.pases_temporales enable row level security;

alter table campus_norte.registros
  add column if not exists cedula_presentada text,
  add column if not exists pase_id uuid references campus_norte.pases_temporales(id) on delete set null;

create table if not exists campus_norte.push_suscripciones(
  endpoint   text primary key,
  adulto_id  uuid not null references campus_norte.adultos(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  agente     text,
  creado_en  timestamptz not null default now()
);
alter table campus_norte.push_suscripciones enable row level security;

-- Bandeja de salida: cada aviso por correo o push queda registrado
create table if not exists campus_norte.notificaciones(
  id           bigint generated always as identity primary key,
  registro_id  bigint references campus_norte.registros(id) on delete cascade,
  adulto_id    uuid references campus_norte.adultos(id) on delete cascade,
  canal        text not null check (canal in ('email','push')),
  destino      text not null,
  asunto       text not null,
  cuerpo       text not null,
  urgente      boolean not null default false,
  estado       text not null default 'pendiente'
               check (estado in ('pendiente','procesando','enviada','error','omitida')),
  intentos     int not null default 0,
  error        text,
  creado_en    timestamptz not null default now(),
  enviado_en   timestamptz
);
create index if not exists notificaciones_pendientes on campus_norte.notificaciones (id)
  where estado in ('pendiente','procesando');
alter table campus_norte.notificaciones enable row level security;

-- ---------------------------------------------------------------------
-- 2. QR aleatorios: los códigos secuenciales dejan de funcionar
-- ---------------------------------------------------------------------
create or replace function campus_norte.nuevo_token() returns text
language sql volatile set search_path = '' as $$
  select 'CN1-' || translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', '-_')
$$;
update campus_norte.credenciales set codigo_qr = campus_norte.nuevo_token();
create unique index if not exists credenciales_codigo_qr_uq on campus_norte.credenciales (codigo_qr);

-- ---------------------------------------------------------------------
-- 3. Funciones auxiliares (esquema privado)
-- ---------------------------------------------------------------------
create or replace function campus_norte.hoy() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Guayaquil')::date
$$;

create or replace function campus_norte.inicio_hoy() returns timestamptz
language sql stable set search_path = '' as $$
  select campus_norte.hoy()::timestamp at time zone 'America/Guayaquil'
$$;

create or replace function campus_norte.hora(t timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(t at time zone 'America/Guayaquil', 'HH24:MI')
$$;

create or replace function campus_norte.mi_email() returns text
language sql stable set search_path = '' as $$
  select lower(nullif(auth.jwt() ->> 'email', ''))
$$;

create or replace function campus_norte.mi_rol() returns text
language sql stable security definer set search_path = '' as $$
  select rol from campus_norte.personal where email = campus_norte.mi_email() and activo
$$;

create or replace function campus_norte.exigir_personal(p_roles text[] default array['guardia','coordinacion'])
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text := campus_norte.mi_rol();
begin
  if v is null or not (v = any(p_roles)) then
    raise exception 'Acceso solo para personal autorizado' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function campus_norte.mi_adulto() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from campus_norte.adultos
   where campus_norte.mi_email() is not null and lower(email) = campus_norte.mi_email()
$$;

create or replace function campus_norte.vigente(au campus_norte.autorizaciones) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(au.vigente_desde, campus_norte.hoy()) <= campus_norte.hoy()
     and (au.vigente_hasta is null or au.vigente_hasta >= campus_norte.hoy())
$$;

-- ¿El adulto con sesión puede ver a este estudiante en el portal?
create or replace function campus_norte.puede_ver(p_est uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from campus_norte.autorizaciones au
     where au.estudiante_id = p_est and au.adulto_id = campus_norte.mi_adulto()
       and au.acceso_portal and campus_norte.vigente(au))
$$;

create or replace function campus_norte.estudiante_por_codigo(p_codigo text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from campus_norte.estudiantes where codigo = upper(trim(p_codigo)) and activo
$$;

-- Último movimiento de hoy (ingreso o salida)
create or replace function campus_norte.ultimo_mov(p_est uuid) returns campus_norte.registros
language sql stable security definer set search_path = '' as $$
  select r.* from campus_norte.registros r
   where r.estudiante_id = p_est and r.tipo in ('ingreso','salida')
     and r.creado_en >= campus_norte.inicio_hoy()
   order by r.creado_en desc limit 1
$$;

-- 'presente' | 'retirado' | 'ausente' según el ÚLTIMO movimiento del día
create or replace function campus_norte.estado(p_est uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select case r.tipo when 'ingreso' then 'presente' else 'retirado' end
                     from campus_norte.registros r
                    where r.estudiante_id = p_est and r.tipo in ('ingreso','salida')
                      and r.creado_en >= campus_norte.inicio_hoy()
                    order by r.creado_en desc limit 1), 'ausente')
$$;

create or replace function campus_norte.ficha(p_est uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'codigo', e.codigo, 'nombres', e.nombres, 'apellidos', e.apellidos,
    'grado', g.nombre, 'modo_salida', g.modo_salida, 'notas_salud', e.notas_salud,
    'foto_url', e.foto_url, 'salida_autonoma', e.salida_autonoma)
  from campus_norte.estudiantes e join campus_norte.grados g on g.id = e.grado_id
  where e.id = p_est
$$;

-- Autorizados vigentes SIN cédula (solo nombre, parentesco y foto)
create or replace function campus_norte.autorizados_json(p_est uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'nombre', a.nombres || ' ' || a.apellidos, 'parentesco', au.parentesco,
           'es_representante', au.es_representante, 'foto_url', a.foto_url)
         order by au.es_representante desc, a.apellidos), '[]'::jsonb)
  from campus_norte.autorizaciones au join campus_norte.adultos a on a.id = au.adulto_id
  where au.estudiante_id = p_est and campus_norte.vigente(au)
$$;

-- Texto del aviso que recibe la familia por cada movimiento
create or replace function campus_norte.texto_evento(r campus_norte.registros) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when r.tipo = 'ingreso' then jsonb_build_object(
      'titulo', e.nombres || ' llegó al campus',
      'cuerpo', e.nombres || ' ingresó a Campus Norte a las ' || campus_norte.hora(r.creado_en)
                || ' por ' || coalesce(lower(r.punto_acceso), 'la puerta principal') || '.',
      'urgente', false)
    when r.tipo = 'salida' then jsonb_build_object(
      'titulo', e.nombres || ' salió del campus',
      'cuerpo', e.nombres || ' salió a las ' || campus_norte.hora(r.creado_en) || ' con '
                || coalesce(a.nombres || ' ' || a.apellidos, p.nombre, 'un adulto autorizado')
                || coalesce(' (' || coalesce(au.parentesco, p.parentesco, 'pase temporal') || ')', '') || '.',
      'urgente', false)
    when r.tipo = 'intento_rechazado' and r.cedula_presentada is not null then jsonb_build_object(
      'titulo', 'Intento de retiro no autorizado',
      'cuerpo', 'A las ' || campus_norte.hora(r.creado_en) || ' una persona que no está autorizada intentó retirar a '
                || e.nombres || '. ' || e.nombres || ' permanece en el campus bajo cuidado del personal y '
                || 'coordinación ya fue alertada. Si enviaste a alguien, crea un pase temporal desde el portal.',
      'urgente', true)
    when r.tipo = 'intento_rechazado' then jsonb_build_object(
      'titulo', 'Se usó un carnet desactivado',
      'cuerpo', 'A las ' || campus_norte.hora(r.creado_en) || ' alguien intentó usar el carnet de '
                || e.nombres || ', que fue reportado como extraviado. El acceso fue bloqueado.',
      'urgente', true)
  end
  from campus_norte.estudiantes e
  left join campus_norte.adultos a on a.id = r.adulto_id
  left join campus_norte.autorizaciones au on au.adulto_id = r.adulto_id and au.estudiante_id = r.estudiante_id
  left join campus_norte.pases_temporales p on p.id = r.pase_id
  where e.id = r.estudiante_id
  limit 1
$$;

-- Pide a la función Edge que procese la bandeja de salida (asíncrono)
create or replace function campus_norte.despachar_avisos() returns void
language sql security definer set search_path = '' as $$
  select net.http_post(
    url     := 'https://fyfqvwvwqnowdzusggaw.supabase.co/functions/v1/cn-notificar',
    body    := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb);
$$;

-- Trigger: cada movimiento genera avisos para las familias con acceso al portal
create or replace function campus_norte.tg_notificar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_txt jsonb; v_urg boolean;
begin
  if new.estudiante_id is null then return null; end if;
  v_txt := campus_norte.texto_evento(new);
  if v_txt is null then return null; end if;
  v_urg := (v_txt ->> 'urgente')::boolean;

  insert into campus_norte.notificaciones(registro_id, adulto_id, canal, destino, asunto, cuerpo, urgente)
  select distinct on (a.id) new.id, a.id, 'email', a.email, v_txt ->> 'titulo', v_txt ->> 'cuerpo', v_urg
    from campus_norte.autorizaciones au join campus_norte.adultos a on a.id = au.adulto_id
   where au.estudiante_id = new.estudiante_id and au.acceso_portal and campus_norte.vigente(au)
     and a.email is not null and (a.avisos_email or v_urg);

  insert into campus_norte.notificaciones(registro_id, adulto_id, canal, destino, asunto, cuerpo, urgente)
  select distinct on (s.endpoint) new.id, a.id, 'push', s.endpoint, v_txt ->> 'titulo', v_txt ->> 'cuerpo', v_urg
    from campus_norte.autorizaciones au
    join campus_norte.adultos a on a.id = au.adulto_id
    join campus_norte.push_suscripciones s on s.adulto_id = a.id
   where au.estudiante_id = new.estudiante_id and au.acceso_portal and campus_norte.vigente(au)
     and (a.avisos_push or v_urg);

  if exists (select 1 from campus_norte.notificaciones where registro_id = new.id) then
    perform campus_norte.despachar_avisos();
  end if;
  return null;
end $$;

drop trigger if exists registros_notificar on campus_norte.registros;
create trigger registros_notificar after insert on campus_norte.registros
  for each row execute function campus_norte.tg_notificar();

-- ---------------------------------------------------------------------
-- 4. Se eliminan las funciones antiguas (abiertas al rol anónimo)
-- ---------------------------------------------------------------------
drop function if exists public.cn_escanear(text, text);
drop function if exists public.cn_verificar_salida(text, text);
drop function if exists public.cn_panel();
drop function if exists public.cn_demo_reiniciar();
drop function if exists public.cn_demo_desactivar(text);

-- ---------------------------------------------------------------------
-- 5. API común
-- ---------------------------------------------------------------------
create or replace function public.cn_yo() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'email', campus_norte.mi_email(),
    'rol', campus_norte.mi_rol(),
    'nombre', coalesce(
       (select nombre from campus_norte.personal where email = campus_norte.mi_email() and activo),
       (select nombres from campus_norte.adultos where id = campus_norte.mi_adulto())),
    'es_padre', exists(
       select 1 from campus_norte.autorizaciones au
        where au.adulto_id = campus_norte.mi_adulto() and au.acceso_portal and campus_norte.vigente(au)))
$$;

-- ---------------------------------------------------------------------
-- 6. API del personal (guardia y coordinación)
-- ---------------------------------------------------------------------
create or replace function public.cn_estudiantes() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform campus_norte.exigir_personal();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'codigo', e.codigo, 'nombre', e.nombres || ' ' || e.apellidos,
            'grado', g.nombre, 'estado', campus_norte.estado(e.id))
          order by g.orden, e.apellidos, e.nombres), '[]'::jsonb)
          from campus_norte.estudiantes e join campus_norte.grados g on g.id = e.grado_id
          where e.activo);
end $$;

-- p_codigo: token del QR o, para ingreso manual, el código del estudiante (CN-2027-0001)
create or replace function public.cn_escanear(p_codigo text, p_tipo text default 'consulta') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cod text := trim(coalesce(p_codigo, ''));
  v_est uuid; v_activa boolean; v_manual boolean := false;
  v_ult campus_norte.registros; v_t timestamptz;
begin
  perform campus_norte.exigir_personal();
  if p_tipo not in ('consulta','ingreso') then raise exception 'Tipo no válido'; end if;
  if v_cod = '' or length(v_cod) > 64 then
    return jsonb_build_object('ok', false, 'mensaje', 'Código vacío o no válido');
  end if;

  select c.estudiante_id, c.activa into v_est, v_activa
    from campus_norte.credenciales c where c.codigo_qr = v_cod;
  if found then
    if not v_activa then
      insert into campus_norte.registros(tipo, estudiante_id, observacion, registrado_por)
      values ('intento_rechazado', v_est, 'Carnet desactivado (reportado como extraviado)', campus_norte.mi_email());
      return jsonb_build_object('ok', false, 'mensaje',
        'Carnet desactivado: fue reportado como extraviado. Verifique la identidad y use el ingreso manual.');
    end if;
  else
    v_est := campus_norte.estudiante_por_codigo(v_cod);
    if v_est is null then
      return jsonb_build_object('ok', false, 'mensaje', 'Código no registrado');
    end if;
    v_manual := true;
  end if;

  v_ult := campus_norte.ultimo_mov(v_est);

  if p_tipo = 'ingreso' then
    if v_ult.tipo = 'ingreso' then
      return jsonb_build_object('ok', true, 'ya_registrado', true,
        'hora', campus_norte.hora(v_ult.creado_en), 'estudiante', campus_norte.ficha(v_est));
    end if;
    insert into campus_norte.registros(tipo, estudiante_id, registrado_por, observacion)
    values ('ingreso', v_est, campus_norte.mi_email(), case when v_manual then 'Ingreso manual (sin carnet)' end)
    returning creado_en into v_t;
    return jsonb_build_object('ok', true, 'ya_registrado', false, 'hora', campus_norte.hora(v_t),
      'estudiante', campus_norte.ficha(v_est),
      'avisados', (select count(distinct au.adulto_id) from campus_norte.autorizaciones au
                    where au.estudiante_id = v_est and au.acceso_portal and campus_norte.vigente(au)));
  end if;

  return jsonb_build_object('ok', true, 'manual', v_manual,
    'estado', case v_ult.tipo when 'ingreso' then 'presente' when 'salida' then 'retirado' else 'ausente' end,
    'hora_estado', campus_norte.hora(v_ult.creado_en),
    'estudiante', campus_norte.ficha(v_est),
    'autorizados', campus_norte.autorizados_json(v_est));
end $$;

-- p_estudiante: código del estudiante o token del QR
create or replace function public.cn_verificar_salida(p_estudiante text, p_cedula text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ced text := regexp_replace(coalesce(p_cedula, ''), '[^0-9]', '', 'g');
  v_est uuid; v_ult campus_norte.registros; v_t timestamptz;
  v_aut record; v_pase record; v_quien text;
begin
  perform campus_norte.exigir_personal();
  if v_ced !~ '^[0-9]{10}$' then
    return jsonb_build_object('ok', false, 'invalido', true, 'mensaje', 'La cédula debe tener 10 dígitos.');
  end if;

  v_est := campus_norte.estudiante_por_codigo(p_estudiante);
  if v_est is null then
    select c.estudiante_id into v_est from campus_norte.credenciales c
     where c.codigo_qr = trim(coalesce(p_estudiante, '')) and c.activa;
  end if;
  if v_est is null then
    return jsonb_build_object('ok', false, 'invalido', true, 'mensaje', 'Estudiante no encontrado o carnet inactivo.');
  end if;

  v_ult := campus_norte.ultimo_mov(v_est);
  if v_ult.tipo is null then
    return jsonb_build_object('ok', false, 'invalido', true, 'estudiante', campus_norte.ficha(v_est),
      'mensaje', 'El estudiante no registra ingreso hoy. Verifique con coordinación antes de entregarlo.');
  end if;
  if v_ult.tipo = 'salida' then
    select coalesce(a.nombres || ' ' || a.apellidos, p.nombre) into v_quien
      from campus_norte.registros r
      left join campus_norte.adultos a on a.id = r.adulto_id
      left join campus_norte.pases_temporales p on p.id = r.pase_id
     where r.id = v_ult.id;
    return jsonb_build_object('ok', false, 'invalido', true, 'estudiante', campus_norte.ficha(v_est),
      'mensaje', 'Ya fue retirado hoy a las ' || campus_norte.hora(v_ult.creado_en)
                 || coalesce(' por ' || v_quien, '') || '.');
  end if;

  -- a) Autorización permanente
  select a.id, a.nombres || ' ' || a.apellidos as nombre, a.foto_url, au.parentesco into v_aut
    from campus_norte.autorizaciones au join campus_norte.adultos a on a.id = au.adulto_id
   where au.estudiante_id = v_est and a.cedula = v_ced and campus_norte.vigente(au)
   limit 1;
  if found then
    insert into campus_norte.registros(tipo, estudiante_id, adulto_id, registrado_por)
    values ('salida', v_est, v_aut.id, campus_norte.mi_email()) returning creado_en into v_t;
    return jsonb_build_object('ok', true, 'hora', campus_norte.hora(v_t), 'estudiante', campus_norte.ficha(v_est),
      'adulto', v_aut.nombre, 'parentesco', v_aut.parentesco, 'foto_url', v_aut.foto_url, 'temporal', false);
  end if;

  -- b) Pase temporal creado por la familia para hoy
  select p.id, p.nombre, p.parentesco into v_pase
    from campus_norte.pases_temporales p
   where p.estudiante_id = v_est and p.cedula = v_ced and p.fecha = campus_norte.hoy()
     and not p.anulado and p.usado_en is null
   order by p.creado_en desc limit 1;
  if found then
    update campus_norte.pases_temporales set usado_en = now() where id = v_pase.id;
    insert into campus_norte.registros(tipo, estudiante_id, pase_id, cedula_presentada, registrado_por, observacion)
    values ('salida', v_est, v_pase.id, v_ced, campus_norte.mi_email(), 'Retiro con pase temporal')
    returning creado_en into v_t;
    return jsonb_build_object('ok', true, 'hora', campus_norte.hora(v_t), 'estudiante', campus_norte.ficha(v_est),
      'adulto', v_pase.nombre, 'parentesco', coalesce(v_pase.parentesco, 'Pase temporal'), 'temporal', true);
  end if;

  -- c) No autorizado: se registra y se avisa (sin revelar a quién pertenece la cédula)
  insert into campus_norte.registros(tipo, estudiante_id, cedula_presentada, registrado_por, observacion)
  values ('intento_rechazado', v_est, v_ced, campus_norte.mi_email(), 'Intento de retiro por adulto no autorizado');
  return jsonb_build_object('ok', false, 'estudiante', campus_norte.ficha(v_est),
    'mensaje', 'Esta persona NO está autorizada para retirar al estudiante.',
    'contactos', (select coalesce(jsonb_agg(jsonb_build_object(
                    'nombre', a.nombres || ' ' || a.apellidos, 'parentesco', au.parentesco, 'telefono', a.telefono)
                  order by au.es_representante desc), '[]'::jsonb)
                  from campus_norte.autorizaciones au join campus_norte.adultos a on a.id = au.adulto_id
                  where au.estudiante_id = v_est and au.acceso_portal and campus_norte.vigente(au)));
end $$;

create or replace function public.cn_panel() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform campus_norte.exigir_personal();
  return jsonb_build_object(
    'total', (select count(*) from campus_norte.estudiantes where activo),
    'rechazos', (select count(*) from campus_norte.registros
                  where tipo = 'intento_rechazado' and creado_en >= campus_norte.inicio_hoy()),
    'grados', (select coalesce(jsonb_agg(x order by x.orden), '[]'::jsonb) from (
        select g.nombre, g.orden, count(e.id) as total,
               count(e.id) filter (where s.estado = 'presente') as presentes,
               count(e.id) filter (where s.estado = 'retirado') as retirados
          from campus_norte.grados g
          left join campus_norte.estudiantes e on e.grado_id = g.id and e.activo
          left join lateral (select campus_norte.estado(e.id) as estado) s on e.id is not null
         group by g.nombre, g.orden) x),
    'recientes', (select coalesce(jsonb_agg(y order by y.t desc), '[]'::jsonb) from (
        select r.creado_en as t, r.tipo, campus_norte.hora(r.creado_en) as hora,
               e.nombres || ' ' || e.apellidos as estudiante, r.observacion,
               coalesce(a.nombres || ' ' || a.apellidos, p.nombre) as adulto
          from campus_norte.registros r
          left join campus_norte.estudiantes e on e.id = r.estudiante_id
          left join campus_norte.adultos a on a.id = r.adulto_id
          left join campus_norte.pases_temporales p on p.id = r.pase_id
         where r.creado_en >= campus_norte.inicio_hoy()
         order by r.creado_en desc limit 15) y));
end $$;

create or replace function public.cn_carnets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform campus_norte.exigir_personal(array['coordinacion']);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'codigo', e.codigo, 'nombre', e.nombres || ' ' || e.apellidos, 'grado', g.nombre,
            'qr', c.codigo_qr, 'activa', coalesce(c.activa, false))
          order by g.orden, e.apellidos), '[]'::jsonb)
          from campus_norte.estudiantes e
          join campus_norte.grados g on g.id = e.grado_id
          left join lateral (select codigo_qr, activa from campus_norte.credenciales
                              where estudiante_id = e.id
                              order by activa desc, emitida_en desc limit 1) c on true
          where e.activo);
end $$;

create or replace function public.cn_carnet_extraviado(p_codigo text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform campus_norte.exigir_personal(array['coordinacion']);
  update campus_norte.credenciales set activa = false, motivo_baja = 'Reportado como extraviado'
   where estudiante_id = campus_norte.estudiante_por_codigo(p_codigo) and activa;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0);
end $$;

create or replace function public.cn_carnet_reemitir(p_codigo text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_est uuid := campus_norte.estudiante_por_codigo(p_codigo); v_qr text := campus_norte.nuevo_token();
begin
  perform campus_norte.exigir_personal(array['coordinacion']);
  if v_est is null then return jsonb_build_object('ok', false); end if;
  update campus_norte.credenciales set activa = false, motivo_baja = coalesce(motivo_baja, 'Reemplazado por nuevo carnet')
   where estudiante_id = v_est and activa;
  insert into campus_norte.credenciales(codigo_qr, estudiante_id) values (v_qr, v_est);
  return jsonb_build_object('ok', true, 'qr', v_qr);
end $$;

create or replace function public.cn_demo_reiniciar() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform campus_norte.exigir_personal(array['coordinacion']);
  delete from campus_norte.registros where creado_en >= campus_norte.inicio_hoy();
  update campus_norte.pases_temporales set usado_en = null where fecha = campus_norte.hoy();
  update campus_norte.credenciales c set activa = true, motivo_baja = null
   where not c.activa and c.id in (select distinct on (estudiante_id) id from campus_norte.credenciales
                                    order by estudiante_id, emitida_en desc);
end $$;

-- ---------------------------------------------------------------------
-- 7. API del portal del padre
-- ---------------------------------------------------------------------
create or replace function public.cn_padre_inicio() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_ad uuid := campus_norte.mi_adulto();
begin
  if v_ad is null then
    return jsonb_build_object('ok', false, 'mensaje',
      'Tu correo no está registrado como representante. Comunícate con secretaría para activarlo.');
  end if;
  return jsonb_build_object('ok', true,
    'adulto', (select jsonb_build_object('nombres', a.nombres, 'apellidos', a.apellidos, 'email', a.email,
                 'avisos_email', a.avisos_email, 'avisos_push', a.avisos_push,
                 'dispositivos', (select count(*) from campus_norte.push_suscripciones s where s.adulto_id = a.id))
               from campus_norte.adultos a where a.id = v_ad),
    'hijos', (select coalesce(jsonb_agg(campus_norte.ficha(e.id) || jsonb_build_object(
                 'parentesco', au.parentesco,
                 'estado', campus_norte.estado(e.id),
                 'hoy', (select coalesce(jsonb_agg(jsonb_build_object(
                            'tipo', r.tipo, 'hora', campus_norte.hora(r.creado_en),
                            'titulo', campus_norte.texto_evento(r) ->> 'titulo',
                            'detalle', campus_norte.texto_evento(r) ->> 'cuerpo',
                            'urgente', (campus_norte.texto_evento(r) ->> 'urgente')::boolean)
                          order by r.creado_en), '[]'::jsonb)
                         from campus_norte.registros r
                        where r.estudiante_id = e.id and r.creado_en >= campus_norte.inicio_hoy()),
                 'autorizados', campus_norte.autorizados_json(e.id),
                 'pases', (select coalesce(jsonb_agg(jsonb_build_object(
                              'id', p.id, 'nombre', p.nombre, 'parentesco', p.parentesco, 'fecha', p.fecha,
                              'cedula', '······' || right(p.cedula, 4),
                              'usado', p.usado_en is not null, 'hora_uso', campus_norte.hora(p.usado_en))
                            order by p.fecha, p.creado_en), '[]'::jsonb)
                           from campus_norte.pases_temporales p
                          where p.estudiante_id = e.id and p.fecha >= campus_norte.hoy() and not p.anulado))
               order by g.orden), '[]'::jsonb)
              from campus_norte.autorizaciones au
              join campus_norte.estudiantes e on e.id = au.estudiante_id
              join campus_norte.grados g on g.id = e.grado_id
             where au.adulto_id = v_ad and au.acceso_portal and campus_norte.vigente(au) and e.activo));
end $$;

create or replace function public.cn_padre_historial(p_codigo text, p_dias int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_est uuid := campus_norte.estudiante_por_codigo(p_codigo);
begin
  if v_est is null or not campus_norte.puede_ver(v_est) then
    raise exception 'No tienes acceso a este estudiante' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(d order by d.fecha desc), '[]'::jsonb) from (
    select (r.creado_en at time zone 'America/Guayaquil')::date as fecha,
           campus_norte.hora(min(r.creado_en) filter (where r.tipo = 'ingreso')) as entrada,
           campus_norte.hora(max(r.creado_en) filter (where r.tipo = 'salida')) as salida,
           (array_agg(coalesce(a.nombres || ' ' || a.apellidos, p.nombre) order by r.creado_en desc)
              filter (where r.tipo = 'salida'))[1] as salio_con,
           count(*) filter (where r.tipo = 'intento_rechazado') as alertas
      from campus_norte.registros r
      left join campus_norte.adultos a on a.id = r.adulto_id
      left join campus_norte.pases_temporales p on p.id = r.pase_id
     where r.estudiante_id = v_est
       and r.creado_en >= campus_norte.inicio_hoy() - make_interval(days => least(greatest(p_dias, 1), 120))
     group by 1) d);
end $$;

create or replace function public.cn_padre_crear_pase(p_codigo text, p_nombre text, p_cedula text,
                                                      p_parentesco text, p_fecha date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_est uuid := campus_norte.estudiante_por_codigo(p_codigo);
  v_ced text := regexp_replace(coalesce(p_cedula, ''), '[^0-9]', '', 'g');
  v_nom text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_par text := nullif(btrim(coalesce(p_parentesco, '')), '');
begin
  if v_est is null or not campus_norte.puede_ver(v_est) then
    raise exception 'No tienes acceso a este estudiante' using errcode = '42501';
  end if;
  if v_ced !~ '^[0-9]{10}$' then return jsonb_build_object('ok', false, 'mensaje', 'La cédula debe tener 10 dígitos.'); end if;
  if char_length(v_nom) not between 3 and 80 then return jsonb_build_object('ok', false, 'mensaje', 'Escribe el nombre completo de la persona.'); end if;
  if v_par is not null and char_length(v_par) > 40 then return jsonb_build_object('ok', false, 'mensaje', 'El parentesco es demasiado largo.'); end if;
  if p_fecha is null or p_fecha < campus_norte.hoy() or p_fecha > campus_norte.hoy() + 7 then
    return jsonb_build_object('ok', false, 'mensaje', 'Elige una fecha entre hoy y los próximos 7 días.');
  end if;
  if (select count(*) from campus_norte.pases_temporales
       where estudiante_id = v_est and fecha = p_fecha and not anulado) >= 3 then
    return jsonb_build_object('ok', false, 'mensaje', 'Ya hay 3 pases para ese día. Anula uno antes de crear otro.');
  end if;
  insert into campus_norte.pases_temporales(estudiante_id, cedula, nombre, parentesco, fecha, creado_por)
  values (v_est, v_ced, v_nom, v_par, p_fecha, campus_norte.mi_adulto());
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.cn_padre_anular_pase(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update campus_norte.pases_temporales p set anulado = true
   where p.id = p_id and p.usado_en is null and campus_norte.puede_ver(p.estudiante_id);
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n > 0);
end $$;

create or replace function public.cn_padre_preferencias(p_email boolean, p_push boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ad uuid := campus_norte.mi_adulto();
begin
  if v_ad is null then raise exception 'Sin acceso' using errcode = '42501'; end if;
  update campus_norte.adultos set avisos_email = coalesce(p_email, avisos_email),
                                  avisos_push = coalesce(p_push, avisos_push)
   where id = v_ad;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.cn_padre_push_guardar(p_endpoint text, p_p256dh text, p_auth text, p_agente text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ad uuid := campus_norte.mi_adulto();
begin
  if v_ad is null then raise exception 'Sin acceso' using errcode = '42501'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100 then
    raise exception 'Suscripción no válida';
  end if;
  if (select count(*) from campus_norte.push_suscripciones where adulto_id = v_ad) >= 10 then
    delete from campus_norte.push_suscripciones
     where endpoint = (select endpoint from campus_norte.push_suscripciones where adulto_id = v_ad order by creado_en limit 1);
  end if;
  insert into campus_norte.push_suscripciones(endpoint, adulto_id, p256dh, auth, agente)
  values (p_endpoint, v_ad, p_p256dh, p_auth, left(p_agente, 200))
  on conflict (endpoint) do update set adulto_id = excluded.adulto_id, p256dh = excluded.p256dh,
                                       auth = excluded.auth, agente = excluded.agente;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.cn_padre_push_borrar(p_endpoint text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  delete from campus_norte.push_suscripciones where endpoint = p_endpoint and adulto_id = campus_norte.mi_adulto();
  return jsonb_build_object('ok', true);
end $$;

-- Envía un aviso de prueba al propio padre (límite por hora)
create or replace function public.cn_padre_prueba() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ad uuid := campus_norte.mi_adulto(); v_n int;
begin
  if v_ad is null then raise exception 'Sin acceso' using errcode = '42501'; end if;
  if (select count(*) from campus_norte.notificaciones
       where adulto_id = v_ad and registro_id is null and creado_en > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'mensaje', 'Ya enviaste varias pruebas. Intenta en una hora.');
  end if;
  insert into campus_norte.notificaciones(adulto_id, canal, destino, asunto, cuerpo)
  select a.id, 'email', a.email, 'Prueba de avisos · Campus Norte',
         'Así te llegarán los avisos de ingreso y salida de tus hijos.'
    from campus_norte.adultos a where a.id = v_ad and a.email is not null and a.avisos_email;
  insert into campus_norte.notificaciones(adulto_id, canal, destino, asunto, cuerpo)
  select v_ad, 'push', s.endpoint, 'Prueba de avisos · Campus Norte',
         'Así te llegarán los avisos de ingreso y salida de tus hijos.'
    from campus_norte.push_suscripciones s join campus_norte.adultos a on a.id = s.adulto_id
   where s.adulto_id = v_ad and a.avisos_push;
  get diagnostics v_n = row_count;
  perform campus_norte.despachar_avisos();
  return jsonb_build_object('ok', true, 'push', v_n);
end $$;

-- ---------------------------------------------------------------------
-- 8. Permisos: nada para anon; solo usuarios con sesión
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname like 'cn\_%') or n.nspname = 'campus_norte'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.nspname = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
