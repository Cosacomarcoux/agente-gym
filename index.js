require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const cron = require('node-cron');

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
const tercerTurnoPendiente = new Map(); // telefonoCosaco → { clienteId, clienteNombre, turnoId, clienteFrom }

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

function guardarMensaje(from, nombre, texto, rol, contentJson = null) {
  const textoFinal = (!texto || !texto.trim() || texto.trim().startsWith('[')) ? '[sin texto]' : texto;
  pool.query(
    'INSERT INTO conversaciones (telefono, nombre, rol, texto, content_json) VALUES ($1, $2, $3, $4, $5)',
    [from, nombre && nombre !== from ? nombre : null, rol, textoFinal, contentJson ? JSON.stringify(contentJson) : null]
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

PAGOS:
Cuando un cliente mencione que pagó (de cualquier forma), pedí su nombre si no lo sabés y el monto si no lo mencionó. Una vez que tenés nombre y monto, llamá SIEMPRE consultar_pago_a_cosaco. Después respondé: "Gracias! Ya le avisé al equipo, en breve te confirmamos 🏑"
IMPORTANTE sobre pagos: consultar_pago_a_cosaco es SOLO para pagos YA REALIZADOS con monto concreto mayor a 0. Si el cliente dice que va a pagar más adelante ("te pago el viernes", "esta semana paso"), NO llames la herramienta: respondé amable ("Dale, cuando abones avisame por acá 🏑") y listo. Nunca inventes ni asumas un monto: si no lo dijo, preguntalo.
Si identificás al cliente por get_clientes, guardá el mapeo con guardar_telefono_cliente.

REGISTRO DE CLIENTES:
Cuando llega el mensaje de reserva con formato, verificá cupos con get_turnos y llamá guardar_registro_pendiente con los datos. Después preguntá: "¿Confirmás tu inscripción en Hockey Vivo?"

TURNOS:
Al confirmar cambio de turno, mostrar día y horario asignado.
Nunca confirmar cambio sin haber llamado gestionar_turnos_cliente primero.

LÍMITE DE TURNOS:
- Máximo 2 turnos por alumno por defecto.
- Si un alumno quiere un 3er turno, el sistema consulta a Cosaco antes de asignarlo.
- Si tiene 2 turnos y pide otro: "¿Querés agregar un 3er turno (requiere autorización especial) o cambiar uno de tus turnos actuales?"
- Si tiene 3 turnos y pide otro, siempre preguntarle cuál quiere cambiar, nunca agregar.

INFORMACIÓN:
- Dirección: Moreno (N) 55 entre Andes y Rivadavia, Santiago del Estero
- Horarios: Lun/Mié/Vie 18:30-21hs | Mar/Jue 16-21hs
- Planes: 1x $29.000 | 2x $35.000 | 3x $39.000
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
Respondé de forma concisa confirmando lo que hiciste.`;

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
    name: 'consultar_pago_a_cosaco',
    description: 'Guarda el pago en pagos_pendientes y notifica a Cosaco. SIEMPRE usar en vez de registrar directamente. SOLO para pagos YA realizados con monto > 0 — nunca para promesas de pago futuro. Si ya hay una confirmación pendiente del mismo cliente, no duplica.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer' },
        cliente_nombre: { type: 'string' },
        monto: { type: 'number' },
        metodo: { type: 'string', description: 'Efectivo o Transferencia' },
      },
      required: ['cliente_id', 'cliente_nombre', 'monto', 'metodo'],
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
    description: 'Envía template de WhatsApp a un cliente. template_tipo: recordatorio, mora, suspension, pago_confirmado, general.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer' },
        template_tipo: {
          type: 'string',
          enum: ['recordatorio', 'mora', 'suspension', 'pago_confirmado', 'general'],
        },
        mensaje: { type: 'string', description: 'Requerido para general' },
        monto: { type: 'number', description: 'Requerido para pago_confirmado' },
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
      // FIX duplicados: 1) memoria propia del bot (telefono → cliente),
      // 2) búsqueda en el sistema (ahora también matchea por teléfono).
      // Si el cliente existe — aunque esté Vencido o Suspendido — se REUTILIZA.
      let existente = null;
      try {
        const tels = [input.telefono, remitente].filter(Boolean);
        for (const t of tels) {
          const { rows } = await pool.query('SELECT cliente_id FROM telefono_cliente WHERE telefono = $1', [t]);
          if (rows.length > 0) {
            const rCli = await fetch(`${GYM_API}/clientes/${rows[0].cliente_id}`, { headers });
            if (rCli.ok) { existente = await rCli.json(); break; }
          }
        }
      } catch (e) { console.warn('lookup telefono_cliente:', e.message); }
      if (!existente) {
        const rBuscar = await fetch(`${GYM_API}/clientes?buscar=${encodeURIComponent(input.telefono)}`, { headers });
        const existentes = await rBuscar.json();
        existente = Array.isArray(existentes) && existentes.length > 0 ? existentes[0] : null;
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
        return { ok: true, nuevo: true, cliente_id: nuevo.id, nombre: nombreCompleto, turnos_asignados: asignados };
      }
      const { asignados, errores } = await asignarTurnos(existente.id, input.turno_ids);
      if (errores.length) return { ok: false, error: errores.join(', ') };
      if (asignados.length) logActividad('turnos_asignados', `${existente.nombre}: ${asignados.length} turno(s)`, asignados.length, input.telefono);
      const eraInactivo = existente.estado === 'Suspendido' || existente.estado === 'Vencido';
      if (eraInactivo) logActividad('cliente_volvio', `${existente.nombre} (estaba ${existente.estado})`, null, input.telefono);
      if (eraInactivo) {
        // Avisar a Cosaco que volvió un cliente inactivo (no se creó duplicado)
        try {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `🔄 ${existente.nombre} (estado: ${existente.estado}) volvió y pidió turnos. Se reutilizó su ficha existente, no se creó duplicado. Recordá registrarle el pago para reactivarlo.`);
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
          // Pide 3er turno → guardar pendiente y notificar a Cosaco
          const turnoId = input.turno_ids_agregar[0];
          tercerTurnoPendiente.set(process.env.COSACO_WHATSAPP, {
            clienteId: input.cliente_id,
            clienteNombre: input.cliente_nombre || cliData.nombre,
            turnoId,
            clienteFrom: remitente,
          });
          await enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `⚠️ ${cliData.nombre} quiere agregar un 3er turno (actualmente tiene ${turnosActuales}). ¿Autorizás? SÍ o NO`);
          return { ok: false, requiere_autorizacion: true, mensaje: 'Tu solicitud fue enviada al equipo para autorización. En breve te confirmamos 🏑' };
        }
      }
      for (const id of (input.turno_ids_agregar || [])) {
        const r = await fetch(`${GYM_API}/turnos/${id}/asignar/${input.cliente_id}`, { method: 'POST', headers });
        resultados.push({ accion: 'agregar', turno_id: id, ok: r.ok });
      }
      return { ok: resultados.every(r => r.ok), resultados };
    }

    if (nombre === 'suspender_cliente') {
      const r = await fetch(`${GYM_API}/clientes/${input.cliente_id}/suspender`, { method: 'DELETE', headers });
      if (!r.ok) return { error: `Error: ${await r.text()}` };
      return { ok: true, nombre: input.cliente_nombre };
    }

    if (nombre === 'consultar_pago_a_cosaco') {
      const metodo = input.metodo || 'Transferencia';
      // FIX: nunca confirmar pagos de $0. Si el cliente dice que va a pagar
      // más adelante, NO es un pago: no se registra nada.
      const monto = Number(input.monto);
      if (!monto || monto <= 0) {
        return { ok: false, rechazado: true,
          error: 'Monto inválido o $0. Esta herramienta es SOLO para pagos ya realizados con monto concreto. Si el cliente va a pagar más adelante, no registres nada: respondele amablemente que puede abonar cuando venga.' };
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

    if (nombre === 'guardar_registro_pendiente') {
      const telefonoFinal = input.telefono || remitente;
      await pool.query(
        'INSERT INTO registros_pendientes (telefono, datos) VALUES ($1, $2) ON CONFLICT (telefono) DO UPDATE SET datos = $2, timestamp = NOW()',
        [telefonoFinal, JSON.stringify(input)]
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
      const templateMap = {
        recordatorio: process.env.TEMPLATE_RECORDATORIO,
        mora: process.env.TEMPLATE_MORA,
        suspension: process.env.TEMPLATE_SUSPENSION,
        pago_confirmado: process.env.TEMPLATE_PAGO_REGISTRADO,
        general: process.env.TEMPLATE_MENSAJE_HOCKEYVIVO,
      };
      const sid = templateMap[input.template_tipo] || process.env.TEMPLATE_MENSAJE_HOCKEYVIVO;
      let variables;
      if (input.template_tipo === 'pago_confirmado') variables = { "1": nombre1, "2": String(input.monto || '') };
      else if (['mora', 'suspension'].includes(input.template_tipo)) variables = { "1": nombre1 };
      else variables = { "1": nombre1, "2": input.mensaje || '' };
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

async function manejarConfirmacionPago(mensajeUpper, pago) {
  if (mensajeUpper === 'SIGUIENTE') {
    await enviarWhatsApp(process.env.COSACO_WHATSAPP,
      `💰 *Confirmación de pago*\nCliente: ${pago.cliente_nombre}\nMonto: $${pago.monto}\nMétodo: ${pago.metodo}\n¿Confirmás? SÍ o NO`);
    return;
  }
  await pool.query(`DELETE FROM pagos_pendientes WHERE id = $1`, [pago.id]);
  if (mensajeUpper === 'SI' || mensajeUpper === 'S') {
    const hdrs = { Authorization: `Bearer ${GYM_TOKEN}`, 'Content-Type': 'application/json' };
    const rCli = await fetch(`${GYM_API}/clientes/${pago.cliente_id}`, { headers: hdrs });
    const cliente = await rCli.json();
    const hoy = new Date().toISOString().split('T')[0];
    await fetch(`${GYM_API}/pagos`, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({
        cliente_id: pago.cliente_id, monto: pago.monto, metodo: pago.metodo,
        fecha_pago: hoy, fecha_inicio: calcularFechaInicio(cliente),
        fecha_vencimiento: calcularFechaVencimiento(hoy, cliente.fecha_vencimiento),
        plan: cliente.plan,
      }),
    });
    await enviarWhatsApp(pago.cliente_from,
      `✅ Pago registrado: ${pago.cliente_nombre} - $${pago.monto} - ${pago.metodo} 🏑`, pago.cliente_nombre);
    console.log(`Pago confirmado: ${pago.cliente_nombre} $${pago.monto}`);
    logActividad('pago_confirmado', `${pago.cliente_nombre} (${pago.metodo})`, pago.monto, pago.cliente_from);
  } else {
    await enviarWhatsApp(pago.cliente_from,
      `Quedá tranquilo/a, en breve un integrante del equipo se comunica con vos 🏑`, pago.cliente_nombre);
  }
  const { rows: sig } = await pool.query(
    `SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC LIMIT 1`
  );
  if (sig.length > 0) {
    await enviarWhatsApp(process.env.COSACO_WHATSAPP,
      `💰 Siguiente: ${sig[0].cliente_nombre} - $${sig[0].monto} - ${sig[0].metodo}\n¿Confirmás? SÍ o NO`);
  }
}

async function procesarMensaje(mensaje, remitente, profileName = null) {
  try {
    const esCosaco = remitente === process.env.COSACO_WHATSAPP;
    console.log('remitente:', remitente, '| esCosaco:', esCosaco);
    const mensajeUpper = mensaje.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const esSiNo = ['SI', 'S', 'NO', 'N'].includes(mensajeUpper);

    // ── 0. COMPROBANTE PENDIENTE ───────────────────────────────────────────
    if (!esCosaco && comprobantePendiente.has(remitente)) {
      comprobantePendiente.delete(remitente);
      // Intentar extraer nombre y monto del mensaje
      const matchMonto = mensaje.match(/\$?([\d.,]+)/);
      const monto = matchMonto ? parseFloat(matchMonto[1].replace(/\./g, '').replace(',', '.')) : null;
      // Nombre: todo lo que no sea números ni símbolos de monto, tomando las primeras palabras
      const sinMonto = mensaje.replace(/\$?[\d.,]+/g, '').replace(/transferencia|efectivo/gi, '').trim();
      const nombre = sinMonto.length > 2 ? sinMonto : null;

      if (nombre && monto) {
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const clientes = await ejecutarTool('get_clientes', { buscar: nombre }, remitente);
        if (Array.isArray(clientes) && clientes.length > 0) {
          const cliente = clientes[0];
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
          await enviarWhatsApp(remitente, `No encontré a "${nombre}" en el sistema. ¿Podés decirme tu nombre completo tal como está registrado?`);
        }
      } else if (!nombre) {
        comprobantePendiente.set(remitente, true);
        await enviarWhatsApp(remitente, `Necesito tu nombre completo para identificarte. ¿Cómo te llamás?`);
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
          const clientes = await ejecutarTool('get_clientes', { buscar: nombre }, remitente);
          if (Array.isArray(clientes) && clientes.length > 0) {
            const cliente = clientes[0];
            const metodo = beca ? `Transferencia (Beca ${beca}%)` : 'Transferencia';
            await pool.query(`DELETE FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`, [cliente.id]);
            await pool.query(
              `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
              [cliente.id, cliente.nombre, remitente, monto, metodo]
            );
            procesados.push({ nombre: cliente.nombre, monto, beca });
          } else {
            procesados.push({ nombre, monto, beca, noEncontrado: true });
          }
        }

        const { rows: cola } = await pool.query(`SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC`);
        const formatMonto = n => n.toLocaleString('es-AR');
        let resumen = `Procesé ${procesados.filter(p => !p.noEncontrado).length} pagos:\n\n`;
        for (const p of procesados) {
          if (p.noEncontrado) resumen += `⚠️ No encontré: ${p.nombre}\n`;
          else resumen += `💰 ${p.nombre} - $${formatMonto(p.monto)}${p.beca ? ` - Beca ${p.beca}%` : ''}\n`;
        }
        if (cola.length > 0) {
          const primero = cola[0];
          resumen += `\n¿Confirmás el pago de ${primero.cliente_nombre} por $${formatMonto(primero.monto)}? SÍ o NO`;
        }
        await enviarWhatsApp(process.env.COSACO_WHATSAPP, resumen);
        return;
      }

      // "pendientes"
      if (mensajeUpper === 'PENDIENTES' || mensajeUpper === 'PENDIENTE') {
        console.log('Procesando pendientes para Cosaco...');
        const { rows: pagos } = await pool.query(`SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC`);
        const { rows: susps } = await pool.query(`SELECT * FROM suspensiones_pendientes WHERE esperando_confirmacion = true ORDER BY timestamp ASC`);
        console.log('Pagos pendientes:', pagos.length, '| Suspensiones:', susps.length);
        if (pagos.length === 0 && susps.length === 0) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, '✅ No hay pendientes de confirmación');
          return;
        }
        let res = '📋 Pendientes:\n';
        if (pagos.length > 0) {
          res += `\n💰 Pagos (${pagos.length}):\n`;
          for (const p of pagos) res += `- ${p.cliente_nombre} $${p.monto} ${p.metodo}\n`;
        }
        if (susps.length > 0) {
          res += `\n⚠️ Suspensiones (${susps.length}):\n`;
          for (const s of susps) res += `- ${s.cliente_nombre}\n`;
        }
        await enviarWhatsApp(process.env.COSACO_WHATSAPP, res);
        return;
      }

      // Si/No → tercer turno pendiente de autorización
      if (esSiNo && tercerTurnoPendiente.has(remitente)) {
        const datos = tercerTurnoPendiente.get(remitente);
        tercerTurnoPendiente.delete(remitente);
        if (mensajeUpper === 'SI' || mensajeUpper === 'S') {
          if (!GYM_TOKEN) await loginConReintentos(3, 3000);
          const r = await fetch(`${GYM_API}/turnos/${datos.turnoId}/asignar/${datos.clienteId}`,
            { method: 'POST', headers: { Authorization: `Bearer ${GYM_TOKEN}` } });
          if (r.ok) {
            await enviarWhatsApp(process.env.COSACO_WHATSAPP, `✅ 3er turno asignado a ${datos.clienteNombre}`);
            await enviarWhatsApp(datos.clienteFrom, `¡Listo! Tu 3er turno fue autorizado y asignado 🏑`, datos.clienteNombre);
          } else {
            await enviarWhatsApp(process.env.COSACO_WHATSAPP, `⚠️ Error al asignar el turno a ${datos.clienteNombre}`);
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

      // "confirmar/registrar el pago de [Nombre] [$monto] [metodo]"
      const matchConfirmar = mensaje.match(/(?:confirmar?|registrar?)\s+el\s+pago\s+de\s+(.+?)(?:\s+\$?([\d.,]+))?(?:\s+(transferencia|efectivo))?$/i);
      // "[Nombre] pagó/pago [$monto] [metodo]" — solo cuando empieza con nombre
      const matchPagoNombre = !matchConfirmar && mensaje.match(/^([A-Za-záéíóúüñÁÉÍÓÚÜÑ\s]+?)\s+pag[oó]\s*\$?([\d.,]+)?[\s,]*(efectivo|transferencia)?$/i);

      const matchPago = matchConfirmar || matchPagoNombre;
      if (matchPago) {
        const nombreBuscar = (matchConfirmar ? matchConfirmar[1] : matchPagoNombre[1]).trim();
        const montoRaw = matchConfirmar ? matchConfirmar[2] : matchPagoNombre[2];
        const metodoRaw = matchConfirmar ? matchConfirmar[3] : matchPagoNombre[3];
        const monto = montoRaw ? parseFloat(montoRaw.replace(/\./g, '').replace(',', '.')) : null;
        const metodo = metodoRaw
          ? (metodoRaw.charAt(0).toUpperCase() + metodoRaw.slice(1).toLowerCase())
          : 'Transferencia';

        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const clientes = await ejecutarTool('get_clientes', { buscar: nombreBuscar }, remitente);
        if (!Array.isArray(clientes) || clientes.length === 0) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `⚠️ No encontré cliente con el nombre "${nombreBuscar}"`);
          return;
        }
        const cliente = clientes[0];

        // Sin monto → guardar en Map y preguntar
        if (!monto) {
          cobrosPendientesDatos.set(remitente, { nombreCliente: nombreBuscar, metodo, clienteId: cliente.id, clienteNombre: cliente.nombre });
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `Encontré a ${cliente.nombre}. ¿Cuál fue el monto transferido?`);
          return;
        }

        // Con nombre y monto → encolar
        await pool.query(`DELETE FROM pagos_pendientes WHERE esperando_confirmacion = true AND cliente_id = $1`, [cliente.id]);
        await pool.query(
          `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
          [cliente.id, cliente.nombre, remitente, monto, metodo]
        );
        const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
        if (parseInt(existing[0].count) > 1) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP, `✅ Pago de ${cliente.nombre} $${monto} encolado`);
        } else {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP,
            `💰 ${cliente.nombre} - $${monto} - ${metodo}\n¿Confirmás? SÍ o NO`);
        }
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
          const texto = `¡Todo listo ${datos.nombre}! Ya quedaste registrado/a en Hockey Vivo 🎉\n\nTus turnos:\n${turnosStr}\n\nNo olvidés traer: 🏑 Palo | 👟 Botines | 💧 Agua\n¡Te esperamos! 💪`;
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
        pagosEsperandoNombre.delete(remitente);
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const clientes = await ejecutarTool('get_clientes', { buscar: mensaje.trim() }, remitente);
        if (Array.isArray(clientes) && clientes.length > 0) {
          const cliente = clientes[0];
          await pool.query(
            `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
            [cliente.id, cliente.nombre, remitente, datosPago.monto || 0, datosPago.metodo || 'Transferencia']
          );
          const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
          if (parseInt(existing[0].count) <= 1) {
            const msg = `💰 Pago pendiente de ${cliente.nombre} (${datosPago.metodo || 'Transferencia'})\n¿Confirmás? SÍ o NO`;
            await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
            guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
          }
          await enviarWhatsApp(remitente, `Gracias! Ya le avisé al equipo, en breve te confirmamos 🏑`, cliente.nombre);
        } else {
          await enviarWhatsApp(remitente, `No encontré ese nombre. ¿Podés decirme tu nombre completo?`);
          pagosEsperandoNombre.set(remitente, datosPago); // seguir esperando
        }
        return;
      }

      const esPagoRealizado = /pagu[eé]|pago[^s]|transfer[ií]|hice el pago|acabo de transferir|ya pag/i.test(mensaje);
      const esIntFutura = /quiero pagar|voy a pagar|puedo pagar|c[oó]mo pago|quisiera pagar/i.test(mensaje);
      if (esPagoRealizado && !esIntFutura) {
        if (!GYM_TOKEN) await loginConReintentos(3, 3000);
        const cliente = await buscarClientePorTelefono(remitente);
        if (cliente) {
          await pool.query(
            `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo) VALUES ($1, $2, $3, $4, $5)`,
            [cliente.id, cliente.nombre, remitente, 0, 'Transferencia']
          );
          const { rows: existing } = await pool.query(`SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`);
          if (parseInt(existing[0].count) <= 1) {
            const msg = `💰 Pago pendiente de ${cliente.nombre} (Transferencia)\n¿Confirmás? SÍ o NO`;
            await twilioClient.messages.create({ from: TWILIO_FROM, to: process.env.COSACO_WHATSAPP, body: msg });
            guardarMensaje(process.env.COSACO_WHATSAPP, null, msg, 'agente');
          }
          await enviarWhatsApp(remitente, `Gracias! Ya le avisé al equipo, en breve te confirmamos 🏑`, cliente.nombre);
        } else {
          const matchMonto = mensaje.match(/\$?(\d[\d.,]*)\s*(transferencia|efectivo)?/i);
          const montoDetectado = matchMonto ? parseFloat(matchMonto[1].replace(/\./g, '').replace(',', '.')) : 0;
          const metodoDetectado = matchMonto?.[2] ? (matchMonto[2].charAt(0).toUpperCase() + matchMonto[2].slice(1).toLowerCase()) : 'Transferencia';
          pagosEsperandoNombre.set(remitente, { monto: montoDetectado, metodo: metodoDetectado });
          await enviarWhatsApp(remitente, `¡Gracias por avisarnos! ¿Podés decirme tu nombre completo para identificarte?`);
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
      ? `Hola ${nombre}! 👋 Te recordamos que tu cuota de Hockey Vivo está por vencer. Podés transferir al alias hockeyvivo o pagarlo en efectivo en el gimnasio. ¡Cualquier duda avisanos! 🏑`
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

app.post('/webhook', (req, res) => {
  const mensaje = req.body.Body;
  const remitente = req.body.From;
  const profileName = req.body.ProfileName || remitente;
  guardarMensaje(remitente, profileName, mensaje || '[imagen]', 'cliente');
  res.type('text/xml').send(new twilio.twiml.MessagingResponse().toString());
  if (parseInt(req.body.NumMedia) > 0 && (!mensaje || !mensaje.trim())) {
    comprobantePendiente.set(remitente, true);
    const resp = '¡Recibí tu comprobante de transferencia! 🏑 Para registrar tu pago necesito:\n- Tu nombre completo\n- El monto que transferiste\n\nEscribime los dos datos y listo 😊';
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
</style>
</head>
<body>
<div class="app">
  <div class="sb" id="sb">
    <div class="sbh">Conversaciones</div>
    <div class="sbs"><input type="text" id="buscador" placeholder="Buscar por nombre o mensaje..."></div>
    <div class="hilos" id="hilos"><div class="ph">Cargando...</div></div>
  </div>
  <div class="chat" id="chat">
    <div class="ch">
      <button class="bv" id="btn-volver">←</button>
      <span class="chn" id="chn">Seleccioná una conversación</span>
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
const mob = () => window.innerWidth <= 768;

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
    div.className = 'hilo';
    const hn = document.createElement('div');
    hn.className = 'hn';
    hn.textContent = h.nombre;
    const hp = document.createElement('div');
    hp.className = 'hp';
    hp.textContent = (h.ultimo_texto || '').slice(0, 60);
    const ht = document.createElement('div');
    ht.className = 'ht';
    ht.textContent = h.ultimo_timestamp ? tiempoRel(h.ultimo_timestamp) : '';
    div.appendChild(hn);
    div.appendChild(hp);
    div.appendChild(ht);
    div.addEventListener('click', () => abrirHilo(h.telefono, h.nombre, div));
    cont.appendChild(div);
  }
}

async function cargarHilos() {
  const cont = document.getElementById('hilos');
  try {
    const r = await fetch('/panel/data');
    const d = await r.json();
    todosLosHilos = d.hilos || [];
    if (todosLosHilos.length === 0) {
      cont.innerHTML = '<div class="ph">Sin conversaciones</div>';
      return;
    }
    renderHilos(todosLosHilos);
  } catch (err) {
    cont.innerHTML = '<div class="ph">Error cargando conversaciones</div>';
  }
}

let buscarTimer = null;
document.getElementById('buscador').addEventListener('input', async function() {
  const q = this.value.trim();
  clearTimeout(buscarTimer);
  if (!q) { renderHilos(todosLosHilos); return; }
  // Filtro local inmediato
  const qLow = q.toLowerCase();
  const local = todosLosHilos.filter(h =>
    (h.nombre || '').toLowerCase().includes(qLow) ||
    (h.ultimo_texto || '').toLowerCase().includes(qLow)
  );
  renderHilos(local);
  // Búsqueda en DB si hay 3+ caracteres
  if (q.length >= 3) {
    buscarTimer = setTimeout(async () => {
      try {
        const r = await fetch('/panel/buscar?q=' + encodeURIComponent(q));
        const d = await r.json();
        if (document.getElementById('buscador').value.trim() === q) {
          renderHilos(d.hilos || []);
        }
      } catch (e) {}
    }, 400);
  }
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

  const r = await fetch('/panel/hilo?telefono=' + encodeURIComponent(telefono));
  const d = await r.json();
  const wrap = document.createElement('div');
  wrap.className = 'mw';

  for (const m of (d.mensajes || [])) {
    const tx = m.texto || '';
    if (!tx || tx === '[sin texto]' || (tx.startsWith('[') && tx.endsWith(']'))) continue;

    const div = document.createElement('div');
    div.className = 'msg ' + m.rol;

    const content = document.createElement('div');
    content.textContent = tx;

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date(m.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    div.appendChild(content);
    div.appendChild(time);
    wrap.appendChild(div);
  }

  msgs.innerHTML = '';
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  document.getElementById('ia').style.display = 'flex';
}

function volver() {
  document.getElementById('chat').classList.remove('visible');
  document.getElementById('sb').classList.remove('oculto');
  telefonoActual = null;
}

async function enviar() {
  const input = document.getElementById('mi');
  const texto = input.value.trim();
  if (!texto || !telefonoActual) return;
  const btn = document.getElementById('btn-enviar');
  input.value = '';
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const r = await fetch('/panel/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono: telefonoActual, mensaje: texto }),
    });
    const d = await r.json();
    if (d.ok) {
      abrirHilo(telefonoActual, null, null);  // refrescar el hilo abierto
      cargarHilos();
    } else {
      // Antes fallaba en silencio: el mensaje desaparecía sin explicación
      alert('No se pudo enviar:\n\n' + (d.error || 'Error desconocido'));
      input.value = texto;  // devolver el texto para no perderlo
    }
  } catch (e) {
    alert('Error de conexión: ' + e.message);
    input.value = texto;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '➤'; }
  }
}

document.getElementById('btn-volver').addEventListener('click', volver);
document.getElementById('btn-enviar').addEventListener('click', enviar);
document.getElementById('mi').addEventListener('keydown', e => { if (e.key === 'Enter') enviar(); });

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
        c.timestamp AS ultimo_timestamp
      FROM conversaciones c
      WHERE c.id = (SELECT id FROM conversaciones sub WHERE sub.telefono = c.telefono ORDER BY sub.timestamp DESC LIMIT 1)
      ORDER BY c.timestamp DESC
    `);
    res.json({ hilos: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      'SELECT rol, texto, timestamp FROM conversaciones WHERE telefono = $1 ORDER BY timestamp ASC',
      [req.query.telefono]
    );
    res.json({ mensajes: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.status(400).json({ error: `Job desconocido: ${job}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
  initDB().catch(err => console.error('Error initDB:', err.message));
  loginConReintentos().catch(() => {});
});
