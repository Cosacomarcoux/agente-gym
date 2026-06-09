require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
Con turnos elegidos y datos personales — procesarlo automáticamente así:
1. Extraer nombre, apellido, fecha de nacimiento, whatsapp, equipo, nivel y turnos elegidos
2. Usar la tool get_turnos para obtener los IDs de los turnos mencionados
3. Usar la tool registrar_cliente_y_asignar_turno para registrar al cliente y asignarle los turnos
4. Responder: "¡Todo listo [nombre]! Ya quedaste registrado/a en Hockey Vivo 🏑 Te esperamos en el entrenamiento. Cualquier consulta escribinos acá."

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

SI NO PODÉS RESOLVER ALGO:
Decí: "Te paso con el equipo de Hockey Vivo, en breve te contactamos 🏑"`;

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
        } catch (twilioErr) {
          console.error(`[Twilio] ERROR al enviar a Cosaco — code: ${twilioErr.code} | status: ${twilioErr.status} | message: ${twilioErr.message}`);
          pagoEnEspera = null;
          return { error: `Error enviando mensaje a Cosaco: ${twilioErr.message}` };
        }
        return { ok: true, enviado_a_cosaco: true };
      }
    }

    if (nombre === 'consultar_beca_a_cosaco') {
      becasPendientes.set(remitente, {
        cliente_id: input.cliente_id,
        cliente_nombre: input.cliente_nombre,
        cliente_from: remitente,
        costo: input.costo,
        plan: input.plan,
      });
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: process.env.COSACO_WHATSAPP,
        body: `⚠️ ${input.cliente_nombre} dice que tiene beca.\n¿Qué tipo le corresponde?\nRespondé: SIN BECA, 50% o 100%`,
      });
      console.log(`Consulta de beca enviada a Cosaco para ${input.cliente_nombre}`);
      return { ok: true };
    }

    return { error: `Tool desconocida: ${nombre}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function procesarMensaje(mensaje, remitente) {
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
    console.log(`Mensaje enviado a ${remitente}`);
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

      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: pago.cliente_from,
        body: `✅ Pago registrado: ${pago.cliente_nombre} - $${pago.monto} - ${pago.metodo} - ${pago.fecha_pago} 🏑`,
      });
    } catch (err) {
      console.error('Error registrando pago confirmado:', err);
    }
  } else {
    console.log(`Cosaco rechazó pago de ${pago.cliente_nombre}`);
    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: pago.cliente_from,
        body: `Quedá tranquilo/a, en breve un integrante del equipo se comunica con vos para resolverlo 🏑`,
      });
    } catch (err) {
      console.error('Error notificando cliente sobre pago rechazado:', err);
    }
  }

  // Procesar siguiente en cola
  if (colaPagendientes.length > 0) {
    pagoEnEspera = colaPagendientes.shift();
    const mensajeCosaco =
      `💰 Siguiente pago a confirmar:\n` +
      `Cliente: ${pagoEnEspera.cliente_nombre} - $${pagoEnEspera.monto} - ${pagoEnEspera.metodo}\n` +
      `¿Confirmás? SÍ o NO`;
    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: process.env.COSACO_WHATSAPP,
        body: mensajeCosaco,
      });
      console.log(`Siguiente pago en cola enviado a Cosaco: ${pagoEnEspera.cliente_nombre}`);
    } catch (err) {
      console.error('Error enviando siguiente pago a Cosaco:', err);
    }
  }
}

app.post('/webhook', (req, res) => {
  console.log('req.body completo:', req.body);
  const mensaje = req.body.Body;
  const remitente = req.body.From;
  console.log(`Mensaje recibido de ${remitente}: ${mensaje}`);

  // Responder inmediatamente a Twilio con TwiML vacío
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml');
  res.send(twiml.toString());

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
          await twilioClient.messages.create({ from: TWILIO_FROM, to: clienteFrom, body: msgCliente });

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
  procesarMensaje(mensaje, remitente);
});

async function enviarWhatsApp(telefono, mensaje) {
  try {
    let tel = telefono.toString().replace(/\D/g, '');
    if (tel.startsWith('549')) tel = tel.slice(2); // queda 9XXXXXXXXXX
    if (tel.startsWith('54')) tel = tel.slice(2);  // queda XXXXXXXXXX
    const to = `whatsapp:+54${tel}`;
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body: mensaje });
    console.log(`✅ Mensaje enviado a ${to}`);
  } catch (err) {
    console.error(`❌ Error enviando a ${telefono}: ${err.message}`);
  }
}

async function clientesPorGrupo(diaGrupo) {
  try {
    const r = await fetch(`${GYM_API}/vencimientos`, {
      headers: { Authorization: `Bearer ${GYM_TOKEN}` }
    });
    const data = await r.json();
    return data.filter(c => {
      if (!c.fecha_vencimiento || c.estado !== 'Vigente') return false;
      const dia = new Date(c.fecha_vencimiento + 'T12:00:00').getDate();
      return dia === diaGrupo;
    });
  } catch (err) {
    console.error('Error obteniendo clientes:', err.message);
    return [];
  }
}

// Día 4 → recordatorio grupo 5
cron.schedule('0 10 4 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 5');
  const clientes = await clientesPorGrupo(5);
  for (const c of clientes) {
    if (c.dias_vencido > 0) continue;
    const msg = `Hola ${c.nombre.split(' ')[0]}! 👋 Te recordamos que mañana vence tu cuota de Hockey Vivo.\n💰 Monto: $${c.costo?.toLocaleString('es-AR') || 'consultar'}\nPara renovar, realizá tu transferencia o acercate al gimnasio.\n¡Gracias y nos vemos en el entrenamiento! 🏑`;
    await enviarWhatsApp(c.telefono, msg);
  }
});

// Día 14 → recordatorio grupo 15
cron.schedule('0 10 14 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 15');
  const clientes = await clientesPorGrupo(15);
  for (const c of clientes) {
    if (c.dias_vencido > 0) continue;
    const msg = `Hola ${c.nombre.split(' ')[0]}! 👋 Te recordamos que mañana vence tu cuota de Hockey Vivo.\n💰 Monto: $${c.costo?.toLocaleString('es-AR') || 'consultar'}\nPara renovar, realizá tu transferencia o acercate al gimnasio.\n¡Gracias y nos vemos en el entrenamiento! 🏑`;
    await enviarWhatsApp(c.telefono, msg);
  }
});

// Día 24 → recordatorio grupo 25
cron.schedule('0 10 24 * *', async () => {
  console.log('🔔 Job: recordatorio grupo 25');
  const clientes = await clientesPorGrupo(25);
  for (const c of clientes) {
    if (c.dias_vencido > 0) continue;
    const msg = `Hola ${c.nombre.split(' ')[0]}! 👋 Te recordamos que mañana vence tu cuota de Hockey Vivo.\n💰 Monto: $${c.costo?.toLocaleString('es-AR') || 'consultar'}\nPara renovar, realizá tu transferencia o acercate al gimnasio.\n¡Gracias y nos vemos en el entrenamiento! 🏑`;
    await enviarWhatsApp(c.telefono, msg);
  }
});

// Día 9 → mora grupo 5 (5 días sin pagar)
cron.schedule('0 10 9 * *', async () => {
  console.log('🔔 Job: mora grupo 5');
  const clientes = await clientesPorGrupo(5);
  for (const c of clientes) {
    if (c.dias_vencido < 1) continue;
    const nombre = c.nombre.split(' ')[0];
    const msg = `Hola ${nombre}! 👋\nTe extrañamos en Hockey Vivo Gym, y vimos que aún no se acreditó tu pago. ¿Fue un error, o necesitás ayuda con algo?\nSabés que contás con nosotros para lo que necesites.\nUn abrazo 🏑`;
    await enviarWhatsApp(c.telefono, msg);
  }
});

// Día 19 → mora grupo 15 (5 días sin pagar)
cron.schedule('0 10 19 * *', async () => {
  console.log('🔔 Job: mora grupo 15');
  const clientes = await clientesPorGrupo(15);
  for (const c of clientes) {
    if (c.dias_vencido < 1) continue;
    const nombre = c.nombre.split(' ')[0];
    const msg = `Hola ${nombre}! 👋\nTe extrañamos en Hockey Vivo Gym, y vimos que aún no se acreditó tu pago. ¿Fue un error, o necesitás ayuda con algo?\nSabés que contás con nosotros para lo que necesites.\nUn abrazo 🏑`;
    await enviarWhatsApp(c.telefono, msg);
  }
});

// Día 29 → mora grupo 25 (5 días sin pagar)
cron.schedule('0 10 29 * *', async () => {
  console.log('🔔 Job: mora grupo 25');
  const clientes = await clientesPorGrupo(25);
  for (const c of clientes) {
    if (c.dias_vencido < 1) continue;
    const nombre = c.nombre.split(' ')[0];
    const msg = `Hola ${nombre}! 👋\nTe extrañamos en Hockey Vivo Gym, y vimos que aún no se acreditó tu pago. ¿Fue un error, o necesitás ayuda con algo?\nSabés que contás con nosotros para lo que necesites.\nUn abrazo 🏑`;
    await enviarWhatsApp(c.telefono, msg);
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

// Día 15 → 10 días vencido grupo 5
cron.schedule('0 10 15 * *', async () => {
  console.log('🔔 Job: suspensión grupo 5');
  const clientes = await clientesPorGrupo(5);
  const morosos = [];
  for (const c of clientes) {
    if (c.dias_vencido < 1) continue;
    const nombre = c.nombre.split(' ')[0];
    const msg = `Hola ${nombre}.\nHan pasado 10 días desde el vencimiento de tu plan, y con mucha pena tendremos que liberar tu cupo en Hockey Vivo Gym.\nPero queremos que sepas que las puertas siempre están abiertas para vos, ¡te queremos de vuelta! Hablá con nosotros para buscar un nuevo turno que te quede cómodo.\n¡Te esperamos! 🏑`;
    await enviarWhatsApp(c.telefono, msg);
    morosos.push(c);
  }
  programarSuspensiones(morosos);
});

// Día 25 → 10 días vencido grupo 15
cron.schedule('0 10 25 * *', async () => {
  console.log('🔔 Job: suspensión grupo 15');
  const clientes = await clientesPorGrupo(15);
  const morosos = [];
  for (const c of clientes) {
    if (c.dias_vencido < 1) continue;
    const nombre = c.nombre.split(' ')[0];
    const msg = `Hola ${nombre}.\nHan pasado 10 días desde el vencimiento de tu plan, y con mucha pena tendremos que liberar tu cupo en Hockey Vivo Gym.\nPero queremos que sepas que las puertas siempre están abiertas para vos, ¡te queremos de vuelta! Hablá con nosotros para buscar un nuevo turno que te quede cómodo.\n¡Te esperamos! 🏑`;
    await enviarWhatsApp(c.telefono, msg);
    morosos.push(c);
  }
  programarSuspensiones(morosos);
});

// Día 5 → 10 días vencido grupo 25
cron.schedule('0 10 5 * *', async () => {
  console.log('🔔 Job: suspensión grupo 25');
  const clientes = await clientesPorGrupo(25);
  const morosos = [];
  for (const c of clientes) {
    if (c.dias_vencido < 1) continue;
    const nombre = c.nombre.split(' ')[0];
    const msg = `Hola ${nombre}.\nHan pasado 10 días desde el vencimiento de tu plan, y con mucha pena tendremos que liberar tu cupo en Hockey Vivo Gym.\nPero queremos que sepas que las puertas siempre están abiertas para vos, ¡te queremos de vuelta! Hablá con nosotros para buscar un nuevo turno que te quede cómodo.\n¡Te esperamos! 🏑`;
    await enviarWhatsApp(c.telefono, msg);
    morosos.push(c);
  }
  programarSuspensiones(morosos);
});

// Job cumpleaños — todos los días a las 9am
cron.schedule('0 9 * * *', async () => {
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
      const nombre = c.nombre.split(' ')[0];
      const msg = `¡Feliz cumpleaños ${nombre}! 🎉🎂\nTodo el equipo de Hockey Vivo te desea un día increíble.\n¡Que este año esté lleno de goles y alegrías! 🏑⚽`;
      await enviarWhatsApp(c.telefono, msg);
    }

    console.log(`🎂 Cumpleaños enviados: ${cumpleanosHoy.length}`);
  } catch (err) {
    console.error('Error en job cumpleaños:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  loginConReintentos().catch(() => {});
});
