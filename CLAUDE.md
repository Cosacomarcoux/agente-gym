# Agente Gym — Bot de WhatsApp de Hockey Vivo

Bot conversacional de WhatsApp para el gimnasio de hockey. Atiende a los alumnos
(reservas, pagos, consultas) y le sirve de secretario a "Cosaco" (Roberto, el
dueño). Es hoy el **operador principal** del gimnasio.

## Arquitectura

- **Node.js monolito**: todo en `index.js`. Al importarse arranca Express, Twilio,
  Anthropic y Pool de Postgres + cron. NO tiene exports (no se puede importar
  parcialmente sin efectos secundarios).
- **`guards.js`**: lógica pura y testeable extraída de `index.js` (detección de
  pagos, montos, teléfonos, comandos). SIEMPRE que toques esa lógica, hacelo acá,
  no dupliques regex en `index.js`.
- **`test/guards.test.js`**: 15+ tests con el runner nativo (`npm test` = `node --test`).
  Corré los tests antes de cada push.
- **Canales**: WhatsApp vía Twilio (API oficial — NO migrar a Baileys/no-oficial,
  sube riesgo de ban). LLM: Anthropic (Claude).
- **DB**: Postgres (Railway). Tablas: conversaciones, actividad, telefono_cliente,
  pagos_pendientes, suspensiones_pendientes, registros_pendientes,
  conversaciones_pausadas.
- **API del gimnasio**: `GYM_API` = sistema hockeyvivo-sistema. El bot opera vía
  esa API con login (rol bot). Token se refresca solo (cron cada 12 h + reintento
  ante 401) — fix crítico: antes se logueaba una vez y moría al vencer el token.

## Reglas críticas — pagos (acá estuvieron los peores bugs)

1. **NUNCA inventar pagos.** `consultar_pago_a_cosaco` exige `texto_cliente` (la
   frase textual del cliente) y `guards.suenaAPago()` la valida. Frases como "no
   voy", "gracias", "quiero pausar" NO son pagos. Nunca sacar el monto del precio
   del plan.
2. **Nunca pagos de $0.** Si no hay monto, el bot pregunta el monto; no encola.
3. **Confirmación de a uno.** "pendientes"/"confirmar" arranca un flujo
   determinístico (`mostrarSiguientePendiente` + SÍ/NO). La IA NO confirma pagos
   y tiene prohibido decir que confirmó.
4. **No perder plata.** Al confirmar (SÍ), se REGISTRA primero en el sistema y
   solo si sale bien se borra el pendiente. Si falla, queda en cola. (Antes se
   borraba antes de registrar → se perdían pagos.)
5. **Promesa de pago futuro** ("te pago el viernes") → solo aviso a Cosaco, no encola.

## Otras reglas

- **Duplicados de clientes**: al volver un ex-alumno, se reutiliza su ficha
  (búsqueda por teléfono incluida). No crear cliente nuevo si el teléfono ya existe.
- **Autorización de 3er turno**: guarda TODOS los turnos pedidos y los asigna al
  confirmar (antes cargaba solo uno).
- **`notificar_cosaco`**: obligatoria antes de decirle al cliente "el equipo se
  contacta". Regla de oro en el SYSTEM_PROMPT.
- **Mensajes de Cosaco a un cliente** (`enviar_mensaje_cliente` tipo `general`):
  van como TEXTO LIBRE, no como template (el template fijo pisaba el mensaje real).

## Panel de conversaciones (`/panel`)

Bandeja tipo WhatsApp servida como template string dentro de `index.js`.
⚠️ **CUIDADO con el escape**: el JS del panel vive dentro de un template literal.
Un `\n` literal en un string se convierte en salto de línea real y ROMPE el panel
(ya pasó). Al editar, verificar evaluando el template como lo hace el server.
Features: pendientes de responder, "tomar el control" (pausa el bot por conversación),
auto-actualización cada 8 s, ver comprobantes (proxy `/panel/media/:id` con
validación anti-SSRF: solo hosts twilio.com).

## Variables de entorno (Railway)

`ANTHROPIC_API_KEY`, `TWILIO_*`, `DATABASE_URL`, `GYM_USER`/`GYM_PASS`,
`COSACO_WHATSAPP`, `BOT_ESCRITURA` (borrar/=1 para que el bot opere),
`TEMPLATE_*` (SIDs de plantillas de WhatsApp aprobadas).

## Antes de deployar

Correr `npm test` (deben pasar todos) y, si tocaste el panel, verificar que el
`<script>` del template evaluado sea JS válido.
