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
  if (/^4\b/.test(t) || /informacion/.test(t) || /\binfo\b/.test(t) || /gimnasio/.test(t) || /precios?/.test(t) || /\bmontos?\b/.test(t) || /direccion/.test(t) || /donde (queda|estan|es|quedan)/.test(t) || /\bgrupo\b/.test(t) || /(metodos?|formas?|medios?) de pago|como (puedo )?pag|como se paga|donde (pago|deposito|transfiero|deposit)|\balias\b|\bcbu\b|a que (cuenta|alias)/.test(t)) return 4;
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

// Igual que parsearMonto pero PENSADO PARA PAGOS del gimnasio, donde la gente
// escribe informal: "35", "35 mil", "35mil", "35k", "42 lucas", "35mio" (typo de
// "mil"). Como los planes son de decenas de miles, un número "pelado" de 1-3
// dígitos se interpreta como miles (35 → 35000). Devuelve null si no hay monto.
function parsearMontoPago(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t.trim()) return null;
  // 1) Formateado con miles (35.000) o número de 4+ dígitos (35000, 42000)
  let m = t.match(/\$?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{4,})/);
  if (m) {
    const raw = m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  // 2) "35 mil" / "35mil" / "35k" / "35 lucas" / "35mio" / "35mik" (typos) → ×1000
  m = t.match(/(\d{1,3})\s*(mil\w*|mi\w+|lu\w*|palos?|k)\b/);
  if (m) return parseInt(m[1], 10) * 1000;
  // 3) Número pelado de 1-3 dígitos (en contexto de pago) → miles: "35" → 35000
  m = t.match(/(?:^|[^\d])(\d{1,3})(?:[^\d]|$)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 999) return n * 1000;
  }
  return null;
}

// Monto DENTRO DE UNA FRASE de pago ("pagué 35000", "pagué 35 mil", "$35.000").
// A diferencia de parsearMontoPago NO toma números pelados cortos: en una frase
// como "pagué el 5" o "pagué la cuota 2" ese número no es un monto. Se usa en el
// primer mensaje del cliente; parsearMontoPago queda para cuando YA le
// preguntamos "¿cuánto pagaste?" y responde "35".
function parsearMontoFrase(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t.trim()) return null;
  let m = t.match(/\$?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{4,})/);
  if (m) {
    const n = parseFloat(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  m = t.match(/(\d{1,3})\s*(mil\w*|lucas?|k)\b/);
  if (m) return parseInt(m[1], 10) * 1000;
  m = t.match(/\$\s*(\d{2,3})\b/);                 // "$35" → 35000
  if (m) return parseInt(m[1], 10) * 1000;
  return null;
}

// Método de pago mencionado en el texto (por defecto, transferencia).
function parsearMetodo(texto) {
  return /efectivo|efvo|\bcash\b|en mano/i.test(String(texto || '')) ? 'Efectivo' : 'Transferencia';
}

// ¿Respondió que SÍ a una pregunta de confirmación? ("sí", "dale", "correcto"...)
function esAfirmacion(texto) {
  const t = normalizarTexto(texto).replace(/[!.,]+/g, ' ').trim();
  return /^(si+|sip|dale|ok|oka|okey|okay|correcto|exacto|eso|ese|asi es|confirmo|afirmativo|claro|si si|si ese|si correcto|si eso|si dale)( (gracias|graciass*|che|bro|perfecto))?$/.test(t);
}

// "Pagué 35000 por Emilia Medina" / "Pagué 35000 por Emilia Medina y 35000 por
// Sol Medina" / "transferencia de Alfonsina Farhat Nazar". Pagos hechos A NOMBRE
// DE OTRA PERSONA (la mamá que paga la cuota de la hija, dos hermanas, etc.).
// Devuelve [{ nombre, monto|null, metodo }] — solo nombres de 2+ palabras, así
// "pagué 35000 de julio" o "por transferencia" no se confunden con nombres.
function parsearPagosPorTerceros(texto) {
  const s = String(texto || '');
  if (!s.trim()) return [];
  const STOP = new Set(['y', 'e', 'o', 'transferencia', 'transfe', 'transf', 'efectivo', 'efvo', 'mercado', 'pago', 'pagos',
    'mp', 'alias', 'cbu', 'cvu', 'banco', 'cuenta', 'favor', 'mes', 'cuota', 'plan', 'del', 'de', 'con', 'en', 'que', 'el',
    'la', 'los', 'las', 'este', 'esta', 'mi', 'su', 'tu', 'hija', 'hijo', 'hijas', 'hijos', 'nena', 'nene', 'sobrina', 'sobrino',
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre',
    'noviembre', 'diciembre', 'ya', 'hoy', 'ayer', 'recien', 'gracias', 'porfa', 'saludos', 'pesos', 'mil', 'lucas']);
  const SALTAR_INICIO = new Set(['mi', 'la', 'el', 'las', 'los', 'su', 'hija', 'hijo', 'hijas', 'nena', 'nene', 'sobrina', 'sobrino', 'nombre', 'a']);
  // Dónde arranca cada "por/para/de/a nombre de" seguido de un nombre
  const re = /\b(por|para|de)\s+/gi;
  const encontrados = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const resto = s.slice(re.lastIndex);
    const palabras = resto.split(/\s+/);
    const nombre = [];
    let i = 0;
    while (i < palabras.length && SALTAR_INICIO.has(normalizarTexto(palabras[i]))) i++;
    let consumido = 0;
    for (; i < palabras.length && nombre.length < 4; i++) {
      const crudo = palabras[i];
      const limpio = crudo.replace(/[^a-záéíóúñü]/gi, '');
      const norm = normalizarTexto(limpio);
      if (!limpio || STOP.has(norm) || /\d/.test(crudo)) break;
      nombre.push(limpio);
      if (/[.,;:!?\n]$/.test(crudo)) { i++; break; }
    }
    consumido = palabras.slice(0, i).join(' ').length;
    if (nombre.length >= 2) {
      encontrados.push({ nombre: capitalizarNombre(nombre.join(' ')), desde: m.index, hasta: re.lastIndex + consumido });
    }
  }
  if (!encontrados.length) return [];
  return encontrados.map((e, idx) => {
    const antesDesde = idx === 0 ? 0 : encontrados[idx - 1].hasta;
    const despuesHasta = idx + 1 < encontrados.length ? encontrados[idx + 1].desde : s.length;
    const antes = s.slice(antesDesde, e.desde);
    const despues = s.slice(e.hasta, despuesHasta);
    const monto = parsearMontoFrase(antes) || parsearMontoFrase(despues) ||
      (encontrados.length === 1 ? parsearMontoFrase(s) : null);
    return { nombre: e.nombre, monto: monto || null, metodo: parsearMetodo(antes + ' ' + despues) };
  });
}

// ── SEGUIMIENTO: días hábiles y respuesta a "¿querés mantener tu turno?" ────

// Días hábiles (lunes a viernes) transcurridos desde `desdeISO` (excluido) hasta
// `hoyISO` (incluido). Ej: desde viernes → el lunes siguiente da 1.
function diasHabilesDesde(desdeISO, hoyISO) {
  if (!desdeISO || !hoyISO) return 0;
  const d = new Date(String(desdeISO).slice(0, 10) + 'T12:00:00Z');
  const h = new Date(String(hoyISO).slice(0, 10) + 'T12:00:00Z');
  if (!(d < h)) return 0;
  let n = 0;
  for (const x = new Date(d.getTime() + 86400000); x <= h; x.setUTCDate(x.getUTCDate() + 1)) {
    const wd = x.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// Respuesta a "¿querés mantener tu turno?": 'si', 'no' o null (no queda claro).
function respuestaMantenerTurno(texto) {
  const t = normalizarTexto(texto).replace(/[!.,¿?]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const no = /^(no+|nop|nope|no gracias|no quiero|no puedo|no voy a (seguir|ir|poder)|no lo quiero|no lo voy a usar|lo dejo|dejalo|liberalo|libéralo|mejor no|no por ahora|por ahora no|no la verdad|la verdad no)\b|\b(no (quiero|voy a) seguir|lo (dejo|libero)|liber(a|á)(lo|r) el turno|prefiero dejar(lo)?|me doy de baja|darme de baja|dejo de (ir|venir|entrenar))\b/;
  const si = /^(si+|sip|dale|ok|oka|okey|okay|obvio|claro|por supuesto|seguro|sisi|si si|quiero|lo quiero|lo mantengo|mantenelo|confirmo)\b|\b(s[ií] quiero|quiero (seguir|mantener|mi turno|el turno|conservar)|lo (quiero )?mantener|voy a seguir|sigo yendo|me lo guardas|guardamelo|tuve que faltar|no pude ir|me surgio|me surgió)\b/;
  // "No pude ir / tuve que faltar" = faltó pero QUIERE el turno (va primero,
  // porque arranca con "no" y si no se confundiría con un rechazo).
  const faltoPeroSigue = /\b(tuve que faltar|no pude (ir|venir|asistir|entrenar)|me surgio|me enferme|estaba enferm[ao]|s[ií] quiero|quiero (seguir|mantener|mi turno|el turno|conservar))\b/;
  if (faltoPeroSigue.test(t) && !/\b(no (quiero|voy a) seguir|me doy de baja)\b/.test(t)) return 'si';
  if (no.test(t)) return 'no';
  if (si.test(t)) return 'si';
  return null;
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

// Capitaliza un nombre para guardarlo prolijo: "virginia paz bravo" → "Virginia
// Paz Bravo". Deja en minúscula los conectores (de, del, la, los...).
function capitalizarNombre(str) {
  const conectores = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'das', 'do', 'dos']);
  const palabras = String(str || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return palabras
    .map((w, i) => (i > 0 && conectores.has(w)) ? w : (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
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
    'registra', 'registrar', 'registrame', 'registrá', 'confirma', 'confirmar', 'puedes', 'podes', 'podrias',
    'carga', 'cargar', 'cargá', 'cargale', 'anota', 'anotar', 'anotá', 'cobra', 'cobre', 'cobrar', 'cobré',
    'siguiente', 'siguientes', 'jugadora', 'jugadoras', 'jugador', 'jugadores',
    'alumna', 'alumnas', 'alumno', 'alumnos', 'chica', 'chicas', 'chico', 'chicos',
    'mil', 'miles', 'mio', 'mik', 'mils', 'luca', 'lucas', 'palo', 'palos', 'k',
    'pagado', 'pagada', 'pagados', 'ya', 'esta', 'listo', 'lista',
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

// ¿El cliente menciona una LESIÓN / problema físico? → avisar a Cosaco para que
// evalúe si suspende el servicio. No toma acción automática, solo detecta.
function esLesion(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  if (/\b(lesion|esguince|fractur|fisura|rotura|me rompi|desgarr|distension|torcedura|me torci|luxacion|tendinitis|tendon|menisco|ligamento|operad|operacion|cirugia|reposo|recuper|convaleciente|kinesio|fisioterapia|rehabilitacion|yeso|muletas|cabestrillo|me lastime|me golpee|me quebre)/.test(t)) return true;
  if (/\bme duele (el|la|un|una|mi) (rodilla|tobillo|hombro|espalda|cadera|muneca|pie|pierna|brazo|cuello|tendon)\b/.test(t)) return true;
  return false;
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

// Parsea uno o varios pagos escritos en texto libre por Cosaco, en una sola línea
// o en varias, con o sin comas. Reconoce el patrón "Nombre Apellido $monto [método]".
// Devuelve [{ nombre, monto, metodo }]. Es la base para que el REGISTRO de pagos sea
// determinístico (nunca lo maneja la IA, que llegó a inventar "✅ Pago registrado").
// Ej: "María Cruz Allende $35.000 transferencia Máxima Ruiz $42000" →
//     [{nombre:'Maria Cruz Allende',monto:35000,...},{nombre:'Maxima Ruiz',monto:42000,...}]
function parsearPagosLibres(texto) {
  let s = String(texto || '');
  if (!s.trim()) return [];
  // Sacar un preámbulo típico ("(por favor) registrá el pago de las siguientes
  // jugadoras:") para que no ensucie el primer nombre.
  s = s.replace(/^\s*(por\s+favor\s+)?(me\s+)?(pod[eé]s\s+|puedes\s+|podr[ií]as\s+)?(registr[a-záéíóúñ]*|carg[a-záéíóúñ]*|anot[a-záéíóúñ]*|cobr[a-záéíóúñ]*|confirm[a-záéíóúñ]*)?\s*(el|los|las)?\s*pagos?\s+de\b(\s+(la|las|los))?(\s+siguientes?)?(\s+(jugadoras?|alumnas?|alumnos?|chicas?|chicos?))?\s*:?/i, ' ');
  const re = /\$?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{3,})/g;
  const ms = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
    const monto = parseFloat(raw);
    if (Number.isFinite(monto)) ms.push({ monto, start: m.index, end: re.lastIndex });
  }
  if (!ms.length) return [];
  // Saltar un preámbulo ("...registrá el pago de las siguientes jugadoras:")
  // cortando en el último ":" que haya antes del primer monto.
  const pre = s.slice(0, ms[0].start);
  const c0 = pre.lastIndexOf(':');
  let cursor = c0 >= 0 ? c0 + 1 : 0;
  const pagos = [];
  for (let i = 0; i < ms.length; i++) {
    // Nombre: lo que hay antes del monto, pero SOLO de su propio renglón (en una
    // lista, el "beca 50" del renglón anterior se pegaba al nombre siguiente).
    let segCrudo = s.slice(cursor, ms[i].start);
    if (segCrudo.includes('\n')) segCrudo = segCrudo.slice(segCrudo.lastIndexOf('\n') + 1);
    let seg = segCrudo.replace(/\b(con\s+)?beca\s*(del\s+|de\s+)?\d{1,3}\s*%?/gi, ' ');
    // Lo que viene después del monto, hasta el fin del renglón (método / beca)
    let post = s.slice(ms[i].end, i + 1 < ms.length ? ms[i + 1].start : s.length);
    const postLinea = post.includes('\n') ? post.slice(0, post.indexOf('\n')) : post;
    const metodo = /efectivo|efvo|cash/i.test(postLinea) ? 'Efectivo' : 'Transferencia';
    const mBeca = (postLinea + ' ' + segCrudo).match(/beca\s*(?:del\s+|de\s+)?(\d{1,3})\s*%?/i);
    const beca = mBeca ? parseInt(mBeca[1], 10) : null;
    post = postLinea.replace(/\b(con\s+)?beca\s*(del\s+|de\s+)?\d{1,3}\s*%?/gi, ' ');
    // Limpia conectores sueltos al INICIO ("a/el/la") y al FINAL ("...de $42000" →
    // saca el "de", que no es parte del nombre).
    const limpiar = (txt) => limpiarNombreBuscado(txt)
      .replace(/^((el|la|a)\s+)+/g, '')
      .replace(/(\s+(de|del|por|para|a|con|en|y|mediante|via))+$/i, '')
      .trim();
    const valido = (n) => n && n.split(' ').filter(Boolean).length >= 2;
    let nombre = limpiar(seg);
    // Si no hay nombre ANTES del monto, probamos DESPUÉS ("cobré 42000 a Clara Marcoux").
    if (!valido(nombre)) {
      const mPost = post.match(/^\s*(?:a|al|para)\s+([a-záéíóúñ].*)$/i);
      if (mPost) nombre = limpiar(mPost[1]);
    }
    if (valido(nombre)) {
      pagos.push({ nombre: capitalizarNombre(nombre), monto: ms[i].monto, metodo, beca });
    }
    cursor = ms[i].end;
  }
  return pagos;
}

// ¿Cosaco está pidiendo REGISTRAR uno o varios pagos? (palabra de pago + al menos
// un monto reconocible). Si es true, el flujo determinístico toma el control y la
// IA NO interviene. Evita el bug de la IA inventando confirmaciones.
function esPedidoDeRegistroPago(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  const kw = /\b(pag\w*|abon\w*|transf\w*|transfir\w*|deposit\w*|efectivo|efvo|cobr\w*)\b/.test(t);
  return kw && parsearPagosLibres(texto).length >= 1;
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
  parsearMontoPago,
  parsearMontoFrase,
  parsearMetodo,
  esAfirmacion,
  parsearPagosPorTerceros,
  diasHabilesDesde,
  respuestaMantenerTurno,
  parsearPagosLibres,
  esPedidoDeRegistroPago,
  montoValido,
  normalizarWhatsApp,
  telefonoNacional,
  normalizarTexto,
  nombreCoincide,
  filtrarClientesPorNombre,
  capitalizarNombre,
  limpiarNombreBuscado,
  esCortesia,
  esAvisoDeAusencia,
  esLesion,
  parsearFechaInicio,
  esSaludo,
  matchOpcionMenu,
  quierePagar,
  esInscripcion,
};
