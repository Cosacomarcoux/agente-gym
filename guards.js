// ============================================================================
//  guards.js — Lógica pura y testeable del bot
//  Acá vive la lógica de decisión crítica (la que causó los bugs históricos),
//  centralizada en un solo lugar para que no "derive" entre los 7 puntos del
//  código donde se procesan pagos. Sin dependencias externas: 100% testeable.
// ============================================================================

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
  const intencionExplicita = /(quiero|voy a|puedo|quisiera|querr[ií]a|necesito|pienso|tengo que|deber[ií]a) (pagar|transferir|depositar|abonar|se[ñn]ar)|c[oó]mo (te )?(pago|hago el pago|abono|transfiero|deposito)|te (pago|transfiero|deposito|mando|paso|abono|se[ñn]o) (despu[eé]s|luego|m[aá]s tarde|m[aá]s adelante|ma[ñn]ana|el |la |los |cuando |apenas |en cuanto |ni bien |a fin|esta semana|la semana|el finde|el fin)|pago (el|la|los) (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|finde|fin|semana|mes|d[ií]a|pr[oó]ximo)|esta semana (pago|te pago|abono|transfiero)|ma[ñn]ana (te )?(pago|abono|transfiero|deposito)/;
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
};
