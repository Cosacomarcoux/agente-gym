require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const cron = require('node-cron');
const guards = require('./guards');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const GYM_API = 'https://hockeyvivo.up.railway.app';
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith('whatsapp:')
  ? process.env.TWILIO_WHATSAPP_NUMBER
  : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
let GYM_TOKEN = null;
const pagosEsperandoNombre = new Map(); // telefono → { monto, metodo }
const comprobantePendiente = new Map(); // telefono → true (mandó imagen/comprobante)
const cobrosPendientesDatos = new Map(); // telefonoCosaco → { nombreCliente, metodo, clienteId, clienteNombre }
const tercerTurnoPendiente = new Map(); // telefonoCosaco → { clienteId, clienteNombre, turnoIds, clienteFrom }
const montoPendiente = new Map();       // remitente → { clienteId, clienteNombre, metodo } esperando que diga el monto
const promesaAvisada = new Map();       // remitente → timestamp del último aviso de "paga después" (throttle 1h)
const ausenciaAvisada = new Map();      // remitente → timestamp del último aviso de "deja de venir" (throttle 6h)
const fechaInicioPagoPendiente = new Map(); // telefonoCosaco → { pago, plan, propuesta } esperando que confirme la fecha de inicio al pagar
const menuEstado = new Map();            // remitenteCliente → { paso, data } máquina de estados del menú guiado

// Dirección del local para "Información del gimnasio" (configurable por env).
const DIRECCION_GIMNASIO = process.env.DIRECCION_GIMNASIO || '(consultá la dirección con el equipo)';
const seleccionPagoPendiente = new Map(); // telefonoCosaco → { candidatos:[{id,nombre,...}], monto, metodo } esperando que elija número de ficha

// Link del grupo de WhatsApp que se envía al registrar/reactivar un cliente.
const GRUPO_WHATSAPP = process.env.GRUPO_WHATSAPP_LINK || 'https://chat.whatsapp.com/GHHchA75hHn7BSbLJl0upd';

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id SERIAL PRIMARY KEY,
      telefono VARCHAR(50) NOT NULL,
      nombre VARCHAR(200),
      rol VARCHAR(20) NOT NULL,
      texto TEXT NOT NULL,
      content_json JSONB,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conv_telefono ON conversaciones(telefono);
    CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversaciones(timestamp);
    -- Registro de actividad del bot: alimenta el informe diario.
    -- Antes el informe se armaba con guiones fijos porque no existía este log.
    CREATE TABLE IF NOT EXISTS actividad (
      id SERIAL PRIMARY KEY,
      tipo VARCHAR(40) NOT NULL,
      detalle TEXT,
      monto NUMERIC,
      telefono VARCHAR(50),
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_actividad_ts ON actividad(timestamp);
    CREATE TABLE IF NOT EXISTS telefono_cliente (
      telefono VARCHAR(50) PRIMARY KEY,
      cliente_id INTEGER NOT NULL,
      cliente_nombre VARCHAR(200),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pagos_pendientes (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL,
      cliente_nombre VARCHAR(200),
      cliente_from VARCHAR(50),
      monto NUMERIC,
      metodo VARCHAR(50),
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      esperando_confirmacion BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS registros_pendientes (
      telefono VARCHAR(50) PRIMARY KEY,
      datos JSONB NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS suspensiones_pendientes (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER,
      cliente_nombre VARCHAR(200),
      telefono VARCHAR(50),
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      notificado_cosaco BOOLEAN DEFAULT FALSE,
      esperando_confirmacion BOOLEAN DEFAULT FALSE
    );
    -- "Tomar el control": conversaciones donde el bot queda en silencio mientras
    -- Cosaco atiende personalmente. Se auto-vencen para no dejar el bot mudo por error.
    CREATE TABLE IF NOT EXISTS conversaciones_pausadas (
      telefono VARCHAR(50) PRIMARY KEY,
      pausado_hasta TIMESTAMPTZ NOT NULL
    );
    -- Comprobantes/imágenes: guardamos la URL de Twilio (se sirve luego por proxy)
    ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS media_url TEXT;
    ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS media_type VARCHAR(60);
  `);
  console.log('Tablas listas');
}

async function loginGimnasio() {
  const r = await fetch(`${GYM_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: process.env.GYM_USER, password: process.env.GYM_PASS }).toString(),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Login fallido: ${r.status}`);
  GYM_TOKEN = (await r.json()).access_token;
  console.log('Login exitoso');
}

async function loginConReintentos(intentos = 10, esperaInicial = 10000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      await loginGimnasio();
      return;
    } catch (err) {
      console.error(`Login intento ${i}/${intentos}: ${err.message}`);
      if (i < intentos) await new Promise(r => setTimeout(r, Math.min(esperaInicial * i, 60000)));
    }
  }
  console.warn('Login fallido tras todos los intentos');
}

// ─── Red de seguridad: cualquier 401 de la API → re-login y reintento único ───
// Complementa el refresco programado de cada 12 h: aunque el token venza igual
// (ej. cambio de SECRET_KEY en el backend), el bot se recupera solo.
const _fetchOriginal = global.fetch;
global.fetch = async function (url, opts = {}) {
  const r = await _fetchOriginal(url, opts);
  const esApiGym = typeof url === 'string' && url.startsWith(GYM_API) && !url.includes('/login');
  if (esApiGym && r.status === 401) {
    console.warn('401 de la API (token vencido) → re-login y reintento');
    try { await loginGimnasio(); } catch (e) { return r; }
    const opts2 = { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${GYM_TOKEN}` } };
    return _fetchOriginal(url, opts2);
  }
  return r;
};

// Registra un evento del bot para el informe diario. No bloquea ni rompe
// el flujo si falla (el informe es importante, pero nunca más que operar).
function logActividad(tipo, detalle, monto = null, telefono = null) {
  pool.query(
    'INSERT INTO actividad (tipo, detalle, monto, telefono) VALUES ($1, $2, $3, $4)',
    [tipo, detalle, monto, telefono]
  ).catch(err => console.error('Error logActividad:', err.message));
}

// ── "Tomar el control": el bot queda mudo en una conversación ────────────────
async function botPausado(telefono) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM conversaciones_pausadas WHERE telefono = $1 AND pausado_hasta > NOW()`,
      [telefono]);
    return rows.length > 0;
  } catch (e) { return false; }
}
async function pausarBot(telefono, horas) {
  const h = Number(horas) > 0 ? Number(horas) : 3;
  await pool.query(
    `INSERT INTO conversaciones_pausadas (telefono, pausado_hasta)
     VALUES ($1, NOW() + ($2 || ' hours')::interval)
     ON CONFLICT (telefono) DO UPDATE SET pausado_hasta = NOW() + ($2 || ' hours')::interval`,
    [telefono, String(h)]);
}
async function reanudarBot(telefono) {
  await pool.query(`DELETE FROM conversaciones_pausadas WHERE telefono = $1`, [telefono]);
}

// ¿Este cliente ya tiene un pago esperando confirmación? (anti-duplicados)
async function hayPagoPendiente(clienteId) {
  const { rows } = await pool.query(
    `SELECT id FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`,
    [clienteId]
  );
  return rows.length > 0;
}

function guardarMensaje(from, nombre, texto, rol, contentJson = null, media = null) {
  const textoFinal = (!texto || !texto.trim() || texto.trim().startsWith('[')) ? '[sin texto]' : texto;
  pool.query(
    'INSERT INTO conversaciones (telefono, nombre, rol, texto, content_json, media_url, media_type) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [from, nombre && nombre !== from ? nombre : null, rol, textoFinal,
     contentJson ? JSON.stringify(contentJson) : null,
     media?.url || null, media?.type || null]
  ).catch(err => console.error('Error guardando mensaje:', err.message));
}

async function getHistorial(from) {
  const result = await pool.query(
    `SELECT rol, texto, content_json FROM conversaciones
     WHERE telefono = $1 AND rol IN ('cliente', 'agente')
     ORDER BY timestamp DESC LIMIT 20`,
    [from]
  );
  return result.rows.reverse().map(row => ({
    role: (row.rol === 'cliente' || row.rol === 'tool_result') ? 'user' : 'assistant',
    content: row.content_json ?? row.texto,
  }));
}

async function enviarWhatsApp(telefono, mensaje, nombre = null) {
  try {
    let tel = telefono.toString().replace(/\D/g, '');
    if (tel.startsWith('549')) tel = tel.slice(2);
    else if (tel.startsWith('54')) tel = tel.slice(2);
    const to = `whatsapp:+54${tel}`;
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body: mensaje });
    guardarMensaje(to, nombre, mensaje, 'agente');
  } catch (err) {
    console.error(`Error enviando WhatsApp a ${telefono}:`, err.message);
  }
}

async function enviarTemplate(telefono, templateSid, variables, textoGuardar = '[Mensaje automático]') {
  console.log('enviarTemplate recibió telefono:', telefono);
  try {
    let to;
    if (telefono.startsWith('whatsapp:')) {
      to = telefono;
    } else {
      let tel = telefono.toString().replace(/\D/g, '');
      if (tel.startsWith('549')) tel = tel.slice(2);
      else if (tel.startsWith('54')) tel = tel.slice(2);
      to = `whatsapp:+54${tel}`;
    }
    console.log('Twilio params:', JSON.stringify({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      contentSid: templateSid,
      contentVariables: JSON.stringify(variables),
    }));
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      contentSid: templateSid,
      contentVariables: JSON.stringify(variables),
    });
    guardarMensaje(to, variables['1'] || null, textoGuardar, 'agente');
  } catch (err) {
    console.error(`Error enviando template a ${telefono}:`, err.message);
  }
}

async function buscarClientePorTelefono(telefono) {
  try {
    const cached = await pool.query('SELECT * FROM telefono_cliente WHERE telefono = $1', [telefono]);
    if (cached.rows.length > 0) return { id: cached.rows[0].cliente_id, nombre: cached.rows[0].cliente_nombre };
    let tel = telefono.replace(/\D/g, '');
    if (tel.startsWith('549')) tel = tel.slice(3);
    else if (tel.startsWith('54')) tel = tel.slice(2);
    const headers = { Authorization: `Bearer ${GYM_TOKEN}` };
    for (const buscar of [tel.slice(-10), tel.slice(-8), `549${tel.slice(-10)}`]) {
      const r = await fetch(`${GYM_API}/clientes?buscar=${buscar}`, { headers });
      const data = await r.json();
      const clientes = Array.isArray(data) ? data : [];
      if (clientes.length > 0) return clientes[0];
    }
    return null;
  } catch (err) {
    console.error('Error buscarClientePorTelefono:', err.message);
    return null;
  }
}

function calcularFechaInicio(cliente) {
  return (cliente.estado === 'Suspendido' || !cliente.fecha_vencimiento)
    ? new Date().toISOString().split('T')[0]
    : cliente.fecha_vencimiento;
}

function calcularFechaVencimiento(fecha_pago, fecha_vencimiento_actual) {
  if (fecha_vencimiento_actual) {
    const venc = new Date(fecha_vencimiento_actual + 'T12:00:00');
    return new Date(venc.getFullYear(), venc.getMonth() + 1, venc.getDate()).toISOString().split('T')[0];
  }
  const fecha = new Date(fecha_pago + 'T12:00:00');
  const dia = fecha.getDate();
  let diaVenc, meses;
  if (dia >= 6 && dia <= 15) { diaVenc = 15; meses = 1; }
  else if (dia >= 16 && dia <= 25) { diaVenc = 25; meses = 1; }
  else { diaVenc = 5; meses = dia >= 26 ? 2 : 1; }
  return new Date(fecha.getFullYear(), fecha.getMonth() + meses, diaVenc).toISOString().split('T')[0];
}

// Vencimiento = fecha de inicio + 1 mes (mismo criterio que calcularFechaVencimiento).
function sumarUnMes(iso) {
  const d = new Date(iso + 'T12:00:00');
  return new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()).toISOString().split('T')[0];
}
// ISO (yyyy-mm-dd) → dd/mm/yyyy para mostrarle a Cosaco.
function fmtFechaAR(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function parsearFecha(fechaStr) {
  if (!fechaStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) return fechaStr;
  const partes = fechaStr.split('/');
  if (partes.length === 3) {
    const dia = partes[0].padStart(2, '0');
    const mes = partes[1].padStart(2, '0');
    const anio = partes[2];
    return `${anio}-${mes}-${dia}`;
  }
  return fechaStr;
}

const SYSTEM_PROMPT = `Sos el asistente de Hockey Vivo. Respondés en español argentino, amable y breve.

PAGOS (LEER CON ATENCIÓN):
Solo registrás un pago si el cliente DICE, con sus propias palabras, que YA pagó/transfirió/depositó/abonó. Ahí sí: si no dio el monto, preguntáselo; con nombre y monto, llamá consultar_pago_a_cosaco (poniendo en texto_cliente la frase textual donde dijo que pagó). Después: "Gracias! Ya le avisé al equipo, en breve te confirmamos 🏑".
NOMBRE DE LA JUGADORA: cuando pidas el nombre para un pago, aclarále SIEMPRE que necesitás el nombre y apellido de la JUGADORA tal como está registrada — muchos que escriben son el papá o la mamá y mandan su propio nombre. Decilo así: "Pasame el nombre y apellido de la jugadora tal como está registrada (si escribís por tu hija, es el nombre de ella, no el tuyo) 🏑". El mismo mensaje sirve aunque escriba la jugadora directamente.

PROHIBIDO registrar pagos en estos casos (NO son pagos):
- "Este mes no voy" / "no voy a ir" → es una baja/pausa, NO un pago.
- "Quiero pausar" / "me doy de baja" → gestión, NO un pago. Usá notificar_cosaco.
- "Gracias" / "dale" / "ok" → cortesía, NO un pago.
- "Te pago el viernes" / "esta semana paso" → promesa futura: NO llames ninguna tool, el sistema ya avisa solo. Respondé "Dale, cuando abones avisame 🏑".
NUNCA saques el monto del precio del plan. NUNCA inventes un pago que el cliente no mencionó. Ante la duda, NO registres: preguntá "¿ya hiciste el pago?" antes de hacer nada.
REGLA DE ORO: si estás por decirle al cliente "el equipo se va a contactar", "le aviso al equipo", "en breve te confirmamos" o cualquier variante, PRIMERO llamá notificar_cosaco con el motivo. Decirlo sin llamar la herramienta = nadie se entera y el cliente queda esperando para siempre. Esto aplica a: dudas que no podés resolver, quejas, pedidos especiales, problemas con turnos o cualquier situación que necesite a un humano.
REGLA DE ORO 2 — NUNCA CONFIRMES ALGO QUE NO SE EJECUTÓ: solo decís "listo/confirmado/registrado/asignado" si la herramienta correspondiente devolvió ok:true. Si no llamaste ninguna herramienta, o devolvió error/ok:false, NO afirmes que se hizo. Ante la duda, "en breve te confirmamos" + notificar_cosaco. Vale para pagos, turnos, inscripciones y bajas.
Si identificás al cliente por get_clientes, guardá el mapeo con guardar_telefono_cliente.

REGISTRO DE CLIENTES:
Cuando llega el mensaje de reserva con formato, verificá cupos con get_turnos y llamá guardar_registro_pendiente con los datos. Después preguntá: "¿Confirmás tu inscripción en Hockey Vivo?"

TURNOS:
Nunca confirmar un turno sin haber llamado gestionar_turnos_cliente Y recibido ok:true.
- Si la herramienta devuelve ok:true → recién ahí confirmá, mostrando día y horario.
- Si devuelve ok:false, error o requiere_autorizacion → NO digas que quedó asignado. Decí "lo estamos gestionando, en breve te confirmamos" y llamá notificar_cosaco con el motivo.
- Si es una persona NUEVA (no está en el sistema) que pide turnos, usá registrar_cliente_y_asignar_turno, NO gestionar_turnos_cliente. Nunca confirmes una inscripción sin que esa herramienta haya devuelto ok:true.

LÍMITE DE TURNOS:
- El plan de 2 veces por semana es el máximo que se ofrece. NUNCA ofrezcas ni sugieras el plan de 3 veces por tu cuenta.
- El plan de 3 veces por semana NO está disponible: "los cupos del plan de 3 veces por semana ya están completos". Solo se habilita con autorización especial de Cosaco (el sistema lo maneja) y cuesta $49.000.
- Si un alumno con 2 turnos pide un 3ro: decile que los cupos de 3x están completos y que podés pedir una autorización especial a Cosaco, o que puede cambiar uno de sus turnos actuales. Si insiste en el 3ro, el sistema consulta a Cosaco automáticamente.
- Si tiene 3 turnos y pide otro, siempre preguntarle cuál quiere cambiar, nunca agregar.

INFORMACIÓN:
- Dirección: Moreno (N) 55 entre Andes y Rivadavia, Santiago del Estero
- Horarios: Lun/Mié/Vie 18:30-21hs | Mar/Jue 16-21hs
- Planes que se ofrecen: 1 vez por semana $35.000 | 2 veces por semana $42.000. (El de 3 veces NO se ofrece: cupos completos.)
- Alias: hockeyvivo | Primera clase GRATIS
- Requisitos: palo, botines, agua
- Cupos: https://hockeyvivo.up.railway.app/cupos

SI NO PODÉS RESOLVER ALGO: "Te paso con el equipo de Hockey Vivo, en breve te contactamos 🏑"

MODO SECRETARIO (solo número de Cosaco):
Sos su asistente administrativo. Usá las tools para:
- Buscar clientes: get_clientes
- Enviar templates: enviar_mensaje_cliente (recordatorio/mora/suspension/pago_confirmado/general)
- Mensajes masivos: enviar_mensaje_masivo
- Cambiar turnos: gestionar_turnos_cliente
Respondé de forma concisa confirmando lo que hiciste.

CARGA DE PAGOS POR COSACO: si Cosaco te pide registrar/cargar/anotar un pago de un alumno (sobre todo en efectivo que cobró en persona), llamá cargar_pago_cosaco con el nombre, el monto y el método. Eso lo ENCOLA y le pedís que confirme con SÍ o NO. No lo des por registrado hasta que Cosaco confirme.

LINK DEL GRUPO: si Cosaco pide "mandale el link del grupo a [nombre]", "enviá el grupo a [nombre]" o similar, llamá enviar_link_grupo con el nombre. Busca al cliente y le manda el link del grupo de WhatsApp del gimnasio. Exclusivo de Cosaco.

LISTA DE SEGUIMIENTO: los alumnos NUEVOS y los que REACTIVAN (ex-alumnos que vuelven) entran solos a la lista de seguimiento. Si Cosaco pide "anotá a Fulana en seguimiento", "poné a Juan en la lista" o similar, llamá agregar_a_seguimiento con el nombre. Cada mañana, a quien esté en la lista y haya sumado una asistencia nueva sin pagar, el sistema le manda el mensaje de seguimiento. El alumno sale de la lista SOLO cuando se registra su pago (es automático). Esto es exclusivo de Cosaco.

CONFIRMACIÓN DE PAGOS (CRÍTICO): vos NO confirmás ni registrás pagos, y NUNCA digas que confirmaste, registraste o notificaste un pago. Ese proceso es automático y va de a uno. Si Cosaco dice "confirmar", "confirmar pagos", "pendientes" o similar, el sistema ya lo maneja solo (no tenés que hacer nada). Si te pregunta por pagos pendientes, decile que escriba "pendientes" y el sistema los muestra de a uno para confirmar con SÍ o NO. Jamás inventes que un pago quedó confirmado.`;

const TOOLS = [
  {
    name: 'get_clientes',
    description: 'Busca clientes por nombre (con fallback sin acentos) o por estado.',
    input_schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', description: 'Filtrar: Vigente, Vencido, Suspendido' },
        buscar: { type: 'string', description: 'Buscar por nombre o teléfono' },
      },
      required: [],
    },
  },
  {
    name: 'get_turnos',
    description: 'Lista turnos con IDs, días, horarios, niveles y cupos. Sin lista de alumnos.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'registrar_cliente_y_asignar_turno',
    description: 'Crea un cliente nuevo y le asigna turnos. Si el teléfono ya corresponde a un cliente (aunque figure Vencido o Suspendido), NO crea uno nuevo: reutiliza la ficha existente y devuelve ya_existia/estado_anterior. Usala también cuando vuelve un ex-alumno.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        apellido: { type: 'string' },
        telefono: { type: 'string' },
        fecha_nacimiento: { type: 'string', description: 'YYYY-MM-DD (opcional)' },
        club: { type: 'string', description: 'Club (opcional)' },
        turno_ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['nombre', 'apellido', 'telefono', 'turno_ids'],
    },
  },
  {
    name: 'gestionar_turnos_cliente',
    description: 'Agrega o quita turnos a un cliente existente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer' },
        turno_ids_agregar: { type: 'array', items: { type: 'integer' } },
        turno_ids_quitar: { type: 'array', items: { type: 'integer' } },
      },
      required: ['cliente_id'],
    },
  },
  {
    name: 'suspender_cliente',
    description: 'Suspende a un cliente. Solo cuando Cosaco confirme explícitamente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer' },
        cliente_nombre: { type: 'string' },
      },
      required: ['cliente_id', 'cliente_nombre'],
    },
  },
  {
    name: 'notificar_cosaco',
    description: 'Envía un aviso por WhatsApp a Cosaco (el dueño). USALA SIEMPRE que: (a) el cliente necesite algo que no podés resolver vos, (b) estés por decirle al cliente "el equipo se va a contactar" o "le aviso al equipo" — si decís eso sin llamar esta herramienta, NADIE se entera y el cliente queda colgado. NO la uses para pagos ya realizados (para eso está consultar_pago_a_cosaco) ni para promesas de pago futuro (eso lo avisa el sistema automáticamente).',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Qué pasó y qué se necesita, en una frase' },
        cliente_nombre: { type: 'string', description: 'Nombre del cliente si se conoce' },
      },
      required: ['motivo'],
    },
  },
  {
    name: 'consultar_pago_a_cosaco',
    description: 'Registra un pago YA REALIZADO y lo manda a confirmar a Cosaco. USAR SOLO si el cliente dijo con sus propias palabras que pagó/transfirió/depositó/abonó, Y dio un monto concreto. NUNCA la uses por: "no voy", "quiero pausar", "gracias", "me doy de baja" o cualquier frase que no sea un pago. NUNCA saques el monto del precio del plan: tiene que haberlo dicho el cliente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer' },
        cliente_nombre: { type: 'string' },
        monto: { type: 'number', description: 'El monto que el cliente dijo haber pagado. Prohibido inventarlo o deducirlo del plan.' },
        metodo: { type: 'string', description: 'Efectivo o Transferencia' },
        texto_cliente: { type: 'string', description: 'La frase TEXTUAL del cliente donde dice que pagó (ej: "ya transferí 35000"). Obligatoria: si el cliente no dijo que pagó, no llames esta herramienta.' },
      },
      required: ['cliente_id', 'cliente_nombre', 'monto', 'metodo', 'texto_cliente'],
    },
  },
  {
    name: 'cargar_pago_cosaco',
    description: 'SOLO para Cosaco (el dueño): carga un pago que Cosaco indica —sobre todo pagos en efectivo que recibió en persona— y lo deja para que él lo reconfirme con SÍ. Usala cuando Cosaco dice cosas como "registrá/cargá/anotá un pago en efectivo a Juan de 35000", "Juan me pagó 42000 en efectivo", "cobré 35000 a María". Encola el pago; NO lo des por registrado hasta que Cosaco confirme con SÍ.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_nombre: { type: 'string', description: 'Nombre del alumno que pagó' },
        monto: { type: 'number', description: 'Monto que indicó Cosaco' },
        metodo: { type: 'string', description: 'Efectivo o Transferencia (por defecto Efectivo si Cosaco no aclara)' },
      },
      required: ['cliente_nombre', 'monto'],
    },
  },
  {
    name: 'enviar_link_grupo',
    description: 'SOLO para Cosaco (el dueño): le envía a un cliente el link del grupo de WhatsApp del gimnasio. Usala cuando Cosaco dice cosas como "mandale el link del grupo a Sofía", "enviá el grupo a Juan", "pasale el grupo de whatsapp a María". Busca al cliente por nombre y le manda el link.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_nombre: { type: 'string', description: 'Nombre del cliente al que enviar el link del grupo' },
      },
      required: ['cliente_nombre'],
    },
  },
  {
    name: 'agregar_a_seguimiento',
    description: 'SOLO para Cosaco (el dueño): agrega un alumno a la LISTA DE SEGUIMIENTO de conversión. Usala cuando Cosaco dice cosas como "anotá a Fulana en seguimiento", "poné a Juan en la lista", "agregá a María para hacerle seguimiento", o cuando indica que un ex-alumno volvió y hay que seguirlo. Mientras el alumno esté en la lista y sume una asistencia nueva sin pagar, el bot le manda el mensaje de seguimiento cada mañana. Sale de la lista SOLO cuando se registra su pago.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_nombre: { type: 'string', description: 'Nombre del alumno a agregar a seguimiento' },
      },
      required: ['cliente_nombre'],
    },
  },
  {
    name: 'guardar_registro_pendiente',
    description: 'Guarda datos de inscripción antes del ¿Confirmás?. Llamar SIEMPRE antes.',
    input_schema: {
      type: 'object',
      properties: {
        telefono: { type: 'string' },
        nombre: { type: 'string' },
        apellido: { type: 'string' },
        fecha_nacimiento: { type: 'string' },
        whatsapp: { type: 'string' },
        club: { type: 'string' },
        turno_ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['telefono', 'nombre', 'turno_ids'],
    },
  },
  {
    name: 'guardar_telefono_cliente',
    description: 'Mapea número de teléfono a cliente identificado durante la conversación.',
    input_schema: {
      type: 'object',
      properties: {
        telefono: { type: 'string' },
        cliente_id: { type: 'integer' },
        cliente_nombre: { type: 'string' },
      },
      required: ['telefono', 'cliente_id', 'cliente_nombre'],
    },
  },
  {
    name: 'enviar_mensaje_cliente',
    description: 'Envía un mensaje de WhatsApp a un cliente. Para un mensaje personalizado usá template_tipo "general" (va como texto libre con lo que pongas en "mensaje"). NO existe confirmación de pagos acá: los pagos los confirma Cosaco.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer' },
        template_tipo: {
          type: 'string',
          enum: ['recordatorio', 'mora', 'suspension', 'general'],
        },
        mensaje: { type: 'string', description: 'Requerido para general (texto libre)' },
      },
      required: ['cliente_id', 'template_tipo'],
    },
  },
  {
    name: 'enviar_mensaje_masivo',
    description: 'Envía template a todos los clientes de un día de la semana.',
    input_schema: {
      type: 'object',
      properties: {
        dia_semana: { type: 'string', description: 'lunes, martes, miercoles, jueves, viernes' },
        mensaje: { type: 'string' },
      },
      required: ['dia_semana', 'mensaje'],
    },
  },
];

async function ejecutarTool(nombre, input, remitente) {
  const headers = { Authorization: `Bearer ${GYM_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    if (nombre === 'get_clientes') {
      const params = new URLSearchParams();
      if (input.estado) params.append('estado', input.estado);
      if (input.buscar?.match(/^\d+$/)) {
        params.set('buscar', input.buscar.replace(/^549/, '').replace(/^54/, '').slice(-8));
      } else if (input.buscar) {
        params.append('buscar', input.buscar);
      }
      const buscar = async (termino) => {
        const p = new URLSearchParams();
        if (input.estado) p.append('estado', input.estado);
        p.append('buscar', termino);
        const r = await fetch(`${GYM_API}/clientes?${p}`, { headers });
        const d = await r.json();
        return Array.isArray(d) ? d : [];
      };
      let res = await fetch(`${GYM_API}/clientes?${params}`, { headers });
      let data = await res.json();
      let resultados = Array.isArray(data) ? data : [];
      if (resultados.length > 0) return resultados;
      if (input.buscar && !input.buscar.match(/^\d+$/)) {
        const sinAcentos = input.buscar.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (sinAcentos !== input.buscar) {
          resultados = await buscar(sinAcentos);
          if (resultados.length > 0) return resultados;
        }
        const palabras = sinAcentos.split(' ').filter(p => p.length > 2);
        for (const p of palabras) {
          resultados = await buscar(p);
          if (resultados.length > 0) return resultados;
        }
        for (const p of palabras) {
          if (p.length > 4) {
            resultados = await buscar(p.slice(0, 4));
            if (resultados.length > 0) return resultados;
          }
        }
      }
      return resultados;
    }

    if (nombre === 'get_turnos') {
      const r = await fetch(`${GYM_API}/turnos`, { headers });
      const data = await r.json();
      return (Array.isArray(data) ? data : []).map(t => ({
        id: t.id, dia_semana: t.dia_semana, hora_inicio: t.hora_inicio,
        nivel: t.nivel, cupo_maximo: t.cupo_maximo, cupo_usado: t.cupo_usado,
        bloqueado: !!t.bloqueado,
        // Un turno bloqueado NUNCA está disponible, aunque tenga cupo libre
        disponible: !t.bloqueado && t.cupo_usado < t.cupo_maximo,
      }));
    }

    if (nombre === 'registrar_cliente_y_asignar_turno') {
      const nombreCompleto = `${input.nombre} ${input.apellido}`;
      const asignarTurnos = async (cliente_id, turno_ids) => {
        const asignados = [], errores = [];
        for (const id of turno_ids) {
          const r = await fetch(`${GYM_API}/turnos/${id}/asignar/${cliente_id}`, { method: 'POST', headers });
          if (r.ok) asignados.push(id);
          else errores.push(`turno ${id}: ${await r.text()}`);
        }
        return { asignados, errores };
      };
      // FIX duplicados: deduplicar SOLO por el teléfono de la persona que se
      // anota (input.telefono), NUNCA por el de quien escribe (remitente).
      // Antes usaba también remitente: si un padre anotaba a su hija —o Cosaco
      // probaba desde su celu— reutilizaba el cliente mapeado al remitente y la
      // persona nueva NUNCA se creaba (los turnos iban a otro). Bug real.
      const telReg = input.telefono;
      let existente = null;
      try {
        const { rows } = await pool.query('SELECT cliente_id FROM telefono_cliente WHERE telefono = $1', [telReg]);
        if (rows.length > 0) {
          const rCli = await fetch(`${GYM_API}/clientes/${rows[0].cliente_id}`, { headers });
          if (rCli.ok) existente = await rCli.json();
        }
      } catch (e) { console.warn('lookup telefono_cliente:', e.message); }
      if (!existente) {
        const rBuscar = await fetch(`${GYM_API}/clientes?buscar=${encodeURIComponent(telReg)}`, { headers });
        const existentes = await rBuscar.json();
        existente = Array.isArray(existentes) && existentes.length > 0 ? existentes[0] : null;
      }
      // Seguridad: si lo "encontrado" no comparte los últimos 8 dígitos del
      // teléfono que se está registrando, NO lo reutilizamos (evita agarrar a
      // otra persona por un match flojo del buscador).
      if (existente) {
        const soloNum = s => String(s || '').replace(/\D/g, '').slice(-8);
        if (soloNum(existente.telefono) !== soloNum(telReg)) existente = null;
      }
      if (!existente) {
        const body = { nombre: nombreCompleto, telefono: input.telefono };
        if (input.fecha_nacimiento) body.fecha_nacimiento = input.fecha_nacimiento;
        if (input.club) body.club = input.club;
        const rNuevo = await fetch(`${GYM_API}/clientes`, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!rNuevo.ok) return { ok: false, error: `No se pudo crear: ${await rNuevo.text()}` };
        const nuevo = await rNuevo.json();
        const { asignados, errores } = await asignarTurnos(nuevo.id, input.turno_ids);
        if (errores.length) return { ok: false, error: errores.join(', ') };
        logActividad('cliente_nuevo', nombreCompleto, null, input.telefono);
        if (asignados.length) logActividad('turnos_asignados', `${nombreCompleto}: ${asignados.length} turno(s)`, asignados.length, input.telefono);
        // Cliente NUEVO → entra a la lista de seguimiento (conversión). Sale sólo al pagar.
        try { await fetch(`${GYM_API}/clientes/${nuevo.id}/seguimiento`, { method: 'POST', headers }); }
        catch (e) { console.warn('alta seguimiento (nuevo):', e.message); }
        return { ok: true, nuevo: true, cliente_id: nuevo.id, nombre: nombreCompleto, turnos_asignados: asignados };
      }
      const { asignados, errores } = await asignarTurnos(existente.id, input.turno_ids);
      if (errores.length) return { ok: false, error: errores.join(', ') };
      if (asignados.length) logActividad('turnos_asignados', `${existente.nombre}: ${asignados.length} turno(s)`, asignados.length, input.telefono);
      const eraInactivo = existente.estado === 'Suspendido' || existente.estado === 'Vencido';
      if (eraInactivo) logActividad('cliente_volvio', `${existente.nombre} (estaba ${existente.estado})`, null, input.telefono);
      if (eraInactivo) {
        // El cliente vuelve, se le asignan turnos, PERO sigue figurando como estaba
        // (Suspendido/Vencido) y entra a seguimiento. Recién queda Vigente cuando se
        // registra su pago — ahí el bot pide confirmar la fecha de inicio (= última
        // asistencia). NO se reactiva acá.
        try { await fetch(`${GYM_API}/clientes/${existente.id}/seguimiento`, { method: 'POST', headers }); }
        catch (e) { console.warn('alta seguimiento (reactivado):', e.message); }
        try {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `🔄 ${existente.nombre} (estado: ${existente.estado}) volvió y pidió turnos. Se reutilizó su ficha existente (no se duplicó) y quedó en *seguimiento*.\n\nSigue figurando como ${existente.estado}. Cuando registres su pago, te voy a pedir que confirmes la fecha de inicio (su última asistencia).`);
        } catch (e) { console.warn('aviso reactivacion:', e.message); }
      }
      return { ok: true, cliente_id: existente.id, nombre: existente.nombre,
               ya_existia: true, estado_anterior: existente.estado, reactivado: eraInactivo,
               turnos_asignados: asignados };
    }

    if (nombre === 'gestionar_turnos_cliente') {
      const resultados = [];
      for (const id of (input.turno_ids_quitar || [])) {
        const r = await fetch(`${GYM_API}/turnos/${id}/quitar/${input.cliente_id}`, { method: 'DELETE', headers });
        resultados.push({ accion: 'quitar', turno_id: id, ok: r.ok });
      }
      if ((input.turno_ids_agregar || []).length > 0) {
        // Verificar turnos actuales del cliente
        const rCli = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
        const cliData = await rCli.json();
        const turnosActuales = (cliData.turnos || []).length;
        const turnosQuitar = (input.turno_ids_quitar || []).length;
        const turnosPost = turnosActuales - turnosQuitar + (input.turno_ids_agregar || []).length;

        if (turnosActuales >= 3) {
          return { ok: false, limite: true, mensaje: `${cliData.nombre} ya tiene ${turnosActuales} turnos. Preguntale cuál quiere cambiar.` };
        }
        if (turnosPost > 2) {
          // Supera el límite → guardar TODOS los turnos pedidos y pedir
          // autorización. (FIX: antes se guardaba solo el primero, y al
          // autorizar se cargaba 1 solo turno de los que pidió.)
          const turnoIds = (input.turno_ids_agregar || []).slice();
          tercerTurnoPendiente.set(process.env.COSACO_WHATSAPP, {
            clienteId: input.cliente_id,
            clienteNombre: input.cliente_nombre || cliData.nombre,
            turnoIds,
            quitarIds: (input.turno_ids_quitar || []).slice(),
            clienteFrom: remitente,
          });
          await enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `⚠️ ${cliData.nombre} tiene ${turnosActuales} turno(s) y pide agregar ${turnoIds.length} más (quedaría con ${turnosPost}). ¿Autorizás TODOS? SÍ o NO`);
          return { ok: false, requiere_autorizacion: true, mensaje: 'Tu solicitud fue enviada al equipo para autorización. En breve te confirmamos 🏑' };
        }
      }
      for (const id of (input.turno_ids_agregar || [])) {
        const r = await fetch(`${GYM_API}/turnos/${id}/asignar/${input.cliente_id}`, { method: 'POST', headers });
        let detalle = '';
        if (!r.ok) { try { detalle = (await r.json()).detail || ''; } catch {} }
        resultados.push({ accion: 'agregar', turno_id: id, ok: r.ok, detalle });
      }
      const todoOk = resultados.every(r => r.ok);
      if (!todoOk) {
        const fallidos = resultados.filter(r => !r.ok);
        return { ok: false, resultados,
          instruccion: `NO se asignaron todos los turnos (fallaron: ${fallidos.map(f => f.turno_id + (f.detalle ? ' — ' + f.detalle : '')).join(', ')}). NO confirmes al cliente. Decile que el equipo lo está gestionando y llamá notificar_cosaco.` };
      }
      return { ok: true, resultados };
    }

    if (nombre === 'suspender_cliente') {
      const r = await fetch(`${GYM_API}/clientes/${input.cliente_id}/suspender`, { method: 'DELETE', headers });
      if (!r.ok) return { error: `Error: ${await r.text()}` };
      return { ok: true, nombre: input.cliente_nombre };
    }

    if (nombre === 'notificar_cosaco') {
      const quien = input.cliente_nombre ? `${input.cliente_nombre}: ` : '';
      const desde = remitente && remitente !== process.env.COSACO_WHATSAPP
        ? `\n(De: ${String(remitente).replace('whatsapp:', '')})` : '';
      await enviarWhatsApp(process.env.COSACO_WHATSAPP, `📣 ${quien}${input.motivo}${desde}`);
      logActividad('aviso_cosaco', `${quien}${input.motivo}`, null, remitente);
      return { ok: true, avisado: true, nota: 'Cosaco ya fue notificado. Ahora sí podés decirle al cliente que el equipo está al tanto.' };
    }

    if (nombre === 'consultar_pago_a_cosaco') {
      const metodo = input.metodo || 'Transferencia';
      // FIX: nunca confirmar pagos de $0.
      const monto = Number(input.monto);
      if (!monto || monto <= 0) {
        return { ok: false, rechazado: true,
          error: 'Monto inválido o $0. Esta herramienta es SOLO para pagos ya realizados con monto concreto. Si el cliente va a pagar más adelante, no registres nada.' };
      }
      // FIX pagos inventados: la frase del cliente debe SONAR a pago. Si el bot
      // "alucina" un pago en una charla que no lo menciona (ej: "no voy este
      // mes", "gracias"), el texto_cliente no va a contener palabras de pago y
      // se rechaza. Candado de código contra confirmaciones fantasma.
      if (!guards.suenaAPago(input.texto_cliente)) {
        return { ok: false, rechazado: true,
          error: 'RECHAZADO: no hay evidencia de que el cliente haya pagado. El texto_cliente no menciona un pago. NO inventes pagos: si el cliente no dijo que pagó, no registres nada y seguí la conversación normal.' };
      }
      // FIX: no duplicar. Si ya hay una confirmación pendiente para este
      // cliente, no se inserta otra (evita que Cosaco reciba el mismo pago 2 veces).
      const { rows: dup } = await pool.query(
        `SELECT id, monto FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`,
        [input.cliente_id]
      );
      if (dup.length > 0) {
        return { ok: true, ya_pendiente: true,
          mensaje: `Ya hay una confirmación pendiente para este cliente ($${dup[0].monto}). No se duplicó el aviso.` };
      }
      await pool.query(
        `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
        [input.cliente_id, input.cliente_nombre, remitente, monto, metodo]
      );
      const { rows } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
      if (parseInt(rows[0].count) > 1) return { ok: true, encolado: true };
      const msg = `💰 Confirmacion de pago\nCliente: ${input.cliente_nombre}\nMonto: $${input.monto}\nMetodo: ${metodo}\n¿Confirmas? SI o NO`;
      try {
        await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
        guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
      } catch (err) {
        console.error('Error notificando pago a Cosaco:', err.message);
      }
      return { ok: true, enviado_a_cosaco: true };
    }

    if (nombre === 'cargar_pago_cosaco') {
      // Exclusivo de Cosaco: carga un pago (típicamente efectivo) para que él lo
      // reconfirme con SÍ. Seguro: solo encola, la confirmación real es de Cosaco.
      if (remitente !== process.env.COSACO_WHATSAPP) {
        return { ok: false, error: 'Solo Cosaco puede cargar pagos de esta forma.' };
      }
      const monto = Number(input.monto);
      if (!guards.montoValido(monto)) {
        return { ok: false, error: 'Falta el monto o es inválido. Preguntale a Cosaco cuánto pagó.' };
      }
      const metodo = /efectivo/i.test(input.metodo || '') ? 'Efectivo'
                   : /transfer/i.test(input.metodo || '') ? 'Transferencia' : 'Efectivo';
      if (!GYM_TOKEN) await loginConReintentos(3, 3000);
      const nombreLimpio = guards.limpiarNombreBuscado(input.cliente_nombre) || input.cliente_nombre;
      const clientes = await ejecutarTool('get_clientes', { buscar: nombreLimpio }, remitente);
      const fuertes = guards.filtrarClientesPorNombre(nombreLimpio, clientes);

      // Varias fichas con ese nombre (duplicados) → NO adivinar. Guardar selección
      // y pedirle a Cosaco el número; el handler determinístico toma la respuesta.
      if (fuertes.length > 1) {
        seleccionPagoPendiente.set(remitente, { candidatos: fuertes, monto, metodo });
        let msg = `Hay ${fuertes.length} fichas de "${input.cliente_nombre}". ¿Cuál? Respondé el número:\n`;
        fuertes.forEach((c, i) => { msg += `${i + 1}. ${c.nombre}${c.estado ? ' — ' + c.estado : ''}\n`; });
        await enviarWhatsApp(remitente, msg.trim());
        return { ok: true, requiere_seleccion: true,
          instruccion: 'Ya le mostré a Cosaco las fichas duplicadas y le pedí que elija el número. NO agregues nada, NO encolaste ningún pago todavía.' };
      }
      if (fuertes.length === 0) {
        return { ok: false, error: `No encontré una ficha que coincida con "${input.cliente_nombre}" (nombre y apellido). Verificá el nombre completo.` };
      }
      const cli = fuertes[0];
      await encolarPagoConfirmable(remitente, cli, monto, metodo);
      return { ok: true, encolado: true, cliente: cli.nombre, monto, metodo,
        instruccion: `Pago encolado y ya le pedí a Cosaco que confirme con SÍ o NO. NO agregues otra confirmación ni digas que quedó registrado.` };
    }

    if (nombre === 'enviar_link_grupo') {
      // Exclusivo de Cosaco: manda el link del grupo de WhatsApp a un cliente.
      if (remitente !== process.env.COSACO_WHATSAPP) {
        return { ok: false, error: 'Solo Cosaco puede enviar el link del grupo.' };
      }
      if (!GYM_TOKEN) await loginConReintentos(3, 3000);
      const nombreLimpio = guards.limpiarNombreBuscado(input.cliente_nombre) || input.cliente_nombre;
      const clientes = await ejecutarTool('get_clientes', { buscar: nombreLimpio }, remitente);
      const fuertes = guards.filtrarClientesPorNombre(nombreLimpio, clientes);
      if (fuertes.length === 0) {
        return { ok: false, error: `No encontré a "${input.cliente_nombre}". Verificá el nombre completo.` };
      }
      if (fuertes.length > 1) {
        return { ok: false, error: `Hay varias fichas de "${input.cliente_nombre}". Decime nombre y apellido completo para no equivocarme.` };
      }
      const cli = fuertes[0];
      if (!cli.telefono) return { ok: false, error: `${cli.nombre} no tiene teléfono cargado.` };
      let tel = String(cli.telefono).replace(/\D/g, '');
      if (tel.startsWith('549')) tel = tel.slice(3);
      else if (tel.startsWith('54')) tel = tel.slice(2);
      const to = `whatsapp:+549${tel}`;
      const nombre1 = cli.nombre.split(' ')[0];
      const texto = `¡Hola ${nombre1}! 🏑 Sumate al grupo de WhatsApp de Hockey Vivo Gym para enterarte de todo 👇\n${GRUPO_WHATSAPP}\n¡Te esperamos!`;
      try {
        await twilioClient.messages.create({ from: TWILIO_FROM, to, body: texto });
        guardarMensaje(to, cli.nombre, texto, 'agente-cosaco');
        logActividad('link_grupo', cli.nombre, null, to);
        return { ok: true, enviado_a: cli.nombre, instruccion: `Ya le mandé el link del grupo a ${cli.nombre}. Confirmáselo a Cosaco.` };
      } catch (err) {
        const fueraVentana = err.code === 63016 || /24 hour|freeform/i.test(err.message || '');
        return { ok: false, error: fueraVentana
          ? `No se pudo enviar a ${cli.nombre}: pasaron +24h desde su último mensaje, WhatsApp no deja escribir libre. Tiene que escribir primero.`
          : (err.message || 'Error enviando el link') };
      }
    }

    if (nombre === 'agregar_a_seguimiento') {
      // Exclusivo de Cosaco: agrega un alumno a la lista de seguimiento de conversión.
      if (remitente !== process.env.COSACO_WHATSAPP) {
        return { ok: false, error: 'Solo Cosaco puede anotar alumnos en seguimiento.' };
      }
      if (!GYM_TOKEN) await loginConReintentos(3, 3000);
      const clientes = await ejecutarTool('get_clientes', { buscar: input.cliente_nombre }, remitente);
      if (!Array.isArray(clientes) || clientes.length === 0) {
        return { ok: false, error: `No encontré a "${input.cliente_nombre}" en el sistema. Verificá el nombre.` };
      }
      const cli = clientes[0];
      const r = await fetch(`${GYM_API}/clientes/${cli.id}/seguimiento`, { method: 'POST', headers });
      if (!r.ok) return { ok: false, error: `No se pudo agregar: ${await r.text()}` };
      logActividad('seguimiento_alta', cli.nombre, null, cli.telefono);
      return { ok: true, cliente: cli.nombre,
        instruccion: `${cli.nombre} quedó en la lista de seguimiento. Cada mañana, si suma una asistencia nueva sin pagar, se le manda el mensaje. Sale de la lista al registrarse su pago.` };
    }

    if (nombre === 'guardar_registro_pendiente') {
      // BUG CRÍTICO CORREGIDO: se guardaba bajo input.telefono (el número de la
      // persona que se anota), pero la confirmación "Sí" se busca por `remitente`
      // (quien escribe). Si un padre anota a su hija —o Cosaco prueba desde su
      // celu— los números no coincidían, el registro NO se encontraba al
      // confirmar, y la IA fabricaba un "todo listo" sin crear a nadie.
      // Ahora se guarda SIEMPRE bajo `remitente` (quien va a confirmar).
      await pool.query(
        'INSERT INTO registros_pendientes (telefono, datos) VALUES ($1, $2) ON CONFLICT (telefono) DO UPDATE SET datos = $2, timestamp = NOW()',
        [remitente, JSON.stringify(input)]
      );
      return { ok: true };
    }

    if (nombre === 'guardar_telefono_cliente') {
      await pool.query(
        `INSERT INTO telefono_cliente (telefono, cliente_id, cliente_nombre) VALUES ($1, $2, $3)
         ON CONFLICT (telefono) DO UPDATE SET cliente_id = $2, cliente_nombre = $3, updated_at = NOW()`,
        [input.telefono, input.cliente_id, input.cliente_nombre]
      );
      return { ok: true };
    }

    if (nombre === 'enviar_mensaje_cliente') {
      const rCli = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
      const cliente = await rCli.json();
      if (!cliente.telefono) return { error: 'Sin teléfono registrado' };
      const nombre1 = cliente.nombre.split(' ')[0];

      // FIX mensaje "random": para un mensaje PERSONALIZADO de Cosaco (general)
      // se envía EXACTAMENTE lo que escribió, como texto libre. Antes usaba el
      // template TEMPLATE_MENSAJE_HOCKEYVIVO, cuyo cuerpo fijo pisaba el texto
      // real → al cliente le llegaba un mensaje genérico, no el que pidió Cosaco.
      if (input.template_tipo === 'general') {
        if (!input.mensaje || !input.mensaje.trim()) {
          return { error: 'Falta el texto del mensaje a enviar' };
        }
        let tel = String(cliente.telefono).replace(/\D/g, '');
        if (tel.startsWith('549')) tel = tel.slice(3);
        else if (tel.startsWith('54')) tel = tel.slice(2);
        const to = `whatsapp:+549${tel}`;
        try {
          await twilioClient.messages.create({ from: TWILIO_FROM, to, body: input.mensaje });
          guardarMensaje(to, cliente.nombre, input.mensaje, 'agente-cosaco');
          logActividad('mensaje_manual', `Cosaco → ${cliente.nombre}: ${input.mensaje.slice(0, 60)}`, null, to);
          return { ok: true, enviado_a: cliente.nombre, texto_enviado: input.mensaje };
        } catch (err) {
          const fueraVentana = err.code === 63016 || /24 hour|freeform/i.test(err.message || '');
          return { ok: false, error: fueraVentana
            ? `No se pudo enviar a ${cliente.nombre}: pasaron +24h desde su último mensaje, WhatsApp no deja escribir libre. El cliente tiene que escribir primero.`
            : (err.message || 'Error enviando') };
        }
      }

      // La IA NO puede confirmar pagos a clientes. Ese mensaje SOLO lo manda el
      // flujo determinístico (manejarConfirmacionPago) cuando Cosaco responde SÍ.
      if (input.template_tipo === 'pago_confirmado') {
        return { ok: false, rechazado: true,
          error: 'PROHIBIDO: no podés confirmar pagos a clientes. El pago lo confirma Cosaco con SÍ y el sistema avisa solo. Si el cliente dice que pagó, usá consultar_pago_a_cosaco.' };
      }
      const templateMap = {
        recordatorio: process.env.TEMPLATE_RECORDATORIO,
        mora: process.env.TEMPLATE_MORA,
        suspension: process.env.TEMPLATE_SUSPENSION,
      };
      const sid = templateMap[input.template_tipo];
      // FIX: si falta el SID del template, NO caer al saludo genérico de Hockey
      // Vivo (antes el cliente recibía un mensaje random). Avisar el error.
      if (!sid) {
        return { ok: false, error: `No hay template configurado para "${input.template_tipo}". Para un mensaje libre usá template_tipo "general".` };
      }
      const variables = { "1": nombre1 };
      await enviarTemplate(cliente.telefono, sid, variables, input.mensaje || null);
      return { ok: true, enviado_a: cliente.nombre };
    }

    if (nombre === 'enviar_mensaje_masivo') {
      const diaNorm = input.dia_semana.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const [rTurnos, rClientes] = await Promise.all([
        fetch(`${GYM_API}/turnos`, { headers }),
        fetch(`${GYM_API}/clientes`, { headers }),
      ]);
      const turnos = await rTurnos.json();
      const todos = await rClientes.json();
      const telPorId = {};
      for (const c of (Array.isArray(todos) ? todos : [])) if (c.id && c.telefono) telPorId[c.id] = c.telefono;
      const turnosDelDia = (Array.isArray(turnos) ? turnos : []).filter(t =>
        (t.dia_semana || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(diaNorm)
      );
      if (!turnosDelDia.length) return { ok: false, mensaje: `Sin turnos para "${input.dia_semana}"` };
      const enviados = [], sinTel = [], ya = new Set();
      for (const turno of turnosDelDia) {
        for (const alumno of (turno.alumnos || [])) {
          if (ya.has(alumno.id)) continue;
          ya.add(alumno.id);
          const tel = telPorId[alumno.id];
          if (!tel) { sinTel.push(alumno.nombre); continue; }
          await enviarTemplate(tel, process.env.TEMPLATE_MENSAJE_HOCKEYVIVO,
            { "1": (alumno.nombre || '').split(' ')[0], "2": input.mensaje }, `[Masivo] ${input.mensaje}`);
          enviados.push(alumno.nombre);
        }
      }
      return { ok: true, enviados, sin_telefono: sinTel };
    }

    return { error: `Tool desconocida: ${nombre}` };
  } catch (err) {
    return { error: err.message };
  }
}

// Encola un pago YA RESUELTO (cliente identificado) y le pide a Cosaco que
// confirme con SÍ/NO. Reemplaza cualquier pendiente previo del mismo cliente.
async function encolarPagoConfirmable(remitente, cliente, monto, metodo) {
  await pool.query(`DELETE FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`, [cliente.id]);
  await pool.query(
    `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
    [cliente.id, cliente.nombre, remitente, monto, metodo]
  );
  const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
  if (parseInt(existing[0].count) > 1) {
    await enviarWhatsApp(remitente, `✅ Pago de ${cliente.nombre} $${monto} encolado`);
  } else {
    await enviarWhatsApp(remitente, `💰 ${cliente.nombre} - $${monto} - ${metodo}\n¿Confirmás? SÍ o NO`);
  }
}

// Resuelve un nombre a UN cliente y encola el pago. Blindaje contra "registrar
// al cliente equivocado": exige coincidencia fuerte (nombre + apellido).
//  - 1 match fuerte → encola directo.
//  - varios (fichas duplicadas) → guarda selección y pide el número de ficha.
//  - ninguno fuerte → avisa, NO adivina.
// Devuelve true si dejó algo resuelto/preguntado (para cortar el flujo).
async function resolverYEncolarPago(remitente, nombreBuscar, monto, metodo) {
  nombreBuscar = guards.limpiarNombreBuscado(nombreBuscar) || nombreBuscar;
  const clientes = await ejecutarTool('get_clientes', { buscar: nombreBuscar }, remitente);
  const fuertes = guards.filtrarClientesPorNombre(nombreBuscar, clientes);

  if (fuertes.length === 1) {
    await encolarPagoConfirmable(remitente, fuertes[0], monto, metodo);
    return true;
  }
  if (fuertes.length > 1) {
    // Fichas duplicadas del mismo nombre → que Cosaco elija por número.
    seleccionPagoPendiente.set(remitente, { candidatos: fuertes, monto, metodo });
    let msg = `Hay ${fuertes.length} fichas de "${nombreBuscar}". ¿Cuál? Respondé el número:\n`;
    fuertes.forEach((c, i) => {
      msg += `${i + 1}. ${c.nombre}${c.estado ? ' — ' + c.estado : ''}${c.nivel ? ', ' + c.nivel : ''}\n`;
    });
    await enviarWhatsApp(remitente, msg.trim());
    return true;
  }
  // Ninguna coincidencia fuerte: mostrar lo más parecido, sin adivinar.
  const arr = Array.isArray(clientes) ? clientes : [];
  if (arr.length > 0) {
    let msg = `No encontré una ficha que coincida con "${nombreBuscar}". Lo más parecido:\n`;
    arr.slice(0, 5).forEach(c => { msg += `• ${c.nombre}\n`; });
    msg += `Escribime el nombre completo tal como figura, o "pagó [nombre] [monto]".`;
    await enviarWhatsApp(remitente, msg.trim());
  } else {
    await enviarWhatsApp(remitente, `No encontré a nadie con el nombre "${nombreBuscar}". Verificá cómo está registrado.`);
  }
  return true;
}

// Muestra el siguiente pago pendiente (uno por uno) o avisa que no quedan.
async function mostrarSiguientePendiente() {
  const { rows: sig } = await pool.query(
    `SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC LIMIT 1`
  );
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pagos_pendientes WHERE esperando_confirmacion = true`
  );
  if (sig.length > 0) {
    await enviarWhatsApp(process.env.COSACO_WHATSAPP,
      `💰 Pago pendiente (quedan ${cnt[0].n})\nCliente: ${sig[0].cliente_nombre}\nMonto: $${sig[0].monto}\nMétodo: ${sig[0].metodo}\n\n¿Confirmás? SÍ o NO`);
  } else {
    await enviarWhatsApp(process.env.COSACO_WHATSAPP, '✅ No quedan pagos pendientes de confirmar.');
  }
  return sig.length;
}

// Lee la ficha del cliente con reintentos. Robustece contra: token vencido
// (fuerza re-login) y arranque en frío del sistema en Railway (502/503 mientras
// despierta → espera y reintenta). Devuelve el objeto cliente o null.
async function getClienteConReintento(clienteId, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    try {
      if (!GYM_TOKEN) await loginConReintentos(3, 3000);
      const r = await fetch(`${GYM_API}/clientes/${clienteId}`, {
        headers: { Authorization: `Bearer ${GYM_TOKEN}` },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return await r.json();
      console.warn(`getCliente ${clienteId} intento ${i}: HTTP ${r.status}`);
      if (r.status === 401) { try { await loginGimnasio(); } catch {} }
    } catch (e) {
      console.warn(`getCliente ${clienteId} intento ${i}: ${e.message}`);
    }
    if (i < intentos) await new Promise(res => setTimeout(res, 2000 * i)); // 2s, 4s (deja despertar al sistema)
  }
  return null;
}

// Fecha (ISO) de la ÚLTIMA asistencia presente del cliente, o null si no tiene.
async function ultimaAsistenciaISO(clienteId) {
  try {
    if (!GYM_TOKEN) await loginConReintentos(3, 3000);
    const r = await fetch(`${GYM_API}/asistencias/${clienteId}`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const arr = await r.json();
    // Vienen ordenadas por fecha DESC; la primera presente es la última asistencia.
    const pres = (Array.isArray(arr) ? arr : []).filter(a => a.presente);
    return pres.length ? pres[0].fecha : null;
  } catch (e) { console.error('ultimaAsistenciaISO:', e.message); return null; }
}

// Escribe el pago en el sistema (POST /pagos). Devuelve true si salió bien.
// El sistema, al recibir fecha_vencimiento, pone al cliente en Vigente, actualiza
// sus fechas y lo saca de la lista de seguimiento.
async function escribirPago(pago, fechaInicio, fechaVenc, plan) {
  if (!GYM_TOKEN) await loginConReintentos(3, 3000);
  const hdrs = { Authorization: `Bearer ${GYM_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const r = await fetch(`${GYM_API}/pagos`, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({
        cliente_id: pago.cliente_id, monto: pago.monto, metodo: pago.metodo,
        fecha_pago: hoy, fecha_inicio: fechaInicio, fecha_vencimiento: fechaVenc, plan,
      }),
      signal: AbortSignal.timeout(30000),
    });
    return r.ok;
  } catch (e) { console.error('escribirPago:', e.message); return false; }
}

// Cierra el pago que estaba esperando confirmación de fecha: lo registra con la
// fecha de inicio elegida, borra el pendiente, avisa al cliente y a Cosaco.
async function finalizarPagoConFecha(remitente, fd, fechaInicio) {
  const venc = sumarUnMes(fechaInicio);
  const ok = await escribirPago(fd.pago, fechaInicio, venc, fd.plan);
  if (!ok) {
    await enviarWhatsApp(remitente, `⚠️ No pude registrar el pago de ${fd.pago.cliente_nombre}. Quedó pendiente para reintentar (escribí "pendientes").`);
    return;
  }
  fechaInicioPagoPendiente.delete(remitente);
  await pool.query(`DELETE FROM pagos_pendientes WHERE id = $1`, [fd.pago.id]);
  await enviarWhatsApp(fd.pago.cliente_from,
    `✅ Pago registrado: ${fd.pago.cliente_nombre} - $${fd.pago.monto} - ${fd.pago.metodo} 🏑`, fd.pago.cliente_nombre);
  await enviarWhatsApp(remitente,
    `✅ ${fd.pago.cliente_nombre} reactivada y al día.\n📅 Fecha de inicio: ${fmtFechaAR(fechaInicio)}\n⏳ Vence: ${fmtFechaAR(venc)}`);
  logActividad('pago_confirmado', `${fd.pago.cliente_nombre} (${fd.pago.metodo}, inicio ${fechaInicio})`, fd.pago.monto, fd.pago.cliente_from);
  await mostrarSiguientePendiente();
}

async function manejarConfirmacionPago(mensajeUpper, pago) {
  if (mensajeUpper === 'SIGUIENTE') {
    await enviarWhatsApp(process.env.COSACO_WHATSAPP,
      `💰 *Confirmación de pago*\nCliente: ${pago.cliente_nombre}\nMonto: $${pago.monto}\nMétodo: ${pago.metodo}\n¿Confirmás? SÍ o NO`);
    return;
  }

  if (mensajeUpper === 'SI' || mensajeUpper === 'S') {
    // FIX pérdida de plata: registrar PRIMERO, verificar, y SOLO SI salió bien
    // borrar el pendiente. Antes se borraba antes de registrar → si el registro
    // fallaba (token vencido, API caída), el pago desaparecía sin guardarse.
    if (!GYM_TOKEN) await loginConReintentos(3, 3000);

    // ¿El cliente viene de seguimiento / suspendido? → su fecha de inicio debe ser
    // su ÚLTIMA ASISTENCIA, y Cosaco tiene que CONFIRMARLA antes de registrar.
    const clienteInfo = await getClienteConReintento(pago.cliente_id);

    if (!clienteInfo) {
      await enviarWhatsApp(process.env.COSACO_WHATSAPP,
        `⚠️ No pude leer la ficha de ${pago.cliente_nombre} (el sistema no respondió). El pago quedó en la cola, NO se perdió. Volvé a escribir "Sí" en un minuto y lo registro.`);
      return; // el pago sigue en cola
    }

    const enSeguimiento = clienteInfo.en_seguimiento === true || clienteInfo.estado === 'Suspendido';
    if (enSeguimiento) {
      const ultima = await ultimaAsistenciaISO(pago.cliente_id);
      const propuesta = ultima || new Date().toISOString().split('T')[0];
      fechaInicioPagoPendiente.set(process.env.COSACO_WHATSAPP, { pago, plan: clienteInfo.plan, propuesta });
      await enviarWhatsApp(process.env.COSACO_WHATSAPP,
        `📅 Antes de registrar el pago de *${pago.cliente_nombre}*:\nSu fecha de inicio sería su *última asistencia*: ${fmtFechaAR(propuesta)}${ultima ? '' : ' (no tiene asistencias cargadas, usé hoy)'}.\n\n¿Confirmás esa fecha? Respondé *SÍ*, o mandame otra (ej: 20/08/2026).`);
      return; // NO se escribe el pago todavía; el pendiente queda en cola
    }

    // Cliente normal (renovación): se registra con la lógica de siempre (hoy).
    const cliente = clienteInfo;
    const hoy = new Date().toISOString().split('T')[0];
    const registrado = await escribirPago(
      pago,
      calcularFechaInicio(cliente),
      calcularFechaVencimiento(hoy, cliente.fecha_vencimiento),
      cliente.plan
    );

    if (!registrado) {
      // NO se borra el pendiente: el pago sigue en cola para reintentar.
      await enviarWhatsApp(process.env.COSACO_WHATSAPP,
        `⚠️ NO pude registrar el pago de ${pago.cliente_nombre} ($${pago.monto}) en el sistema. Quedó pendiente para reintentar. Probá de nuevo en un minuto o cargalo desde el panel.`);
      return; // no avanza: el mismo pago sigue siendo el primero
    }

    await pool.query(`DELETE FROM pagos_pendientes WHERE id = $1`, [pago.id]);
    await enviarWhatsApp(pago.cliente_from,
      `✅ Pago registrado: ${pago.cliente_nombre} - $${pago.monto} - ${pago.metodo} 🏑`, pago.cliente_nombre);
    console.log(`Pago confirmado: ${pago.cliente_nombre} $${pago.monto}`);
    logActividad('pago_confirmado', `${pago.cliente_nombre} (${pago.metodo})`, pago.monto, pago.cliente_from);
  } else {
    // NO → descartar este pendiente y avisar al cliente
    await pool.query(`DELETE FROM pagos_pendientes WHERE id = $1`, [pago.id]);
    await enviarWhatsApp(pago.cliente_from,
      `Quedá tranquilo/a, en breve un integrante del equipo se comunica con vos 🏑`, pago.cliente_nombre);
  }

  // Avanzar al siguiente, de a uno
  await mostrarSiguientePendiente();
}

// ════════════════════════════════════════════════════════════════════════════
//  MENÚ GUIADO PARA CLIENTES (opciones numeradas, sin libre escritura)
// ════════════════════════════════════════════════════════════════════════════
async function mostrarMenuPrincipal(remitente) {
  let nombre1 = '';
  try { const c = await buscarClientePorTelefono(remitente); if (c && c.nombre) nombre1 = ' ' + c.nombre.split(' ')[0]; } catch {}
  menuEstado.set(remitente, { paso: 'MENU', data: {} });
  await enviarWhatsApp(remitente,
`¡Hola${nombre1}! 🏑 Soy el asistente de Hockey Vivo. ¿Qué querés hacer? Respondé con el número (o escribí la opción):

1️⃣ Cargar un pago
2️⃣ Modificar mis turnos
3️⃣ Pedir mi estado de cuenta
4️⃣ Información del gimnasio
5️⃣ Enviar un mensaje al Equipo de HV`);
}

// Encola el pago (para que Cosaco lo confirme) y le avisa al cliente.
async function encolarPagoDesdeMenu(remitente, clienteId, clienteNombre, monto, metodo) {
  await pool.query(`DELETE FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`, [clienteId]);
  await pool.query(
    `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
    [clienteId, clienteNombre, remitente, monto, metodo]
  );
  const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
  if (parseInt(existing[0].count) <= 1) {
    const msg = `💰 ${clienteNombre} - $${monto} - ${metodo}\n¿Confirmás? SÍ o NO`;
    await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
    guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
  }
  logActividad('pago_menu', `${clienteNombre} ($${monto} ${metodo})`, monto, remitente);
  await enviarWhatsApp(remitente,
    `¡Gracias! 🏑 Tomé tu pago de *$${monto}* (${metodo}) a nombre de *${clienteNombre}* y lo mandé al equipo para confirmarlo. En breve te avisamos cuando quede acreditado.`);
}

// Busca un nombre escrito por el cliente y lo deja listo para confirmar.
async function resolverNombreMenu(remitente, texto, estado) {
  if (!GYM_TOKEN) await loginConReintentos(3, 3000);
  const nombreLimpio = guards.limpiarNombreBuscado(texto) || texto.trim();
  const clientes = await ejecutarTool('get_clientes', { buscar: nombreLimpio }, remitente);
  const fuertes = guards.filtrarClientesPorNombre(nombreLimpio, clientes);
  const lista = fuertes.length ? fuertes : (Array.isArray(clientes) ? clientes.slice(0, 5) : []);
  if (lista.length === 0) {
    estado.paso = 'PAGO_NOMBRE_OTRO'; menuEstado.set(remitente, estado);
    await enviarWhatsApp(remitente, `No encontré a nadie con ese nombre 🤔 Escribime el nombre y apellido tal como figura registrada.`);
    return;
  }
  if (lista.length === 1) {
    estado.data.candidatos = lista; estado.data.multi = false;
    estado.paso = 'PAGO_NOMBRE_CONFIRMAR'; menuEstado.set(remitente, estado);
    await enviarWhatsApp(remitente, `¿Confirmás que el pago es para *${lista[0].nombre}*?\n1️⃣ Sí\n2️⃣ No, es otra`);
    return;
  }
  estado.data.candidatos = lista; estado.data.multi = true;
  estado.paso = 'PAGO_NOMBRE_CONFIRMAR'; menuEstado.set(remitente, estado);
  let msg = `Encontré varias. ¿Cuál es? Respondé el número:\n`;
  lista.forEach((c, i) => { msg += `${i + 1}. ${c.nombre}\n`; });
  msg += `\n(o escribí de nuevo el nombre completo)`;
  await enviarWhatsApp(remitente, msg.trim());
}

async function enviarEstadoDeCuenta(remitente) {
  try {
    if (!GYM_TOKEN) await loginConReintentos(3, 3000);
    const cli = await buscarClientePorTelefono(remitente);
    if (!cli) { await enviarWhatsApp(remitente, `No encontré tu ficha con este número 🤔 Escribile al Equipo de HV (opción 5) y lo revisamos.`); return; }
    const r = await fetch(`${GYM_API}/clientes/${cli.id}`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
    const c = await r.json();
    const venc = c.fecha_vencimiento ? fmtFechaAR(c.fecha_vencimiento) : '—';
    const planTxt = c.plan == 1 ? '1 vez por semana' : c.plan == 2 ? '2 veces por semana' : c.plan == 3 ? '3 veces por semana' : `${c.plan}`;
    await enviarWhatsApp(remitente,
      `📄 *Estado de cuenta* — ${c.nombre}\n\n• Estado: ${c.estado}\n• Plan: ${planTxt}\n• Vencimiento: ${venc}\n\n¿Necesitás algo más? Escribí "menú" para volver 🏑`, c.nombre);
  } catch (e) {
    await enviarWhatsApp(remitente, `Uy, no pude traer tu estado de cuenta ahora 😅 Probá de nuevo en un rato o escribile al equipo (opción 5).`);
  }
}

async function enviarInfoGimnasio(remitente) {
  await enviarWhatsApp(remitente,
`ℹ️ *Hockey Vivo Gym*

💰 Planes:
• 1 vez por semana: $35.000
• 2 veces por semana: $42.000

📍 Dirección: ${DIRECCION_GIMNASIO}

👥 Grupo de WhatsApp:
${GRUPO_WHATSAPP}

Escribí "menú" para volver 🏑`);
}

// Máquina de estados del menú. Devuelve tras responder.
async function manejarMenu(remitente, mensaje, profileName) {
  const estado = menuEstado.get(remitente);
  const low = mensaje.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Salir / volver al menú en cualquier momento
  if (/^(cancelar|salir|men[u]|inicio|volver|atras)$/.test(low)) { await mostrarMenuPrincipal(remitente); return; }

  // ── MENÚ PRINCIPAL ──
  if (estado.paso === 'MENU') {
    const op = guards.matchOpcionMenu(mensaje);
    if (!op) { await enviarWhatsApp(remitente, `No te entendí 🤔 Respondé con un número del *1 al 5*, o escribí la opción (ej: "cargar un pago").`); return; }
    if (op === 1) {
      estado.paso = 'PAGO_MONTO'; estado.data = {}; menuEstado.set(remitente, estado);
      await enviarWhatsApp(remitente, `💰 ¿Qué monto vas a pagar?\n1️⃣ $35.000 (1 vez por semana)\n2️⃣ $42.000 (2 veces por semana)\n\n(o escribime el monto si es otro)`);
      return;
    }
    if (op === 2) {
      estado.paso = 'TURNOS_DESC'; menuEstado.set(remitente, estado);
      await enviarWhatsApp(remitente, `📅 Contame qué cambio querés en tus turnos (qué día/horario tenés y a cuál querés cambiar) y le paso el pedido al equipo 🏑`);
      return;
    }
    if (op === 3) { menuEstado.delete(remitente); await enviarEstadoDeCuenta(remitente); return; }
    if (op === 4) { menuEstado.delete(remitente); await enviarInfoGimnasio(remitente); return; }
    if (op === 5) {
      estado.paso = 'MENSAJE_EQUIPO'; menuEstado.set(remitente, estado);
      await enviarWhatsApp(remitente, `✍️ Escribime el mensaje para el Equipo de HV y se lo hago llegar 🏑`);
      return;
    }
  }

  // ── PAGO: monto ──
  if (estado.paso === 'PAGO_MONTO') {
    let monto = null;
    if (/^1$/.test(low)) monto = 35000;
    else if (/^2$/.test(low)) monto = 42000;
    else { const m = guards.parsearMonto(mensaje); if (m) monto = m; }
    if (!monto) { await enviarWhatsApp(remitente, `Elegí el monto: 1️⃣ $35.000 · 2️⃣ $42.000 (o escribí el monto en números).`); return; }
    estado.data.monto = monto; estado.paso = 'PAGO_METODO'; menuEstado.set(remitente, estado);
    await enviarWhatsApp(remitente, `¿Cómo lo pagás?\n1️⃣ Transferencia\n2️⃣ Efectivo`);
    return;
  }

  // ── PAGO: método ──
  if (estado.paso === 'PAGO_METODO') {
    let metodo = null;
    if (/^1$/.test(low) || /transfer/.test(low)) metodo = 'Transferencia';
    else if (/^2$/.test(low) || /efectiv/.test(low)) metodo = 'Efectivo';
    if (!metodo) { await enviarWhatsApp(remitente, `Elegí el método: 1️⃣ Transferencia · 2️⃣ Efectivo`); return; }
    estado.data.metodo = metodo;
    const cli = await buscarClientePorTelefono(remitente).catch(() => null);
    if (cli && cli.nombre) {
      estado.data.clienteId = cli.id; estado.data.clienteNombre = cli.nombre;
      estado.paso = 'PAGO_NOMBRE'; menuEstado.set(remitente, estado);
      await enviarWhatsApp(remitente, `El pago es a nombre de *${cli.nombre}*?\n1️⃣ Sí\n2️⃣ Es para otra jugadora (escribí su nombre y apellido)`);
    } else {
      estado.paso = 'PAGO_NOMBRE_OTRO'; menuEstado.set(remitente, estado);
      await enviarWhatsApp(remitente, `¿A nombre de qué jugadora es el pago? Escribime su nombre y apellido tal como está registrada 🏑`);
    }
    return;
  }

  // ── PAGO: ¿es a nombre del titular del número? ──
  if (estado.paso === 'PAGO_NOMBRE') {
    if (/^1$/.test(low) || /^s[i]$/.test(low) || /^si$/.test(low)) {
      await encolarPagoDesdeMenu(remitente, estado.data.clienteId, estado.data.clienteNombre, estado.data.monto, estado.data.metodo);
      menuEstado.delete(remitente);
      return;
    }
    if (/^2$/.test(low)) {
      estado.paso = 'PAGO_NOMBRE_OTRO'; menuEstado.set(remitente, estado);
      await enviarWhatsApp(remitente, `Dale, escribime el nombre y apellido de la jugadora 🏑`);
      return;
    }
    // Escribió otro nombre directamente
    await resolverNombreMenu(remitente, mensaje, estado);
    return;
  }

  // ── PAGO: pidió otro nombre ──
  if (estado.paso === 'PAGO_NOMBRE_OTRO') {
    await resolverNombreMenu(remitente, mensaje, estado);
    return;
  }

  // ── PAGO: confirmar el nombre elegido ──
  if (estado.paso === 'PAGO_NOMBRE_CONFIRMAR') {
    const cands = estado.data.candidatos || [];
    if (estado.data.multi) {
      const mNum = low.match(/^(\d{1,2})$/);
      if (mNum) {
        const idx = parseInt(mNum[1], 10) - 1;
        if (idx >= 0 && idx < cands.length) {
          await encolarPagoDesdeMenu(remitente, cands[idx].id, cands[idx].nombre, estado.data.monto, estado.data.metodo);
          menuEstado.delete(remitente); return;
        }
        await enviarWhatsApp(remitente, `Ese número no está en la lista. Elegí entre 1 y ${cands.length}, o escribí el nombre completo.`); return;
      }
      // no fue número → re-buscar con lo que escribió
      await resolverNombreMenu(remitente, mensaje, estado); return;
    }
    // un solo candidato → Sí/No
    if (/^1$/.test(low) || /^si$/.test(low) || /^s$/.test(low)) {
      await encolarPagoDesdeMenu(remitente, cands[0].id, cands[0].nombre, estado.data.monto, estado.data.metodo);
      menuEstado.delete(remitente); return;
    }
    if (/^2$/.test(low) || /^no$/.test(low)) {
      estado.paso = 'PAGO_NOMBRE_OTRO'; menuEstado.set(remitente, estado);
      await enviarWhatsApp(remitente, `Dale, escribime el nombre y apellido correcto 🏑`); return;
    }
    // cualquier otra cosa → tratar como nuevo nombre
    await resolverNombreMenu(remitente, mensaje, estado); return;
  }

  // ── MODIFICAR TURNOS: descripción → avisar a Cosaco ──
  if (estado.paso === 'TURNOS_DESC') {
    menuEstado.delete(remitente);
    const cli = await buscarClientePorTelefono(remitente).catch(() => null);
    const quien = cli ? cli.nombre : (profileName || remitente.replace('whatsapp:', ''));
    await enviarWhatsApp(process.env.COSACO_WHATSAPP, `📅 *${quien}* pide modificar turnos:\n"${mensaje.slice(0, 250)}"`);
    logActividad('pedido_turnos', quien, null, remitente);
    await enviarWhatsApp(remitente, `¡Listo! Le pasé tu pedido al equipo, en breve te responden 🏑`);
    return;
  }

  // ── MENSAJE AL EQUIPO ──
  if (estado.paso === 'MENSAJE_EQUIPO') {
    menuEstado.delete(remitente);
    const cli = await buscarClientePorTelefono(remitente).catch(() => null);
    const quien = cli ? cli.nombre : (profileName || remitente.replace('whatsapp:', ''));
    await enviarWhatsApp(process.env.COSACO_WHATSAPP, `✉️ Mensaje de *${quien}* para el equipo:\n"${mensaje.slice(0, 400)}"`);
    logActividad('mensaje_equipo', quien, null, remitente);
    await enviarWhatsApp(remitente, `¡Recibido! Le hice llegar tu mensaje al equipo 🏑`);
    return;
  }

  // Estado raro → reiniciar al menú
  await mostrarMenuPrincipal(remitente);
}

async function procesarMensaje(mensaje, remitente, profileName = null) {
  try {
    const esCosaco = remitente === process.env.COSACO_WHATSAPP;
    console.log('remitente:', remitente, '| esCosaco:', esCosaco);

    // "Tomar el control": si Cosaco pausó esta conversación, el bot NO responde.
    // El mensaje del cliente ya se guardó en el webhook, así que Cosaco lo ve en
    // el panel y responde a mano. Se ignora solo para clientes, nunca para Cosaco.
    if (!esCosaco && await botPausado(remitente)) {
      console.log('Bot pausado para', remitente, '— no responde (Cosaco al control)');
      return;
    }
    const mensajeUpper = mensaje.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const esSiNo = ['SI', 'S', 'NO', 'N'].includes(mensajeUpper);

    // ── MENÚ GUIADO (clientes) ────────────────────────────────────────────
    // Si el cliente está dentro del menú, sus respuestas las maneja la máquina
    // de estados (números/opciones). Si saluda y no hay otro flujo activo, le
    // mostramos el menú. Todo esto es SOLO para clientes, nunca para Cosaco.
    if (!esCosaco && menuEstado.has(remitente)) {
      await manejarMenu(remitente, mensaje, profileName);
      return;
    }
    const quiereAnotarse = /anotar|inscrib|sumar|arrancar|empezar a (entrenar|jugar)|quiero (entrenar|jugar|empezar|probar)|clase de prueba|info para (anotar|sumar|arrancar|jugar)/i.test(mensaje);
    if (!esCosaco && guards.esSaludo(mensaje) && !quiereAnotarse
        && !montoPendiente.has(remitente) && !comprobantePendiente.has(remitente)
        && !pagosEsperandoNombre.has(remitente)) {
      await mostrarMenuPrincipal(remitente);
      return;
    }

    // ── 0-bis. ESPERANDO EL MONTO (le preguntamos "¿cuánto pagaste?") ─────
    if (!esCosaco && montoPendiente.has(remitente)) {
      const datos = montoPendiente.get(remitente);
      // Cortesía mientras esperamos el monto → limpiar y cortar (no insistir).
      if (guards.esCortesia(mensaje)) {
        montoPendiente.delete(remitente);
        await enviarWhatsApp(remitente, `¡De nada! Cuando tengas el monto me lo pasás y lo registramos 🏑`, datos.clienteNombre);
        return;
      }
      const mM = mensaje.match(/\$?\s*([\d]{3,}[\d.,]*)/);
      const monto = mM ? parseFloat(mM[1].replace(/\./g, '').replace(',', '.')) : 0;
      if (monto > 0) {
        montoPendiente.delete(remitente);
        if (!(await hayPagoPendiente(datos.clienteId))) {
          await pool.query(
            `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
            [datos.clienteId, datos.clienteNombre, remitente, monto, datos.metodo || 'Transferencia']
          );
          const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
          if (parseInt(existing[0].count) <= 1) {
            const msg = `💰 ${datos.clienteNombre} - $${monto} - ${datos.metodo || 'Transferencia'}\n¿Confirmás? SÍ o NO`;
            await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
            guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
          }
        }
        await enviarWhatsApp(remitente, `¡Perfecto! Ya le avisé al equipo, en breve te confirmamos 🏑`, datos.clienteNombre);
      } else {
        await enviarWhatsApp(remitente, `No pude leer el monto 😅 ¿Me lo decís en números? Ej: 35000`, datos.clienteNombre);
      }
      return;
    }

    // ── 0. COMPROBANTE PENDIENTE ───────────────────────────────────────────
    if (!esCosaco && comprobantePendiente.has(remitente)) {
      // Cortesía ("gracias", "ok"...) → no es nombre: limpiar estado y cortar.
      if (guards.esCortesia(mensaje)) {
        comprobantePendiente.delete(remitente);
        pagosEsperandoNombre.delete(remitente);
        await enviarWhatsApp(remitente, `¡De nada! Cualquier cosa escribinos 🏑`);
        return;
      }
      comprobantePendiente.delete(remitente);
      // Intentar extraer nombre y monto del mensaje
      const matchMonto = mensaje.match(/\$?([\d.,]+)/);
      const monto = matchMonto ? parseFloat(matchMonto[1].replace(/\./g, '').replace(',', '.')) : null;
      // Nombre: sacar montos y muletillas de pago, quedarnos con el nombre real.
      const nombreRaw = guards.limpiarNombreBuscado(mensaje.replace(/\$?[\d.,]+/g, ' '));
      const nombre = nombreRaw && nombreRaw.length > 2 ? nombreRaw : null;

      if (nombre && monto) {
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const clientes = await ejecutarTool('get_clientes', { buscar: nombre }, remitente);
        const fuertes = guards.filtrarClientesPorNombre(nombre, clientes);
        if (fuertes.length >= 1) {
          const cliente = fuertes[0];
          pagosEsperandoNombre.delete(remitente); // limpiar estado residual
          if (await hayPagoPendiente(cliente.id)) {
            await enviarWhatsApp(remitente, `¡Ya lo tengo registrado! En breve te confirmamos 🏑`, cliente.nombre);
            return;
          }
          await pool.query(
            `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
            [cliente.id, cliente.nombre, remitente, monto, 'Transferencia']
          );
          const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
          if (parseInt(existing[0].count) <= 1) {
            const msg = `💰 Comprobante de ${cliente.nombre} - $${monto} - Transferencia\n¿Confirmás? SÍ o NO`;
            await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
            guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
          }
          await enviarWhatsApp(remitente, `Gracias! Ya le avisé al equipo, en breve te confirmamos 🏑`, cliente.nombre);
        } else {
          // No encontró cliente → pedir nombre de nuevo
          comprobantePendiente.set(remitente, true);
          await enviarWhatsApp(remitente, `No encontré a "${nombre}" en el sistema 🤔 Pasame el nombre y apellido de la jugadora tal como está registrada. Si escribís por tu hija, es el nombre de ella (no el tuyo) 🏑`);
        }
      } else if (!nombre) {
        comprobantePendiente.set(remitente, true);
        await enviarWhatsApp(remitente, `Para registrar el pago necesito el nombre y apellido de la jugadora, tal como está registrada. Si escribís por tu hija, pasame el nombre de ella (no el tuyo) 🏑`);
      } else {
        // Tiene nombre pero falta monto
        comprobantePendiente.set(remitente, true);
        pagosEsperandoNombre.set(remitente, { monto: 0, metodo: 'Transferencia', nombreYaConocido: nombre });
        await enviarWhatsApp(remitente, `¿Cuál fue el monto que transferiste?`);
      }
      return;
    }

    // ── 1. MODO SECRETARIO (solo Cosaco) ──────────────────────────────────
    if (esCosaco) {
      // ── CONFIRMAR FECHA DE INICIO AL PAGAR (reactivación) ─────────────────
      // Cuando se paga un cliente que estaba en seguimiento/suspendido, el bot
      // propone su ÚLTIMA ASISTENCIA como fecha de inicio y espera que Cosaco
      // confirme (SÍ) o mande otra fecha. Va PRIMERO para que ese "SÍ"/fecha no
      // se confunda con la confirmación normal del pago.
      if (fechaInicioPagoPendiente.has(remitente)) {
        const fd = fechaInicioPagoPendiente.get(remitente);
        const low = mensaje.trim().toLowerCase();
        if (mensajeUpper === 'SI' || mensajeUpper === 'S' || /^(dale|confirmo|correcto|esa|esa fecha|si esa|ok esa|de una)$/.test(low)) {
          await finalizarPagoConFecha(remitente, fd, fd.propuesta);
          return;
        }
        if (/^(cancelar|cancela|no|dejalo|despues|despu[eé]s|luego)$/.test(low)) {
          fechaInicioPagoPendiente.delete(remitente);
          await enviarWhatsApp(remitente, `Ok, no registré el pago de ${fd.pago.cliente_nombre}. Quedó pendiente — escribí "pendientes" cuando quieras retomarlo.`);
          return;
        }
        const fecha = guards.parsearFechaInicio(mensaje);
        if (fecha) { await finalizarPagoConFecha(remitente, fd, fecha); return; }
        // Si parece un intento de fecha fallido, avisamos; si no, no bloqueamos.
        const pareceFecha = /^\s*\d{1,2}\s*[\/\-.]\s*\d{1,2}/.test(low)
          || /^\s*(hoy|ayer|manana|mañana)\b/.test(low)
          || /^\s*\d{1,2}\s+(de\s+)?[a-zñáéíóú]+/i.test(low);
        if (pareceFecha) {
          await enviarWhatsApp(remitente, `No entendí la fecha 🤔 Mandame día/mes/año (ej: 20/08/2026), o "SÍ" para usar ${fmtFechaAR(fd.propuesta)} (su última asistencia). O "cancelar".`);
          return;
        }
        // no parece fecha → seguir con el resto de handlers (no return)
      }

      // ── SELECCIÓN DE FICHA (fichas duplicadas): Cosaco responde el número ──
      // Va PRIMERO para que ese "1"/"2" elija la ficha y NUNCA se interprete como
      // monto ($1). Solo se activa si hay una selección pendiente.
      if (seleccionPagoPendiente.has(remitente)) {
        const sel = seleccionPagoPendiente.get(remitente);
        const mLimpio = mensaje.trim().toLowerCase();
        if (/^(no|cancelar|nada|dejalo|olvidalo)$/.test(mLimpio)) {
          seleccionPagoPendiente.delete(remitente);
          await enviarWhatsApp(remitente, 'Ok, cancelo esa carga. Decime de nuevo cuando quieras 🏑');
          return;
        }
        const mNum = mensaje.trim().match(/^#?\s*(\d{1,2})$/);
        if (mNum) {
          const idx = parseInt(mNum[1], 10) - 1;
          if (idx >= 0 && idx < sel.candidatos.length) {
            const cliente = sel.candidatos[idx];
            seleccionPagoPendiente.delete(remitente);
            if (sel.monto && sel.monto > 0) {
              await encolarPagoConfirmable(remitente, cliente, sel.monto, sel.metodo || 'Transferencia');
            } else {
              // Faltaba el monto: ahora que sabemos la ficha, lo pedimos.
              cobrosPendientesDatos.set(remitente, { nombreCliente: cliente.nombre, metodo: sel.metodo || 'Transferencia', clienteId: cliente.id, clienteNombre: cliente.nombre });
              await enviarWhatsApp(remitente, `Elegiste a ${cliente.nombre}. ¿Cuál fue el monto?`);
            }
            return;
          }
          await enviarWhatsApp(remitente, `Ese número no está en la lista. Elegí entre 1 y ${sel.candidatos.length}, o escribí "no" para cancelar.`);
          return;
        }
        // No fue número ni cancelación → recordar que estamos esperando la elección.
        await enviarWhatsApp(remitente, `Necesito que elijas con un número (1 a ${sel.candidatos.length}) cuál ficha es, o "no" para cancelar.`);
        return;
      }

      // Lista de pagos múltiples: 2+ líneas con "Nombre $monto"
      const lineas = mensaje.split('\n').map(l => l.trim()).filter(l => l);
      const esPagoMultiple = lineas.length >= 2 && lineas.every(l => /\w+.*\$?[\d.,]+/.test(l));
      if (esPagoMultiple) {
        const parsearLinea = (l) => {
          const matchBeca = l.match(/beca[^\d]*([\d]+)%/i);
          const beca = matchBeca ? matchBeca[1] : null;
          const matchMonto = l.match(/\$?([\d.,]+)/);
          const montoBase = matchMonto ? parseFloat(matchMonto[1].replace(/\./g, '').replace(',', '.')) : 0;
          const monto = beca ? Math.round(montoBase * (1 - parseInt(beca) / 100)) : montoBase;
          const nombre = l.replace(/\$?[\d.,]+.*$/, '').replace(/beca.*/i, '').trim();
          return { nombre, monto, beca };
        };

        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const procesados = [];
        for (const linea of lineas) {
          const { nombre, monto, beca } = parsearLinea(linea);
          if (!nombre) continue;
          if (!(monto > 0)) { procesados.push({ nombre, monto, beca, montoInvalido: true }); continue; }
          const clientes = await ejecutarTool('get_clientes', { buscar: nombre }, remitente);
          const fuertes = guards.filtrarClientesPorNombre(nombre, clientes);
          if (fuertes.length === 1) {
            const cliente = fuertes[0];
            const metodo = beca ? `Transferencia (Beca ${beca}%)` : 'Transferencia';
            await pool.query(`DELETE FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`, [cliente.id]);
            await pool.query(
              `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
              [cliente.id, cliente.nombre, remitente, monto, metodo]
            );
            procesados.push({ nombre: cliente.nombre, monto, beca });
          } else if (fuertes.length > 1) {
            procesados.push({ nombre, monto, beca, ambiguo: true });
          } else {
            procesados.push({ nombre, monto, beca, noEncontrado: true });
          }
        }

        const { rows: cola } = await pool.query(`SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC`);
        const formatMonto = n => n.toLocaleString('es-AR');
        let resumen = `Procesé ${procesados.filter(p => !p.noEncontrado).length} pagos:\n\n`;
        for (const p of procesados) {
          if (p.montoInvalido) resumen += `⚠️ Monto inválido (no encolé): ${p.nombre}\n`;
          else if (p.ambiguo) resumen += `⚠️ Hay varias fichas de "${p.nombre}" — cargalo aparte para elegir cuál\n`;
          else if (p.noEncontrado) resumen += `⚠️ No encontré: ${p.nombre}\n`;
          else resumen += `💰 ${p.nombre} - $${formatMonto(p.monto)}${p.beca ? ` - Beca ${p.beca}%` : ''}\n`;
        }
        if (cola.length > 0) {
          const primero = cola[0];
          resumen += `\n¿Confirmás el pago de ${primero.cliente_nombre} por $${formatMonto(primero.monto)}? SÍ o NO`;
        }
        await enviarWhatsApp(process.env.COSACO_WHATSAPP, resumen);
        return;
      }

      // "pendientes" / "confirmar" / "confirmar pagos" → arranca el flujo
      // determinístico de confirmación UNO POR UNO (nunca lo maneja la IA:
      // la IA no tiene forma de registrar pagos y antes "decía" que confirmaba
      // sin hacerlo, perdiendo la plata).
      const esComandoConfirmar = guards.esComandoConfirmarPagos(mensaje);
      if (esComandoConfirmar) {
        console.log('Procesando pendientes para Cosaco...');
        const { rows: pagos } = await pool.query(`SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC`);
        const { rows: susps } = await pool.query(`SELECT * FROM suspensiones_pendientes WHERE esperando_confirmacion = true ORDER BY timestamp ASC`);
        console.log('Pagos pendientes:', pagos.length, '| Suspensiones:', susps.length);
        if (pagos.length === 0 && susps.length === 0) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, '✅ No hay pendientes de confirmación');
          return;
        }
        // Resumen breve + arrancar la confirmación de a uno
        if (pagos.length > 0) {
          let res = `📋 Tenés ${pagos.length} pago(s) para confirmar, de a uno:\n`;
          for (const p of pagos) res += `• ${p.cliente_nombre} — $${p.monto} ${p.metodo}\n`;
          res += `\nEmpecemos 👇`;
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, res);
          await mostrarSiguientePendiente();
        }
        if (susps.length > 0) {
          let res = `⚠️ Suspensiones pendientes (${susps.length}):\n`;
          for (const s of susps) res += `- ${s.cliente_nombre}\n`;
          res += `Respondé SÍ o NO para cada una cuando termines los pagos.`;
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, res);
        }
        return;
      }

      // Si/No → tercer turno pendiente de autorización
      if (esSiNo && tercerTurnoPendiente.has(remitente)) {
        const datos = tercerTurnoPendiente.get(remitente);
        tercerTurnoPendiente.delete(remitente);
        if (mensajeUpper === 'SI' || mensajeUpper === 'S') {
          if (!GYM_TOKEN) await loginConReintentos(3, 3000);
          const hdrs = { Authorization: `Bearer ${GYM_TOKEN}` };
          // Primero los quitados acordados (si el pedido incluía cambios)
          for (const qid of (datos.quitarIds || [])) {
            await fetch(`${GYM_API}/turnos/${qid}/quitar/${datos.clienteId}`, { method: 'DELETE', headers: hdrs }).catch(() => {});
          }
          // FIX: asignar TODOS los turnos autorizados (antes solo el primero)
          const ids = datos.turnoIds || (datos.turnoId ? [datos.turnoId] : []);
          const ok = [], mal = [];
          for (const tid of ids) {
            const r = await fetch(`${GYM_API}/turnos/${tid}/asignar/${datos.clienteId}`, { method: 'POST', headers: hdrs });
            if (r.ok) ok.push(tid); else mal.push(tid);
          }
          logActividad('turnos_asignados', `${datos.clienteNombre}: ${ok.length} turno(s) autorizados`, ok.length, datos.clienteFrom);
          if (mal.length === 0) {
            await enviarWhatsApp(process.env.COSACO_WHATSAPP, `✅ ${ok.length} turno(s) asignados a ${datos.clienteNombre}`);
            await enviarWhatsApp(datos.clienteFrom, `¡Listo! Tus ${ok.length} turno(s) fueron autorizados y asignados 🏑`, datos.clienteNombre);
          } else {
            await enviarWhatsApp(process.env.COSACO_WHATSAPP,
              `⚠️ ${datos.clienteNombre}: asigné ${ok.length}, fallaron ${mal.length} (turnos ${mal.join(', ')} — ¿llenos o bloqueados?). Revisá la grilla.`);
            await enviarWhatsApp(datos.clienteFrom,
              ok.length ? `Se asignaron ${ok.length} de tus turnos; el equipo está revisando el resto 🏑` : `Hubo un problema con la asignación; el equipo lo está revisando 🏑`,
              datos.clienteNombre);
          }
        } else {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `👍 3er turno de ${datos.clienteNombre} no autorizado`);
          await enviarWhatsApp(datos.clienteFrom,
            `Tu solicitud no fue aprobada por el momento. Podés elegir cambiar uno de tus turnos actuales si querés 🏑`, datos.clienteNombre);
        }
        return;
      }

      // Si/No → pago pendiente
      const { rows: pagosPend } = await pool.query(
        `SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC LIMIT 1`
      );
      if (pagosPend.length > 0 && esSiNo) {
        await manejarConfirmacionPago(mensajeUpper, pagosPend[0]);
        return;
      }

      // ── CORRECCIÓN DE NOMBRE sobre un pago pendiente ──────────────────────
      // "No, Martina Munar" / "no es Delfina Coronel" / "era Juan Perez":
      // descarta el pendiente actual y re-resuelve el nombre corregido,
      // CONSERVANDO el monto/método. Antes esto lo tomaba la IA, que solo
      // reescribía el texto sin cambiar el registro → confirmaba a la persona
      // equivocada. Ahora es determinístico.
      if (pagosPend.length > 0 && !esSiNo) {
        const mCorr = mensaje.trim().match(/^no[,.\-!\s]+(?:es\s+|era\s+|es la\s+|es el\s+)?([a-záéíóúüñ][a-záéíóúüñ\s.]+)$/i);
        if (mCorr) {
          const nombreCorregido = mCorr[1].replace(/[.!]+$/, '').trim();
          // Evitar falsos positivos tipo "no gracias", "no se", "no todavia"
          const descartes = /^(gracias|se|s[eé]|todav[ií]a|todavia|ahora|por ahora|aun|a[uú]n|nada|ninguno|ninguna|es correcto|est[aá] bien|esta bien)$/i;
          if (nombreCorregido.length >= 3 && !descartes.test(nombreCorregido)) {
            const pendiente = pagosPend[0];
            const monto = pendiente.monto;
            const metodo = pendiente.metodo || 'Transferencia';
            // Descartar el pendiente equivocado
            await pool.query(`DELETE FROM pagos_pendientes WHERE id = $1`, [pendiente.id]);
            if (!GYM_TOKEN) await loginConReintentos(3, 3000);
            await resolverYEncolarPago(remitente, nombreCorregido, monto, metodo);
            return;
          }
        }
      }

      // Si/No → suspensión pendiente
      const { rows: suspsPend } = await pool.query(
        `SELECT * FROM suspensiones_pendientes WHERE esperando_confirmacion = true ORDER BY timestamp ASC LIMIT 1`
      );
      if (suspsPend.length > 0 && esSiNo) {
        const susp = suspsPend[0];
        await pool.query(`DELETE FROM suspensiones_pendientes WHERE id = $1`, [susp.id]);
        if (mensajeUpper === 'SI' || mensajeUpper === 'S') {
          const suspsPendientes = await pool.query('SELECT * FROM suspensiones_pendientes WHERE esperando_confirmacion = true');
          console.log('Suspensiones pendientes en DB:', suspsPendientes.rows.length);
          await fetch(`${GYM_API}/clientes/${susp.cliente_id}/suspender`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${GYM_TOKEN}` }
          });
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `✅ ${susp.cliente_nombre} suspendido correctamente`);
        } else {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `👍 Ok, ${susp.cliente_nombre} no fue suspendido`);
        }
        const { rows: sig } = await pool.query(
          `SELECT * FROM suspensiones_pendientes WHERE esperando_confirmacion = true ORDER BY timestamp ASC LIMIT 1`
        );
        if (sig.length > 0) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `⚠️ Siguiente: ${sig[0].cliente_nombre} lleva días sin pagar. ¿Suspendo? SÍ o NO`);
        }
        return;
      }

      // Cosaco mandó solo un número → completar cobro pendiente de datos
      const matchNumeroSolo = mensaje.match(/^\$?([\d.,]+)\s*(transferencia|efectivo)?$/i);
      if (matchNumeroSolo && cobrosPendientesDatos.has(remitente)) {
        const datos = cobrosPendientesDatos.get(remitente);
        cobrosPendientesDatos.delete(remitente);
        const monto = parseFloat(matchNumeroSolo[1].replace(/\./g, '').replace(',', '.'));
        const metodo = matchNumeroSolo[2]
          ? (matchNumeroSolo[2].charAt(0).toUpperCase() + matchNumeroSolo[2].slice(1).toLowerCase())
          : datos.metodo || 'Transferencia';
        if (!(monto > 0)) {
          cobrosPendientesDatos.set(remitente, datos); // seguir esperando un monto válido
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `⚠️ Ese monto no es válido. ¿Cuál fue el monto de ${datos.clienteNombre}?`);
          return;
        }
        await pool.query(`DELETE FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`, [datos.clienteId]);
        await pool.query(
          `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
          [datos.clienteId, datos.clienteNombre, remitente, monto, metodo]
        );
        const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
        if (parseInt(existing[0].count) > 1) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `✅ Pago de ${datos.clienteNombre} $${monto} encolado`);
        } else {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `💰 ${datos.clienteNombre} - $${monto} - ${metodo}\n¿Confirmás? SÍ o NO`);
        }
        return;
      }

      // "confirmar/registrar el pago de [Nombre] [$monto] [en/por metodo]"
      // Tolera "en/por" antes del método y signos finales ("...29000 en transferencia?").
      const matchConfirmar = mensaje.match(/(?:confirm[aá]r?|registr[aá]r?|carg[aá]r?)\s+el\s+pago\s+de\s+(.+?)(?:\s+\$?(\d[\d.,]*))?(?:\s+(?:en\s+|por\s+)?(transferencia|efectivo|transf|efvo))?\s*[?.!¿¡]*$/i);
      // "[Nombre] pagó/pago [$monto] [metodo]" — solo cuando empieza con nombre
      const matchPagoNombre = !matchConfirmar && mensaje.match(/^([A-Za-záéíóúüñÁÉÍÓÚÜÑ\s]+?)\s+pag[oó]\s*\$?(\d[\d.,]*)?[\s,]*(?:en\s+|por\s+)?(efectivo|transferencia|transf|efvo)?\s*[?.!¿¡]*$/i);

      const matchPago = matchConfirmar || matchPagoNombre;
      if (matchPago) {
        const nombreCrudo = (matchConfirmar ? matchConfirmar[1] : matchPagoNombre[1]).replace(/[?.!¿¡]+$/, '').trim();
        // Sacar muletillas ("por favor", "pago", "?"...) para que el match no falle.
        const nombreBuscar = guards.limpiarNombreBuscado(nombreCrudo) || nombreCrudo;
        const montoRaw = matchConfirmar ? matchConfirmar[2] : matchPagoNombre[2];
        const metodoRaw = matchConfirmar ? matchConfirmar[3] : matchPagoNombre[3];
        const monto = montoRaw ? parseFloat(montoRaw.replace(/\./g, '').replace(',', '.')) : null;
        const metodo = /efec|efvo/i.test(metodoRaw || '') ? 'Efectivo' : 'Transferencia';

        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const clientes = await ejecutarTool('get_clientes', { buscar: nombreBuscar }, remitente);
        const fuertes = guards.filtrarClientesPorNombre(nombreBuscar, clientes);

        // Sin monto → primero resolver a UN cliente, después pedir el monto.
        if (!monto) {
          if (fuertes.length === 1) {
            const cliente = fuertes[0];
            cobrosPendientesDatos.set(remitente, { nombreCliente: nombreBuscar, metodo, clienteId: cliente.id, clienteNombre: cliente.nombre });
            await enviarWhatsApp(process.env.COSACO_WHATSAPP, `Encontré a ${cliente.nombre}. ¿Cuál fue el monto?`);
            return;
          }
          if (fuertes.length > 1) {
            seleccionPagoPendiente.set(remitente, { candidatos: fuertes, monto: null, metodo });
            let msg = `Hay ${fuertes.length} fichas de "${nombreBuscar}". ¿Cuál? Respondé el número:\n`;
            fuertes.forEach((c, i) => { msg += `${i + 1}. ${c.nombre}${c.estado ? ' — ' + c.estado : ''}\n`; });
            await enviarWhatsApp(process.env.COSACO_WHATSAPP, msg.trim());
            return;
          }
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `⚠️ No encontré una ficha que coincida con "${nombreBuscar}". Verificá el nombre completo.`);
          return;
        }

        // Con nombre y monto → resolver (nombre+apellido) y encolar / preguntar cuál.
        await resolverYEncolarPago(remitente, nombreBuscar, monto, metodo);
        return;
      }

      // "suspendé a [nombre]"
      const matchSuspender = mensaje.match(/suspen[dé]+\s+a\s+(.+)/i);
      if (matchSuspender) {
        const nombreBuscar = matchSuspender[1].trim();
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const clientes = await ejecutarTool('get_clientes', { buscar: nombreBuscar }, remitente);
        if (Array.isArray(clientes) && clientes.length > 0) {
          const cliente = clientes[0];
          await pool.query(
            `INSERT INTO suspensiones_pendientes (cliente_id, cliente_nombre, esperando_confirmacion) VALUES ($1, $2, true)`,
            [cliente.id, cliente.nombre]
          );
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `⚠️ ¿Suspendés a ${cliente.nombre}? SÍ o NO`);
        } else {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `⚠️ No encontré cliente con el nombre "${nombreBuscar}"`);
        }
        return;
      }

      // Todo lo demás de Cosaco → Claude (fall through)
    }

    console.log('Mensaje a procesar:', mensaje);
    console.log('Contiene pago?:', /pagu[eé]|transfer[ií]|hice el pago|acabo de transferir/i.test(mensaje));
    console.log('Contiene reserva?:', /me interesa reservar|turnos elegidos/i.test(mensaje));

    // ── 2. MENSAJE DE RESERVA ──────────────────────────────────────────────
    const esReserva = /me interesa reservar lugar en hockey vivo/i.test(mensaje) ||
      (/turnos elegidos:/i.test(mensaje) && /mis datos:/i.test(mensaje));

    if (esReserva) {
      const extraer = (pattern) => mensaje.match(pattern)?.[1]?.trim() || '';
      const nombre = extraer(/nombre[:\s]+([^\n\r]+)/i);
      const apellido = extraer(/apellido[:\s]+([^\n\r]+)/i);
      const nacimiento = extraer(/(?:nacimiento|fecha de nacimiento)[:\s]+([^\n\r]+)/i);
      const whatsapp = extraer(/whatsapp[:\s]+([^\n\r]+)/i);
      const equipo = extraer(/equipo[:\s]+([^\n\r]+)/i);

      // Extraer líneas de turnos
      const bloqueTurnos = mensaje.match(/turnos elegidos[\s\S]*$/i)?.[0] || '';
      const lineasTurnos = bloqueTurnos.split('\n')
        .filter(l => /lunes|martes|mi[eé]rcoles|jueves|viernes/i.test(l));

      if (!GYM_TOKEN) await loginConReintentos(3, 3000);
      const turnosData = await ejecutarTool('get_turnos', {}, remitente);
      const turnos = Array.isArray(turnosData) ? turnosData : [];

      const normStr = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const turnoIds = [];
      const turnosTexto = [];

      for (const linea of lineasTurnos) {
        const lineaNorm = normStr(linea);
        const match = turnos.find(t =>
          !turnoIds.includes(t.id) &&
          lineaNorm.includes(normStr(t.dia_semana)) &&
          (t.hora_inicio ? lineaNorm.includes(t.hora_inicio.slice(0, 5)) : true)
        );
        if (match) {
          turnoIds.push(match.id);
          turnosTexto.push(`${match.dia_semana} ${match.hora_inicio}`);
        }
      }

      if (turnoIds.length === 0) {
        await enviarWhatsApp(remitente,
          `Hola${nombre ? ' ' + nombre : ''}! Vi tu consulta pero no pude identificar los turnos. Podés ver los disponibles en: https://hockeyvivo.up.railway.app/cupos 🏑`,
          nombre || null);
        return;
      }

      const sinCupo = turnos.filter(t => turnoIds.includes(t.id) && t.cupo_usado >= t.cupo_maximo);
      if (sinCupo.length > 0) {
        await enviarWhatsApp(remitente,
          `Hola${nombre ? ' ' + nombre : ''}! Lamentablemente los turnos que pediste no tienen lugar disponible. Podés ver los cupos en: https://hockeyvivo.up.railway.app/cupos 🏑`,
          nombre || null);
        return;
      }

      const telefonoFinal = whatsapp || remitente;
      const datos = { nombre, apellido, telefono: telefonoFinal, fecha_nacimiento: parsearFecha(nacimiento), club: equipo, turno_ids: turnoIds };
      await pool.query(
        'INSERT INTO registros_pendientes (telefono, datos) VALUES ($1, $2) ON CONFLICT (telefono) DO UPDATE SET datos = $2, timestamp = NOW()',
        [remitente, JSON.stringify(datos)]
      );

      const turnosStr = turnosTexto.join(', ');
      await enviarWhatsApp(remitente,
        `¡Hola ${nombre}! Verificamos y ${turnosStr} ${turnoIds.length > 1 ? 'tienen' : 'tiene'} lugar disponible 🏑\n¿Confirmás tu inscripción en Hockey Vivo?`,
        nombre);
      return;
    }

    // ── 3. CONFIRMACIÓN DE INSCRIPCIÓN ─────────────────────────────────────
    if (!esCosaco && ['si', 'sí', 'confirmo', 'dale', 'ok', 'yes'].includes(mensaje.trim().toLowerCase())) {
      const { rows } = await pool.query('SELECT datos FROM registros_pendientes WHERE telefono = $1', [remitente]);
      if (rows.length > 0) {
        const datos = rows[0].datos;
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const resultado = await ejecutarTool('registrar_cliente_y_asignar_turno', datos, remitente);
        await pool.query('DELETE FROM registros_pendientes WHERE telefono = $1', [remitente]);
        if (resultado.ok) {
          const turnosData = await ejecutarTool('get_turnos', {}, remitente);
          const turnosStr = datos.turno_ids.map(id => {
            const t = Array.isArray(turnosData) ? turnosData.find(t => t.id === id) : null;
            return t ? `📅 ${t.dia_semana} ${t.hora_inicio}` : `📅 Turno ${id}`;
          }).join('\n');
          const texto = `¡Todo listo ${datos.nombre}! Ya quedaste registrado/a en Hockey Vivo 🎉\n\nTus turnos:\n${turnosStr}\n\nSumate al grupo de WhatsApp del gimnasio para enterarte de todo 👇\n${GRUPO_WHATSAPP}\n\nNo olvidés traer: 🏑 Palo | 👟 Botines | 💧 Agua\n¡Te esperamos! 💪`;
          await enviarWhatsApp(remitente, texto, datos.nombre);
          guardarMensaje(remitente, datos.nombre, texto, 'agente');
        } else {
          await enviarWhatsApp(remitente, 'Ya tomamos nota, en breve te confirmamos tu lugar 🏑', datos.nombre);
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `⚠️ Error al registrar a ${datos.nombre}: ${resultado.error}`);
        }
        return;
      }
    }

    // ── 4. INTENCIÓN DE PAGO ───────────────────────────────────────────────
    if (!esCosaco) {
      // Si el cliente ya avisó que pagó y estamos esperando su nombre
      if (pagosEsperandoNombre.has(remitente)) {
        const datosPago = pagosEsperandoNombre.get(remitente);
        // Si mandó una cortesía ("gracias", "ok", "dale"...) NO es un nombre:
        // limpiamos el estado y respondemos amable, sin buscar clientes.
        if (guards.esCortesia(mensaje)) {
          pagosEsperandoNombre.delete(remitente);
          comprobantePendiente.delete(remitente);
          await enviarWhatsApp(remitente, `¡De nada! Cualquier cosa escribinos 🏑`);
          return;
        }
        pagosEsperandoNombre.delete(remitente);
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const nombreDado = guards.limpiarNombreBuscado(mensaje) || mensaje.trim();
        const clientes = await ejecutarTool('get_clientes', { buscar: nombreDado }, remitente);
        const fuertes = guards.filtrarClientesPorNombre(nombreDado, clientes);
        if (fuertes.length >= 1) {
          const cliente = fuertes[0];
          const montoDP = Number(datosPago.monto) || 0;
          // FIX $0: si no sabemos el monto, preguntarlo en vez de encolar $0
          if (!(montoDP > 0)) {
            montoPendiente.set(remitente, { clienteId: cliente.id, clienteNombre: cliente.nombre, metodo: datosPago.metodo || 'Transferencia' });
            await enviarWhatsApp(remitente, `Gracias ${cliente.nombre.split(' ')[0]}! ¿Cuál fue el monto que pagaste? 🏑`, cliente.nombre);
            return;
          }
          if (await hayPagoPendiente(cliente.id)) {
            await enviarWhatsApp(remitente, `¡Ya lo tengo registrado! En breve te confirmamos 🏑`, cliente.nombre);
            return;
          }
          await pool.query(
            `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
            [cliente.id, cliente.nombre, remitente, montoDP, datosPago.metodo || 'Transferencia']
          );
          const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
          if (parseInt(existing[0].count) <= 1) {
            const msg = `💰 ${cliente.nombre} - $${montoDP} - ${datosPago.metodo || 'Transferencia'}\n¿Confirmás? SÍ o NO`;
            await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
            guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
          }
          await enviarWhatsApp(remitente, `Gracias! Ya le avisé al equipo, en breve te confirmamos 🏑`, cliente.nombre);
        } else {
          await enviarWhatsApp(remitente, `No encontré ese nombre 🤔 Pasame el nombre y apellido de la jugadora tal como está registrada. Si escribís por tu hija, es el nombre de ella (no el tuyo) 🏑`);
          pagosEsperandoNombre.set(remitente, datosPago); // seguir esperando
        }
        return;
      }

      // ── AVISO DE AUSENCIA / BAJA: el cliente dice que deja de venir, que este
      // mes no va, o que vuelve más adelante → avisar a Cosaco para que vea la
      // conversación y evalúe una suspensión. NO toma ninguna acción automática.
      // Throttle de 6 h por cliente para no spamear. Responde amable y corta acá.
      if (guards.esAvisoDeAusencia(mensaje)) {
        const cliA = await buscarClientePorTelefono(remitente).catch(() => null);
        const quien = cliA ? cliA.nombre : (profileName || remitente.replace('whatsapp:', ''));
        const ultimo = ausenciaAvisada.get(remitente) || 0;
        if (Date.now() - ultimo > 6 * 3600000) {
          ausenciaAvisada.set(remitente, Date.now());
          const estado = cliA ? ` (estado: ${cliA.estado})` : '';
          enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `⏸️ ${quien}${estado} avisó que dejaría de asistir / no viene un tiempo:\n"${mensaje.slice(0, 160)}"\n\nRevisá la conversación por si conviene suspender el servicio. (Solo aviso — no hice nada automático)`).catch(() => {});
          logActividad('aviso_ausencia', quien, null, remitente);
        }
        const nombre1 = cliA && cliA.nombre ? cliA.nombre.split(' ')[0] : '';
        await enviarWhatsApp(remitente,
          `¡Gracias por avisar${nombre1 ? ', ' + nombre1 : ''}! Le paso el mensaje al equipo así lo tienen en cuenta. Cuando quieras retomar, escribinos y coordinamos 🏑`,
          cliA ? cliA.nombre : null);
        return;
      }

      const esPagoRealizado = guards.esPagoRealizado(mensaje);
      const esIntFutura = guards.esPromesaFutura(mensaje);

      // ── PROMESA DE PAGO FUTURO: avisar a Cosaco y nada más ──
      // No se encola NADA (nada de confirmaciones de $0). Solo un aviso
      // informativo, con throttle de 1 h por cliente para no spamear.
      if (esIntFutura && !esPagoRealizado) {
        const cliP = await buscarClientePorTelefono(remitente).catch(() => null);
        const quien = cliP ? cliP.nombre : remitente.replace('whatsapp:', '');
        const ultimo = promesaAvisada.get(remitente) || 0;
        if (Date.now() - ultimo > 3600000) {
          promesaAvisada.set(remitente, Date.now());
          enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `📣 ${quien} avisó que va a pagar más adelante: "${mensaje.slice(0, 120)}"\n(Solo aviso — no hay nada que confirmar)`).catch(() => {});
          logActividad('promesa_pago', quien, null, remitente);
        }
        // CLAVE: es una PROMESA de pago futuro → responder amable y CORTAR acá.
        // Nunca preguntarle el monto ni pasarlo a la IA (evita el "¿cuánto
        // transferiste?" cuando el cliente solo dijo que paga más adelante).
        const nombre1 = cliP && cliP.nombre ? cliP.nombre.split(' ')[0] : '';
        await enviarWhatsApp(remitente,
          `¡Perfecto${nombre1 ? ', ' + nombre1 : ''}! No hay problema, quedamos a la espera. Cuando lo abones avisanos por acá y listo 🏑`,
          cliP ? cliP.nombre : null);
        return;
      }

      if (esPagoRealizado && !esIntFutura) {
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const cliente = await buscarClientePorTelefono(remitente);
        if (cliente) {
          // FIX $0: intentar leer el monto del propio mensaje ("transferí 35000")
          const mMonto = mensaje.match(/\$?\s*([\d]{4,}[\d.,]*)/);
          const montoMsg = mMonto ? parseFloat(mMonto[1].replace(/\./g, '').replace(',', '.')) : 0;
          if (!(montoMsg > 0)) {
            // Sin monto → NO encolar $0: preguntarle cuánto pagó
            montoPendiente.set(remitente, { clienteId: cliente.id, clienteNombre: cliente.nombre, metodo: 'Transferencia' });
            await enviarWhatsApp(remitente, `¡Gracias por avisar! ¿Cuál fue el monto que pagaste? 🏑`, cliente.nombre);
            return;
          }
          if (await hayPagoPendiente(cliente.id)) {
            await enviarWhatsApp(remitente, `¡Ya lo tengo registrado! En breve te confirmamos 🏑`, cliente.nombre);
            return;
          }
          await pool.query(
            `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
            [cliente.id, cliente.nombre, remitente, montoMsg, 'Transferencia']
          );
          const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
          if (parseInt(existing[0].count) <= 1) {
            const msg = `💰 ${cliente.nombre} - $${montoMsg} - Transferencia\n¿Confirmás? SÍ o NO`;
            await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
            guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
          }
          await enviarWhatsApp(remitente, `Gracias! Ya le avisé al equipo, en breve te confirmamos 🏑`, cliente.nombre);
        } else {
          const matchMonto = mensaje.match(/\$?(\d[\d.,]*)\s*(transferencia|efectivo)?/i);
          const montoDetectado = matchMonto ? parseFloat(matchMonto[1].replace(/\./g, '').replace(',', '.')) : 0;
          const metodoDetectado = matchMonto?.[2] ? (matchMonto[2].charAt(0).toUpperCase() + matchMonto[2].slice(1).toLowerCase()) : 'Transferencia';
          pagosEsperandoNombre.set(remitente, { monto: montoDetectado, metodo: metodoDetectado });
          await enviarWhatsApp(remitente, `¡Gracias por avisarnos! Para identificar el pago, pasame el nombre y apellido de la jugadora tal como está registrada. Si escribís por tu hija, es el nombre de ella (no el tuyo) 🏑`);
        }
        return;
      }
    }

    // ── 5. BAJA DE CLIENTE ─────────────────────────────────────────────────
    if (!esCosaco) {
      const esBaja = /no voy a continuar|me doy de baja|quiero darme de baja|no puedo seguir|voy a pausar/i.test(mensaje);
      if (esBaja) {
        console.log('Baja detectada de:', remitente);
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const cliente = await buscarClientePorTelefono(remitente);
        console.log('Cliente encontrado:', cliente ? cliente.nombre : 'ninguno');
        const nombreMostrar = cliente?.nombre || profileName || remitente;

        await enviarWhatsApp(remitente,
          `Lamentamos mucho que te vayas 😔 Antes de que te vayas queremos que sepas que las puertas siempre van a estar abiertas para vos. En unos minutos confirmamos tu baja y preparamos todo para cuando quieras volver. ¡Te esperamos! 🏑`,
          profileName || null);

        if (cliente?.id) {
          await pool.query(
            `INSERT INTO suspensiones_pendientes (cliente_id, cliente_nombre, telefono, esperando_confirmacion) VALUES ($1, $2, $3, true)`,
            [cliente.id, cliente.nombre, remitente]
          );
        }

        await enviarWhatsApp(process.env.COSACO_WHATSAPP,
          `⚠️ ${nombreMostrar} quiere darse de baja. ¿Confirmás la suspensión? Respondé SÍ o NO`);
        return;
      }
    }

    // ── 6. TODO LO DEMÁS → Claude ──────────────────────────────────────────
    if (!GYM_TOKEN) await loginConReintentos(3, 3000);
    const clienteIdentificado = await buscarClientePorTelefono(remitente);
    const messages = await getHistorial(remitente);
    messages.push({ role: 'user', content: mensaje });

    const fechaHoy = new Date().toLocaleDateString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const fechaISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

    let system = SYSTEM_PROMPT;
    if (clienteIdentificado) {
      system += `\n\nCLIENTE IDENTIFICADO: Estás hablando con ${clienteIdentificado.nombre} (plan ${clienteIdentificado.plan}, estado ${clienteIdentificado.estado}, vencimiento ${clienteIdentificado.fecha_vencimiento}). Usá su nombre directamente.`;
    }
    system += `\n\nFECHA ACTUAL: ${fechaHoy} (${fechaISO})`;

    while (true) {
      const respuesta = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      });

      if (respuesta.stop_reason !== 'tool_use') {
        const bloqueTexto = respuesta.content.find(b => b.type === 'text');
        const texto = bloqueTexto?.text?.trim() || '¡Listo! Si necesitás algo más, avisame 🏑';
        await twilioClient.messages.create({ from: TWILIO_FROM, to: remitente, body: texto });
        guardarMensaje(remitente, null, texto, 'agente');
        break;
      }

      messages.push({ role: 'assistant', content: respuesta.content });
      guardarMensaje(remitente, null, '[tool_use]', 'tool_use', respuesta.content);
      const toolResults = [];
      for (const bloque of respuesta.content) {
        if (bloque.type !== 'tool_use') continue;
        console.log(`Tool: ${bloque.name}`, JSON.stringify(bloque.input).slice(0, 200));
        const resultado = await ejecutarTool(bloque.name, bloque.input, remitente);
        console.log(`Resultado ${bloque.name}:`, JSON.stringify(resultado).slice(0, 200));
        toolResults.push({ type: 'tool_result', tool_use_id: bloque.id, content: JSON.stringify(resultado) });
      }
      messages.push({ role: 'user', content: toolResults });
      guardarMensaje(remitente, null, '[tool_result]', 'tool_result', toolResults);
    }
  } catch (err) {
    console.error(`Error procesando mensaje de ${remitente}:`, err);
  }
}

async function clientesPorGrupo(diaGrupo, tipoJob) {
  try {
    const r = await fetch(`${GYM_API}/vencimientos`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
    const data = await r.json();
    const clientes = Array.isArray(data) ? data : (data[`dia${diaGrupo}`] || []);
    const hoy = new Date();
    return clientes.filter(c => {
      if (!c.vencimiento) return false;
      const venc = new Date(c.vencimiento + 'T12:00:00');
      const dias = Math.floor((hoy - venc) / 86400000);
      c.dias_vencido = dias;
      if (venc.getDate() !== diaGrupo) return false;
      if (tipoJob === 'recordatorio') return c.estado === 'Vigente' && dias >= -1 && dias <= 0;
      if (tipoJob === 'mora') return dias >= 4 && dias <= 6;
      if (tipoJob === 'suspension') return dias >= 9 && dias <= 11;
      return false;
    });
  } catch (err) {
    console.error('Error clientesPorGrupo:', err.message);
    return [];
  }
}

async function runJob(diaGrupo, tipoJob) {
  const clientes = await clientesPorGrupo(diaGrupo, tipoJob);
  const templateMap = {
    recordatorio: process.env.TEMPLATE_RECORDATORIO,
    mora: process.env.TEMPLATE_MORA,
    suspension: process.env.TEMPLATE_SUSPENSION,
  };
  for (const c of clientes) {
    const nombre = c.nombre.split(' ')[0];
    const textoGuardar = tipoJob === 'mora'
      ? `Hola ${nombre}! 👋 Te extrañamos en Hockey Vivo Gym y vimos que todavía no se acreditó tu pago. ¿Fue un error o necesitás ayuda con algo? Sabés que siempre podés contar con nosotros. Un abrazo! 🏑`
      : tipoJob === 'recordatorio'
      ? `Hola ${nombre}! 👋 Hoy vence tu plan en Hockey Vivo Gym. Cada entrenamiento que hacés es un paso que te acerca a la mejor versión de tu juego. Ese trabajo no se detiene — y nosotros tampoco. Para seguir, estos son los planes: 🏑 2 veces por semana: $42.000 🏑 1 vez por semana: $35.000. Transferí al alias: hockeyvivo. Confirmando el pago, tu lugar queda asegurado. 💪`
      : tipoJob === 'suspension'
      ? `Hola ${nombre}! 👋 Tu membresía en Hockey Vivo fue suspendida por falta de pago. Cuando estés listo/a para volver, avisanos y te reactivamos enseguida. ¡Te esperamos! 🏑`
      : `[${tipoJob}]`;
    await enviarTemplate(c.telefono, templateMap[tipoJob], { "1": nombre }, textoGuardar);
    if (tipoJob === 'suspension') {
      await pool.query(
        `INSERT INTO suspensiones_pendientes (cliente_id, cliente_nombre, telefono)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [c.id, c.nombre, c.telefono]
      );
      console.log(`Suspensión pendiente guardada en DB: ${c.nombre}`);
    }
  }
  console.log(`Job ${tipoJob} grupo ${diaGrupo}: ${clientes.length} clientes`);
}

// ─── FIX CRÍTICO: refresco proactivo del token ───
// El bot se logueaba UNA vez al arrancar y usaba ese token para siempre.
// Con tokens de 30 días + reinicios frecuentes zafaba; ahora los tokens duran
// 48 h (Etapa 0 del backend), así que sin esto el bot muere a los 2 días.
// Refrescamos cada 12 h: el token nunca llega ni cerca de vencer.
cron.schedule('0 */12 * * *', () => loginConReintentos(3, 5000));

// Keep-warm: cada 4 min pingea el sistema para que no se "duerma" en Railway.
// Sin esto, la primera llamada tras un rato de inactividad fallaba con 502/timeout
// (cold start) — era lo que rompía la confirmación de pagos. Silencioso.
cron.schedule('*/4 * * * *', () => {
  fetch(`${GYM_API}/`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
});

cron.schedule('0 13 4 * *',  () => runJob(5, 'recordatorio'));
cron.schedule('0 13 14 * *', () => runJob(15, 'recordatorio'));
cron.schedule('0 13 24 * *', () => runJob(25, 'recordatorio'));
cron.schedule('0 13 9 * *',  () => runJob(5, 'mora'));
cron.schedule('0 13 19 * *', () => runJob(15, 'mora'));
cron.schedule('0 13 29 * *', () => runJob(25, 'mora'));
cron.schedule('0 13 15 * *', () => runJob(5, 'suspension'));
cron.schedule('0 13 25 * *', () => runJob(15, 'suspension'));
cron.schedule('0 13 5 * *',  () => runJob(25, 'suspension'));

cron.schedule('*/15 * * * *', async () => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM suspensiones_pendientes
      WHERE notificado_cosaco = false AND timestamp < NOW() - INTERVAL '1 hour'
      ORDER BY timestamp ASC
    `);
    for (const s of rows) {
      await enviarWhatsApp(process.env.COSACO_WHATSAPP,
        `⚠️ ${s.cliente_nombre} lleva 10 días sin pagar. ¿Suspendo su servicio?\nRespondé SÍ o NO`);
      await pool.query(
        `UPDATE suspensiones_pendientes SET notificado_cosaco = true, esperando_confirmacion = true WHERE id = $1`,
        [s.id]
      );
    }
  } catch (err) { console.error('Error cron suspensiones:', err.message); }
});

cron.schedule('0 12 * * *', async () => {
  try {
    const r = await fetch(`${GYM_API}/cumpleanos`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
    const data = await r.json();
    const hoy = new Date();
    const cumpleaneros = (Array.isArray(data) ? data : []).filter(c => {
      if (!c.fecha_nacimiento) return false;
      const f = new Date(c.fecha_nacimiento + 'T12:00:00');
      return f.getDate() === hoy.getDate() && f.getMonth() === hoy.getMonth();
    });
    for (const c of cumpleaneros) {
      await enviarTemplate(c.telefono, process.env.TEMPLATE_CUMPLEANOS, { "1": c.nombre.split(' ')[0] }, '[Cumpleaños]');
      await enviarWhatsApp(process.env.COSACO_WHATSAPP, `🎂 Hoy es el cumpleaños de ${c.nombre}! Saludalo desde tu celular 🏑`);
    }
    console.log(`Cumpleaños enviados: ${cumpleaneros.length}`);
  } catch (err) { console.error('Error cron cumpleaños:', err.message); }
});

// ────────────────────────────────────────────────────────────────────────────
//  INFORME DIARIO — ahora con datos reales
//  Antes mandaba guiones fijos porque no se registraba la actividad.
//  Cubre las últimas 24 h (de informe a informe), hora de Argentina.
// ────────────────────────────────────────────────────────────────────────────
async function generarInforme() {
  const hoy = new Date().toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const DESDE = "NOW() - INTERVAL '24 hours'";

  const [msgs, act, pend] = await Promise.all([
    pool.query(`SELECT
        COUNT(*) FILTER (WHERE rol = 'cliente')                    AS recibidos,
        COUNT(*) FILTER (WHERE rol IN ('agente','agente-cosaco'))  AS enviados,
        COUNT(DISTINCT telefono)                                   AS personas
      FROM conversaciones WHERE timestamp >= ${DESDE}`),
    pool.query(`SELECT tipo, COUNT(*)::int AS n, COALESCE(SUM(monto),0) AS total
      FROM actividad WHERE timestamp >= ${DESDE} GROUP BY tipo`),
    pool.query(`SELECT COUNT(*)::int AS n FROM pagos_pendientes WHERE esperando_confirmacion = true`),
  ]);

  const m = msgs.rows[0] || {};
  const porTipo = {};
  for (const r of act.rows) porTipo[r.tipo] = { n: r.n, total: Number(r.total) };
  const g = (t) => porTipo[t] || { n: 0, total: 0 };

  const pagos = g('pago_confirmado');
  const partes = [
    `Informe ${hoy}`,
    `Mensajes: ${m.recibidos || 0} recibidos / ${m.enviados || 0} enviados (${m.personas || 0} personas)`,
    `Pagos: ${pagos.n} por $${Number(pagos.total).toLocaleString('es-AR')}`,
    `Clientes nuevos: ${g('cliente_nuevo').n}`,
  ];
  if (g('cliente_volvio').n) partes.push(`Reingresos: ${g('cliente_volvio').n}`);
  if (g('promesa_pago').n) partes.push(`Prometieron pagar: ${g('promesa_pago').n}`);
  partes.push(`Turnos asignados: ${g('turnos_asignados').total}`);
  const nPend = pend.rows[0]?.n || 0;
  if (nPend) partes.push(`PENDIENTE: ${nPend} pago(s) esperando tu SI/NO`);
  partes.push('Buen dia Cosaco!');

  return partes.join(' | ');
}

cron.schedule('5 12 * * *', async () => {
  try {
    const informe = await generarInforme();
    console.log('[INFORME]', informe);
    await enviarTemplate(
      process.env.COSACO_WHATSAPP,
      process.env.TEMPLATE_NOTIFICACION_COSACO,
      { "1": informe }, informe
    );
    console.log('Informe diario enviado');
  } catch (err) { console.error('Error cron informe:', err.message); }
});

// ────────────────────────────────────────────────────────────────────────────
//  LISTA DE SEGUIMIENTO (conversión de nuevos / reactivados)
//  Cada mañana (9:00 AR = 12:00 UTC): el sistema revisa SOLO a los alumnos que
//  están en la lista de seguimiento y sumaron una asistencia nueva sin pagar
//  todavía. A cada uno se le manda el mensaje de seguimiento. Opción B: se envía
//  CADA VEZ que suma una asistencia nueva (persistente), no una sola vez. El
//  alumno sale de la lista SOLO cuando se registra su pago (auto en el sistema).
//  Requiere una plantilla de WhatsApp aprobada: TEMPLATE_CLASE_PRUEBA.
// ────────────────────────────────────────────────────────────────────────────
async function enviarSeguimiento() {
  const SID = process.env.TEMPLATE_CLASE_PRUEBA || process.env.TEMPLATE_INCENTIVO_PRUEBA;
  if (!SID) { console.warn('[SEGUIMIENTO] Falta TEMPLATE_CLASE_PRUEBA — no se envía nada.'); return; }
  if (!GYM_TOKEN) await loginConReintentos(3, 5000);
  const hdrs = { Authorization: `Bearer ${GYM_TOKEN}` };
  let alumnos = [];
  try {
    const r = await fetch(`${GYM_API}/seguimiento/a-notificar`, { headers: hdrs });
    if (!r.ok) { console.error('[SEGUIMIENTO] API', r.status); return; }
    alumnos = (await r.json()).alumnos || [];
  } catch (e) { console.error('[SEGUIMIENTO] error consultando:', e.message); return; }

  console.log(`[SEGUIMIENTO] ${alumnos.length} alumno(s) a notificar`);
  for (const a of alumnos) {
    if (!a.telefono) continue;
    try {
      const nombre1 = (a.nombre || '').split(' ')[0];
      await enviarTemplate(a.telefono, SID, { "1": nombre1 }, '[Seguimiento]');
      // Marcar el envío de HOY SOLO si el mensaje salió (Opción B: al próximo
      // presente nuevo se vuelve a enviar; sale de la lista sólo al pagar).
      await fetch(`${GYM_API}/clientes/${a.id}/seguimiento-enviado`, { method: 'POST', headers: hdrs });
      logActividad('seguimiento', a.nombre, null, a.telefono);
      console.log(`[SEGUIMIENTO] enviado a ${a.nombre}`);
    } catch (e) {
      console.error(`[SEGUIMIENTO] falló con ${a.nombre}:`, e.message);
    }
  }
}
// Alias por compatibilidad con llamadas existentes (comando manual de Cosaco).
const enviarIncentivosPrueba = enviarSeguimiento;

cron.schedule('0 12 * * *', () => enviarSeguimiento().catch(e => console.error('cron seguimiento:', e.message)));

app.post('/webhook', (req, res) => {
  const mensaje = req.body.Body;
  const remitente = req.body.From;
  const profileName = req.body.ProfileName || remitente;
  const numMedia = parseInt(req.body.NumMedia) || 0;
  // Si vino una imagen (comprobante), guardamos su URL para verla en el panel
  const media = (numMedia > 0 && req.body.MediaUrl0)
    ? { url: req.body.MediaUrl0, type: req.body.MediaContentType0 || 'image/jpeg' }
    : null;
  guardarMensaje(remitente, profileName, mensaje || (media ? '📎 Imagen' : '[imagen]'), 'cliente', null, media);
  res.type('text/xml').send(new twilio.twiml.MessagingResponse().toString());
  if (numMedia > 0 && (!mensaje || !mensaje.trim())) {
    comprobantePendiente.set(remitente, true);
    const resp = '¡Recibí el comprobante de transferencia! 🏑 Para registrar el pago necesito:\n- Nombre y apellido de la jugadora (tal como está registrada — si sos el papá o la mamá, es el nombre de tu hija, no el tuyo)\n- El monto que transferiste\n\nEscribime los dos datos y listo 😊';
    twilioClient.messages.create({ from: TWILIO_FROM, to: remitente, body: resp })
      .then(() => guardarMensaje(remitente, null, resp, 'agente'))
      .catch(err => console.error('Error respondiendo comprobante:', err.message));
    return;
  }
  procesarMensaje(mensaje, remitente, profileName);
});

app.get('/panel', (req, res) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel Hockey Vivo</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;height:100dvh;overflow:hidden}
.app{display:flex;height:100dvh;max-width:900px;margin:0 auto;background:#fff}
.sb{width:340px;min-width:340px;border-right:1px solid #e0e0e0;display:flex;flex-direction:column}
.sbh{background:#075e54;color:#fff;padding:16px;font-size:18px;font-weight:600;flex-shrink:0}
.sbs{padding:8px 10px;border-bottom:1px solid #e0e0e0;flex-shrink:0}
.sbs input{width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:20px;font-size:13px;outline:none}
.sbs input:focus{border-color:#075e54}
.hilos{overflow-y:auto;flex:1}
.hilo{padding:14px 16px;border-bottom:1px solid #f0f0f0;cursor:pointer}
.hilo:hover,.hilo.activo{background:#f5f5f5}
.hn{font-weight:600;font-size:15px;color:#111}
.hp{font-size:13px;color:#667;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ht{font-size:11px;color:#999;margin-top:2px}
.chat{flex:1;display:flex;flex-direction:column;min-width:0}
.ch{background:#075e54;color:#fff;padding:14px 16px;font-size:16px;font-weight:600;display:flex;align-items:center;gap:12px;flex-shrink:0}
.bv{display:none;background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 4px}
.chn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msgs{flex:1;overflow-y:auto;padding:16px;background:#e5ddd5}
.mw{display:flex;flex-direction:column}
.msg{max-width:75%;margin-bottom:10px;padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}
.msg.cliente{background:#fff;align-self:flex-start;border-radius:0 8px 8px 8px}
.msg.agente,.msg.agente-cosaco{background:#dcf8c6;align-self:flex-end;margin-left:auto;border-radius:8px 0 8px 8px}
.msg-time{font-size:10px;color:#999;margin-top:4px;text-align:right}
.fecha-sep{text-align:center;margin:12px 0 8px}
.fecha-sep span{display:inline-block;background:#d9e7f5;color:#4a5568;font-size:11px;font-weight:600;padding:3px 12px;border-radius:12px;text-transform:capitalize;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.msg-img{max-width:220px;max-height:280px;border-radius:6px;display:block;cursor:pointer;object-fit:cover}
.ph-msg{opacity:.45}
.ph-txt{font-size:11px;color:#888;font-style:italic}
.ph{display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:15px}
.ia{padding:10px 16px;background:#f0f2f5;display:flex;gap:8px;align-items:center;flex-shrink:0}
.ia input{flex:1;padding:10px 14px;border-radius:24px;border:none;font-size:16px;outline:none}
.ia button{background:#075e54;color:#fff;border:none;border-radius:50%;width:42px;height:42px;font-size:18px;cursor:pointer}
@media(max-width:768px){
  .app{max-width:100vw}
  .sb{position:fixed;inset:0;width:100vw;min-width:0;z-index:10;transition:transform .25s}
  .sb.oculto{transform:translateX(-100%);pointer-events:none}
  .chat{position:fixed;inset:0;width:100vw;z-index:10;transform:translateX(100%);transition:transform .25s}
  .chat.visible{transform:translateX(0)}
  .bv{display:block}
  .ia{position:sticky;bottom:0;padding-bottom:max(10px,env(safe-area-inset-bottom))}
}
/* Aviso de error visible (nunca falla en silencio) */
#banner{position:fixed;top:0;left:0;right:0;z-index:100;background:#c0392b;color:#fff;padding:10px 44px 10px 16px;font-size:13px;line-height:1.35;box-shadow:0 2px 8px rgba(0,0,0,.2);transform:translateY(-120%);transition:transform .25s}
#banner.show{transform:translateY(0)}
#banner.ok{background:#1e8449}
#banner button{position:absolute;right:8px;top:6px;background:rgba(255,255,255,.2);border:none;color:#fff;width:28px;height:28px;border-radius:6px;font-size:14px;cursor:pointer}
#banner .rt{margin-left:10px;text-decoration:underline;cursor:pointer;font-weight:600}
/* Pestañas Todos / Pendientes */
.tabs{display:flex;border-bottom:1px solid #e0e0e0;flex-shrink:0}
.tab{flex:1;padding:10px;text-align:center;font-size:13px;font-weight:600;color:#667;cursor:pointer;border-bottom:2px solid transparent}
.tab.activo{color:#075e54;border-bottom-color:#075e54}
.tab .badge-n{display:inline-block;background:#c0392b;color:#fff;border-radius:10px;padding:0 6px;font-size:11px;margin-left:4px;min-width:18px}
.hilo.pend{background:#fffdf5}
.hilo .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#c0392b;margin-right:6px;vertical-align:middle}
.hilo.paus-mark .hn::after{content:' 🔇';font-size:12px}
/* Botón tomar el control */
.ctrl-btn{background:rgba(255,255,255,.18);border:none;color:#fff;font-size:12px;font-weight:600;padding:6px 10px;border-radius:16px;cursor:pointer;white-space:nowrap}
.ctrl-btn.on{background:#f39c12}
</style>
</head>
<body>
<div id="banner"><span id="banner-txt"></span><button onclick="ocultarBanner()">✕</button></div>
<div class="app">
  <div class="sb" id="sb">
    <div class="sbh">Conversaciones</div>
    <div class="tabs">
      <div class="tab activo" id="tab-todos" onclick="cambiarTab('todos')">Todos</div>
      <div class="tab" id="tab-pend" onclick="cambiarTab('pend')">Pendientes<span class="badge-n" id="badge-pend" style="display:none">0</span></div>
    </div>
    <div class="sbs"><input type="text" id="buscador" placeholder="Buscar por nombre o mensaje..."></div>
    <div class="hilos" id="hilos"><div class="ph">Cargando...</div></div>
  </div>
  <div class="chat" id="chat">
    <div class="ch">
      <button class="bv" id="btn-volver">←</button>
      <span class="chn" id="chn">Seleccioná una conversación</span>
      <button class="ctrl-btn" id="btn-control" style="display:none" onclick="toggleControl()">🤖 Bot activo</button>
    </div>
    <div class="msgs" id="msgs"><div class="ph">← Seleccioná una conversación</div></div>
    <div class="ia" id="ia" style="display:none">
      <input type="text" id="mi" placeholder="Escribí un mensaje...">
      <button id="btn-enviar">➤</button>
    </div>
  </div>
</div>
<script>
let telefonoActual = null;
let todosLosHilos = [];
let tabActual = 'todos';
let pausaActual = false;
let _ultimoConteoHilo = 0;
const mob = () => window.innerWidth <= 768;

function cambiarTab(t) {
  tabActual = t;
  document.getElementById('tab-todos').classList.toggle('activo', t === 'todos');
  document.getElementById('tab-pend').classList.toggle('activo', t === 'pend');
  aplicarFiltroYRender();
}

function aplicarFiltroYRender() {
  const q = (document.getElementById('buscador').value || '').trim().toLowerCase();
  let lista = todosLosHilos;
  if (tabActual === 'pend') lista = lista.filter(h => h.pendiente);
  if (q) lista = lista.filter(h =>
    (h.nombre || '').toLowerCase().includes(q) || (h.ultimo_texto || '').toLowerCase().includes(q));
  renderHilos(lista);
}

function actualizarBadgePend() {
  const n = todosLosHilos.filter(h => h.pendiente).length;
  const b = document.getElementById('badge-pend');
  if (b) { b.textContent = n; b.style.display = n > 0 ? 'inline-block' : 'none'; }
}

// ── CAPA ANTI-FALLO-SILENCIOSO ──────────────────────────────────────────────
// Todo error queda VISIBLE: banner rojo arriba, con opción de reintentar.
let _bannerTimer = null;
function ocultarBanner(){ document.getElementById('banner').classList.remove('show'); }
function mostrarBanner(texto, opts){
  opts = opts || {};
  const b = document.getElementById('banner');
  const t = document.getElementById('banner-txt');
  t.textContent = texto;
  b.className = opts.ok ? 'show ok' : 'show';
  if (opts.reintentar){
    const link = document.createElement('span');
    link.className = 'rt';
    link.textContent = 'Reintentar';
    link.onclick = () => { ocultarBanner(); opts.reintentar(); };
    t.appendChild(link);
  }
  clearTimeout(_bannerTimer);
  if (opts.ok) _bannerTimer = setTimeout(ocultarBanner, 2500);
}

// Wrapper central de red: si algo falla (sin conexión, error del server,
// respuesta no-OK), lanza un error claro en vez de devolver basura o colgarse.
async function pedir(url, opciones){
  let r;
  try {
    r = await fetch(url, opciones);
  } catch(e){
    throw new Error('Sin conexión con el servidor');
  }
  if (!r.ok){
    let detalle = '';
    try { const j = await r.json(); detalle = j.error || ''; } catch(_){}
    throw new Error(detalle || ('Error del servidor (' + r.status + ')'));
  }
  return r.json();
}

// Red de seguridad final: cualquier error que se escape igual se muestra.
window.addEventListener('error', ev => {
  mostrarBanner('Ocurrió un error en el panel. Si sigue, recargá la página.');
});
window.addEventListener('unhandledrejection', ev => {
  const msg = (ev.reason && ev.reason.message) ? ev.reason.message : 'Ocurrió un error inesperado';
  mostrarBanner(msg);
});

function tiempoRel(ts) {
  const min = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return 'hace ' + min + 'm';
  const hs = Math.floor(min / 60);
  return hs < 24 ? 'hace ' + hs + 'h' : 'hace ' + Math.floor(hs / 24) + 'd';
}

function renderHilos(hilos) {
  const cont = document.getElementById('hilos');
  cont.innerHTML = '';
  if (!hilos || hilos.length === 0) {
    cont.innerHTML = '<div class="ph">Sin resultados</div>';
    return;
  }
  for (const h of hilos) {
    const div = document.createElement('div');
    div.className = 'hilo' + (h.pendiente ? ' pend' : '') + (h.pausado ? ' paus-mark' : '');
    const hn = document.createElement('div');
    hn.className = 'hn';
    // Punto rojo si está esperando respuesta
    if (h.pendiente) { const dot = document.createElement('span'); dot.className = 'dot'; hn.appendChild(dot); }
    hn.appendChild(document.createTextNode(h.nombre));
    const hp = document.createElement('div');
    hp.className = 'hp';
    hp.textContent = (h.ultimo_texto || '').slice(0, 60);
    const ht = document.createElement('div');
    ht.className = 'ht';
    ht.textContent = h.ultimo_timestamp ? tiempoRel(h.ultimo_timestamp) : '';
    div.appendChild(hn);
    div.appendChild(hp);
    div.appendChild(ht);
    if (h.telefono === telefonoActual) div.classList.add('activo');
    div.addEventListener('click', () => abrirHilo(h.telefono, h.nombre, div));
    cont.appendChild(div);
  }
}

async function cargarHilos() {
  const cont = document.getElementById('hilos');
  try {
    const d = await pedir('/panel/data');
    todosLosHilos = d.hilos || [];
    actualizarBadgePend();
    if (todosLosHilos.length === 0) {
      cont.innerHTML = '<div class="ph">Sin conversaciones</div>';
      return;
    }
    aplicarFiltroYRender();
  } catch (err) {
    cont.innerHTML = '<div class="ph">No se pudieron cargar las conversaciones</div>';
    mostrarBanner('No se pudieron cargar las conversaciones: ' + err.message, { reintentar: cargarHilos });
  }
}

document.getElementById('buscador').addEventListener('input', function() {
  // Filtro local inmediato, respetando la pestaña activa (Todos / Pendientes)
  aplicarFiltroYRender();
});

async function abrirHilo(telefono, nombre, divEl) {
  telefonoActual = telefono;
  document.querySelectorAll('.hilo.activo').forEach(el => el.classList.remove('activo'));
  if (divEl) divEl.classList.add('activo');
  // Si viene null (refresco tras enviar), conservar el nombre que ya se muestra
  if (nombre) document.getElementById('chn').textContent = nombre;
  const msgs = document.getElementById('msgs');
  msgs.innerHTML = '<div class="ph">Cargando...</div>';
  if (mob()) {
    document.getElementById('sb').classList.add('oculto');
    document.getElementById('chat').classList.add('visible');
  }

  let d;
  try {
    d = await pedir('/panel/hilo?telefono=' + encodeURIComponent(telefono));
  } catch (err) {
    // Antes esto quedaba en "Cargando..." para siempre si fallaba. Ahora avisa
    // y ofrece reintentar en vez de dejar la pantalla colgada en silencio.
    msgs.innerHTML = '<div class="ph">No se pudo cargar la conversación</div>';
    mostrarBanner('No se pudo abrir la conversación: ' + err.message, { reintentar: () => abrirHilo(telefono, nombre, divEl) });
    return;
  }
  // Estado del botón "tomar el control"
  pausaActual = !!d.pausado;
  pintarBotonControl();

  msgs.innerHTML = '';
  msgs.appendChild(construirWrap(d.mensajes || []));
  msgs.scrollTop = msgs.scrollHeight;
  _ultimoConteoHilo = (d.mensajes || []).length;
  document.getElementById('ia').style.display = 'flex';
}

// Arma el contenedor de mensajes (reutilizado por abrirHilo y el auto-refresco)
// Etiqueta de fecha estilo WhatsApp: Hoy / Ayer / dd de mes
function _etiquetaFecha(ts) {
  const d = new Date(ts), hoy = new Date();
  const soloDia = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const difDias = Math.round((soloDia(hoy) - soloDia(d)) / 86400000);
  if (difDias === 0) return 'Hoy';
  if (difDias === 1) return 'Ayer';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: (d.getFullYear() !== hoy.getFullYear() ? 'numeric' : undefined) });
}

function construirWrap(mensajes) {
  const wrap = document.createElement('div');
  wrap.className = 'mw';
  let _diaActual = null;
  for (const m of mensajes) {
    const tx = m.texto || '';
    const tieneMedia = m.tiene_media;
    if (!tieneMedia && (!tx || tx === '[sin texto]' || (tx.startsWith('[') && tx.endsWith(']')))) continue;

    // Separador de fecha cuando cambia el día
    const diaMsg = new Date(m.timestamp).toDateString();
    if (diaMsg !== _diaActual) {
      _diaActual = diaMsg;
      const sep = document.createElement('div');
      sep.className = 'fecha-sep';
      sep.innerHTML = '<span>' + _etiquetaFecha(m.timestamp) + '</span>';
      wrap.appendChild(sep);
    }

    const div = document.createElement('div');
    div.className = 'msg ' + m.rol;

    if (tieneMedia) {
      const img = document.createElement('img');
      img.className = 'msg-img';
      img.src = '/panel/media/' + m.id;
      img.loading = 'lazy';
      img.onclick = () => window.open('/panel/media/' + m.id, '_blank');
      img.onerror = () => { img.replaceWith(document.createTextNode('📎 (no se pudo cargar la imagen)')); };
      div.appendChild(img);
    }
    if (tx && tx !== '[sin texto]' && !(tx.startsWith('[') && tx.endsWith(']')) && tx !== '📎 Imagen') {
      const content = document.createElement('div');
      content.textContent = tx;
      div.appendChild(content);
    }
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date(m.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    div.appendChild(time);
    wrap.appendChild(div);
  }
  return wrap;
}

// ── TOMAR EL CONTROL (pausar / reactivar el bot en esta conversación) ────────
function pintarBotonControl() {
  const b = document.getElementById('btn-control');
  if (!b) return;
  b.style.display = telefonoActual ? 'inline-block' : 'none';
  if (pausaActual) {
    b.textContent = '🔇 Bot pausado — reactivar';
    b.classList.add('on');
  } else {
    b.textContent = '🤖 Bot activo — tomar control';
    b.classList.remove('on');
  }
}

async function toggleControl() {
  if (!telefonoActual) return;
  const b = document.getElementById('btn-control');
  if (b) b.disabled = true;
  try {
    const ruta = pausaActual ? '/panel/reanudar' : '/panel/pausar';
    await pedir(ruta, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono: telefonoActual, horas: 3 }),
    });
    pausaActual = !pausaActual;
    pintarBotonControl();
    mostrarBanner(pausaActual ? 'Tomaste el control: el bot no responde por 3h en esta charla' : 'Bot reactivado en esta conversación', { ok: true });
    cargarHilos();
  } catch (e) {
    mostrarBanner('No se pudo cambiar el control: ' + e.message);
  } finally {
    if (b) b.disabled = false;
  }
}

function volver() {
  document.getElementById('chat').classList.remove('visible');
  document.getElementById('sb').classList.remove('oculto');
  telefonoActual = null;
  document.getElementById('btn-control').style.display = 'none';
}

async function enviar() {
  const input = document.getElementById('mi');
  const texto = input.value.trim();
  if (!texto || !telefonoActual) return;
  const btn = document.getElementById('btn-enviar');
  input.value = '';
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    await pedir('/panel/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono: telefonoActual, mensaje: texto }),
    });
    abrirHilo(telefonoActual, null, null);  // refrescar el hilo abierto
    cargarHilos();
    mostrarBanner('Mensaje enviado', { ok: true });
  } catch (e) {
    // El texto no se pierde: se devuelve al input para reintentar
    input.value = texto;
    mostrarBanner('No se pudo enviar: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '➤'; }
  }
}

document.getElementById('btn-volver').addEventListener('click', volver);
document.getElementById('btn-enviar').addEventListener('click', enviar);
document.getElementById('mi').addEventListener('keydown', e => { if (e.key === 'Enter') enviar(); });

// ── AUTO-ACTUALIZACIÓN ──────────────────────────────────────────────────────
// Refresca la lista y la conversación abierta cada 8s, sin recargar la página.
// Respeta lo que estás haciendo: no molesta si estás leyendo mensajes viejos
// (solo baja al fondo si ya estabas abajo) y se pausa si la pestaña está oculta.
async function refrescarHiloAbierto() {
  if (!telefonoActual || document.hidden) return;
  let d;
  try { d = await pedir('/panel/hilo?telefono=' + encodeURIComponent(telefonoActual)); }
  catch (e) { return; }
  pausaActual = !!d.pausado;
  pintarBotonControl();
  const n = (d.mensajes || []).length;
  if (n === _ultimoConteoHilo) return;   // no hay mensajes nuevos
  const msgs = document.getElementById('msgs');
  const cercaDelFondo = (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight) < 140;
  msgs.innerHTML = '';
  msgs.appendChild(construirWrap(d.mensajes || []));
  if (cercaDelFondo) msgs.scrollTop = msgs.scrollHeight;
  _ultimoConteoHilo = n;
}

setInterval(() => {
  if (document.hidden) return;
  cargarHilos();            // actualiza lista + badge de pendientes
  refrescarHiloAbierto();   // actualiza la conversación abierta si hay algo nuevo
}, 8000);

cargarHilos();
</script>
</body>
</html>`);
});

app.get('/panel/data', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.telefono,
        COALESCE(
          (SELECT nombre FROM conversaciones n WHERE n.telefono = c.telefono AND n.nombre IS NOT NULL ORDER BY n.timestamp DESC LIMIT 1),
          c.telefono
        ) AS nombre,
        c.texto AS ultimo_texto,
        c.rol  AS ultimo_rol,
        c.timestamp AS ultimo_timestamp,
        EXISTS(SELECT 1 FROM conversaciones_pausadas p WHERE p.telefono = c.telefono AND p.pausado_hasta > NOW()) AS pausado
      FROM conversaciones c
      WHERE c.id = (SELECT id FROM conversaciones sub WHERE sub.telefono = c.telefono ORDER BY sub.timestamp DESC LIMIT 1)
      ORDER BY c.timestamp DESC
    `);
    // "pendiente" = el último mensaje es del cliente (espera respuesta humana)
    for (const h of rows) h.pendiente = (h.ultimo_rol === 'cliente');
    res.json({ hilos: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pausar / reanudar el bot en una conversación ("tomar el control")
app.post('/panel/pausar', async (req, res) => {
  const { telefono, horas } = req.body;
  if (!telefono) return res.status(400).json({ error: 'Falta telefono' });
  try { await pausarBot(telefono, horas); res.json({ ok: true, pausado: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/panel/reanudar', async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: 'Falta telefono' });
  try { await reanudarBot(telefono); res.json({ ok: true, pausado: false }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/panel/buscar', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ hilos: [] });
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (c.telefono)
        c.telefono,
        COALESCE(
          (SELECT nombre FROM conversaciones n WHERE n.telefono = c.telefono AND n.nombre IS NOT NULL ORDER BY n.timestamp DESC LIMIT 1),
          c.telefono
        ) AS nombre,
        c.texto AS ultimo_texto,
        c.timestamp AS ultimo_timestamp
      FROM conversaciones c
      WHERE c.nombre ILIKE $1 OR c.texto ILIKE $1
      ORDER BY c.telefono, c.timestamp DESC
      LIMIT 20
    `, [`%${q}%`]);
    res.json({ hilos: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/panel/hilo', async (req, res) => {
  if (!req.query.telefono) return res.status(400).json({ error: 'Falta telefono' });
  try {
    const { rows } = await pool.query(
      `SELECT id, rol, texto, timestamp, (media_url IS NOT NULL) AS tiene_media
       FROM conversaciones WHERE telefono = $1 ORDER BY timestamp ASC`,
      [req.query.telefono]
    );
    const pausado = await botPausado(req.query.telefono);
    res.json({ mensajes: rows, pausado });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Proxy seguro de imágenes de Twilio: el navegador no puede acceder a la URL
// de Twilio (requiere auth); este endpoint la trae con las credenciales del
// servidor y la reenvía. Solo sirve URLs del dominio de Twilio (anti-SSRF).
app.get('/panel/media/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT media_url, media_type FROM conversaciones WHERE id = $1', [req.params.id]);
    if (!rows.length || !rows[0].media_url) return res.status(404).send('Sin imagen');
    const url = rows[0].media_url;
    let host;
    try { host = new URL(url).host; } catch { return res.status(400).send('URL inválida'); }
    if (!/(^|\.)twilio\.com$/.test(host)) return res.status(403).send('Origen no permitido');
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: 'Basic ' + auth } });
    if (!r.ok) return res.status(502).send('No se pudo traer la imagen');
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', rows[0].media_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.post('/panel/enviar', async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
  try {
    let tel = telefono.replace(/\D/g, '');
    if (tel.startsWith('549')) tel = tel.slice(3);       // 549 + área
    else if (tel.startsWith('54')) tel = tel.slice(2);   // 54 + área
    const to = `whatsapp:+549${tel}`;                    // Argentina: siempre 549
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body: mensaje });
    // Auto-pausa: al responder a mano, el bot queda mudo 3h en esta charla para
    // no meter un mensaje automático encima de la respuesta de Cosaco.
    await pausarBot(telefono, 3).catch(() => {});
    guardarMensaje(telefono, null, mensaje, 'agente-cosaco'); // guardar con el MISMO
    // teléfono del hilo (antes usaba 'to' normalizado y el mensaje aparecía en
    // un hilo separado, como si fuera otra conversación)
    logActividad('mensaje_manual', `Cosaco → ${telefono}`, null, telefono);
    res.json({ ok: true });
  } catch (err) {
    console.error('[PANEL/ENVIAR]', err.code, err.message);
    // 63016 = fuera de la ventana de 24 h de WhatsApp (regla de Meta)
    const fueraDeVentana = err.code === 63016 || /24 hour|freeform/i.test(err.message || '');
    res.status(500).json({
      error: fueraDeVentana
        ? 'Pasaron más de 24 h desde el último mensaje del cliente. WhatsApp no permite escribir libre; el cliente tiene que escribirte primero.'
        : (err.message || 'Error enviando'),
    });
  }
});

app.get('/admin/importar-telefonos', async (req, res) => {
  if (req.query.secret !== 'hockeyvivo') return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const r = await fetch(`${GYM_API}/clientes`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
    const clientes = await r.json();
    let importados = 0;
    for (const c of (Array.isArray(clientes) ? clientes : [])) {
      if (!c.telefono || !c.id) continue;
      let tel = c.telefono.replace(/\D/g, '');
      if (tel.startsWith('549')) tel = tel.slice(2);
      else if (tel.startsWith('54')) tel = tel.slice(2);
      await pool.query(
        `INSERT INTO telefono_cliente (telefono, cliente_id, cliente_nombre) VALUES ($1, $2, $3)
         ON CONFLICT (telefono) DO UPDATE SET cliente_id = $2, cliente_nombre = $3, updated_at = NOW()`,
        [`whatsapp:+54${tel}`, c.id, c.nombre]
      );
      importados++;
    }
    res.json({ ok: true, importados });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/test-jobs', async (req, res) => {
  if (req.query.secret !== 'hockeyvivo') return res.status(403).json({ error: 'Acceso denegado' });
  const job = req.query.job;
  if (!job) return res.status(400).json({ error: 'job requerido: recordatorio, mora, suspension, cumpleanos, informe' });
  try {
    if (['recordatorio', 'mora', 'suspension'].includes(job)) {
      const dia = new Date().getDate();
      const grupo = dia <= 10 ? 5 : dia <= 20 ? 15 : 25;
      await runJob(grupo, job);
      return res.json({ ok: true, job, grupo });
    }
    // PRUEBA: manda la plantilla SOLO a Cosaco, sin tocar a ningún cliente.
    // Ej: /test-jobs?secret=hockeyvivo&job=test-recordatorio  (o &nombre=Sofía)
    if (['test-recordatorio', 'test-mora', 'test-suspension'].includes(job)) {
      const mapaSid = {
        'test-recordatorio': process.env.TEMPLATE_RECORDATORIO,
        'test-mora': process.env.TEMPLATE_MORA,
        'test-suspension': process.env.TEMPLATE_SUSPENSION,
      };
      const sid = mapaSid[job];
      if (!sid) return res.status(400).json({ error: `Falta la variable de entorno para ${job}` });
      const nombre = req.query.nombre || 'Cosaco';
      await enviarTemplate(process.env.COSACO_WHATSAPP, sid, { "1": nombre }, `[Prueba ${job}]`);
      return res.json({ ok: true, job, enviado_a: 'Cosaco (solo prueba)', sid });
    }
    if (job === 'cumpleanos') {
      const r = await fetch(`${GYM_API}/cumpleanos`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
      const data = await r.json();
      const hoy = new Date();
      const lista = (Array.isArray(data) ? data : []).filter(c => {
        if (!c.fecha_nacimiento) return false;
        const f = new Date(c.fecha_nacimiento + 'T12:00:00');
        return f.getDate() === hoy.getDate() && f.getMonth() === hoy.getMonth();
      });
      for (const c of lista) {
        await enviarTemplate(c.telefono, process.env.TEMPLATE_CUMPLEANOS, { "1": c.nombre.split(' ')[0] }, '[Cumpleaños]');
      }
      return res.json({ ok: true, job, enviados: lista.map(c => c.nombre) });
    }
    if (job === 'informe') {
      const informe = await generarInforme();
      // ?preview=1 → solo devuelve el texto sin mandar WhatsApp (para probar)
      if (req.query.preview === '1') return res.json({ ok: true, preview: informe });
      await enviarTemplate(
        process.env.COSACO_WHATSAPP,
        process.env.TEMPLATE_NOTIFICACION_COSACO,
        { "1": informe }, informe
      );
      return res.json({ ok: true, job });
    }
    if (job === 'incentivo' || job === 'seguimiento') {
      // ?preview=1 → diagnóstico: quién califica + si el template está configurado,
      // sin enviar ni marcar nada. Sirve para ver por qué "dejó de mandar".
      if (req.query.preview === '1') {
        if (!GYM_TOKEN) await loginConReintentos(3, 5000);
        let aNotificar = null, enLista = null, errorApi = null;
        try {
          const r1 = await fetch(`${GYM_API}/seguimiento/a-notificar`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
          aNotificar = r1.ok ? await r1.json() : `HTTP ${r1.status}`;
          const r2 = await fetch(`${GYM_API}/seguimiento`, { headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
          enLista = r2.ok ? await r2.json() : `HTTP ${r2.status}`;
        } catch (e) { errorApi = e.message; }
        return res.json({
          ok: true,
          diagnostico: {
            template_configurado: !!(process.env.TEMPLATE_CLASE_PRUEBA || process.env.TEMPLATE_INCENTIVO_PRUEBA),
            template_sid: process.env.TEMPLATE_CLASE_PRUEBA || process.env.TEMPLATE_INCENTIVO_PRUEBA || null,
            en_la_lista_de_seguimiento: Array.isArray(enLista) ? enLista.length : enLista,
            a_notificar_hoy: aNotificar,
            error_api: errorApi,
            hora_servidor_utc: new Date().toISOString(),
          },
        });
      }
      await enviarSeguimiento();
      return res.json({ ok: true, job });
    }
    res.status(400).json({ error: `Job desconocido: ${job}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
  initDB().catch(err => console.error('Error initDB:', err.message));
  loginConReintentos().catch(() => {});
});
