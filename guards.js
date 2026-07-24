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

// ¿El cliente dice que YA pagó? (pago realizado, pretérito)
function esPagoRealizado(texto) {
  return /pagu[eé]|pago[^s]|transfer[ií]|hice el pago|acabo de transferir|ya pag/i.test(String(texto || ''));
}

// ¿El cliente dice que va a pagar MÁS ADELANTE? (promesa futura → solo aviso)
function esPromesaFutura(texto) {
  return /quiero pagar|voy a pagar|puedo pagar|c[oó]mo pago|quisiera pagar|despu[eé]s (te |lo )?pago|pago (el|la|los) |esta semana pago/i.test(String(texto || ''));
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
  parsearMonto,
  montoValido,
  normalizarWhatsApp,
  telefonoNacional,
};
