require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id SERIAL PRIMARY KEY,
      telefono VARCHAR(50) NOT NULL,
      nombre VARCHAR(200),
      rol VARCHAR(20) NOT NULL,
      texto TEXT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_telefono ON conversaciones(telefono);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON conversaciones(timestamp);

    CREATE TABLE IF NOT EXISTS actividad_dia (
      fecha DATE PRIMARY KEY,
      mensajes_atendidos INTEGER DEFAULT 0,
      nuevos_clientes JSONB DEFAULT '[]',
      pagos_registrados JSONB DEFAULT '[]',
      turnos_cambiados JSONB DEFAULT '[]'
    );
  `);
  console.log('Tablas listas en PostgreSQL');
}

async function registrarActividad(tipo, dato) {
  const hoy = new Date().toISOString().split('T')[0];
  try {
    await pool.query(
      `INSERT INTO actividad_dia (fecha) VALUES ($1) ON CONFLICT (fecha) DO NOTHING`,
      [hoy]
    );
    if (tipo === 'mensaje') {
      await pool.query(
        `UPDATE actividad_dia SET mensajes_atendidos = mensajes_atendidos + 1 WHERE fecha = $1`,
        [hoy]
      );
    } else if (tipo === 'cliente') {
      await pool.query(
        `UPDATE actividad_dia SET nuevos_clientes = nuevos_clientes || $2::jsonb WHERE fecha = $1`,
        [hoy, JSON.stringify(dato)]
      );
    } else if (tipo === 'pago') {
      await pool.query(
        `UPDATE actividad_dia SET pagos_registrados = pagos_registrados || $2::jsonb WHERE fecha = $1`,
        [hoy, JSON.stringify(dato)]
      );
    } else if (tipo === 'turno') {
      await pool.query(
        `UPDATE actividad_dia SET turnos_cambiados = turnos_cambiados || $2::jsonb WHERE fecha = $1`,
        [hoy, JSON.stringify(dato)]
      );
    }
  } catch (err) {
    console.error('Error registrando actividad:', err.message);
  }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const GYM_API = 'https://hockeyvivo.up.railway.app';
let GYM_TOKEN = null;

const TWILIO_FROM = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith('whatsapp:')
  ? process.env.TWILIO_WHATSAPP_NUMBER
  : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

// Memoria conversacional por número de WhatsApp
const conversaciones = new Map(); // { from: { messages: [], lastSeen: Date } }
const EXPIRACION_MS = 24 * 60 * 60 * 1000; // 24 horas

// Cola de pagos pendientes de confirmación por Cosaco
let pagoEnEspera = null; // { cliente_id, cliente_nombre, cliente_from, monto, metodo, fecha_pago }
const colaPagendientes = []; // cola FIFO de pagos

// Suspensiones pendientes de confirmación por Cosaco
const suspencionesPendientes = new Map();
// clave: cliente_id como string, valor: { cliente_id, cliente_nombre, telefono, timestamp, esperandoConfirmacion }

// Becas pendientes de confirmación por Cosaco
const becasPendientes = new Map();
// clave: cliente_from (whatsapp del cliente), valor: { cliente_id, cliente_nombre, cliente_from, costo, plan, tipo_beca?, monto_final? }


function limpiarConversacionesViejas() {
  const ahora = Date.now();
  for (const [key, val] of conversaciones) {
    if (ahora - val.lastSeen > EXPIRACION_MS) {
      conversaciones.delete(key);
    }
  }
}

function getHistorial(from) {
  limpiarConversacionesViejas();
  if (!conversaciones.has(from)) {
    conversaciones.set(from, { messages: [], lastSeen: Date.now() });
  }
  return conversaciones.get(from);
}

async function loginGimnasio() {
  const body = new URLSearchParams({
    username: process.env.GYM_USER,
    password: process.env.GYM_PASS,
  });

  const r = await fetch(`${GYM_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(120000),
  });

  if (!r.ok) {
    throw new Error(`Login fallido: ${r.status} ${await r.text()}`);
  }

  const data = await r.json();
  GYM_TOKEN = data.access_token;
  console.log('Login exitoso en Hockey Vivo API');
  console.log(`Token: ${GYM_TOKEN.slice(0, 40)}...`);
}

async function loginConReintentos(intentos = 10, esperaInicial = 10000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      console.log(`Intentando login (intento ${i}/${intentos})...`);
      await loginGimnasio();
      return;
    } catch (err) {
      console.error(`Error en login: ${err.message}`);
      if (i < intentos) {
        const espera = Math.min(esperaInicial * i, 60000);
        console.log(`Reintentando en ${espera / 1000}s...`);
        await new Promise(r => setTimeout(r, espera));
      }
    }
  }
  console.warn('No se pudo hacer login tras todos los intentos. Se reintentará en cada request.');
}

function calcularFechaVencimiento(fecha_pago, fecha_vencimiento_actual) {

  // Si el cliente ya tiene grupo asignado, mantenerlo
  if (fecha_vencimiento_actual) {
    const diaGrupo = new Date(fecha_vencimiento_actual + 'T12:00:00').getDate();
    const base = new Date(fecha_pago + 'T12:00:00');
    const vencimiento = new Date(base.getFullYear(), base.getMonth() + 1, diaGrupo);
    return vencimiento.toISOString().split('T')[0];
  }

  // Cliente nuevo: calcular grupo según día de pago
  const fecha = new Date(fecha_pago + 'T12:00:00');
  const dia = fecha.getDate();

  let diaVencimiento;
  let mesesAdelante;

  if (dia >= 6 && dia <= 15) {
    // Grupo 15 — vence el 15 del mes siguiente
    diaVencimiento = 15;
    mesesAdelante = 1;
  } else if (dia >= 16 && dia <= 25) {
    // Grupo 25 — vence el 25 del mes siguiente
    diaVencimiento = 25;
    mesesAdelante = 1;
  } else {
    // Grupo 5 — del 26 al 31 o del 1 al 5
    // Si paga del 26 al 31 → salta 2 meses (ej: 26 abril → 5 junio)
    // Si paga del 1 al 5 → mes siguiente (ej: 3 mayo → 5 junio)
    diaVencimiento = 5;
    mesesAdelante = dia >= 26 ? 2 : 1;
  }

  const vencimiento = new Date(fecha.getFullYear(), fecha.getMonth() + mesesAdelante, diaVencimiento);
  return vencimiento.toISOString().split('T')[0];
}

const SYSTEM_PROMPT = `Sos el asistente virtual del gimnasio Hockey Vivo en Santiago del Estero, Argentina. Atendés consultas de clientes y potenciales alumnos por WhatsApp. Respondés en español argentino, de forma amable y breve. Usá emojis con moderación.

DATOS DEL GIMNASIO (usá solo cuando te pregunten puntualmente por esto):
- Dirección: Moreno (N) 55 entre Andes y Rivadavia, Santiago del Estero
- Horarios: Lunes, miércoles y viernes de 18:30 a 21hs / Martes y jueves de 16 a 21hs
- Instagram: @hockeyvivo.cm2
- Requisitos para asistir: palo, botines y agua
- Ubicación en mapa: https://maps.google.com/?q=-27.785810,-64.268463
- Planes: 1 vez/semana $29.000 | 2 veces/semana $35.000 | 3 veces/semana $39.000

REGLA IMPORTANTE: No mezcles información. Respondé solo lo que te preguntan. Si preguntan por el gimnasio en general, usá el mensaje de presentación. Si preguntan puntualmente por dirección, horarios, precios o ubicación, respondé solo eso.

CUANDO PREGUNTEN QUÉ ES HOCKEY VIVO, QUÉ SE HACE AHÍ, O PIDAN INFO DEL GIMNASIO EN GENERAL:
Respondé exactamente con este mensaje:
"Hockey Vivo es un espacio de entrenamiento creado por un jugador de hockey con una perspectiva diferente: un lugar exclusivo para que mejores tu rendimiento en la cancha de forma real y medible.

Cada jugador que entrena con nosotros empieza a notar mejoras desde las primeras semanas, y esto no es casualidad:

🏑 Cada rutina está diseñada exclusivamente para hockey. Nada de rutinas genéricas.
🏑 Entrenamos en estaciones que fortalecen y enriquecen tu técnica.
🏑 Tenés seguimiento constante para potenciar tu estilo de juego.

Trabajamos con un máximo de 6 personas por turno para que siempre tengas la atención que necesitás.

La primera clase es GRATIS para que lo vivas vos mismo. Si decidís quedarte, se abona el mes por adelantado. 🏑"

CUANDO PREGUNTEN POR TURNOS O CUPOS:
Respondé con este mensaje:
"¡Podés ver todos los turnos y cupos disponibles acá! 👇
🔗 https://hockeyvivo.up.railway.app/cupos
Para anotarte escribinos acá. Si el turno está lleno, podés anotarte en la lista de espera desde esa misma página 🏑"

CUANDO LLEGUE UN MENSAJE CON ESTE FORMATO (solicitud de reserva desde la web):
"Hola! Me interesa reservar lugar en Hockey Vivo..."
Con turnos elegidos y datos personales — seguir este flujo:

1. Extraer los datos del mensaje: nombre, fecha de nacimiento, whatsapp, equipo, nivel y turnos solicitados
2. Usar get_turnos para verificar si los turnos solicitados tienen cupo disponible (cupo_actual < cupo_maximo)
3. Si hay lugar → responder:
"¡Hola [nombre]! 🏑 Verificamos y [turno/s con día y hora] tiene lugar disponible.
¿Confirmás tu inscripción en Hockey Vivo?"
   Y guardar los datos del cliente en la conversación con pendiente_confirmacion: true (NO registrar todavía)

4. Si NO hay lugar → responder:
"Hola [nombre], lamentablemente el turno de [día y hora] está completo por el momento 😔 Podés anotarte en la lista de espera desde acá: https://hockeyvivo.up.railway.app/cupos y te avisamos cuando se libere un lugar 🏑"

5. Cuando el cliente responde SÍ, CONFIRMO o SI (y tiene pendiente_confirmacion activo):
   - Registrar al cliente con registrar_cliente_y_asignar_turno usando los datos guardados
   - Responder:
"¡Todo listo [nombre], ya quedaste registrado/a en Hockey Vivo! 🎉

Tus turnos asignados:
📅 [día y hora de cada turno]

Para tu primer entrenamiento recordá traer:
🏑 Palo
👟 Botines
💧 Agua

Y lo más importante: vení con la mente abierta a aprender cosas nuevas y dispuesto/a a entregarlo todo. ¡Te esperamos! 💪"

CUANDO PIDAN UBICACIÓN O DIRECCIÓN:
Dar la dirección y el link: https://maps.google.com/?q=-27.785810,-64.268463

REGISTRO DE PAGOS:
Cuando alguien quiera registrar un pago o vos lo indiques:
1. Usar get_clientes para encontrar al cliente y obtener su ID
2. Confirmar monto y método (Efectivo o Transferencia)
3. Usar la tool consultar_pago_a_cosaco (NO uses registrar_pago directamente)
4. Responder al cliente: "✅ Pago enviado para confirmación. En breve queda registrado 🏑"
IMPORTANTE: Nunca uses registrar_pago directamente desde una conversación con un cliente. Siempre pasá por consultar_pago_a_cosaco.
La fecha de pago se calcula automáticamente (no la pidas al cliente): si el cliente está Suspendido o no tiene fecha de vencimiento, se usa la fecha de hoy; si está Vigente, se usa su última fecha de vencimiento.

CUANDO REGISTRES O ASIGNES TURNOS (cliente nuevo o existente):
Al confirmar, siempre incluí un resumen de TODOS los turnos asignados actualmente. Usá get_turnos para obtener los nombres y horarios, y mostrá el mensaje así:

"¡Todo listo [nombre]! Ya quedaste registrado/a en Hockey Vivo 🏑

Tus turnos asignados:
📅 [Día] [Horario]
📅 [Día] [Horario]

Si querés cambiar o agregar algún día, avisame acá mismo. ¡Te esperamos en el entrenamiento! 🏑"

Siempre mostrá día y horario de cada turno, nunca solo el ID.

CUANDO UN CLIENTE MENCIONE QUE TIENE BECA O DESCUENTO:
1. Respondele: "Perfecto, dejame confirmarlo con el equipo y te avisamos en breve 🏑"
2. Usá get_clientes para obtener el ID y datos del cliente
3. Usá la tool consultar_beca_a_cosaco para notificar a Cosaco
No uses registrar_pago hasta que la beca esté confirmada y el cliente avise que pagó.

MODO SECRETARIO — cuando Cosaco escribe directamente:
Sos su asistente administrativo personal. Podés hacer todo lo que haría un secretario:

1. ENVIAR MENSAJES A CLIENTES:
Si Cosaco dice "mandále un mensaje a [nombre] diciéndole [texto]":
- Buscá al cliente con get_clientes
- Enviá el mensaje con enviar_mensaje_cliente
- Confirmale a Cosaco: "✅ Mensaje enviado a [nombre]"

2. CONSULTAR INFO:
Si Cosaco pregunta por un cliente, sus pagos, sus turnos, vencimientos — buscá y respondé con un resumen claro.

3. REGISTRAR PAGOS EN EFECTIVO:
Si Cosaco dice "[nombre] me pagó $[monto] en efectivo" → flujo normal de pago.

4. CUALQUIER GESTIÓN:
Cosaco puede pedirte registrar clientes, cambiar turnos, consultar deudores, ver cumpleaños, etc.

Siempre respondé a Cosaco de forma concisa y confirmando lo que hiciste.

CUANDO COSACO PIDA SUSPENDER A UN CLIENTE (ejemplo: "suspendé a Romina" o "dá de baja a María"):
1. Buscá al cliente con get_clientes
2. Confirmale a Cosaco: "¿Confirmás que querés suspender a [nombre]? Respondé SÍ o NO"
3. Si Cosaco confirma con SÍ, usá suspender_cliente para suspenderlo
4. Confirmale: "✅ [nombre] fue suspendido correctamente"

SOBRE EL ENTRENAMIENTO:
- Cada sesión dura 1 hora
- Está dividida en dos etapas: una etapa física y una etapa técnica
- Se abona el mes por adelantado
- El pago se puede realizar justo después de la clase de prueba o antes del primer entrenamiento del plan

SI NO PODÉS RESOLVER ALGO:
Decí: "Te paso con el equipo de Hockey Vivo, en breve te contactamos 🏑"

INTENCIÓN DE PAGO vs PAGO REALIZADO:
Diferenciá claramente entre:
- "Quiero pagar", "quisiera pagar", "voy a pagar", "puedo pagar" → es una INTENCIÓN futura. Preguntá: "¿Cuándo vas a realizar el pago? Podés hacerlo por transferencia al alias hockeyvivo o en efectivo en el gimnasio 🏑"
- "Pagué", "ya pagué", "transferí", "hice el pago", manda comprobante → es un PAGO REALIZADO. Iniciá el flujo de confirmación.

NOMBRES AMBIGUOS:
Cuando alguien mencione un nombre incompleto, apodo, solo apellido, o nombre de otra persona:
1. Primero buscá en get_clientes usando el número de teléfono del remitente para ver si es un cliente registrado
2. Si encontrás al cliente → confirmá: "¿Me estás hablando de [nombre completo]?"
3. Si no encontrás → buscá con el nombre/apellido que dieron en get_clientes?buscar=[nombre]
4. Si encontrás uno solo → confirmá: "¿Me estás hablando de [nombre completo]?"
5. Si encontrás varios → mostrá las opciones: "¿De cuál me hablás? • Emilia Medina • María Medina"
6. Si no encontrás nada → pedí el nombre completo amablemente`;

const TOOLS = [
  {
    name: 'get_turnos',
    description: 'Obtiene los turnos del gimnasio con sus IDs, horarios, niveles y cupos. Usá esta tool cuando necesites los IDs de los turnos para asignar un cliente.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_clientes',
    description: 'Obtiene la lista de clientes del gimnasio. Se puede filtrar por estado o buscar por nombre/teléfono.',
    input_schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', description: 'Filtrar por estado (Vigente, Vencido, Suspendido)' },
        buscar: { type: 'string', description: 'Buscar por nombre o teléfono' },
      },
      required: [],
    },
  },
  {
    name: 'get_vencimientos',
    description: 'Obtiene la lista de clientes con cuotas próximas a vencer o ya vencidas.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'registrar_cliente_y_asignar_turno',
    description: 'Registra un nuevo cliente y lo asigna a uno o más turnos.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del cliente' },
        apellido: { type: 'string', description: 'Apellido del cliente' },
        telefono: { type: 'string', description: 'Teléfono del cliente' },
        fecha_nacimiento: { type: 'string', description: 'Fecha de nacimiento en formato YYYY-MM-DD (opcional)' },
        club: { type: 'string', description: 'Club al que pertenece (opcional)' },
        turno_ids: { type: 'array', items: { type: 'integer' }, description: 'Lista de IDs de turnos a asignar' },
      },
      required: ['nombre', 'apellido', 'telefono', 'turno_ids'],
    },
  },
  {
    name: 'asignar_turnos',
    description: 'Asigna o reemplaza turnos de un cliente existente. Usá esta tool después de que el cliente confirme si quiere agregar o reemplazar sus turnos actuales.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente existente' },
        turno_ids: { type: 'array', items: { type: 'integer' }, description: 'IDs de los turnos a asignar' },
        reemplazar: { type: 'boolean', description: 'Si true, quita los turnos actuales antes de asignar los nuevos' },
        turnos_actuales: { type: 'array', items: { type: 'integer' }, description: 'IDs de los turnos actuales (necesario si reemplazar=true)' },
      },
      required: ['cliente_id', 'turno_ids'],
    },
  },
  {
    name: 'registrar_pago',
    description: 'Registra un pago de cuota de un cliente. SOLO usar internamente, nunca desde conversaciones con clientes.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente' },
        monto: { type: 'number', description: 'Monto en pesos argentinos' },
        metodo: { type: 'string', description: 'Método de pago (Efectivo, Transferencia)' },
        fecha_pago: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
      },
      required: ['cliente_id', 'monto', 'fecha_pago'],
    },
  },
  {
    name: 'consultar_pago_a_cosaco',
    description: 'Envía una solicitud de confirmación de pago al dueño del gimnasio (Cosaco) por WhatsApp. Usar SIEMPRE en lugar de registrar_pago cuando un cliente quiere pagar.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente' },
        cliente_nombre: { type: 'string', description: 'Nombre completo del cliente' },
        monto: { type: 'number', description: 'Monto en pesos argentinos' },
        metodo: { type: 'string', description: 'Método de pago (Efectivo, Transferencia)' },
      },
      required: ['cliente_id', 'cliente_nombre', 'monto', 'metodo'],
    },
  },
  {
    name: 'enviar_mensaje_cliente',
    description: 'Envía un mensaje de WhatsApp a un cliente específico. Usar cuando Cosaco pide mandar un mensaje a un cliente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente' },
        mensaje: { type: 'string', description: 'Texto del mensaje a enviar' },
      },
      required: ['cliente_id', 'mensaje'],
    },
  },
  {
    name: 'consultar_beca_a_cosaco',
    description: 'Notifica a Cosaco que un cliente dice tener beca o descuento, para que confirme el tipo. Usá esta tool cuando un cliente mencione que tiene beca.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente' },
        cliente_nombre: { type: 'string', description: 'Nombre completo del cliente' },
        costo: { type: 'number', description: 'Costo mensual del plan del cliente' },
        plan: { type: 'integer', description: 'Número de plan del cliente' },
      },
      required: ['cliente_id', 'cliente_nombre', 'costo', 'plan'],
    },
  },
  {
    name: 'suspender_cliente',
    description: 'Suspende el servicio de un cliente. Usar solo cuando Cosaco confirme explícitamente que quiere suspender al cliente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente a suspender' },
        cliente_nombre: { type: 'string', description: 'Nombre completo del cliente' },
      },
      required: ['cliente_id', 'cliente_nombre'],
    },
  },
];

async function ejecutarTool(nombre, input, remitente) {
  const headers = {
    'Authorization': `Bearer ${GYM_TOKEN}`,
    'Content-Type': 'application/json',
  };

  try {
    if (nombre === 'registrar_cliente_y_asignar_turno') {
      const nombreCompleto = `${input.nombre} ${input.apellido}`;

      // 1. Buscar cliente por teléfono
      const rBuscar = await fetch(`${GYM_API}/clientes?buscar=${encodeURIComponent(input.telefono)}`, { headers });
      const resultadoBusqueda = await rBuscar.json();
      const clienteExistente = Array.isArray(resultadoBusqueda) && resultadoBusqueda.length > 0
        ? resultadoBusqueda[0]
        : null;

      async function asignarTurnos(cliente_id, turno_ids) {
        const asignados = [];
        const errores = [];
        for (const turno_id of turno_ids) {
          const r = await fetch(`${GYM_API}/turnos/${turno_id}/asignar/${cliente_id}`, {
            method: 'POST',
            headers,
          });
          if (r.ok) asignados.push(turno_id);
          else errores.push(`turno ${turno_id}: ${await r.text()}`);
        }
        return { asignados, errores };
      }

      // 2. Cliente NO existe → registrar y asignar
      if (!clienteExistente) {
        const bodyCliente = { nombre: nombreCompleto, telefono: input.telefono };
        if (input.fecha_nacimiento) bodyCliente.fecha_nacimiento = input.fecha_nacimiento;
        if (input.club) bodyCliente.club = input.club;

        const rNuevo = await fetch(`${GYM_API}/clientes`, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyCliente),
        });
        if (!rNuevo.ok) return { error: `Error al crear cliente: ${await rNuevo.text()}` };

        const nuevoCliente = await rNuevo.json();
        const { asignados, errores } = await asignarTurnos(nuevoCliente.id, input.turno_ids);
        registrarActividad('cliente', nombreCompleto);
        return {
          ok: true,
          nuevo: true,
          cliente_id: nuevoCliente.id,
          nombre: nombreCompleto,
          turnos_asignados: asignados,
          errores: errores.length ? errores : undefined,
        };
      }

      // Cliente existe → obtener sus turnos actuales
      const cliente_id = clienteExistente.id;
      const nombreExistente = clienteExistente.nombre;

      const rTurnos = await fetch(`${GYM_API}/turnos`, { headers });
      const todosTurnos = await rTurnos.json();
      const turnosActuales = todosTurnos
        .filter(t => Array.isArray(t.alumnos) && t.alumnos.some(a => a.id === cliente_id))
        .map(t => ({ id: t.id, dia: t.dia_semana, hora: t.hora_inicio, nivel: t.nivel }));

      // 4. Existe pero sin turnos → asignar directamente
      if (turnosActuales.length === 0) {
        const { asignados, errores } = await asignarTurnos(cliente_id, input.turno_ids);
        registrarActividad('cliente', nombreExistente);
        return {
          ok: true,
          bienvenida_vuelta: true,
          cliente_id,
          nombre: nombreExistente,
          turnos_asignados: asignados,
          errores: errores.length ? errores : undefined,
        };
      }

      // 5. Existe Y tiene turnos → devolver info para que Claude pregunte
      return {
        existe: true,
        tiene_turnos: true,
        cliente_id,
        nombre: nombreExistente,
        turnos_actuales: turnosActuales,
        turnos_solicitados: input.turno_ids,
      };
    }

    if (nombre === 'asignar_turnos') {
      // Quitar turnos actuales si se pide reemplazar
      if (input.reemplazar && Array.isArray(input.turnos_actuales)) {
        for (const turno_id of input.turnos_actuales) {
          await fetch(`${GYM_API}/turnos/${turno_id}/quitar/${input.cliente_id}`, {
            method: 'DELETE',
            headers,
          });
        }
      }
      // Asignar nuevos turnos
      const asignados = [];
      const errores = [];
      for (const turno_id of input.turno_ids) {
        const r = await fetch(`${GYM_API}/turnos/${turno_id}/asignar/${input.cliente_id}`, {
          method: 'POST',
          headers,
        });
        if (r.ok) asignados.push(turno_id);
        else errores.push(`turno ${turno_id}: ${await r.text()}`);
      }
      if (asignados.length > 0) {
        const rCli = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
        const cli = await rCli.json();
        registrarActividad('turno', cli.nombre || `ID ${input.cliente_id}`);
      }
      return {
        ok: true,
        turnos_asignados: asignados,
        errores: errores.length ? errores : undefined,
      };
    }

    if (nombre === 'get_turnos') {
      const r = await fetch(`${GYM_API}/turnos`, { headers });
      return await r.json();
    }

    if (nombre === 'get_clientes') {
      const params = new URLSearchParams();
      if (input.estado) params.append('estado', input.estado);
      if (input.buscar) params.append('buscar', input.buscar);
      const r = await fetch(`${GYM_API}/clientes?${params.toString()}`, { headers });
      return await r.json();
    }

    if (nombre === 'get_vencimientos') {
      const r = await fetch(`${GYM_API}/vencimientos`, { headers });
      return await r.json();
    }

    if (nombre === 'registrar_pago') {
      const rCliente = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      const hoy = new Date().toISOString().split('T')[0];
      const fecha_pago = input.fecha_pago
        || (cliente.estado === 'Suspendido' || !cliente.fecha_vencimiento ? hoy : cliente.fecha_vencimiento);
      // Si hay beca confirmada para este cliente, usar el monto_final
      const becaCliente = becasPendientes.get(remitente);
      const monto = (becaCliente?.monto_final !== undefined) ? becaCliente.monto_final : input.monto;
      const r = await fetch(`${GYM_API}/pagos`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cliente_id: input.cliente_id,
          monto,
          metodo: input.metodo || 'Transferencia',
          fecha_pago,
          fecha_inicio: fecha_pago,
          fecha_vencimiento: calcularFechaVencimiento(fecha_pago, cliente.fecha_vencimiento),
          plan: cliente.plan,
        }),
      });
      const resultado = await r.json();
      // Limpiar beca pendiente una vez registrado el pago
      if (becaCliente) becasPendientes.delete(remitente);
      registrarActividad('pago', { nombre: cliente.nombre, monto });
      return resultado;
    }

    if (nombre === 'consultar_pago_a_cosaco') {
      const rCliente = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      const hoy = new Date().toISOString().split('T')[0];
      const fecha_pago = cliente.estado === 'Suspendido' || !cliente.fecha_vencimiento
        ? hoy
        : cliente.fecha_vencimiento;
      const nuevoPago = {
        cliente_id: input.cliente_id,
        cliente_nombre: input.cliente_nombre,
        cliente_from: remitente,
        monto: input.monto,
        metodo: input.metodo || 'Transferencia',
        fecha_pago,
      };

      const mensajeCosaco =
        `💰 *Confirmación de pago*\n` +
        `Cliente: ${input.cliente_nombre}\n` +
        `Monto: $${input.monto}\n` +
        `Método: ${input.metodo || 'Transferencia'}\n` +
        `¿Confirmás este pago? Respondé *SÍ* o *NO*`;

      if (pagoEnEspera) {
        colaPagendientes.push(nuevoPago);
        console.log(`Pago encolado para ${input.cliente_nombre} (posición ${colaPagendientes.length})`);
        return { ok: true, encolado: true, posicion: colaPagendientes.length };
      } else {
        pagoEnEspera = nuevoPago;
        console.log(`[Twilio] Enviando a Cosaco — from: ${process.env.TWILIO_WHATSAPP_NUMBER} | to: ${process.env.COSACO_WHATSAPP}`);
        try {
          const msgResult = await twilioClient.messages.create({
            from: TWILIO_FROM,
            to: process.env.COSACO_WHATSAPP,
            body: mensajeCosaco,
          });
          console.log(`[Twilio] Mensaje enviado OK — SID: ${msgResult.sid} | status: ${msgResult.status} | to: ${msgResult.to} | from: ${msgResult.from}`);
          guardarMensaje(process.env.COSACO_WHATSAPP, null, mensajeCosaco, 'agente');
        } catch (twilioErr) {
          console.error(`[Twilio] ERROR al enviar a Cosaco — code: ${twilioErr.code} | status: ${twilioErr.status} | message: ${twilioErr.message}`);
          pagoEnEspera = null;
          return { error: `Error enviando mensaje a Cosaco: ${twilioErr.message}` };
        }
        return { ok: true, enviado_a_cosaco: true };
      }
    }

    if (nombre === 'enviar_mensaje_cliente') {
      const rCliente = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      await enviarWhatsApp(cliente.telefono, input.mensaje);
      return { ok: true, enviado_a: cliente.nombre };
    }

    if (nombre === 'suspender_cliente') {
      const r = await fetch(`${GYM_API}/clientes/${input.cliente_id}/suspender`, {
        method: 'DELETE',
        headers,
      });
      if (!r.ok) return { error: `Error suspendiendo cliente: ${await r.text()}` };
      return { ok: true, nombre: input.cliente_nombre };
    }

    if (nombre === 'consultar_beca_a_cosaco') {
      becasPendientes.set(remitente, {
        cliente_id: input.cliente_id,
        cliente_nombre: input.cliente_nombre,
        cliente_from: remitente,
        costo: input.costo,
        plan: input.plan,
      });
      await enviarWhatsApp(process.env.COSACO_WHATSAPP,
        `⚠️ ${input.cliente_nombre} dice que tiene beca.\n¿Qué tipo le corresponde?\nRespondé: SIN BECA, 50% o 100%`);
      console.log(`Consulta de beca enviada a Cosaco para ${input.cliente_nombre}`);
      return { ok: true };
    }

    return { error: `Tool desconocida: ${nombre}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function procesarMensaje(mensaje, remitente, profileName = null) {
  try {
    if (!GYM_TOKEN) {
      console.log('Sin token, intentando login...');
      await loginConReintentos(3, 3000);
    }

    const conv = getHistorial(remitente);
    conv.messages.push({ role: 'user', content: mensaje });
    conv.lastSeen = Date.now();

    // Agentic loop
    let respuesta;
    while (true) {
      respuesta = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conv.messages,
      });

      console.log(`Stop reason: ${respuesta.stop_reason}`);

      if (respuesta.stop_reason !== 'tool_use') break;

      conv.messages.push({ role: 'assistant', content: respuesta.content });

      const toolResults = [];
      for (const bloque of respuesta.content) {
        if (bloque.type !== 'tool_use') continue;
        console.log(`Ejecutando tool: ${bloque.name}`, bloque.input);
        const resultado = await ejecutarTool(bloque.name, bloque.input, remitente);
        console.log(`Resultado de ${bloque.name}:`, JSON.stringify(resultado).slice(0, 300));
        toolResults.push({
          type: 'tool_result',
          tool_use_id: bloque.id,
          content: JSON.stringify(resultado),
        });
      }

      conv.messages.push({ role: 'user', content: toolResults });
    }

    const bloqueTexto = respuesta.content.find(b => b.type === 'text');
    const texto = bloqueTexto ? bloqueTexto.text : 'No pude procesar tu consulta. Intentá de nuevo.';
    conv.messages.push({ role: 'assistant', content: texto });
    console.log(`Respuesta de Claude: ${texto}`);

    await twilioClient.messages.create({
      from: TWILIO_FROM,
      to: remitente,
      body: texto,
    });
    guardarMensaje(remitente, null, texto, 'agente');
    registrarActividad('mensaje');
    console.log(`Mensaje enviado a ${remitente}`);

    if (texto.includes('Te paso con el equipo')) {
      await enviarWhatsApp(
        process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
        `⚠️ ${profileName || remitente} necesita atención humana.\nÚltimo mensaje: "${mensaje}"\nContactalo a la brevedad 🏑`,
        'Cosaco'
      );
    }
  } catch (error) {
    console.error(`Error procesando mensaje de ${remitente}:`, error);
  }
}

async function manejarConfirmacionPago(confirmado) {
  const pago = pagoEnEspera;
  pagoEnEspera = null;

  if (confirmado) {
    console.log(`Cosaco confirmó pago de ${pago.cliente_nombre} por $${pago.monto}`);
    try {
      const headers = {
        'Authorization': `Bearer ${GYM_TOKEN}`,
        'Content-Type': 'application/json',
      };
      const rCliente = await fetch(`${GYM_API}/clientes/${pago.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      const r = await fetch(`${GYM_API}/pagos`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cliente_id: pago.cliente_id,
          monto: pago.monto,
          metodo: pago.metodo,
          fecha_pago: pago.fecha_pago,
          fecha_inicio: pago.fecha_pago,
          fecha_vencimiento: calcularFechaVencimiento(pago.fecha_pago, cliente.fecha_vencimiento),
          plan: cliente.plan,
        }),
      });
      const resultado = await r.json();
      console.log('Pago registrado:', JSON.stringify(resultado));
      registrarActividad('pago', { nombre: pago.cliente_nombre, monto: pago.monto });

      await enviarWhatsApp(pago.cliente_from,
        `✅ Pago registrado: ${pago.cliente_nombre} - $${pago.monto} - ${pago.metodo} - ${pago.fecha_pago} 🏑`,
        pago.cliente_nombre);
    } catch (err) {
      console.error('Error registrando pago confirmado:', err);
    }
  } else {
    console.log(`Cosaco rechazó pago de ${pago.cliente_nombre}`);
    await enviarWhatsApp(pago.cliente_from,
      `Quedá tranquilo/a, en breve un integrante del equipo se comunica con vos para resolverlo 🏑`,
      pago.cliente_nombre);
  }

  // Procesar siguiente en cola
  if (colaPagendientes.length > 0) {
    pagoEnEspera = colaPagendientes.shift();
    const mensajeCosaco =
      `💰 Siguiente pago a confirmar:\n` +
      `Cliente: ${pagoEnEspera.cliente_nombre} - $${pagoEnEspera.monto} - ${pagoEnEspera.metodo}\n` +
      `¿Confirmás? SÍ o NO`;
    await enviarWhatsApp(process.env.COSACO_WHATSAPP, mensajeCosaco);
    console.log(`Siguiente pago en cola enviado a Cosaco: ${pagoEnEspera.cliente_nombre}`);
  }
}

app.get('/test-jobs', async (req, res) => {
  if (req.query.secret !== 'hockeyvivo') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const job = req.query.job;
  if (!job) {
    return res.status(400).json({ error: 'Parámetro job requerido: recordatorio, mora, suspension, cumpleanos, informe, todos' });
  }

  try {
    const r = await fetch(`${GYM_API}/clientes?buscar=Roberto+Marcoux`, {
      headers: { Authorization: `Bearer ${GYM_TOKEN}` }
    });
    const data = await r.json();
    const c = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!c) return res.status(404).json({ error: 'Cliente Roberto Marcoux no encontrado' });

    const nombre = c.nombre.split(' ')[0];
    let templateSid;

    if (job === 'recordatorio') {
      const clientes = await clientesPorGrupo(15, 'recordatorio');
      console.log(`Clientes grupo 15 encontrados: ${clientes.length}`);
      if (clientes.length === 0) {
        return res.json({ ok: false, mensaje: 'No hay clientes con vencimiento el día 15' });
      }
      for (const c of clientes) {
        const nombre = c.nombre.split(' ')[0];
        await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, {"1": nombre}, '[Recordatorio de vencimiento]');
        console.log(`✅ Enviado a ${c.nombre}`);
      }
      return res.json({ ok: true, enviados: clientes.map(c => c.nombre) });
    } else if (job === 'mora') {
      templateSid = process.env.TEMPLATE_MORA;
    } else if (job === 'suspension') {
      const clientesSusp = await clientesPorGrupo(5, 'suspension');
      console.log(`Clientes suspensión grupo 5: ${clientesSusp.length}`);
      if (clientesSusp.length === 0) {
        return res.json({ ok: false, mensaje: 'No hay clientes con 10 días vencidos en grupo 5' });
      }
      for (const c of clientesSusp) {
        const nombre = c.nombre.split(' ')[0];
        await enviarTemplate(c.telefono, process.env.TEMPLATE_SUSPENSION, {"1": nombre}, '[Aviso de suspensión]');
        console.log(`✅ Enviado suspensión a ${c.nombre}`);
      }
      return res.json({ ok: true, enviados: clientesSusp.map(c => c.nombre) });
    } else if (job === 'cumpleanos') {
      templateSid = process.env.TEMPLATE_CUMPLEANOS;
    } else if (job === 'informe') {
      const fechaHoy = new Date().toISOString().split('T')[0];
      const result = await pool.query('SELECT * FROM actividad_dia WHERE fecha = $1', [fechaHoy]);
      const actividad = result.rows[0] || { mensajes_atendidos: 0, nuevos_clientes: [], pagos_registrados: [], turnos_cambiados: [] };
      const hoy = new Date().toLocaleDateString('es-AR');
      let informe = `📊 *Informe del día — ${hoy}*\n\n`;
      informe += `💬 Mensajes atendidos: ${actividad.mensajes_atendidos}\n\n`;
      if (actividad.nuevos_clientes.length > 0) {
        informe += `✅ Nuevos clientes (${actividad.nuevos_clientes.length}):\n`;
        actividad.nuevos_clientes.forEach(n => informe += `• ${n}\n`);
        informe += '\n';
      } else {
        informe += `✅ Nuevos clientes: ninguno\n\n`;
      }
      if (actividad.pagos_registrados.length > 0) {
        const total = actividad.pagos_registrados.reduce((sum, p) => sum + p.monto, 0);
        informe += `💰 Pagos registrados (${actividad.pagos_registrados.length}) — Total: $${total.toLocaleString('es-AR')}:\n`;
        actividad.pagos_registrados.forEach(p => informe += `• ${p.nombre}: $${p.monto.toLocaleString('es-AR')}\n`);
        informe += '\n';
      } else {
        informe += `💰 Pagos registrados: ninguno\n\n`;
      }
      if (actividad.turnos_cambiados.length > 0) {
        informe += `🔄 Cambios de turno (${actividad.turnos_cambiados.length}):\n`;
        actividad.turnos_cambiados.forEach(n => informe += `• ${n}\n`);
        informe += '\n';
      } else {
        informe += `🔄 Cambios de turno: ninguno\n\n`;
      }
      informe += `_Hasta mañana Cosaco! 🏑_`;
      await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''), informe);
      console.log('[test-jobs] Informe enviado a Cosaco');
      return res.json({ ok: true, job: 'informe', informe });
    } else if (job === 'todos') {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const jobs = ['recordatorio', 'mora', 'suspension', 'cumpleanos', 'informe'];
      const resultados = [];
      for (const j of jobs) {
        try {
          const url = `http://localhost:${PORT}/test-jobs?secret=hockeyvivo&job=${j}`;
          const resp = await fetch(url);
          const resultado = await resp.json();
          resultados.push({ job: j, ok: resp.ok, resultado });
          console.log(`[test-jobs/todos] Job "${j}" completado`);
        } catch (err) {
          resultados.push({ job: j, ok: false, error: err.message });
          console.error(`[test-jobs/todos] Error en job "${j}":`, err.message);
        }
        await delay(2000);
      }
      return res.json({ ok: true, job: 'todos', resultados });
    } else {
      return res.status(400).json({ error: `Job desconocido: ${job}` });
    }

    await enviarTemplate(c.telefono, templateSid, { "1": nombre });
    console.log(`[test-jobs] Job "${job}" ejecutado para ${c.nombre}`);
    res.json({ ok: true, job, cliente: c.nombre, telefono: c.telefono, template: templateSid });
  } catch (err) {
    console.error('[test-jobs] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', (req, res) => {
  console.log('req.body completo:', req.body);
  const mensaje = req.body.Body;
  const remitente = req.body.From;
  const profileName = req.body.ProfileName || remitente;
  console.log(`Mensaje recibido de ${remitente}: ${mensaje}`);
  guardarMensaje(remitente, profileName, mensaje || '[imagen]', 'cliente');

  // Responder inmediatamente a Twilio con TwiML vacío
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml');
  res.send(twiml.toString());

  // Detectar imagen sin texto
  if (parseInt(req.body.NumMedia) > 0 && (!mensaje || mensaje.trim() === '')) {
    const respuestaImagen = 'Hola! 👋 Recibí tu imagen pero no puedo leerla directamente. ¿Me podés escribir de qué se trata? Por ejemplo: "Pagué el mes de junio por $35.000" y con eso te ayudo enseguida 🏑';
    twilioClient.messages.create({ from: TWILIO_FROM, to: remitente, body: respuestaImagen })
      .then(() => guardarMensaje(remitente, null, respuestaImagen, 'agente'))
      .catch(err => console.error('Error respondiendo imagen:', err.message));
    return;
  }

  // Detectar si es Cosaco respondiendo a una confirmación de pago
  if (remitente === process.env.COSACO_WHATSAPP && pagoEnEspera) {
    const respuesta = mensaje.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (respuesta === 'SI' || respuesta === 'S') {
      manejarConfirmacionPago(true).catch(err => console.error('Error manejando confirmación SÍ:', err));
      return;
    } else if (respuesta === 'NO' || respuesta === 'N') {
      manejarConfirmacionPago(false).catch(err => console.error('Error manejando confirmación NO:', err));
      return;
    }
    // Si no es SÍ/NO, procesar como mensaje normal de Cosaco
  }

  // Detectar si es Cosaco respondiendo a una suspensión pendiente
  if (remitente === process.env.COSACO_WHATSAPP) {
    const suspensionEsperando = [...suspencionesPendientes.values()].find(s => s.esperandoConfirmacion);
    if (suspensionEsperando) {
      const respuesta = mensaje.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      (async () => {
        if (respuesta === 'SI' || respuesta === 'S') {
          await fetch(`${GYM_API}/clientes/${suspensionEsperando.cliente_id}/suspender`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${GYM_TOKEN}` }
          });
          console.log(`✅ Cliente ${suspensionEsperando.cliente_nombre} suspendido`);
          await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
            `✅ Servicio de ${suspensionEsperando.cliente_nombre} suspendido correctamente.`);
        } else {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
            `👍 Ok, ${suspensionEsperando.cliente_nombre} no fue suspendido.`);
        }

        // Limpiar y pasar al siguiente
        suspencionesPendientes.delete(suspensionEsperando.cliente_id.toString());
        const siguiente = [...suspencionesPendientes.values()].find(s => !s.esperandoConfirmacion);
        if (siguiente) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
            `⚠️ Siguiente: ${siguiente.cliente_nombre} lleva 10 días sin pagar. ¿Suspendo su servicio?\nRespondé SÍ o NO`);
          suspencionesPendientes.set(siguiente.cliente_id.toString(), { ...siguiente, esperandoConfirmacion: true });
        }
      })().catch(err => console.error('Error manejando suspensión:', err));
      return;
    }
  }

  // Detectar si es Cosaco respondiendo a una consulta de beca
  if (remitente === process.env.COSACO_WHATSAPP && becasPendientes.size > 0) {
    const respuestaNorm = mensaje.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const esBeca = respuestaNorm === 'SIN BECA' || respuestaNorm === '50%' || respuestaNorm === '100%';
    if (esBeca) {
      // Tomar la primera beca pendiente sin tipo confirmado
      const becaEntry = [...becasPendientes.entries()].find(([, b]) => !b.tipo_beca);
      if (becaEntry) {
        const [clienteFrom, beca] = becaEntry;
        (async () => {
          let monto;
          let tipoBeca;
          if (respuestaNorm === 'SIN BECA') {
            monto = beca.costo;
            tipoBeca = 'SIN BECA';
          } else if (respuestaNorm === '50%') {
            monto = Math.round(beca.costo / 2);
            tipoBeca = '50%';
          } else {
            monto = 0;
            tipoBeca = '100%';
          }

          // Actualizar becasPendientes con tipo y monto confirmado
          becasPendientes.set(clienteFrom, { ...beca, tipo_beca: tipoBeca, monto_final: monto });

          // Notificar al cliente
          const msgCliente = tipoBeca === 'SIN BECA'
            ? `✅ Confirmado ${beca.cliente_nombre.split(' ')[0]}! No tenés beca asignada.\nTu cuota este mes es $${monto.toLocaleString('es-AR')}.\n¿Ya realizaste el pago? Si es así, avisanos para registrarlo 🏑`
            : `✅ Confirmado ${beca.cliente_nombre.split(' ')[0]}! Tu beca es del ${tipoBeca}.\nTu cuota este mes es $${monto.toLocaleString('es-AR')}.\n¿Ya realizaste el pago? Si es así, avisanos para registrarlo 🏑`;
          await enviarWhatsApp(clienteFrom, msgCliente, beca.cliente_nombre.split(' ')[0]);

          // Notificar a Cosaco
          await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
            `✅ Beca confirmada. Le avisé a ${beca.cliente_nombre} que su cuota es $${monto.toLocaleString('es-AR')}`);

          console.log(`Beca ${tipoBeca} confirmada para ${beca.cliente_nombre}, monto: $${monto}`);
        })().catch(err => console.error('Error manejando beca:', err));
        return;
      }
    }
  }

  // Procesar en background
  procesarMensaje(mensaje, remitente, profileName);
});

async function enviarWhatsApp(telefono, mensaje, nombre = null) {
  try {
    let tel = telefono.toString().replace(/\D/g, '');
    if (tel.startsWith('549')) tel = tel.slice(2); // queda 9XXXXXXXXXX
    if (tel.startsWith('54')) tel = tel.slice(2);  // queda XXXXXXXXXX
    const to = `whatsapp:+54${tel}`;
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body: mensaje });
    console.log(`✅ Mensaje enviado a ${to}`);
    guardarMensaje(to, nombre, mensaje, 'agente');
  } catch (err) {
    console.error(`❌ Error enviando a ${telefono}: ${err.message}`);
  }
}

function guardarMensaje(from, nombre, texto, rol) {
  pool.query(
    'INSERT INTO conversaciones (telefono, nombre, rol, texto) VALUES ($1, $2, $3, $4)',
    [from, nombre && nombre !== from ? nombre : null, rol, texto]
  ).catch(err => console.error('Error guardando mensaje en DB:', err.message));
}

async function enviarTemplate(telefono, templateSid, variables, textoGuardar = '[Mensaje automático]') {
  try {
    let tel = telefono.toString().replace(/\D/g, '');
    if (tel.startsWith('549')) tel = tel.slice(2);
    if (tel.startsWith('54')) tel = tel.slice(2);
    const to = `whatsapp:+54${tel}`;

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      contentSid: templateSid,
      contentVariables: JSON.stringify(variables)
    });
    console.log(`✅ Template enviado a ${to}`);

    const nombre = variables['1'] || null;
    guardarMensaje(to, nombre, textoGuardar, 'agente');
  } catch (err) {
    console.error(`❌ Error enviando template a ${telefono}: ${err.message}`);
  }
}

async function clientesPorGrupo(diaGrupo, tipoJob = 'recordatorio') {
  try {
    const r = await fetch(`${GYM_API}/vencimientos`, {
      headers: { Authorization: `Bearer ${GYM_TOKEN}` }
    });
    const data = await r.json();

    // La API devuelve { dia5: [...], dia15: [...], dia25: [...] }
    const key = `dia${diaGrupo}`;
    const clientes = Array.isArray(data) ? data : (data[key] || []);

    console.log(`clientesPorGrupo(${diaGrupo}, ${tipoJob}): ${clientes.length} clientes en ${key}`);

    const PRECIO_PLAN = { 1: 29000, 2: 35000, 3: 39000 };
    const hoy = new Date();

    return clientes
      .filter(c => {
        if (!c.vencimiento) return false;
        if (tipoJob === 'recordatorio') {
          if (c.estado !== 'Vigente') return false;
        } else {
          if (c.estado !== 'Vigente' && c.estado !== 'Vencido') return false;
        }
        const venc = new Date(c.vencimiento + 'T12:00:00');
        const dias = Math.floor((hoy - venc) / (1000 * 60 * 60 * 24));
        c.dias_vencido = dias;

        if (venc.getDate() !== diaGrupo) return false;

        if (tipoJob === 'recordatorio') {
          // Vence mañana o hoy (dias_vencido entre -1 y 0)
          return dias >= -1 && dias <= 0;
        } else if (tipoJob === 'mora') {
          // Venció hace 4-6 días
          return dias >= 4 && dias <= 6;
        } else if (tipoJob === 'suspension') {
          // Venció hace 9-11 días
          return dias >= 9 && dias <= 11;
        }
        return false;
      })
      .map(c => {
        c.monto = c.costo ?? PRECIO_PLAN[c.plan] ?? 0;
        return c;
      });
  } catch (err) {
    console.error('Error obteniendo clientes:', err.message);
    return [];
  }
}

// Día 4 → recordatorio grupo 5
cron.schedule('0 13 4 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 5');
  const clientes = await clientesPorGrupo(5, 'recordatorio');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, { "1": c.nombre.split(' ')[0] }, '[Recordatorio de vencimiento]');
  }
});

// Especial: recordatorio grupo 15 — 14 junio 2026 (una sola vez)
cron.schedule('45 13 14 6 *', async () => {
  console.log('🔔 Job especial: recordatorio grupo 15 - hoy 14 junio');
  const clientes = await clientesPorGrupo(15, 'recordatorio');
  for (const c of clientes) {
    const nombre = c.nombre.split(' ')[0];
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, {"1": nombre}, '[Recordatorio de vencimiento]');
  }
});

// Día 14 → recordatorio grupo 15
cron.schedule('0 13 14 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 15');
  const clientes = await clientesPorGrupo(15, 'recordatorio');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, { "1": c.nombre.split(' ')[0] }, '[Recordatorio de vencimiento]');
  }
});

// Día 24 → recordatorio grupo 25
cron.schedule('0 13 24 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 25');
  const clientes = await clientesPorGrupo(25, 'recordatorio');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, { "1": c.nombre.split(' ')[0] }, '[Recordatorio de vencimiento]');
  }
});

// Día 9 → mora grupo 5 (4-6 días sin pagar)
cron.schedule('0 13 9 * *', async () => {
  console.log('🔔 Job: mora grupo 5');
  const clientes = await clientesPorGrupo(5, 'mora');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_MORA, { "1": c.nombre.split(' ')[0] }, '[Aviso de mora]');
  }
});

// Día 19 → mora grupo 15 (4-6 días sin pagar)
cron.schedule('0 13 19 * *', async () => {
  console.log('🔔 Job: mora grupo 15');
  const clientes = await clientesPorGrupo(15, 'mora');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_MORA, { "1": c.nombre.split(' ')[0] }, '[Aviso de mora]');
  }
});

// Día 29 → mora grupo 25 (4-6 días sin pagar)
cron.schedule('0 13 29 * *', async () => {
  console.log('🔔 Job: mora grupo 25');
  const clientes = await clientesPorGrupo(25, 'mora');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_MORA, { "1": c.nombre.split(' ')[0] }, '[Aviso de mora]');
  }
});

function programarSuspensiones(clientes) {
  for (const c of clientes) {
    suspencionesPendientes.set(c.id.toString(), {
      cliente_id: c.id,
      cliente_nombre: c.nombre,
      telefono: c.telefono,
      timestamp: Date.now()
    });
  }
  setTimeout(async () => {
    for (const [cliente_id, datos] of suspencionesPendientes.entries()) {
      if (datos.esperandoConfirmacion) continue;
      await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
        `⚠️ ${datos.cliente_nombre} lleva 10 días sin pagar. ¿Suspendo su servicio?\nRespondé SÍ o NO`);
      suspencionesPendientes.set(cliente_id, { ...datos, esperandoConfirmacion: true });
      break; // enviar de a uno
    }
  }, 60 * 60 * 1000); // 1 hora
}

// Día 15 → 9-11 días vencido grupo 5
cron.schedule('0 13 15 * *', async () => {
  console.log('🔔 Job: suspensión grupo 5');
  const clientes = await clientesPorGrupo(5, 'suspension');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_SUSPENSION, { "1": c.nombre.split(' ')[0] }, '[Aviso de suspensión]');
  }
  programarSuspensiones(clientes);
});

// Día 25 → 9-11 días vencido grupo 15
cron.schedule('0 13 25 * *', async () => {
  console.log('🔔 Job: suspensión grupo 15');
  const clientes = await clientesPorGrupo(15, 'suspension');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_SUSPENSION, { "1": c.nombre.split(' ')[0] }, '[Aviso de suspensión]');
  }
  programarSuspensiones(clientes);
});

// Día 5 → 9-11 días vencido grupo 25
cron.schedule('0 13 5 * *', async () => {
  console.log('🔔 Job: suspensión grupo 25');
  const clientes = await clientesPorGrupo(25, 'suspension');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_SUSPENSION, { "1": c.nombre.split(' ')[0] }, '[Aviso de suspensión]');
  }
  programarSuspensiones(clientes);
});

// Job cumpleaños — todos los días a las 9am
cron.schedule('0 12 * * *', async () => {
  console.log('🎂 Job: cumpleaños');
  try {
    const r = await fetch(`${GYM_API}/cumpleanos`, {
      headers: { Authorization: `Bearer ${GYM_TOKEN}` }
    });
    const data = await r.json();

    const hoy = new Date();
    const diaHoy = hoy.getDate();
    const mesHoy = hoy.getMonth() + 1;

    const cumpleanosHoy = data.filter(c => {
      if (!c.fecha_nacimiento) return false;
      const fecha = new Date(c.fecha_nacimiento + 'T12:00:00');
      return fecha.getDate() === diaHoy && (fecha.getMonth() + 1) === mesHoy;
    });

    for (const c of cumpleanosHoy) {
      await enviarTemplate(c.telefono, process.env.TEMPLATE_CUMPLEANOS, { "1": c.nombre.split(' ')[0] }, '[Feliz cumpleaños]');
      await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
        `🎂 Hoy es el cumpleaños de ${c.nombre}! No olvides saludarlo/a desde tu celular personal 🏑`);
    }

    console.log(`🎂 Cumpleaños enviados: ${cumpleanosHoy.length}`);
  } catch (err) {
    console.error('Error en job cumpleaños:', err.message);
  }
});

// Informe diario a las 23hs
cron.schedule('0 2 * * *', async () => {
  try {
    const fechaHoy = new Date().toISOString().split('T')[0];
    const result = await pool.query('SELECT * FROM actividad_dia WHERE fecha = $1', [fechaHoy]);
    const actividad = result.rows[0] || { mensajes_atendidos: 0, nuevos_clientes: [], pagos_registrados: [], turnos_cambiados: [] };

    const hoy = new Date().toLocaleDateString('es-AR');
    let informe = `📊 *Informe del día — ${hoy}*\n\n`;

    informe += `💬 Mensajes atendidos: ${actividad.mensajes_atendidos}\n\n`;

    if (actividad.nuevos_clientes.length > 0) {
      informe += `✅ Nuevos clientes (${actividad.nuevos_clientes.length}):\n`;
      actividad.nuevos_clientes.forEach(n => informe += `• ${n}\n`);
      informe += '\n';
    } else {
      informe += `✅ Nuevos clientes: ninguno\n\n`;
    }

    if (actividad.pagos_registrados.length > 0) {
      const total = actividad.pagos_registrados.reduce((sum, p) => sum + p.monto, 0);
      informe += `💰 Pagos registrados (${actividad.pagos_registrados.length}) — Total: $${total.toLocaleString('es-AR')}:\n`;
      actividad.pagos_registrados.forEach(p => informe += `• ${p.nombre}: $${p.monto.toLocaleString('es-AR')}\n`);
      informe += '\n';
    } else {
      informe += `💰 Pagos registrados: ninguno\n\n`;
    }

    if (actividad.turnos_cambiados.length > 0) {
      informe += `🔄 Cambios de turno (${actividad.turnos_cambiados.length}):\n`;
      actividad.turnos_cambiados.forEach(n => informe += `• ${n}\n`);
      informe += '\n';
    } else {
      informe += `🔄 Cambios de turno: ninguno\n\n`;
    }

    informe += `_Hasta mañana Cosaco! 🏑_`;

    await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''), informe);
    console.log('📊 Informe diario enviado a Cosaco');
  } catch (err) {
    console.error('Error en cron informe diario:', err.message);
  }
});

// Panel de conversaciones
app.get('/panel', async (req, res) => {
  try {
    // Obtener última fila por teléfono (último mensaje + nombre más reciente no nulo)
    const { rows: hilos } = await pool.query(`
      SELECT
        c.telefono,
        COALESCE(
          (SELECT nombre FROM conversaciones n WHERE n.telefono = c.telefono AND n.nombre IS NOT NULL ORDER BY n.timestamp DESC LIMIT 1),
          c.telefono
        ) AS nombre,
        c.texto   AS ultimo_texto,
        c.rol     AS ultimo_rol,
        c.timestamp AS ultimo_timestamp
      FROM conversaciones c
      WHERE c.id = (
        SELECT id FROM conversaciones sub
        WHERE sub.telefono = c.telefono
        ORDER BY sub.timestamp DESC LIMIT 1
      )
      ORDER BY c.timestamp DESC
    `);

    function tiempoRelativo(ts) {
      const diff = Date.now() - new Date(ts).getTime();
      const min = Math.floor(diff / 60000);
      if (min < 1) return 'ahora';
      if (min < 60) return `hace ${min}m`;
      const hs = Math.floor(min / 60);
      if (hs < 24) return `hace ${hs}h`;
      return `hace ${Math.floor(hs / 24)}d`;
    }

    const listaHTML = hilos.map(h => {
      const preview = (h.ultimo_texto || '').slice(0, 60) + ((h.ultimo_texto || '').length > 60 ? '…' : '');
      const nombreEsc = h.nombre.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const telefonoEsc = h.telefono.replace(/'/g, "\\'");
      return `<div class="hilo" onclick="abrirHilo('${telefonoEsc}')">
        <div class="hilo-nombre">${nombreEsc}</div>
        <div class="hilo-preview">${preview.replace(/</g, '&lt;')}</div>
        <div class="hilo-tiempo">${tiempoRelativo(h.ultimo_timestamp)}</div>
      </div>`;
    }).join('');

    const hilosMetaJSON = JSON.stringify(
      hilos.map(h => ({ telefono: h.telefono, nombre: h.nombre }))
    ).replace(/</g, '\\u003c');

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Panel de Conversaciones</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; height: 100dvh; overflow: hidden; }

    /* ── Desktop layout ── */
    .app { display: flex; height: 100dvh; max-width: 900px; margin: 0 auto; background: #fff; }

    .sidebar { width: 340px; min-width: 340px; border-right: 1px solid #e0e0e0; display: flex; flex-direction: column; }
    .sidebar-header { background: #075e54; color: #fff; padding: 16px; font-size: 18px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
    .btn-actividad { background: #054d44; color: #fff; text-decoration: none; font-size: 13px; font-weight: 600; padding: 5px 11px; border-radius: 6px; white-space: nowrap; }
    .hilos { overflow-y: auto; flex: 1; -webkit-overflow-scrolling: touch; }
    .hilo { padding: 14px 16px; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
    .hilo:active, .hilo.activo { background: #f5f5f5; }
    .hilo-nombre { font-weight: 600; font-size: 15px; color: #111; }
    .hilo-preview { font-size: 13px; color: #667; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hilo-tiempo { font-size: 11px; color: #999; margin-top: 2px; }

    .chat { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .chat-header { background: #075e54; color: #fff; padding: 14px 16px; font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .btn-volver { display: none; background: none; border: none; color: #fff; font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; }
    .chat-header-nombre { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mensajes { flex: 1; overflow-y: auto; padding: 16px; background: #e5ddd5; -webkit-overflow-scrolling: touch; }
    .mensajes-wrap { display: flex; flex-direction: column; }
    .msg { max-width: 75%; margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4; word-wrap: break-word; }
    .msg.cliente { background: #fff; align-self: flex-start; border-radius: 0 8px 8px 8px; }
    .msg.agente, .msg.agente-cosaco { background: #dcf8c6; align-self: flex-end; margin-left: auto; border-radius: 8px 0 8px 8px; }
    .msg-rol { font-size: 10px; color: #999; margin-bottom: 2px; }
    .msg-time { font-size: 10px; color: #999; margin-top: 4px; text-align: right; }
    .input-area { padding: 10px 16px; background: #f0f2f5; display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
    .input-area input { flex: 1; padding: 10px 14px; border-radius: 24px; border: none; font-size: 16px; outline: none; }
    .input-area button { background: #075e54; color: #fff; border: none; border-radius: 50%; width: 42px; height: 42px; min-width: 42px; font-size: 18px; cursor: pointer; }
    .placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: #999; font-size: 15px; }

    /* ── Mobile layout ── */
    @media (max-width: 768px) {
      .app { max-width: 100vw; }

      .sidebar {
        position: fixed; inset: 0;
        width: 100vw; min-width: 0;
        z-index: 10;
        transform: translateX(0);
        transition: transform 0.25s ease;
      }
      .sidebar.oculto {
        transform: translateX(-100%);
        pointer-events: none;
      }

      .chat {
        position: fixed; inset: 0;
        width: 100vw;
        z-index: 10;
        transform: translateX(100%);
        transition: transform 0.25s ease;
      }
      .chat.visible {
        transform: translateX(0);
      }

      .btn-volver { display: block; }

      .input-area {
        position: sticky; bottom: 0;
        padding-bottom: max(10px, env(safe-area-inset-bottom));
      }
    }
  </style>
</head>
<body>
<div class="app">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <span>Conversaciones</span>
      <a class="btn-actividad" href="/panel/actividad">📊 Actividad</a>
    </div>
    <div class="hilos">${listaHTML}</div>
  </div>
  <div class="chat" id="chat">
    <div class="chat-header">
      <button class="btn-volver" id="btn-volver" onclick="volverALista()">←</button>
      <span class="chat-header-nombre" id="chat-header">Seleccioná una conversación</span>
    </div>
    <div class="mensajes" id="mensajes"><div class="placeholder">← Seleccioná una conversación</div></div>
    <div class="input-area" id="input-area" style="display:none">
      <input type="text" id="msg-input" placeholder="Escribí un mensaje..." onkeydown="if(event.key==='Enter')enviar()">
      <button onclick="enviar()">➤</button>
    </div>
  </div>
</div>
<script>
  const hilosMeta = ${hilosMetaJSON};
  let telefonoActual = null;
  let nombreActual = null;
  const isMobile = () => window.innerWidth <= 768;

  async function abrirHilo(telefono) {
    telefonoActual = telefono;
    const meta = hilosMeta.find(x => x.telefono === telefono);
    nombreActual = meta ? meta.nombre : telefono;
    document.querySelectorAll('.hilo').forEach(el => el.classList.remove('activo'));
    event.currentTarget.classList.add('activo');
    document.getElementById('chat-header').textContent = nombreActual;
    document.getElementById('mensajes').innerHTML = '<div class="placeholder">Cargando...</div>';

    if (isMobile()) {
      document.getElementById('sidebar').classList.add('oculto');
      document.getElementById('chat').classList.add('visible');
    }

    const r = await fetch('/panel/hilo?telefono=' + encodeURIComponent(telefono));
    const data = await r.json();

    const wrap = document.createElement('div');
    wrap.className = 'mensajes-wrap';
    (data.mensajes || []).forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg ' + m.rol;
      const hora = new Date(m.timestamp).toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'});
      div.innerHTML = (m.rol !== 'cliente' ? '<div class="msg-rol">' + (m.rol === 'agente-cosaco' ? 'Cosaco' : 'Agente') + '</div>' : '') +
        '<div>' + m.texto.replace(/\\n/g, '<br>') + '</div>' +
        '<div class="msg-time">' + hora + '</div>';
      wrap.appendChild(div);
    });
    const cont = document.getElementById('mensajes');
    cont.innerHTML = '';
    cont.appendChild(wrap);
    cont.scrollTop = cont.scrollHeight;
    document.getElementById('input-area').style.display = 'flex';
  }

  function volverALista() {
    document.getElementById('chat').classList.remove('visible');
    document.getElementById('sidebar').classList.remove('oculto');
    telefonoActual = null;
  }

  async function enviar() {
    const input = document.getElementById('msg-input');
    const texto = input.value.trim();
    if (!texto || !telefonoActual) return;
    input.value = '';
    const r = await fetch('/panel/enviar', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ telefono: telefonoActual, mensaje: texto })
    });
    const data = await r.json();
    if (data.ok) location.reload();
  }
</script>
</body>
</html>`);
  } catch (err) {
    console.error('Error en GET /panel:', err.message);
    res.status(500).send('Error cargando el panel: ' + err.message);
  }
});

// Hilo completo de una conversación desde PostgreSQL
app.get('/panel/hilo', async (req, res) => {
  const { telefono } = req.query;
  if (!telefono) return res.status(400).json({ error: 'Falta telefono' });
  try {
    const { rows } = await pool.query(
      'SELECT rol, texto, timestamp FROM conversaciones WHERE telefono = $1 ORDER BY timestamp ASC',
      [telefono]
    );
    res.json({ mensajes: rows });
  } catch (err) {
    console.error('Error en GET /panel/hilo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historial de actividad diaria
app.get('/panel/actividad', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT fecha, mensajes_atendidos, nuevos_clientes, pagos_registrados, turnos_cambiados
       FROM actividad_dia
       ORDER BY fecha DESC
       LIMIT 30`
    );

    const diasHTML = rows.map(row => {
      const fecha = new Date(row.fecha + 'T12:00:00').toLocaleDateString('es-AR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
      const nuevos = row.nuevos_clientes || [];
      const pagos  = row.pagos_registrados || [];
      const turnos = row.turnos_cambiados || [];
      const total  = pagos.reduce((s, p) => s + (p.monto || 0), 0);

      const liNuevos = nuevos.length
        ? nuevos.map(n => `<li>${n}</li>`).join('')
        : '<li class="vacio">Ninguno</li>';

      const liPagos = pagos.length
        ? pagos.map(p => `<li><span class="pago-nombre">${p.nombre}</span><span class="pago-monto">$${Number(p.monto).toLocaleString('es-AR')}</span></li>`).join('')
        : '<li class="vacio">Ninguno</li>';

      const liTurnos = turnos.length
        ? turnos.map(n => `<li>${n}</li>`).join('')
        : '<li class="vacio">Ninguno</li>';

      const totalHTML = pagos.length
        ? `<div class="total-dia">Total cobrado: <strong>$${total.toLocaleString('es-AR')}</strong></div>`
        : '';

      return `<div class="dia-card">
  <div class="dia-header">
    <span class="dia-fecha">${fecha}</span>
    <span class="dia-badge">${row.mensajes_atendidos} mensaje${row.mensajes_atendidos !== 1 ? 's' : ''}</span>
  </div>
  <div class="dia-body">
    <div class="seccion">
      <div class="seccion-titulo">✅ Nuevos clientes (${nuevos.length})</div>
      <ul>${liNuevos}</ul>
    </div>
    <div class="seccion">
      <div class="seccion-titulo">💰 Pagos registrados (${pagos.length})</div>
      <ul>${liPagos}</ul>
      ${totalHTML}
    </div>
    <div class="seccion">
      <div class="seccion-titulo">🔄 Cambios de turno (${turnos.length})</div>
      <ul>${liTurnos}</ul>
    </div>
  </div>
</div>`;
    }).join('');

    const contenido = rows.length
      ? diasHTML
      : '<div class="empty">No hay actividad registrada aún.</div>';

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Actividad Diaria — Hockey Vivo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; }
    header { background: #075e54; color: #fff; padding: 16px 20px; display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 10; }
    header a { color: #fff; text-decoration: none; font-size: 20px; line-height: 1; }
    header h1 { font-size: 18px; font-weight: 600; }
    .container { max-width: 720px; margin: 0 auto; padding: 20px 16px 40px; }
    .dia-card { background: #fff; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08); overflow: hidden; }
    .dia-header { background: #075e54; color: #fff; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
    .dia-fecha { font-weight: 600; font-size: 15px; text-transform: capitalize; }
    .dia-badge { background: rgba(255,255,255,.2); border-radius: 20px; padding: 3px 10px; font-size: 12px; white-space: nowrap; }
    .dia-body { padding: 14px 16px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
    .seccion { }
    .seccion-titulo { font-size: 12px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 6px; }
    ul { list-style: none; padding: 0; }
    ul li { font-size: 14px; color: #222; padding: 2px 0; }
    ul li.vacio { color: #aaa; font-style: italic; }
    .pago-nombre { display: block; }
    .pago-monto { display: block; font-weight: 600; color: #075e54; font-size: 13px; }
    .total-dia { margin-top: 8px; font-size: 13px; color: #333; border-top: 1px solid #eee; padding-top: 6px; }
    .empty { text-align: center; color: #999; padding: 60px 0; font-size: 15px; }
    @media (max-width: 540px) {
      .dia-body { grid-template-columns: 1fr; }
      .dia-header { flex-direction: column; align-items: flex-start; gap: 4px; }
    }
  </style>
</head>
<body>
<header>
  <a href="/panel" title="Volver">&#8592;</a>
  <h1>Actividad Diaria</h1>
</header>
<div class="container">
  ${contenido}
</div>
</body>
</html>`);
  } catch (err) {
    console.error('Error en GET /panel/actividad:', err.message);
    res.status(500).send('Error cargando actividad: ' + err.message);
  }
});

app.post('/panel/enviar', async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: 'Faltan telefono o mensaje' });
  try {
    let tel = telefono.toString().replace(/\D/g, '');
    if (tel.startsWith('549')) tel = tel.slice(2);
    if (tel.startsWith('54')) tel = tel.slice(2);
    const to = `whatsapp:+54${tel}`;
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body: mensaje });
    guardarMensaje(to, null, mensaje, 'agente-cosaco');
    res.json({ ok: true });
  } catch (err) {
    console.error('Error enviando desde panel:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  initDB().catch(err => console.error('Error inicializando DB:', err.message));
  loginConReintentos().catch(() => {});
});
