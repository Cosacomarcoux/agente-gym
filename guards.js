// ============================================================================
//  guards.js — Lógica pura y testeable del bot
//  Acá vive la lógica de decisión crítica (la que causó los bugs históricos),
//  centralizada en un solo lugar para que no "derive" entre los 7 puntos del
//  código donde se procesan pagos. Sin dependencias externas: 100% testeable.
// ============================================================================

// ── MENÚ GUIADO ─────────────────────────────────────────────────────────────
// ¿El cliente saludó / quiere arrancar? → mostramos el menú de opciones.
function esSaludo(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return /^(hola+|holis|hol[a]+|ola|buenas|buenos|buen dia|buen dias|buenos dias|buenas tardes|buenas noches|hey|ey|que tal|menu|inicio|empezar|arrancar|volver|hello)\b/.test(t);
}

// ¿Es un mensaje de INSCRIPCIÓN / reserva de un cliente nuevo? (aunque empiece
// con "Hola"). No debe abrir el menú: va directo al flujo de alta (la IA).
function esInscripcion(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/turnos elegidos|hay lugar|me interesa reservar|reservar (un |mi )?lugar|quiero reservar|reservar lugar/.test(t)) return true;
  if (/\b(anotar|anotarme|anotarla|inscribir|inscribirme|inscripcion|sumarme|sumarla)\b/.test(t)) return true;
  if (/me (quiero|gustaria|interesa) (anotar|sumar|inscribir|reservar)/.test(t)) return true;
  if (/clase de prueba|quiero probar|probar una clase/.test(t)) return true;
  // Plantilla de inscripción: varios campos de datos juntos (nombre, nacimiento…)
  const campos = ['nombre', 'nacimiento', 'whatsapp', 'equipo', 'nivel', 'turnos', 'comentario'].filter(k => t.includes(k)).length;
  if (campos >= 3 && /reservar|lugar|turno|inscrib|interesa|disponible/.test(t)) return true;
  return false;
}

// De un mensaje en el menú principal, devuelve la opción elegida (1-5) por número
// o por texto ("modificar un turno" → 2). null si no reconoce ninguna.
function matchOpcionMenu(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^1\b/.test(t) || /\bpagar\b/.test(t) || /\b(cargar|carga|registrar|hacer)\b.*\bpago\b/.test(t) || /^pago\b/.test(t) || /\bun pago\b/.test(t)) return 1;
  if (/^2\b/.test(t) || /\bturnos?\b/.test(t)) return 2;
  if (/^3\b/.test(t) || /estado (de )?cuenta/.test(t) || /\bcuenta\b/.test(t) || /cuanto (debo|adeudo|falta)/.test(t) || /mi estado/.test(t) || /vencimiento/.test(t)) return 3;
  if (/^4\b/.test(t) || /informacion/.test(t) || /\binfo\b/.test(t) || /gimnasio/.test(t) || /precios?/.test(t) || /\bmontos?\b/.test(t) || /direccion/.test(t) || /donde (queda|estan|es|quedan)/.test(t) || /\bgrupo\b/.test(t)) return 4;
  if (/^5\b/.test(t) || /mensaje/.test(t) || /\bequipo\b/.test(t) || /hablar con/.test(t) || /contactar/.test(t) || /una consulta/.test(t)) return 5;
  return null;
}

// ── PAGOS ──────────────────────────────────────────────────────────────────

// ¿El texto del cliente SUENA a un pago real? Candado contra pagos inventados:
// si el bot "alucina" un pago en una charla que no lo menciona, este filtro
// (aplicado sobre la frase textual del cliente) lo rechaza.
function suenaAPago(texto) {
  const t = String(texto || '').toLowerCase();
  if (!t.trim()) return false;
  return /pag|transf|deposit|abon|envi[eé]|mand[eé]|efectivo|plata|guita|comprobante|\$|\d{4,}/.test(t);
}

// ¿El cliente dice que YA pagó? (pago realizado — SOLO pretérito / acción hecha).
// OJO: NO debe matchear presente/futuro como "te pago", "voy a pagar" o
// "el viernes transfiero": eso es promesa, no pago hecho. Fue la causa de que el
// bot preguntara "¿cuánto transferiste?" ante un simple "mañana te pago".
function esPagoRealizado(texto) {
  const t = String(texto || '').toLowerCase();
  // Una promesa futura NUNCA es un pago realizado (desempate a favor de la promesa).
  if (esPromesaFutura(t)) return false;
  return /pagu[eé]|ya pag|transfer[ií](?!r)|ya transferid|deposit[eé]|dep[oó]sit[eé]|abon[eé]|se[ñn][eé]|hice (el|la|un|una) (pago|dep[oó]sito|transferencia)|acabo de (pagar|transferir|depositar|abonar)|reci[eé]n (pagu[eé]|transfer[ií]|deposit[eé]|abon[eé])|ya (te )?(pagu[eé]|transfer[ií]|deposit[eé]|abon[eé])|te (pagu[eé]|transfer[ií]|deposit[eé]|abon[eé]|se[ñn][eé])|ya est[aá] (hecho )?el (pago|dep[oó]sito)|mand[eé] el comprobante|pas[eé] el comprobante|adjunto el comprobante|ac[aá] (est[aá]|te dejo|te mando) el comprobante/i.test(t);
}

// ¿El cliente dice que va a pagar MÁS ADELANTE? (promesa futura → solo aviso,
// nunca se le pregunta el monto). Cubre intención explícita ("voy a pagar",
// "cómo pago") y cualquier mención de pago junto a un marcador temporal futuro
// ("mañana", "el viernes", "cuando cobre", "la semana que viene", etc.).
function esPromesaFutura(texto) {
  const t = String(texto || '').toLowerCase();
  // Solo cuenta como promesa si hay MARCADOR DE FUTURO explícito. Las intenciones
  // puras ("quiero pagar", "cómo pago") ya NO entran acá: esas abren el flujo de
  // pago guiado (el cliente quiere pagar ahora, no más adelante).
  const intencionExplicita = /te (pago|transfiero|deposito|mando|paso|abono|se[ñn]o) (despu[eé]s|luego|m[aá]s tarde|m[aá]s adelante|ma[ñn]ana|el |la |los |cuando |apenas |en cuanto |ni bien |a fin|esta semana|la semana|el finde|el fin)|pago (el|la|los) (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|finde|fin|semana|mes|d[ií]a|pr[oó]ximo)|esta semana (pago|te pago|abono|transfiero)|ma[ñn]ana (te )?(pago|abono|transfiero|deposito)/;
  if (intencionExplicita.test(t)) return true;
  const futuro = /despu[eé]s|luego|m[aá]s tarde|m[aá]s adelante|ma[ñn]ana|pasado ma[ñn]ana|el (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|finde|fin de semana|mes|d[ií]a|pr[oó]ximo)|la semana que viene|semana que viene|el mes que viene|a fin de mes|fin de mes|cuando (pueda|cobre|tenga|junte|me paguen)|apenas (pueda|cobre|tenga)|en cuanto (pueda|cobre|tenga)|ni bien (pueda|cobre)|ahora no (puedo|tengo)|no puedo (pagar )?ahora|no tengo (ahora|la plata)/;
  const mencionPago = /pag|transf|dep[oó]sit|abon|se[ñn]a|cuota|plata/;
  return futuro.test(t) && mencionPago.test(t);
}

// Extrae un monto del texto ("transferí 35.000" → 35000, "$29.000" → 29000).
// null si no hay. Maneja formato argentino con separador de miles (punto o coma)
// y evita falsos positivos con números cortos como fechas ("18/03").
function parsearMonto(texto) {
  const m = String(texto || '').match(
    // Rama 1: miles formateados (1-3 dígitos + grupos de 3) · Rama 2: número plano de 3+ dígitos
    /\$?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{3,})/
  );
  if (!m) return null;
  let raw = m[1].replace(/[.,](?=\d{3}\b)/g, ''); // sacar separadores de miles
  raw = raw.replace(',', '.');                     // coma decimal → punto
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// ── RESOLUCIÓN DE NOMBRES (evitar registrar pagos al cliente equivocado) ─────
// Bug histórico: el bot buscaba "Martina Munar", la API devolvía también a
// "Martina Chaparro" (match por el nombre de pila) y el código agarraba el
// PRIMER resultado → registraba el pago a la persona equivocada. Estas funciones
// exigen que TODOS los tokens del nombre buscado estén en el candidato.

function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sacar acentos
    .replace(/[^a-z0-9\s]/g, ' ')                      // signos → espacio
    .replace(/\s+/g, ' ')
    .trim();
}

// ¿El nombre buscado calza FUERTE con el candidato? Todos los tokens del buscado
// (nombre y apellido) deben aparecer como comienzo de palabra en el candidato.
// "martina munar" vs "martina chaparro" → false (falta "munar").
function nombreCoincide(buscado, candidato) {
  const toks = normalizarTexto(buscado).split(' ').filter(Boolean);
  if (!toks.length) return false;
  const c = ' ' + normalizarTexto(candidato) + ' ';
  return toks.every(tok => c.includes(' ' + tok));
}

// De una lista de clientes ({nombre,...}), devolver SOLO los que calzan fuerte.
// Si el buscado trae apellido, esto descarta homónimos de otro apellido.
function filtrarClientesPorNombre(buscado, clientes) {
  const arr = Array.isArray(clientes) ? clientes : [];
  return arr.filter(c => nombreCoincide(buscado, c && c.nombre));
}

// Saca muletillas de pago del nombre buscado para que el match no falle por
// ellas: "mercedes Rimini? Pago" → "mercedes rimini"; "Lola Godoy por favor" →
// "lola godoy". También descarta números (montos) y saludos.
function limpiarNombreBuscado(texto) {
  let t = normalizarTexto(texto);
  t = t.replace(/\bpor favor\b/g, ' ');
  const stop = new Set([
    'pago', 'pagó', 'pagar', 'paga', 'pague', 'abono', 'abonar', 'abone', 'abonó',
    'transferencia', 'transfer', 'transf', 'transferi', 'transferir', 'efectivo', 'efvo',
    'monto', 'porfa', 'porfis', 'porfavor', 'por', 'favor',
    'gracias', 'hola', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tardes', 'noches',
    'registra', 'registrar', 'registrame', 'confirma', 'confirmar', 'puedes', 'podes', 'podrias',
  ]);
  t = t.split(/\s+/).filter(w => w && !stop.has(w) && !/^\d/.test(w)).join(' ');
  return t.trim();
}

// ¿El cliente avisa que va a DEJAR de venir un tiempo largo? (deja de asistir,
// este mes no va, vuelve el mes que viene / en tal mes...). NO matchea ausencias
// de un solo día ("hoy no voy", "mañana no puedo"). Sirve para avisarle a Cosaco
// que evalúe una suspensión — no toma ninguna acción automática.
function esAvisoDeAusencia(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  const meses = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
  const dejar = /\b(dej(o|a|as|ar|are|ara|aria|amos|an|e) de (ir|asistir|entrenar|venir|jugar|entrenamiento|las clases|hockey)|voy a dejar|quiero dejar|pienso dejar|voy a dejarlo|no voy a seguir|no (voy|vengo|asisto|entreno) mas|no (va|viene|asiste) mas|no vuelvo mas|me doy de baja|dar(me)? de baja|darla de baja|quiero pausar|pausar (el|mi|la|este)|me tomo (un|unos|una) (descanso|tiempo|receso|mes|meses|semanas)|dejo por un tiempo|dejo (el gym|hockey|el gimnasio|el club)|me bajo|voy a faltar (todo|el))\b/;
  const mesNo = /\b(este mes|el mes que viene|el proximo mes|proximo mes|todo el mes|el resto del mes|en el mes)\b[^]*\bno\b[^]*\b(voy|va|asisto|asiste|entreno|entrena|vengo|viene|puedo|podra|va a ir|voy a ir)\b|\bno\b[^]*\b(voy|va|asisto|asiste|entreno|entrena|vengo|viene|ire|ira)\b[^]*\b(este mes|en el mes|el mes que viene|todo el mes|el resto del mes)\b/;
  const vuelvo = new RegExp('\\b(vuelvo|vuelve|volvera|volveria|volvere|regreso|regresa|regresara|retomo|retoma|retomara|reanudo|reanuda|arranco|arranca|arrancara|empiezo|empieza|reincorpora|reincorporo)\\b[^]{0,25}?\\b(en|el|a|para|despues de|luego de|dentro de|recien|a partir de|el mes que viene)?\\s*(' + meses + '|mes que viene|proximo mes|mes siguiente|a(n|ñ)?o que viene|\\d+\\s*mes)');
  const hasta = new RegExp('\\bhasta\\b[^]{0,30}(' + meses + '|el mes que viene|proximo mes|a(n|ñ)?o que viene)[^]{0,20}\\bno\\b[^]{0,15}\\b(voy|va|vengo|viene|asisto|entreno)\\b');
  return dejar.test(t) || mesNo.test(t) || vuelvo.test(t) || hasta.test(t);
}

// ¿El cliente quiere pagar AHORA / pregunta cómo pagar? (sin marcador de futuro).
// Dispara el flujo de pago guiado. OJO: esPromesaFutura se chequea ANTES, así que
// "voy a pagar el viernes" no llega acá (es promesa).
function quierePagar(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return false;
  return /\b(quiero pagar|voy a pagar|quisiera pagar|querria pagar|necesito pagar|quiero abonar|voy a abonar|quiero transferir|voy a transferir|paso a pagar|vengo a pagar|quiero (hacer|realizar) (el|un) pago|como (te )?(pago|abono|transfiero|hago el pago)|donde (pago|deposito|transfiero|abono)|a que (alias|cuenta|cbu)|cual es el alias|quiero (dejar|registrar) (el|mi) pago)\b/.test(t);
}

// Parsea una fecha escrita por Cosaco a formato ISO (yyyy-mm-dd). Acepta:
// "hoy", "ayer", "mañana", "20/08/2026", "20-08-2026", "20/8/26", "20/08"
// (año actual). Devuelve null si no reconoce una fecha válida.
function parsearFechaInicio(texto, hoyDate) {
  const hoy = hoyDate instanceof Date ? hoyDate : new Date();
  const raw = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!raw) return null;
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const armar = (y, mo, d) => {
    y = parseInt(y, 10); mo = parseInt(mo, 10); d = parseInt(d, 10);
    if (String(y).length === 2) y = 2000 + y;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    // Rechazar fechas inexistentes (ej: 31/02 → JS la corre a marzo)
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return iso(dt);
  };
  if (/\bhoy\b/.test(raw)) return iso(hoy);
  if (/\bayer\b/.test(raw)) { const d = new Date(hoy); d.setDate(d.getDate() - 1); return iso(d); }
  if (/\bmanana\b/.test(raw)) { const d = new Date(hoy); d.setDate(d.getDate() + 1); return iso(d); }
  let m = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);      // yyyy-mm-dd
  if (m) return armar(m[1], m[2], m[3]);
  m = raw.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);        // dd/mm/yyyy
  if (m) return armar(m[3], m[2], m[1]);
  // "20 de agosto [de 2026]" / "20 agosto"
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
  m = raw.match(/\b(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+(?:de\s+)?(\d{2,4}))?/);
  if (m) {
    let idx = meses.indexOf(m[2]);
    if (idx === 9) idx = 8; // setiembre = septiembre
    if (idx >= 0) return armar(m[3] || hoy.getFullYear(), idx + 1, m[1]);
  }
  m = raw.match(/\b(\d{1,2})[-/.](\d{1,2})\b/);                  // dd/mm (año actual)
  if (m) return armar(hoy.getFullYear(), m[2], m[1]);
  return null;
}

// ¿El mensaje es una cortesía / no-nombre? (para no tratar "gracias", "ok", "dale"
// como si fueran el nombre de la jugadora cuando el bot está esperando un nombre.)
function esCortesia(texto) {
  const t = normalizarTexto(texto);
  if (!t) return true;
  return /^(gracias+|muchas gracias|mil gracias|graciasss*|ok|oka|okey|okay|dale|listo|lista|perfecto|barbaro|buenisimo|genial|de nada|joya|copado|copada|si|sii+|no|nop|hola+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|chau|saludos|excelente|va|vale|👍|🙏|❤️)$/.test(t);
}

// Un monto es válido para registrar un pago solo si es un número > 0.
function montoValido(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0;
}

// ¿Cosaco escribió un comando para arrancar la confirmación de pagos?
// (flujo determinístico de a uno; nunca lo maneja la IA)
function esComandoConfirmarPagos(texto) {
  return /^(pendientes?|confirmar( pagos?)?|confirmemos|ver pendientes|revisar pendientes)$/i.test(String(texto || '').trim());
}

// ── TELÉFONOS ──────────────────────────────────────────────────────────────

// Normaliza cualquier formato de teléfono argentino a "whatsapp:+549XXXXXXXXXX".
// Unifica las variantes inconsistentes que había en el código (slice(2) vs
// slice(3)): siempre deja el número nacional de 10 dígitos (área + número) y le
// antepone 549, que es lo que exige WhatsApp para Argentina.
function normalizarWhatsApp(telefono) {
  let tel = String(telefono || '').replace(/[^\d]/g, '');
  // Sacar prefijos de país/celular en cualquier orden habitual
  if (tel.startsWith('549')) tel = tel.slice(3);
  else if (tel.startsWith('54')) tel = tel.slice(2);
  if (tel.startsWith('9') && tel.length === 11) tel = tel.slice(1);
  tel = tel.slice(-10); // nacional: 10 dígitos (código de área + número)
  return `whatsapp:+549${tel}`;
}

// Devuelve solo los últimos 10 dígitos, para buscar clientes por teléfono.
function telefonoNacional(telefono) {
  let tel = String(telefono || '').replace(/[^\d]/g, '');
  if (tel.startsWith('549')) tel = tel.slice(3);
  else if (tel.startsWith('54')) tel = tel.slice(2);
  if (tel.startsWith('9') && tel.length === 11) tel = tel.slice(1);
  return tel.slice(-10);
}

module.exports = {
  suenaAPago,
  esPagoRealizado,
  esPromesaFutura,
  esComandoConfirmarPagos,
  parsearMonto,
  montoValido,
  normalizarWhatsApp,
  telefonoNacional,
  normalizarTexto,
  nombreCoincide,
  filtrarClientesPorNombre,
  limpiarNombreBuscado,
  esCortesia,
  esAvisoDeAusencia,
  parsearFechaInicio,
  esSaludo,
  matchOpcionMenu,
  quierePagar,
  esInscripcion,
};
