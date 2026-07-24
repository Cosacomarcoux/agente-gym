// Tests de la lógica crítica del bot. Correr con: npm test
// Usa el runner nativo de Node (node:test) — sin dependencias extra.
const { test } = require('node:test');
const assert = require('node:assert');
const g = require('../guards');

// ── suenaAPago: el candado contra pagos inventados ──────────────────────────
test('suenaAPago RECHAZA frases que no son pagos', () => {
  for (const txt of [
    'Este mes no voy',
    'gracias',
    'Quiero pausar mi membresia este mes',
    'me doy de baja',
    'dale ok',
    'hola como estas',
    'no puedo ir hoy',
    '',
  ]) {
    assert.strictEqual(g.suenaAPago(txt), false, `debería rechazar: "${txt}"`);
  }
});

test('suenaAPago ACEPTA frases que sí son pagos', () => {
  for (const txt of [
    'ya transferi 35000',
    'pagué el plan, 35000 por transferencia',
    'deposité la plata',
    'te mando el comprobante',
    'ya aboné en efectivo',
    'hice el pago de $29000',
  ]) {
    assert.strictEqual(g.suenaAPago(txt), true, `debería aceptar: "${txt}"`);
  }
});

// ── Clasificación de intención: realizado vs promesa futura ─────────────────
test('esPagoRealizado detecta pagos ya hechos', () => {
  assert.ok(g.esPagoRealizado('ya pagué'));
  assert.ok(g.esPagoRealizado('acabo de transferir'));
  assert.ok(g.esPagoRealizado('hice el pago'));
});

test('esPromesaFutura detecta promesas, no pagos hechos', () => {
  assert.ok(g.esPromesaFutura('voy a pagar el viernes'));
  assert.ok(g.esPromesaFutura('esta semana pago'));
  assert.ok(g.esPromesaFutura('quiero pagar'));
});

test('"ya pagué" es realizado y NO promesa (no se confunden)', () => {
  const txt = 'ya pagué';
  assert.ok(g.esPagoRealizado(txt) && !g.esPromesaFutura(txt));
});

test('"voy a pagar" es promesa y NO realizado', () => {
  const txt = 'voy a pagar mañana';
  assert.ok(g.esPromesaFutura(txt) && !g.esPagoRealizado(txt));
});

// ── parsearMonto: leer el monto del mensaje ─────────────────────────────────
test('parsearMonto lee montos en formatos comunes', () => {
  assert.strictEqual(g.parsearMonto('transferí 35000'), 35000);
  assert.strictEqual(g.parsearMonto('pagué $29.000'), 29000);
  assert.strictEqual(g.parsearMonto('son 39.000 pesos'), 39000);
  assert.strictEqual(g.parsearMonto('35000'), 35000);
});

test('parsearMonto devuelve null si no hay monto', () => {
  assert.strictEqual(g.parsearMonto('ya transferí'), null);
  assert.strictEqual(g.parsearMonto('gracias'), null);
  // "este mes no voy" no debe leerse como un monto
  assert.strictEqual(g.parsearMonto('este mes no voy'), null);
});

// ── montoValido: nunca $0 ni basura ─────────────────────────────────────────
test('montoValido solo acepta números > 0', () => {
  assert.ok(g.montoValido(35000));
  assert.ok(!g.montoValido(0));
  assert.ok(!g.montoValido(-100));
  assert.ok(!g.montoValido(null));
  assert.ok(!g.montoValido('hola'));
  assert.ok(!g.montoValido(undefined));
});

// ── normalizarWhatsApp: unificar el formato de teléfono ─────────────────────
test('normalizarWhatsApp deja siempre whatsapp:+549 + 10 dígitos', () => {
  const esperado = 'whatsapp:+5493854123456';
  assert.strictEqual(g.normalizarWhatsApp('3854123456'), esperado);
  assert.strictEqual(g.normalizarWhatsApp('5493854123456'), esperado);
  assert.strictEqual(g.normalizarWhatsApp('543854123456'), esperado);
  assert.strictEqual(g.normalizarWhatsApp('whatsapp:+5493854123456'), esperado);
  assert.strictEqual(g.normalizarWhatsApp('+54 9 3854 12-3456'), esperado);
});

test('telefonoNacional devuelve 10 dígitos para buscar clientes', () => {
  assert.strictEqual(g.telefonoNacional('5493854123456'), '3854123456');
  assert.strictEqual(g.telefonoNacional('whatsapp:+5493854123456'), '3854123456');
});

// ── El caso real de Josefina (regresión del bug reportado) ──────────────────
test('REGRESIÓN: la conversación de Josefina NO genera un pago', () => {
  const mensajesJosefina = ['Este mes no voy', 'Quiero pausar mi membresia este mes', 'Gracias'];
  for (const m of mensajesJosefina) {
    assert.strictEqual(g.suenaAPago(m), false, `"${m}" no es un pago`);
    assert.strictEqual(g.parsearMonto(m), null, `"${m}" no tiene monto`);
  }
});

// ── El caso real de Justina (regresión: "Hola si!!" no es un pago) ───────────
test('REGRESIÓN: "Hola si!!" y "2 veces x semana" NO son pagos', () => {
  for (const m of ['Hola si!!', 'si!!', '2 veces x semana', 'Alias porfa']) {
    assert.strictEqual(g.suenaAPago(m), false, `"${m}" no es un pago`);
  }
});

// ── Comando de confirmación de pagos (uno por uno) ──────────────────────────
test('esComandoConfirmarPagos reconoce los comandos de Cosaco', () => {
  for (const m of ['pendientes', 'Pendientes', 'confirmar', 'Confirmar', 'confirmar pagos', 'ver pendientes']) {
    assert.ok(g.esComandoConfirmarPagos(m), `debería reconocer: "${m}"`);
  }
});

test('esComandoConfirmarPagos NO se dispara con SÍ/NO ni frases sueltas', () => {
  for (const m of ['si', 'no', 'hola', 'confirmá el pago de Juan', 'quiero confirmar el pago de maria']) {
    assert.strictEqual(g.esComandoConfirmarPagos(m), false, `no debería dispararse: "${m}"`);
  }
});
