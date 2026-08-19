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

test('esPromesaFutura detecta promesas (con marcador de futuro), no pagos hechos', () => {
  assert.ok(g.esPromesaFutura('voy a pagar el viernes'));
  assert.ok(g.esPromesaFutura('esta semana pago'));
  assert.ok(g.esPromesaFutura('te pago cuando cobre'));
  // "quiero pagar" (sin futuro) YA NO es promesa: abre el flujo de pago guiado
  assert.strictEqual(g.esPromesaFutura('quiero pagar'), false);
});

test('quierePagar detecta intención de pagar ahora (y no promesas futuras)', () => {
  for (const t of ['quiero pagar', 'voy a pagar', 'como pago', 'donde deposito', 'cual es el alias', 'quiero abonar', 'quiero hacer el pago']) {
    assert.ok(g.quierePagar(t), `debería querer pagar: "${t}"`);
  }
  for (const t of ['te pago el viernes', 'gracias', 'hola', 'no puedo pagar ahora']) {
    // estas no deben abrir el flujo (son promesa/cortesía/saludo)
    assert.ok(!g.quierePagar(t) || g.esPromesaFutura(t), `no debería abrir flujo directo: "${t}"`);
  }
});

test('"ya pagué" es realizado y NO promesa (no se confunden)', () => {
  const txt = 'ya pagué';
  assert.ok(g.esPagoRealizado(txt) && !g.esPromesaFutura(txt));
});

test('"voy a pagar" es promesa y NO realizado', () => {
  const txt = 'voy a pagar mañana';
  assert.ok(g.esPromesaFutura(txt) && !g.esPagoRealizado(txt));
});

// Regresión: frases de pago FUTURO que antes el bot confundía con "ya pagó" y
// respondía "¿cuánto transferiste?". Todas deben ser promesa y NO realizado.
test('promesas futuras NUNCA se toman como pago realizado', () => {
  for (const txt of [
    'mañana te pago',
    'te pago el viernes',
    'te pago cuando cobre',
    'el jueves te transfiero',
    'la semana que viene pago',
    'el lunes te deposito',
    'ahora no puedo, la semana que viene te transfiero',
    'a fin de mes te abono',
    'apenas cobre te pago',
    'el finde te paso la plata',
    'necesito pagar pero puedo el lunes',
  ]) {
    assert.ok(g.esPromesaFutura(txt), `debería ser promesa: "${txt}"`);
    assert.strictEqual(g.esPagoRealizado(txt), false, `NO debería ser pago hecho: "${txt}"`);
  }
});

// Pagos ya hechos que deben seguir clasificándose como realizados.
test('pagos ya hechos se detectan como realizados (y no promesa)', () => {
  for (const txt of [
    'ya pagué',
    'ya te transferí',
    'recién deposité',
    'acabo de transferir 35000',
    'te pasé el comprobante',
    'listo, aboné en efectivo',
    'hice la transferencia',
  ]) {
    assert.ok(g.esPagoRealizado(txt), `debería ser pago hecho: "${txt}"`);
    assert.strictEqual(g.esPromesaFutura(txt), false, `NO debería ser promesa: "${txt}"`);
  }
});

// ── Resolución de nombres: no registrar al cliente equivocado ───────────────
test('nombreCoincide exige nombre Y apellido (no confunde homónimos)', () => {
  assert.strictEqual(g.nombreCoincide('Martina Munar', 'Martina Chaparro'), false);
  assert.strictEqual(g.nombreCoincide('Delfina Coronel', 'Delfina Chavez'), false);
  assert.ok(g.nombreCoincide('Martina Munar', 'Martina Munar'));
  assert.ok(g.nombreCoincide('martina munar', 'Martina Belén Munar')); // apellido presente
  assert.ok(g.nombreCoincide('Martina', 'Martina Chaparro'));          // solo pila → calza
  assert.ok(g.nombreCoincide('Muñoz', 'Ana Munoz'));                    // acentos/ñ
});

test('filtrarClientesPorNombre descarta el homónimo de otro apellido', () => {
  const clientes = [
    { id: 1, nombre: 'Martina Chaparro' },
    { id: 2, nombre: 'Martina Munar' },
  ];
  const r = g.filtrarClientesPorNombre('Martina Munar', clientes);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, 2);
});

test('filtrarClientesPorNombre detecta fichas duplicadas del mismo nombre', () => {
  const clientes = [
    { id: 324, nombre: 'Delfina Coronel' },
    { id: 65, nombre: 'Delfina Coronel' },
    { id: 9, nombre: 'Delfina Chavez' },
  ];
  const r = g.filtrarClientesPorNombre('Delfina Coronel', clientes);
  assert.strictEqual(r.length, 2); // las dos Coronel, NO la Chavez
});

// ── Limpieza de muletillas y cortesías (casos reales que fallaron) ──────────
test('limpiarNombreBuscado saca muletillas de pago del nombre', () => {
  assert.strictEqual(g.limpiarNombreBuscado('mercedes Rimini? Pago'), 'mercedes rimini');
  assert.strictEqual(g.limpiarNombreBuscado('Lola Godoy por favor'), 'lola godoy');
  assert.strictEqual(g.limpiarNombreBuscado('Gómez Olga Monto'), 'gomez olga');
  assert.strictEqual(g.limpiarNombreBuscado('Delfina Coronel pago 29000 transferencia'), 'delfina coronel');
});

test('el nombre limpio ahora sí matchea a la ficha', () => {
  const clientes = [{ id: 1, nombre: 'Mercedes Rimini' }, { id: 2, nombre: 'Lola Godoy' }];
  assert.ok(g.nombreCoincide(g.limpiarNombreBuscado('mercedes Rimini? Pago'), 'Mercedes Rimini'));
  assert.ok(g.nombreCoincide(g.limpiarNombreBuscado('Lola Godoy por favor'), 'Lola Godoy'));
});

test('esCortesia detecta agradecimientos/OK, no nombres reales', () => {
  for (const t of ['gracias', 'Gracias!', 'ok', 'dale', 'listo', 'perfecto', 'muchas gracias', '👍']) {
    assert.ok(g.esCortesia(t), `debería ser cortesía: "${t}"`);
  }
  for (const t of ['Mercedes Rimini', 'Lola Godoy', 'Olga Gomez']) {
    assert.strictEqual(g.esCortesia(t), false, `NO debería ser cortesía: "${t}"`);
  }
});

// ── Aviso de ausencia / baja (para avisar a Cosaco y evaluar suspensión) ────
test('esAvisoDeAusencia detecta bajas y ausencias largas', () => {
  for (const t of [
    'dejará de asistir', 'dejo de ir al gym', 'este mes no voy a ir',
    'este mes no va a ir', 'voy a dejar hockey', 'quiero pausar este mes',
    'me tomo un descanso', 'vuelvo en marzo', 'recién vuelve en agosto',
    'vuelve el mes que viene', 'me doy de baja', 'no voy a venir este mes',
    'vuelvo el año que viene',
  ]) {
    assert.ok(g.esAvisoDeAusencia(t), `debería avisar: "${t}"`);
  }
});

test('esAvisoDeAusencia NO se dispara con ausencias de un día ni charla normal', () => {
  for (const t of [
    'hoy no voy a poder ir', 'no voy a ir a la clase de hoy', 'mañana no voy',
    'gracias nos vemos', 'ya pagué', 'te pago el viernes', 'vuelvo el lunes',
    'quiero cambiar mi turno', 'hola como estan',
  ]) {
    assert.strictEqual(g.esAvisoDeAusencia(t), false, `NO debería avisar: "${t}"`);
  }
});

// ── parsearFechaInicio: fecha de inicio para reactivar ──────────────────────
test('parsearFechaInicio entiende formatos comunes', () => {
  const hoy = new Date(2026, 7, 20); // 20 ago 2026
  assert.strictEqual(g.parsearFechaInicio('hoy', hoy), '2026-08-20');
  assert.strictEqual(g.parsearFechaInicio('ayer', hoy), '2026-08-19');
  assert.strictEqual(g.parsearFechaInicio('20/08/2026', hoy), '2026-08-20');
  assert.strictEqual(g.parsearFechaInicio('5/9/2026', hoy), '2026-09-05');
  assert.strictEqual(g.parsearFechaInicio('20-08-26', hoy), '2026-08-20');
  assert.strictEqual(g.parsearFechaInicio('1/12', hoy), '2026-12-01');
  assert.strictEqual(g.parsearFechaInicio('15 de julio de 2026', hoy), '2026-07-15');
  assert.strictEqual(g.parsearFechaInicio('3 de setiembre', hoy), '2026-09-03');
});

test('parsearFechaInicio rechaza fechas inválidas o texto suelto', () => {
  const hoy = new Date(2026, 7, 20);
  assert.strictEqual(g.parsearFechaInicio('31/02/2026', hoy), null);
  assert.strictEqual(g.parsearFechaInicio('hola', hoy), null);
  assert.strictEqual(g.parsearFechaInicio('si', hoy), null);
  assert.strictEqual(g.parsearFechaInicio('', hoy), null);
});

// ── Menú guiado ─────────────────────────────────────────────────────────────
test('esSaludo reconoce saludos y no confunde otras frases', () => {
  for (const t of ['hola', 'Hola!', 'buenas', 'buen dia', 'buenos dias', 'buenas noches', 'menu']) {
    assert.ok(g.esSaludo(t), `debería ser saludo: "${t}"`);
  }
  for (const t of ['ya pagué 35000', 'quiero pagar', 'modificar turno', '35000']) {
    assert.strictEqual(g.esSaludo(t), false, `NO debería ser saludo: "${t}"`);
  }
});

test('matchOpcionMenu entiende número y texto', () => {
  assert.strictEqual(g.matchOpcionMenu('1'), 1);
  assert.strictEqual(g.matchOpcionMenu('cargar un pago'), 1);
  assert.strictEqual(g.matchOpcionMenu('pagar'), 1);
  assert.strictEqual(g.matchOpcionMenu('2'), 2);
  assert.strictEqual(g.matchOpcionMenu('modificar un turno'), 2);
  assert.strictEqual(g.matchOpcionMenu('3'), 3);
  assert.strictEqual(g.matchOpcionMenu('estado de cuenta'), 3);
  assert.strictEqual(g.matchOpcionMenu('4'), 4);
  assert.strictEqual(g.matchOpcionMenu('informacion del gimnasio'), 4);
  assert.strictEqual(g.matchOpcionMenu('5'), 5);
  assert.strictEqual(g.matchOpcionMenu('enviar un mensaje al equipo'), 5);
  assert.strictEqual(g.matchOpcionMenu('cualquier cosa rara'), null);
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
