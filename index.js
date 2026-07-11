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

    CREATE TABLE IF NOT EXISTS suspensiones_pendientes (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL,
      cliente_nombre VARCHAR(200),
      telefono VARCHAR(50),
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      esperando_confirmacion BOOLEAN DEFAULT FALSE,
      notificado_cosaco BOOLEAN DEFAULT FALSE
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

    CREATE TABLE IF NOT EXISTS telefono_cliente (
      telefono VARCHAR(50) PRIMARY KEY,
      cliente_id INTEGER NOT NULL,
      cliente_nombre VARCHAR(200),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

  `);
  await pool.query(`
    ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS content_json JSONB;
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
    console.error('Error registrarActividad:', tipo, dato, err.message);
  }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const GYM_API = 'https://hockeyvivo.up.railway.app';
let GYM_TOKEN = null;

const TWILIO_FROM = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith('whatsapp:')
  ? process.env.TWILIO_WHATSAPP_NUMBER
  : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

// Historial conversacional persistido en PostgreSQL

// Pagos pendientes de confirmación → persisten en tabla pagos_pendientes (PostgreSQL)

// Suspensiones pendientes de confirmación por Cosaco
// clave: cliente_id como string, valor: { cliente_id, cliente_nombre, telefono, timestamp, esperandoConfirmacion }

// Becas pendientes de confirmación por Cosaco
const becasPendientes = new Map();
// clave: cliente_from (whatsapp del cliente), valor: { cliente_id, cliente_nombre, cliente_from, costo, plan, tipo_beca?, monto_final? }


async function getHistorial(from) {
  const result = await pool.query(
    `SELECT rol, texto, content_json FROM conversaciones
     WHERE telefono = $1 AND rol IN ('cliente', 'agente', 'tool_use', 'tool_result')
     ORDER BY timestamp DESC LIMIT 20`,
    [from]
  );
  return result.rows.reverse().map(row => ({
    role: (row.rol === 'cliente' || row.rol === 'tool_result') ? 'user' : 'assistant',
    content: row.content_json ?? row.texto,
  }));
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

function calcularFechaInicio(cliente) {
  const hoy = new Date().toISOString().split('T')[0];
  if (cliente.estado === 'Suspendido' || !cliente.fecha_vencimiento) return hoy;
  return cliente.fecha_vencimiento;
}

function calcularFechaVencimiento(fecha_pago, fecha_vencimiento_actual) {
  if (fecha_vencimiento_actual) {
    // Sumar exactamente 1 mes a la fecha de vencimiento anterior
    const venc = new Date(fecha_vencimiento_actual + 'T12:00:00');
    const nuevaFecha = new Date(venc.getFullYear(), venc.getMonth() + 1, venc.getDate());
    return nuevaFecha.toISOString().split('T')[0];
  }
  // Cliente nuevo: calcular grupo desde fecha_pago
  const fecha = new Date(fecha_pago + 'T12:00:00');
  const dia = fecha.getDate();
  let diaVencimiento;
  let mesesAdelante;
  if (dia >= 6 && dia <= 15) {
    diaVencimiento = 15;
    mesesAdelante = 1;
  } else if (dia >= 16 && dia <= 25) {
    diaVencimiento = 25;
    mesesAdelante = 1;
  } else {
    diaVencimiento = 5;
    mesesAdelante = dia >= 26 ? 2 : 1;
  }
  const vencimiento = new Date(fecha.getFullYear(), fecha.getMonth() + mesesAdelante, diaVencimiento);
  return vencimiento.toISOString().split('T')[0];
}

const SYSTEM_PROMPT = `Sos el asistente virtual del gimnasio Hockey Vivo en Santiago del Estero, Argentina. Atendés consultas de clientes y potenciales alumnos por WhatsApp. Respondés en español argentino, de forma amable y breve. Usá emojis con moderación.

IDENTIFICACIÓN DEL CLIENTE:
Al inicio de cada conversación el sistema intenta identificar automáticamente al cliente por su número de teléfono.
Si el cliente ya está identificado (se te indica en el contexto), usá su nombre directamente sin pedírselo.
Si no está identificado pero durante la conversación el cliente menciona su nombre y lo encontrás con get_clientes, llamá inmediatamente guardar_telefono_cliente con su número de teléfono (el remitente del mensaje), cliente_id y cliente_nombre para recordarlo en el futuro.
Si no lo encontrás, tratalo como cliente nuevo.

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

TURNOS Y CUPOS DISPONIBLES:
NUNCA muestres ni inventes horarios de turnos disponibles.
Cuando alguien pregunte por turnos disponibles, cupos, horarios libres, o si un turno está lleno:
Siempre respondé: 'Para ver todos los turnos y cupos disponibles en tiempo real, entrá acá 👇
🔗 https://hockeyvivo.up.railway.app/cupos
Si el turno que querés está lleno, podés anotarte en lista de espera desde esa misma página y te avisamos cuando se libere un lugar 🏑'

NO uses get_turnos para mostrar disponibilidad al cliente. Solo usá get_turnos internamente cuando necesites el ID de un turno para asignarlo.

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

6. Si registrar_cliente_y_asignar_turno devuelve ok: false:
   - Decile al cliente: "Ya tomamos nota de tu solicitud, en breve te confirmamos tu lugar 🏑"
   - Usá enviar_mensaje_a_cosaco para avisarme: "⚠️ Error al registrar a [nombre]: [error]. Revisalo y avisame para confirmarle al cliente."
   - NO mencionar ningún error al cliente.

CUANDO PIDAN UBICACIÓN O DIRECCIÓN:
Dar la dirección y el link: https://maps.google.com/?q=-27.785810,-64.268463

FLUJO DE PAGOS - OBLIGATORIO:

Paso 1: Si el cliente menciona que pagó, pedí nombre si no lo sabés.
Paso 2: Pedí método de pago si no lo mencionó.
Paso 3: Cuando tengas nombre Y método → buscá con get_clientes.
Paso 4: INMEDIATAMENTE llamá consultar_pago_a_cosaco. ESTE PASO ES OBLIGATORIO Y NO SE PUEDE SALTEAR.
Paso 5: Decile al cliente EXACTAMENTE esto: 'Gracias! Ya le avisé al equipo para confirmar tu pago. En breve te avisamos 🏑'

PROHIBIDO:
- NUNCA decir 'quedó registrado', 'registré tu pago', 'listo' o similar sin haber llamado consultar_pago_a_cosaco
- NUNCA saltear el paso 4
- Si consultar_pago_a_cosaco no está disponible, decile al cliente que se comunique directamente con el equipo

RECORDÁ: vos no registrás pagos. Solo Cosaco puede confirmar y registrar pagos.
La fecha de pago se calcula automáticamente (no la pidas al cliente): si el cliente está Suspendido o no tiene fecha de vencimiento, se usa la fecha de hoy; si está Vigente, se usa su última fecha de vencimiento.

CUANDO REGISTRES O ASIGNES TURNOS (cliente nuevo o existente):
Al confirmar, siempre incluí un resumen de TODOS los turnos asignados actualmente. Usá get_turnos para obtener los nombres y horarios, y mostrá el mensaje así:

"¡Todo listo [nombre]! Ya quedaste registrado/a en Hockey Vivo 🏑

Tus turnos asignados:
📅 [Día] [Horario]
📅 [Día] [Horario]

Si querés cambiar o agregar algún día, avisame acá mismo. ¡Te esperamos en el entrenamiento! 🏑"

Siempre mostrá día y horario de cada turno, nunca solo el ID.

PALABRA 'SACAR':
Cuando un cliente use la palabra 'sacar' en relación a turnos, SIEMPRE preguntá antes de actuar:
'Cuando decís sacar, ¿te referís a:
1️⃣ Eliminar un turno que ya tenés
2️⃣ Conseguir (agregar) un turno nuevo
¿Cuál es tu caso?'

CAMBIO DE TURNOS - FLUJO OBLIGATORIO:
Cuando un cliente confirme un cambio de turno (responda 'Si', 'Sí', 'Confirmo', 'Dale', etc.):
1. SIEMPRE llamá gestionar_turnos_cliente ANTES de responder
2. Pasá turno_ids_quitar con el ID del turno actual
3. Pasá turno_ids_agregar con el ID del turno nuevo
4. Solo confirmá el cambio DESPUÉS de que la tool devuelva éxito
5. Si la tool falla, avisá que hubo un error y contactá a Cosaco

NUNCA confirmes un cambio de turno sin haber llamado gestionar_turnos_cliente primero.

CUANDO UN CLIENTE MENCIONE QUE TIENE BECA O DESCUENTO:
1. Respondele: "Perfecto, dejame confirmarlo con el equipo y te avisamos en breve 🏑"
2. Usá get_clientes para obtener el ID y datos del cliente
3. Usá la tool consultar_beca_a_cosaco para notificar a Cosaco
No uses registrar_pago hasta que la beca esté confirmada y el cliente avise que pagó.

MODO SECRETARIO — cuando Cosaco escribe directamente:
Sos su asistente administrativo personal. Podés hacer todo lo que haría un secretario:

REGLAS DE ENVÍO DE MENSAJES - OBLIGATORIO:
Cuando Cosaco pida enviar cualquier mensaje a un cliente, SIEMPRE usá la tool correspondiente con su template. NUNCA escribas el mensaje vos mismo con texto libre.

- Recordatorio de vencimiento → tool: enviar_mensaje_cliente con template_tipo: 'recordatorio'
- Aviso de mora → tool: enviar_mensaje_cliente con template_tipo: 'mora'
- Mensaje de suspensión → tool: enviar_mensaje_cliente con template_tipo: 'suspension'
- Seguimiento clase de prueba → tool: enviar_clase_prueba con TEMPLATE_CLASE_PRUEBA
- Mensaje general → tool: enviar_mensaje_cliente con template_tipo: 'general'
- Mensaje masivo por día → tool: enviar_mensaje_masivo

NUNCA uses enviarWhatsApp directo ni escribas mensajes propios. SIEMPRE tools con templates.

1. ENVIAR MENSAJES A CLIENTES:
Si Cosaco dice "mandále un mensaje a [nombre] diciéndole [texto]":
- Buscá al cliente con get_clientes
- Enviá el mensaje con enviar_mensaje_cliente usando template_tipo adecuado
- Confirmale a Cosaco: "✅ Mensaje enviado a [nombre]"

CLASE DE PRUEBA:
Cuando Cosaco pida mandar el mensaje de seguimiento de clase de prueba a un cliente, usá SIEMPRE la tool enviar_clase_prueba, nunca enviar_mensaje_cliente.

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

MENSAJES MASIVOS:
Para enviar mensajes masivos a clientes de un día específico, SIEMPRE usá la tool enviar_mensaje_masivo. NUNCA confirmes que enviaste mensajes sin haber llamado esta tool primero.

SI NO PODÉS RESOLVER ALGO:
Decí: "Te paso con el equipo de Hockey Vivo, en breve te contactamos 🏑"

INTENCIÓN DE PAGO vs PAGO REALIZADO:
- 'Quiero pagar', 'quisiera abonar', 'me gustaría pagar', 'quiero hacer un pago' → es INTENCIÓN FUTURA.
  Respondé: '¡Perfecto! Podés hacerlo por transferencia al alias hockeyvivo o en efectivo en el gimnasio. ¿Ya lo realizaste o todavía no?'
- Solo si el cliente confirma que YA pagó → iniciá el flujo de confirmación de pago
- 'Pagué', 'ya pagué', 'transferí', 'hice el pago', manda comprobante → PAGO REALIZADO. Iniciá confirmación.

BÚSQUEDA DE CLIENTES POR NOMBRE:
Cuando alguien mencione un nombre de cliente (completo, parcial, apodo o solo apellido):

1. Usá get_clientes con el parámetro buscar usando SOLO la parte más distintiva del nombre.
   Ejemplos:
   - 'Sofia Rubio' → buscar: 'Rubio'
   - 'Emi Paz' → buscar: 'Paz'
   - 'la de Medina' → buscar: 'Medina'
   - 'Emi' → buscar: 'Emi'

2. Si encontrás UN SOLO cliente cuyo nombre contenga alguna de las palabras mencionadas → confirmá:
   '¿Me estás hablando de [nombre completo]?'

3. Si encontrás VARIOS clientes → mostrá las opciones:
   '¿De cuál me hablás?
   • Sofia Aldana Rubio
   • Sofia Rubio Martinez'

4. Si no encontrás nada → buscá con otra palabra del nombre e intentá de nuevo antes de pedir aclaración.

5. NUNCA asumas que el nombre es exacto. Siempre confirmá antes de hacer cualquier acción (registrar pago, cambiar turno, etc.)

6. Para apodos comunes: Emi/Emilia, Vicky/Victoria, Caro/Carolina, Sofi/Sofia, Luci/Luciana, Valen/Valentina, Nati/Natalia, Flor/Florencia — buscá ambas versiones si la primera no da resultados.

CUANDO NO ENTIENDAS UN MENSAJE:
Si el cliente manda algo confuso o que no tiene sentido, respondé:
'No entiendo bien lo que necesitás 😅 Si escribís *menu* te muestro todo lo que puedo hacer por vos 🏑'

CUANDO EL CLIENTE ESCRIBA 'menu' o 'MENU':
Respondé exactamente esto:
'¡Hola! 👋 Esto es lo que puedo hacer por vos:

1️⃣ *Registrar un pago* — avisame que pagaste y el monto
2️⃣ *Ver o cambiar turnos* — consultá o modificá tus horarios
3️⃣ *Información del gimnasio* — horarios, precios, ubicación
4️⃣ *Inscribirte* — si sos nuevo/a y querés empezar
5️⃣ *Hablar con el equipo* — te contactamos personalmente

¿En qué te ayudo? 🏑'`;

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
    description: 'Envía un mensaje de WhatsApp a un cliente usando el template correspondiente. Usá template_tipo para seleccionar el template correcto según el tipo de mensaje.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente' },
        mensaje: { type: 'string', description: 'Texto del mensaje a enviar' },
        template_tipo: {
          type: 'string',
          enum: ['recordatorio', 'mora', 'suspension', 'general'],
          description: 'Tipo de template a usar: recordatorio (vencimiento), mora (deuda), suspension (baja), general (mensaje libre)',
        },
      },
      required: ['cliente_id', 'mensaje'],
    },
  },
  {
    name: 'enviar_clase_prueba',
    description: 'Envía el mensaje de seguimiento de clase de prueba a un cliente. Usá SIEMPRE esta tool cuando Cosaco pida mandar el mensaje de seguimiento de clase de prueba, nunca enviar_mensaje_cliente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente' },
      },
      required: ['cliente_id'],
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
  {
    name: 'enviar_mensaje_masivo',
    description: 'Envía un mensaje masivo a todos los clientes de un día específico de la semana. Usá esta tool cuando Cosaco quiera comunicarse con todos los alumnos de un día.',
    input_schema: {
      type: 'object',
      properties: {
        dia_semana: { type: 'string', description: 'Día de la semana en minúsculas: lunes, martes, miercoles, jueves, viernes' },
        mensaje: { type: 'string', description: 'Texto del mensaje a enviar a los clientes' },
      },
      required: ['dia_semana', 'mensaje'],
    },
  },
  {
    name: 'gestionar_turnos_cliente',
    description: 'Agrega o quita turnos a un cliente existente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente_id: { type: 'integer', description: 'ID del cliente' },
        turno_ids_agregar: { type: 'array', items: { type: 'integer' }, description: 'IDs de turnos a agregar' },
        turno_ids_quitar: { type: 'array', items: { type: 'integer' }, description: 'IDs de turnos a quitar' },
      },
      required: ['cliente_id'],
    },
  },
  {
    name: 'guardar_telefono_cliente',
    description: 'Guarda el mapeo entre el número de teléfono del remitente actual y un cliente identificado durante la conversación. Llamar siempre que se identifique a un cliente por nombre.',
    input_schema: {
      type: 'object',
      properties: {
        telefono: { type: 'string', description: 'Número de teléfono del remitente (formato whatsapp:+549XXXXXXXXXX)' },
        cliente_id: { type: 'integer', description: 'ID del cliente en el sistema' },
        cliente_nombre: { type: 'string', description: 'Nombre completo del cliente' },
      },
      required: ['telefono', 'cliente_id', 'cliente_nombre'],
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
        if (!rNuevo.ok) return { ok: false, error: `No se pudo crear el cliente: ${await rNuevo.text()}` };

        const nuevoCliente = await rNuevo.json();
        const { asignados, errores } = await asignarTurnos(nuevoCliente.id, input.turno_ids);
        if (errores.length > 0) {
          return { ok: false, error: `Cliente creado pero no se pudo asignar turno ${errores.join(', ')}` };
        }
        registrarActividad('cliente', nombreCompleto);
        return {
          ok: true,
          nuevo: true,
          cliente_id: nuevoCliente.id,
          nombre: nombreCompleto,
          turnos_asignados: asignados,
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
        if (errores.length > 0) {
          return { ok: false, error: `Cliente creado pero no se pudo asignar turno ${errores.join(', ')}` };
        }
        registrarActividad('cliente', nombreExistente);
        return {
          ok: true,
          bienvenida_vuelta: true,
          cliente_id,
          nombre: nombreExistente,
          turnos_asignados: asignados,
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
      const data = await r.json();
      const turnos = Array.isArray(data) ? data : [];

      // Devolver solo los campos necesarios, sin la lista de alumnos
      return turnos.map(t => ({
        id: t.id,
        dia_semana: t.dia_semana,
        hora_inicio: t.hora_inicio,
        nivel: t.nivel,
        cupo_maximo: t.cupo_maximo,
        cupo_usado: t.cupo_usado,
        disponible: t.cupo_usado < t.cupo_maximo
      }));
    }

    if (nombre === 'get_clientes') {
      const params = new URLSearchParams();
      if (input.estado) params.append('estado', input.estado);

      // Búsqueda por teléfono: limpiar prefijos 549/54 y usar últimos 8 dígitos
      if (input.buscar && input.buscar.match(/^\d+$/)) {
        let tel = input.buscar.replace(/^549/, '').replace(/^54/, '');
        tel = tel.slice(-8);
        params.set('buscar', tel);
      } else if (input.buscar) {
        params.append('buscar', input.buscar);
      }

      const buscarClientes = async (termino) => {
        const p = new URLSearchParams();
        if (input.estado) p.append('estado', input.estado);
        p.append('buscar', termino);
        const r = await fetch(`${GYM_API}/clientes?${p.toString()}`, { headers });
        const d = await r.json();
        return Array.isArray(d) ? d : [];
      };

      // 1. Búsqueda con término original (o teléfono limpio)
      const r = await fetch(`${GYM_API}/clientes?${params.toString()}`, { headers });
      const data = await r.json();
      let resultados = Array.isArray(data) ? data : [];
      if (resultados.length > 0) return resultados;

      if (input.buscar && !input.buscar.match(/^\d+$/)) {
        const sinAcentos = input.buscar
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

        // 2. Buscar sin acentos (término completo)
        if (sinAcentos !== input.buscar) {
          resultados = await buscarClientes(sinAcentos);
          if (resultados.length > 0) return resultados;
        }

        // 3. Buscar cada palabra por separado (sin acentos)
        const palabras = sinAcentos.split(' ').filter(p => p.length > 2);
        for (const palabra of palabras) {
          resultados = await buscarClientes(palabra);
          if (resultados.length > 0) return resultados;
        }

        // 4. Buscar con solo las primeras 4 letras de cada palabra
        for (const palabra of palabras) {
          if (palabra.length > 4) {
            resultados = await buscarClientes(palabra.slice(0, 4));
            if (resultados.length > 0) return resultados;
          }
        }
      }

      return resultados;
    }

    if (nombre === 'get_vencimientos') {
      const r = await fetch(`${GYM_API}/vencimientos`, { headers });
      return await r.json();
    }

    if (nombre === 'registrar_pago') {
      const rCliente = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      const hoy = new Date().toISOString().split('T')[0];
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
          fecha_pago: hoy,
          fecha_inicio: calcularFechaInicio(cliente),
          fecha_vencimiento: calcularFechaVencimiento(hoy, cliente.fecha_vencimiento),
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
      const metodo = input.metodo || 'Transferencia';

      // Insertar en DB
      await pool.query(
        `INSERT INTO pagos_pendientes (cliente_id, cliente_nombre, cliente_from, monto, metodo)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.cliente_id, input.cliente_nombre, remitente, input.monto, metodo]
      );

      // Si ya hay otro pago esperando, este queda encolado en DB automáticamente
      const { rows: pendientes } = await pool.query(
        `SELECT COUNT(*) AS count FROM pagos_pendientes WHERE esperando_confirmacion = true`
      );
      const total = parseInt(pendientes[0].count);

      if (total > 1) {
        console.log(`Pago encolado para ${input.cliente_nombre} (posición ${total - 1})`);
        return { ok: true, encolado: true, posicion: total - 1 };
      }

      // Es el único: notificar a Cosaco
      const mensajeCosaco =
        `💰 *Confirmación de pago*\n` +
        `Cliente: ${input.cliente_nombre}\n` +
        `Monto: $${input.monto}\n` +
        `Método: ${metodo}\n` +
        `¿Confirmás este pago? Respondé *SÍ* o *NO*`;

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
        await pool.query(`DELETE FROM pagos_pendientes WHERE cliente_id = $1 AND cliente_from = $2 AND esperando_confirmacion = true ORDER BY id DESC LIMIT 1`, [input.cliente_id, remitente]);
        return { error: `Error enviando mensaje a Cosaco: ${twilioErr.message}` };
      }
      return { ok: true, enviado_a_cosaco: true };
    }

    if (nombre === 'enviar_mensaje_cliente') {
      const rCliente = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      if (!cliente.telefono) return { error: 'El cliente no tiene teléfono registrado' };

      const nombreCliente = cliente.nombre.split(' ')[0];
      const templateMap = {
        recordatorio: process.env.TEMPLATE_RECORDATORIO,
        mora: process.env.TEMPLATE_MORA,
        suspension: process.env.TEMPLATE_SUSPENSION,
        general: process.env.TEMPLATE_MENSAJE_HOCKEYVIVO,
      };
      const templateId = templateMap[input.template_tipo] || process.env.TEMPLATE_MENSAJE_HOCKEYVIVO;
      await enviarTemplate(
        cliente.telefono,
        templateId,
        { "1": nombreCliente, "2": input.mensaje },
        input.mensaje
      );
      return { ok: true, enviado_a: cliente.nombre };
    }

    if (nombre === 'enviar_clase_prueba') {
      const rCliente = await fetch(`${GYM_API}/clientes/${input.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      if (!cliente.telefono) return { error: 'El cliente no tiene teléfono registrado' };

      const nombreCliente = cliente.nombre.split(' ')[0];
      await enviarTemplate(
        cliente.telefono,
        process.env.TEMPLATE_CLASE_PRUEBA,
        { "1": nombreCliente },
        null
      );
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

    if (nombre === 'enviar_mensaje_masivo') {
      const diaNorm = input.dia_semana.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // GET /turnos trae alumnos embebidos (id, nombre, estado) pero sin teléfono
      const [rTurnos, rClientes] = await Promise.all([
        fetch(`${GYM_API}/turnos`, { headers }),
        fetch(`${GYM_API}/clientes`, { headers }),
      ]);
      const turnos = await rTurnos.json();
      const todosClientes = await rClientes.json();

      // Índice id → teléfono para lookup eficiente
      const telefonoPorId = {};
      for (const c of (Array.isArray(todosClientes) ? todosClientes : [])) {
        if (c.id && c.telefono) telefonoPorId[c.id] = c.telefono;
      }

      const turnosDelDia = (Array.isArray(turnos) ? turnos : []).filter(t => {
        const diaTurno = (t.dia_semana || t.dia || t.nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return diaTurno.includes(diaNorm);
      });

      if (turnosDelDia.length === 0) {
        return { ok: false, mensaje: `No se encontraron turnos para el día "${input.dia_semana}"` };
      }

      const enviados = [];
      const sinTelefono = [];
      const yaEnviados = new Set(); // evitar duplicados si un cliente está en varios turnos del día

      for (const turno of turnosDelDia) {
        for (const alumno of (turno.alumnos || [])) {
          if (yaEnviados.has(alumno.id)) continue;
          yaEnviados.add(alumno.id);

          const tel = telefonoPorId[alumno.id];
          if (!tel) { sinTelefono.push(alumno.nombre); continue; }

          const nombreCorto = (alumno.nombre || '').split(' ')[0];
          await enviarTemplate(tel, process.env.TEMPLATE_MENSAJE_HOCKEYVIVO,
            { "1": nombreCorto, "2": input.mensaje }, `[Mensaje masivo] ${input.mensaje}`);
          enviados.push(alumno.nombre);
        }
      }

      console.log(`📢 Mensaje masivo ${input.dia_semana}: ${enviados.length} enviados, ${sinTelefono.length} sin teléfono`);
      return { ok: true, enviados, sin_telefono: sinTelefono };
    }

    if (nombre === 'gestionar_turnos_cliente') {
      const resultados = [];

      for (const turno_id of (input.turno_ids_quitar || [])) {
        const r = await fetch(`${GYM_API}/turnos/${turno_id}/quitar/${input.cliente_id}`, {
          method: 'DELETE',
          headers,
        });
        resultados.push({ accion: 'quitar', turno_id, ok: r.ok, status: r.status });
      }

      for (const turno_id of (input.turno_ids_agregar || [])) {
        const r = await fetch(`${GYM_API}/turnos/${turno_id}/asignar/${input.cliente_id}`, {
          method: 'POST',
          headers,
        });
        resultados.push({ accion: 'agregar', turno_id, ok: r.ok, status: r.status });
      }

      const todoBien = resultados.every(r => r.ok);
      return { ok: todoBien, resultados };
    }

    if (nombre === 'guardar_telefono_cliente') {
      await pool.query(
        `INSERT INTO telefono_cliente (telefono, cliente_id, cliente_nombre)
         VALUES ($1, $2, $3)
         ON CONFLICT (telefono) DO UPDATE SET cliente_id = $2, cliente_nombre = $3, updated_at = NOW()`,
        [input.telefono, input.cliente_id, input.cliente_nombre]
      );
      console.log('Mapeo guardado:', input.telefono, '→', input.cliente_nombre);
      return { ok: true };
    }

    return { error: `Tool desconocida: ${nombre}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function buscarClientePorTelefono(telefono) {
  try {
    // Primero buscar en caché local (telefono_cliente)
    const cached = await pool.query('SELECT * FROM telefono_cliente WHERE telefono = $1', [telefono]);
    if (cached.rows.length > 0) {
      console.log('Cliente encontrado en caché:', cached.rows[0].cliente_nombre);
      return { id: cached.rows[0].cliente_id, nombre: cached.rows[0].cliente_nombre };
    }

    // Limpiar el número
    let tel = telefono.replace(/\D/g, '');

    // Quitar prefijos internacionales
    if (tel.startsWith('549')) tel = tel.slice(3);
    else if (tel.startsWith('54')) tel = tel.slice(2);

    // Intentar con los últimos 10 dígitos
    const tel10 = tel.slice(-10);
    // Intentar con los últimos 8 dígitos (más flexible)
    const tel8 = tel.slice(-8);

    // Búsqueda 1: últimos 10 dígitos
    let r = await fetch(`${GYM_API}/clientes?buscar=${tel10}`, {
      headers: { Authorization: `Bearer ${GYM_TOKEN}` }
    });
    let data = await r.json();
    let clientes = Array.isArray(data) ? data : [];

    if (clientes.length > 0) {
      console.log('Cliente encontrado con tel10:', clientes[0].nombre);
      return clientes[0];
    }

    // Búsqueda 2: últimos 8 dígitos
    r = await fetch(`${GYM_API}/clientes?buscar=${tel8}`, {
      headers: { Authorization: `Bearer ${GYM_TOKEN}` }
    });
    data = await r.json();
    clientes = Array.isArray(data) ? data : [];

    if (clientes.length > 0) {
      console.log('Cliente encontrado con tel8:', clientes[0].nombre);
      return clientes[0];
    }

    // Búsqueda 3: con 549 adelante
    r = await fetch(`${GYM_API}/clientes?buscar=549${tel10}`, {
      headers: { Authorization: `Bearer ${GYM_TOKEN}` }
    });
    data = await r.json();
    clientes = Array.isArray(data) ? data : [];

    if (clientes.length > 0) {
      console.log('Cliente encontrado con 549:', clientes[0].nombre);
      return clientes[0];
    }

    console.log('Cliente no encontrado para:', telefono);
    return null;
  } catch (err) {
    console.error('Error buscarClientePorTelefono:', err.message);
    return null;
  }
}

async function procesarMensaje(mensaje, remitente, profileName = null) {
  try {
    const esCosaco = remitente === process.env.COSACO_WHATSAPP;

    if (esCosaco) {
      const mensajeUpper = mensaje.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const esSiNo = mensajeUpper === 'SI' || mensajeUpper === 'S' || mensajeUpper === 'NO' || mensajeUpper === 'N';

      // Resumen de pendientes
      if (mensajeUpper === 'PENDIENTES' || mensajeUpper === 'PENDIENTE') {
        const { rows: pagos } = await pool.query(
          `SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC`
        );
        const { rows: suspensiones } = await pool.query(
          `SELECT * FROM suspensiones_pendientes WHERE esperando_confirmacion = true ORDER BY timestamp ASC`
        );
        const becasPend = [...becasPendientes.values()].filter(b => !b.tipo_beca);

        if (pagos.length === 0 && suspensiones.length === 0 && becasPend.length === 0) {
          await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
            '✅ No hay nada pendiente de confirmación');
          return;
        }

        let resumen = '📋 *Pendientes de confirmación:*\n';

        if (pagos.length > 0) {
          resumen += `\n💰 *Pagos* (${pagos.length}):\n`;
          for (const p of pagos) resumen += `- ${p.cliente_nombre} - $${p.monto} - ${p.metodo}\n`;
        }
        if (suspensiones.length > 0) {
          resumen += `\n⚠️ *Suspensiones* (${suspensiones.length}):\n`;
          for (const s of suspensiones) resumen += `- ${s.cliente_nombre}\n`;
        }
        if (becasPend.length > 0) {
          resumen += `\n🎓 *Becas* (${becasPend.length}):\n`;
          for (const b of becasPend) resumen += `- ${b.cliente_nombre} - esperando tipo de beca\n`;
        }

        resumen += '\n¿Querés procesar alguno ahora? Respondé el nombre o \'todos\' para ir uno por uno';
        await enviarWhatsApp(process.env.COSACO_WHATSAPP, resumen, 'Cosaco');
        return;
      }

      // Modo "todos" → presentar primer pendiente para confirmación uno por uno
      const mensajeNorm = mensaje.trim().toLowerCase();
      if (mensajeNorm === 'todos' || mensajeNorm === 'todo') {
        // 1. Primero suspensiones (sin filtro de flag)
        const { rows: suspensiones } = await pool.query(
          'SELECT * FROM suspensiones_pendientes ORDER BY id ASC LIMIT 1'
        );
        if (suspensiones.length > 0) {
          const sig = suspensiones[0];
          await pool.query(
            'UPDATE suspensiones_pendientes SET esperando_confirmacion = true WHERE id = $1',
            [sig.id]
          );
          await enviarWhatsApp(
            process.env.COSACO_WHATSAPP,
            `⚠️ ${sig.cliente_nombre} lleva 10 días sin pagar. ¿Suspendo su servicio?\nRespondé SÍ o NO`,
            'Cosaco'
          );
          return;
        }
        // 2. Luego pagos
        const { rows: pagos } = await pool.query(
          'SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC LIMIT 1'
        );
        if (pagos.length > 0) {
          await manejarConfirmacionPago('SIGUIENTE', pagos[0]);
          return;
        }
        await enviarWhatsApp(process.env.COSACO_WHATSAPP, '✅ No hay pendientes para procesar.', 'Cosaco');
        return;
      }

      // Detectar si Cosaco estaba esperando confirmación de turno
      const historialCosaco = conversaciones.get(process.env.COSACO_WHATSAPP);
      const ultimoMensajeAgente = historialCosaco?.messages
        ?.filter(m => m.role === 'assistant')
        ?.slice(-1)[0];
      const textoUltimoAgente = typeof ultimoMensajeAgente?.content === 'string'
        ? ultimoMensajeAgente.content
        : '';
      const esperandoConfirmacionTurno =
        textoUltimoAgente.includes('¿Confirmo que le agrego') ||
        textoUltimoAgente.includes('¿Confirmás que querés cambiar');

      // Si esperaba confirmación de turno y Cosaco dijo SI → derivar a Claude
      if (esperandoConfirmacionTurno && esSiNo) {
        // fall through al bloque de Claude
      } else {
        // 1. Pago pendiente
        const { rows: pagosPendientes } = await pool.query(
          `SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC LIMIT 1`
        );
        if (pagosPendientes.length > 0 && esSiNo) {
          await manejarConfirmacionPago(mensajeUpper, pagosPendientes[0]);
          return;
        }

        // 2. Suspensión pendiente en DB
        const suspPendiente = await pool.query(
          'SELECT * FROM suspensiones_pendientes WHERE esperando_confirmacion = true LIMIT 1'
        );
        if (suspPendiente.rows.length > 0 && esSiNo) {
          await manejarConfirmacionSuspension(mensajeUpper, suspPendiente.rows[0]);
          return;
        }

        // 3. Beca pendiente
        if (becasPendientes.size > 0) {
          const becaEntry = [...becasPendientes.entries()].find(([, b]) => !b.tipo_beca);
          if (becaEntry) {
            const handled = await manejarConfirmacionBeca(mensajeUpper, becaEntry);
            if (handled) return;
          }
        }
      }

      // 4. Modo secretario con Claude (fall through)
    }

    if (!GYM_TOKEN) {
      console.log('Sin token, intentando login...');
      await loginConReintentos(3, 3000);
    }

    const clienteIdentificado = await buscarClientePorTelefono(remitente);
    console.log('Cliente identificado:', clienteIdentificado ? clienteIdentificado.nombre : 'ninguno');

    // Leer historial previo desde PostgreSQL y agregar mensaje actual en memoria
    const messages = await getHistorial(remitente);
    messages.push({ role: 'user', content: mensaje });

    const systemPromptFinal = clienteIdentificado
      ? `${SYSTEM_PROMPT}\n\nCLIENTE IDENTIFICADO: Estás hablando con ${clienteIdentificado.nombre}, cliente registrado/a con plan ${clienteIdentificado.plan}, estado ${clienteIdentificado.estado}, vencimiento ${clienteIdentificado.fecha_vencimiento}. Usá su nombre directamente sin pedírselo.`
      : SYSTEM_PROMPT;

    // Agentic loop
    let respuesta;
    while (true) {
      respuesta = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: [{ type: 'text', text: systemPromptFinal, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      });

      console.log(`Stop reason: ${respuesta.stop_reason}`);

      if (respuesta.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: respuesta.content });
      guardarMensaje(remitente, null, '[tool_use]', 'tool_use', respuesta.content);

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

      messages.push({ role: 'user', content: toolResults });
      guardarMensaje(remitente, null, '[tool_result]', 'tool_result', toolResults);
    }

    const bloqueTexto = respuesta.content.find(b => b.type === 'text');
    const texto = bloqueTexto?.text?.trim()
      ? bloqueTexto.text
      : '¡Listo! Tu solicitud fue procesada correctamente 🏑 Si necesitás algo más, avisame.';
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

async function manejarConfirmacionPago(mensajeUpper, pago) {
  // Modo presentación: mostrar el pago a Cosaco sin procesarlo todavía
  if (mensajeUpper === 'SIGUIENTE') {
    await enviarWhatsApp(
      process.env.COSACO_WHATSAPP,
      `💰 *Confirmación de pago*\nCliente: ${pago.cliente_nombre}\nMonto: $${pago.monto}\nMétodo: ${pago.metodo}\n¿Confirmás? Respondé SÍ o NO`,
      'Cosaco'
    );
    return;
  }

  const confirmado = mensajeUpper === 'SI' || mensajeUpper === 'S';

  // Eliminar de la tabla
  await pool.query(`DELETE FROM pagos_pendientes WHERE id = $1`, [pago.id]);

  if (confirmado) {
    console.log(`Cosaco confirmó pago de ${pago.cliente_nombre} por $${pago.monto}`);
    try {
      const headers = {
        'Authorization': `Bearer ${GYM_TOKEN}`,
        'Content-Type': 'application/json',
      };
      const rCliente = await fetch(`${GYM_API}/clientes/${pago.cliente_id}`, { headers });
      const cliente = await rCliente.json();
      const hoy = new Date().toISOString().split('T')[0];
      const fecha_pago = cliente.estado === 'Suspendido' || !cliente.fecha_vencimiento ? hoy : cliente.fecha_vencimiento;
      const r = await fetch(`${GYM_API}/pagos`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cliente_id: pago.cliente_id,
          monto: pago.monto,
          metodo: pago.metodo,
          fecha_pago: hoy,
          fecha_inicio: calcularFechaInicio(cliente),
          fecha_vencimiento: calcularFechaVencimiento(hoy, cliente.fecha_vencimiento),
          plan: cliente.plan,
        }),
      });
      const resultado = await r.json();
      console.log('Pago registrado:', JSON.stringify(resultado));
      registrarActividad('pago', { nombre: pago.cliente_nombre, monto: pago.monto });

      await enviarWhatsApp(pago.cliente_from,
        `✅ Pago registrado: ${pago.cliente_nombre} - $${pago.monto} - ${pago.metodo} - ${fecha_pago} 🏑`,
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

  // Siguiente en cola (el SELECT ya trae el próximo por id ASC)
  const { rows: siguientes } = await pool.query(
    `SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC LIMIT 1`
  );
  if (siguientes.length > 0) {
    const siguiente = siguientes[0];
    const mensajeCosaco =
      `💰 Siguiente pago a confirmar:\n` +
      `Cliente: ${siguiente.cliente_nombre} - $${siguiente.monto} - ${siguiente.metodo}\n` +
      `¿Confirmás? SÍ o NO`;
    await enviarWhatsApp(process.env.COSACO_WHATSAPP, mensajeCosaco);
    console.log(`Siguiente pago en cola enviado a Cosaco: ${siguiente.cliente_nombre}`);
  }
}

async function manejarConfirmacionSuspension(mensajeUpper, suspension) {
  if (mensajeUpper === 'SI' || mensajeUpper === 'S') {
    await fetch(`${GYM_API}/clientes/${suspension.cliente_id}/suspender`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${GYM_TOKEN}` },
    });
    console.log(`✅ Cliente ${suspension.cliente_nombre} suspendido`);
    await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
      `✅ Servicio de ${suspension.cliente_nombre} suspendido correctamente.`);
  } else {
    await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
      `👍 Ok, ${suspension.cliente_nombre} no fue suspendido.`);
  }

  // Eliminar la suspensión procesada (usamos su id, no hacemos otro SELECT)
  await pool.query(`DELETE FROM suspensiones_pendientes WHERE id = $1`, [suspension.id]);

  // Limpiar cualquier flag sucio y tomar la siguiente por id
  await pool.query(`UPDATE suspensiones_pendientes SET esperando_confirmacion = false`);
  const siguiente = await pool.query(
    'SELECT * FROM suspensiones_pendientes ORDER BY id ASC LIMIT 1'
  );
  if (siguiente.rows.length > 0) {
    const sig = siguiente.rows[0];
    await pool.query(
      'UPDATE suspensiones_pendientes SET esperando_confirmacion = true WHERE id = $1',
      [sig.id]
    );
    await enviarWhatsApp(
      process.env.COSACO_WHATSAPP,
      `⚠️ Siguiente: ${sig.cliente_nombre} lleva 10 días sin pagar. ¿Suspendo su servicio?\nRespondé SÍ o NO`,
      'Cosaco'
    );
  } else {
    const pagoSig = await pool.query(
      'SELECT * FROM pagos_pendientes WHERE esperando_confirmacion = true ORDER BY id ASC LIMIT 1'
    );
    if (pagoSig.rows.length > 0) {
      const p = pagoSig.rows[0];
      await enviarWhatsApp(
        process.env.COSACO_WHATSAPP,
        `💰 Siguiente pendiente:\nCliente: ${p.cliente_nombre}\nMonto: $${p.monto}\nMétodo: ${p.metodo}\n¿Confirmás? SÍ o NO`,
        'Cosaco'
      );
    } else {
      await enviarWhatsApp(
        process.env.COSACO_WHATSAPP,
        '✅ No hay más pendientes. ¡Todo procesado! 🏑',
        'Cosaco'
      );
    }
  }
}

async function manejarConfirmacionBeca(mensajeUpper, becaEntry) {
  const esBeca = mensajeUpper === 'SIN BECA' || mensajeUpper === '50%' || mensajeUpper === '100%';
  if (!esBeca) return false;

  const [clienteFrom, beca] = becaEntry;
  let monto;
  let tipoBeca;

  if (mensajeUpper === 'SIN BECA') {
    monto = beca.costo;
    tipoBeca = 'SIN BECA';
  } else if (mensajeUpper === '50%') {
    monto = Math.round(beca.costo / 2);
    tipoBeca = '50%';
  } else {
    monto = 0;
    tipoBeca = '100%';
  }

  becasPendientes.set(clienteFrom, { ...beca, tipo_beca: tipoBeca, monto_final: monto });

  const msgCliente = tipoBeca === 'SIN BECA'
    ? `✅ Confirmado ${beca.cliente_nombre.split(' ')[0]}! No tenés beca asignada.\nTu cuota este mes es $${monto.toLocaleString('es-AR')}.\n¿Ya realizaste el pago? Si es así, avisanos para registrarlo 🏑`
    : `✅ Confirmado ${beca.cliente_nombre.split(' ')[0]}! Tu beca es del ${tipoBeca}.\nTu cuota este mes es $${monto.toLocaleString('es-AR')}.\n¿Ya realizaste el pago? Si es así, avisanos para registrarlo 🏑`;
  await enviarWhatsApp(clienteFrom, msgCliente, beca.cliente_nombre.split(' ')[0]);

  await enviarWhatsApp(process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
    `✅ Beca confirmada. Le avisé a ${beca.cliente_nombre} que su cuota es $${monto.toLocaleString('es-AR')}`);

  console.log(`Beca ${tipoBeca} confirmada para ${beca.cliente_nombre}, monto: $${monto}`);
  return true;
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
        await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, {"1": nombre}, 'Hoy vence tu plan');
        console.log(`✅ Enviado a ${c.nombre}`);
      }
      return res.json({ ok: true, enviados: clientes.map(c => c.nombre) });
    } else if (job === 'mora') {
      templateSid = process.env.TEMPLATE_MORA;
    } else if (job === 'notificar_suspensiones') {
      const result = await pool.query(
        `SELECT * FROM suspensiones_pendientes WHERE notificado_cosaco = false ORDER BY timestamp ASC`
      );
      if (result.rows.length === 0) {
        return res.json({ ok: false, mensaje: 'No hay suspensiones pendientes sin notificar' });
      }
      const notificados = [];
      for (const s of result.rows) {
        await enviarWhatsApp(
          process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
          `⚠️ ${s.cliente_nombre} lleva 10 días sin pagar. ¿Suspendo su servicio?\nRespondé SÍ o NO`,
          'Cosaco'
        );
        await pool.query(
          `UPDATE suspensiones_pendientes SET notificado_cosaco = true, esperando_confirmacion = true WHERE id = $1`,
          [s.id]
        );
        notificados.push(s.cliente_nombre);
      }
      return res.json({ ok: true, notificados });
    } else if (job === 'suspension') {
      const clientesSusp = await clientesPorGrupo(5, 'suspension');
      console.log(`Clientes suspensión grupo 5: ${clientesSusp.length}`);
      if (clientesSusp.length === 0) {
        return res.json({ ok: false, mensaje: 'No hay clientes con 10 días vencidos en grupo 5' });
      }
      for (const c of clientesSusp) {
        const nombre = c.nombre.split(' ')[0];
        await enviarTemplate(c.telefono, process.env.TEMPLATE_SUSPENSION, {"1": nombre}, '[Aviso de suspensión]');
        await pool.query(
          `INSERT INTO suspensiones_pendientes (cliente_id, cliente_nombre, telefono)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [c.id, c.nombre, c.telefono]
        );
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
      let informe = `📊 *Informe del día — ${hoy}*\n`;
      informe += `💬 Mensajes: ${actividad.mensajes_atendidos}\n`;
      if (actividad.nuevos_clientes.length === 0) {
        informe += `✅ Nuevos clientes: ninguno\n`;
      } else if (actividad.nuevos_clientes.length > 5) {
        informe += `✅ Nuevos clientes: ${actividad.nuevos_clientes.length}\n`;
      } else {
        informe += `✅ Nuevos clientes (${actividad.nuevos_clientes.length}): ${actividad.nuevos_clientes.join(', ')}\n`;
      }
      if (actividad.pagos_registrados.length === 0) {
        informe += `💰 Pagos: ninguno\n`;
      } else {
        const total = actividad.pagos_registrados.reduce((sum, p) => sum + p.monto, 0);
        if (actividad.pagos_registrados.length > 5) {
          informe += `💰 Pagos: ${actividad.pagos_registrados.length} — Total: $${total.toLocaleString('es-AR')}\n`;
        } else {
          informe += `💰 Pagos (${actividad.pagos_registrados.length}) — Total: $${total.toLocaleString('es-AR')}:\n`;
          actividad.pagos_registrados.forEach(p => informe += `• ${p.nombre}: $${p.monto.toLocaleString('es-AR')}\n`);
        }
      }
      if (actividad.turnos_cambiados.length === 0) {
        informe += `🔄 Turnos cambiados: ninguno\n`;
      } else if (actividad.turnos_cambiados.length > 5) {
        informe += `🔄 Turnos cambiados: ${actividad.turnos_cambiados.length}\n`;
      } else {
        informe += `🔄 Turnos cambiados (${actividad.turnos_cambiados.length}): ${actividad.turnos_cambiados.join(', ')}\n`;
      }
      informe += `_Hasta mañana Cosaco! 🏑_`;
      console.log('Longitud del informe:', informe.length);
      await enviarTemplate(
        process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
        process.env.TEMPLATE_MENSAJE_HOCKEYVIVO,
        {"1": informe},
        informe
      );
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

function guardarMensaje(from, nombre, texto, rol, contentJson = null) {
  pool.query(
    'INSERT INTO conversaciones (telefono, nombre, rol, texto, content_json) VALUES ($1, $2, $3, $4, $5)',
    [from, nombre && nombre !== from ? nombre : null, rol, texto, contentJson !== null ? JSON.stringify(contentJson) : null]
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

    const textoFinal = textoGuardar || '[Mensaje automático]';
    await guardarMensaje(to, variables['1'] || 'Cliente', textoFinal, 'agente');
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
          // Vence hoy (dias_vencido entre -1 y 0)
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
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, { "1": c.nombre.split(' ')[0] }, 'Hoy vence tu plan');
  }
});

// Especial: recordatorio grupo 15 — 14 junio 2026 (una sola vez)
cron.schedule('45 13 14 6 *', async () => {
  console.log('🔔 Job especial: recordatorio grupo 15 - hoy 14 junio');
  const clientes = await clientesPorGrupo(15, 'recordatorio');
  for (const c of clientes) {
    const nombre = c.nombre.split(' ')[0];
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, {"1": nombre}, 'Hoy vence tu plan');
  }
});

// Día 14 → recordatorio grupo 15
cron.schedule('0 13 14 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 15');
  const clientes = await clientesPorGrupo(15, 'recordatorio');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, { "1": c.nombre.split(' ')[0] }, 'Hoy vence tu plan');
  }
});

// Día 24 → recordatorio grupo 25
cron.schedule('0 13 24 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 25');
  const clientes = await clientesPorGrupo(25, 'recordatorio');
  for (const c of clientes) {
    await enviarTemplate(c.telefono, process.env.TEMPLATE_RECORDATORIO, { "1": c.nombre.split(' ')[0] }, 'Hoy vence tu plan');
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

async function programarSuspensiones(clientes) {
  for (const c of clientes) {
    await pool.query(
      `INSERT INTO suspensiones_pendientes (cliente_id, cliente_nombre, telefono)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [c.id, c.nombre, c.telefono]
    );
    console.log(`📋 Suspensión programada en DB: ${c.nombre}`);
  }
}

// Cada 15 minutos: notificar a Cosaco las suspensiones con más de 1 hora sin notificar
cron.schedule('*/15 * * * *', async () => {
  try {
    const result = await pool.query(`
      SELECT * FROM suspensiones_pendientes
      WHERE notificado_cosaco = false
      AND timestamp < NOW() - INTERVAL '1 hour'
      ORDER BY timestamp ASC
    `);
    for (const s of result.rows) {
      await enviarWhatsApp(
        process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
        `⚠️ ${s.cliente_nombre} lleva 10 días sin pagar. ¿Suspendo su servicio?\nRespondé SÍ o NO`,
        'Cosaco'
      );
      await pool.query(
        `UPDATE suspensiones_pendientes SET notificado_cosaco = true, esperando_confirmacion = true WHERE id = $1`,
        [s.id]
      );
    }
  } catch (err) {
    console.error('Error en cron suspensiones pendientes:', err.message);
  }
});

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
      await enviarWhatsApp(
        process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
        `🎂 Hoy es el cumpleaños de ${c.nombre}! No olvides saludarlo/a desde tu celular personal 🏑`,
        'Cosaco'
      );
    }

    console.log(`🎂 Cumpleaños enviados: ${cumpleanosHoy.length}`);
  } catch (err) {
    console.error('Error en job cumpleaños:', err.message);
  }
});

// Informe diario a las 9am Argentina (12:00 UTC)
cron.schedule('0 12 * * *', async () => {
  try {
    console.log('🕐 Hora servidor:', new Date().toString());
    console.log('🕐 Hora UTC:', new Date().toISOString());
    console.log('🕐 Hora Argentina:', new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }));

    const fechaHoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); // YYYY-MM-DD en AR
    const result = await pool.query('SELECT * FROM actividad_dia WHERE fecha = $1', [fechaHoy]);
    const actividad = result.rows[0] || { mensajes_atendidos: 0, nuevos_clientes: [], pagos_registrados: [], turnos_cambiados: [] };

    const hoy = new Date().toLocaleDateString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    let informe = `📊 *Informe del día — ${hoy}*\n`;
    informe += `💬 Mensajes: ${actividad.mensajes_atendidos}\n`;

    if (actividad.nuevos_clientes.length === 0) {
      informe += `✅ Nuevos clientes: ninguno\n`;
    } else if (actividad.nuevos_clientes.length > 5) {
      informe += `✅ Nuevos clientes: ${actividad.nuevos_clientes.length}\n`;
    } else {
      informe += `✅ Nuevos clientes (${actividad.nuevos_clientes.length}): ${actividad.nuevos_clientes.join(', ')}\n`;
    }

    if (actividad.pagos_registrados.length === 0) {
      informe += `💰 Pagos: ninguno\n`;
    } else {
      const total = actividad.pagos_registrados.reduce((sum, p) => sum + p.monto, 0);
      if (actividad.pagos_registrados.length > 5) {
        informe += `💰 Pagos: ${actividad.pagos_registrados.length} — Total: $${total.toLocaleString('es-AR')}\n`;
      } else {
        informe += `💰 Pagos (${actividad.pagos_registrados.length}) — Total: $${total.toLocaleString('es-AR')}:\n`;
        actividad.pagos_registrados.forEach(p => informe += `• ${p.nombre}: $${p.monto.toLocaleString('es-AR')}\n`);
      }
    }

    if (actividad.turnos_cambiados.length === 0) {
      informe += `🔄 Turnos cambiados: ninguno\n`;
    } else if (actividad.turnos_cambiados.length > 5) {
      informe += `🔄 Turnos cambiados: ${actividad.turnos_cambiados.length}\n`;
    } else {
      informe += `🔄 Turnos cambiados (${actividad.turnos_cambiados.length}): ${actividad.turnos_cambiados.join(', ')}\n`;
    }

    informe += `_Hasta mañana Cosaco! 🏑_`;

    console.log('Longitud del informe:', informe.length);

    await enviarTemplate(
      process.env.COSACO_WHATSAPP.replace('whatsapp:+54', ''),
      process.env.TEMPLATE_MENSAJE_HOCKEYVIVO,
      {"1": informe},
      informe
    );
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
app.get('/panel/db-check', async (req, res) => {
  if (req.query.secret !== 'hockeyvivo') return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const [suspensiones, actividad] = await Promise.all([
      pool.query('SELECT * FROM suspensiones_pendientes ORDER BY timestamp ASC'),
      pool.query('SELECT * FROM actividad_dia WHERE fecha = $1', [hoy]),
    ]);
    res.json({
      suspensiones_pendientes: suspensiones.rows,
      actividad_hoy: actividad.rows[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/panel/actividad', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT fecha, mensajes_atendidos, nuevos_clientes, pagos_registrados, turnos_cambiados
       FROM actividad_dia
       ORDER BY fecha DESC
       LIMIT 30`
    );

    const diasHTML = rows.map(row => {
      const fecha = new Date(row.fecha);
      const fechaFormateada = fecha.toLocaleDateString('es-AR', {
        timeZone: 'UTC',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
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
    <span class="dia-fecha">${fechaFormateada}</span>
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
