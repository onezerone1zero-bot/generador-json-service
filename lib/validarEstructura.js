// Valida la forma de lo que devuelve cada IA antes de guardarlo en KV.
// No valida contenido (eso lo hace el corrector -- Mistral, o Fable/Opus
// para exam/visual, ver lib/generar.js), solo que la estructura sea la
// que espera el frontend -- así nunca se guarda un JSON con forma rota,
// sea porque Claude/Fable se mandó cualquier cosa en el borrador o
// porque la corrección vino incompleta.

import { compilarFormula, compilarImplicita, compilarParametricaMultilinea, detectarTipoFormula } from "./formulaSegura.js";

function error(errores, msg) {
  errores.push(msg);
}

function validarPregunta(p, i, errores) {
  const prefijo = `pregunta[${i}]`;
  if (typeof p !== "object" || p === null) {
    error(errores, `${prefijo}: no es un objeto`);
    return;
  }
  if (typeof p.enunciado !== "string" || p.enunciado.trim() === "") {
    error(errores, `${prefijo}: falta "enunciado" o no es string`);
  }
  if (!Array.isArray(p.opciones) || p.opciones.length !== 4) {
    error(errores, `${prefijo}: "opciones" tiene que ser un array de 4 elementos`);
  } else if (p.opciones.some((o) => typeof o !== "string" || o.trim() === "")) {
    error(errores, `${prefijo}: alguna opción está vacía o no es string`);
  }
  if (
    typeof p.respuesta_correcta !== "number" ||
    !Number.isInteger(p.respuesta_correcta) ||
    p.respuesta_correcta < 0 ||
    p.respuesta_correcta > 3
  ) {
    error(errores, `${prefijo}: "respuesta_correcta" tiene que ser un entero entre 0 y 3`);
  }
  if (typeof p.explicacion !== "string" || p.explicacion.trim() === "") {
    error(errores, `${prefijo}: falta "explicacion" o no es string`);
  }
}

/**
 * Valida practice.json / exam.json: { modelos: [{ premium, preguntas: [...] }, ...] }
 */
export function validarPreguntas(data) {
  const errores = [];

  if (typeof data !== "object" || data === null) {
    return { ok: false, errores: ["la raíz no es un objeto"] };
  }
  if (!Array.isArray(data.modelos) || data.modelos.length === 0) {
    return { ok: false, errores: ['falta "modelos" o está vacío'] };
  }

  data.modelos.forEach((modelo, i) => {
    const prefijo = `modelos[${i}]`;
    if (typeof modelo !== "object" || modelo === null) {
      error(errores, `${prefijo}: no es un objeto`);
      return;
    }
    if (typeof modelo.premium !== "boolean") {
      error(errores, `${prefijo}: falta "premium" o no es boolean`);
    }
    if (!Array.isArray(modelo.preguntas) || modelo.preguntas.length === 0) {
      error(errores, `${prefijo}: falta "preguntas" o está vacío`);
      return;
    }
    modelo.preguntas.forEach((p, j) => validarPregunta(p, j, errores));
  });

  return { ok: errores.length === 0, errores: errores.length > 0 ? errores : null };
}

/**
 * Valida formulas.json: { formula: "string LaTeX" }
 */
export function validarFormulas(data) {
  const errores = [];

  if (typeof data !== "object" || data === null) {
    return { ok: false, errores: ["la raíz no es un objeto"] };
  }
  if (typeof data.formula !== "string" || data.formula.trim() === "") {
    error(errores, 'falta "formula" o no es string');
    return { ok: errores.length === 0, errores: errores.length > 0 ? errores : null };
  }

  // Chequeo barato de llaves { } balanceadas -- no valida LaTeX de
  // verdad, pero atrapa el caso típico de un output truncado a mitad
  // de generación (ej: "\begin{gathered}...\end{gathered" sin cerrar,
  // o un \frac{...} que se cortó). Mismo criterio que llavesBalanceadas
  // en generador-service-main/src/lib/sanitizar.js.
  const abiertas = (data.formula.match(/{/g) || []).length;
  const cerradas = (data.formula.match(/}/g) || []).length;
  if (abiertas !== cerradas) {
    error(errores, `"formula" tiene llaves { } desbalanceadas (${abiertas} abiertas, ${cerradas} cerradas) -- probable LaTeX truncado`);
  }

  return { ok: errores.length === 0, errores: errores.length > 0 ? errores : null };
}

/**
 * Valida visual.json. Formato nuevo:
 *   { formulas: [ "expr", ... ] }   o   { formulas: [ { formula, color? }, ... ] }
 * Formato viejo (se sigue aceptando):
 *   { formula: "expr" }
 *
 * OJO: es un "formula" homónimo del de validarFormulas() arriba, pero NO
 * es lo mismo -- ahí es LaTeX para mostrar (título del tema); acá es una
 * expresión (explícita, implícita o paramétrica -- ver formulaSegura.js)
 * que el frontend (visual.js) tiene que poder compilar y graficar de
 * verdad. Por eso la validación real pasa por formulaSegura.js (mismo
 * parser que usa el frontend), no por un chequeo de llaves balanceadas.
 *
 * Cada fórmula se valida por separado. Si una sola no compila (o compila
 * pero no se ve bien, ver formulaSeVeBien), falla todo el visual.json
 * (mismo criterio que validarPreguntas: nunca se guarda un JSON a medias,
 * así el corrector/reintento lo rehace completo).
 */
export const MAX_FORMULAS_VISUAL = 6;

// Chequeo de "se ve bien" -- compilar* ya garantiza que la fórmula
// respeta la gramática, pero eso no dice nada sobre si el resultado
// sirve para algo: puede ser constante, indefinida en casi todo el
// rango, dispararse fuera de cámara, o (implícita) no tener solución
// real visible, o (paramétrica) colapsar a un punto o una curva 1D en
// vez de una superficie. Este chequeo samplea la fórmula ya compilada y
// descarta esos casos antes de guardar. La heurística concreta depende
// del formato -- ver chequearExplicita/chequearImplicita/chequearParametrica.
//
// RANGO_MUESTREO=±10 es una aproximación al rango 2D que ve el usuario
// al abrir el graficador (PPU_INICIAL=70 en visual.js, canvas típico
// ~700-900px -> rango visible real de ~±5 a ±7), no un cálculo exacto
// del tamaño de canvas real del usuario -- alcanza para descartar los
// casos obvios, que es todo lo que este chequeo pretende hacer. Para
// paramétrica se usa el rango por defecto documentado en el prompt:
// u∈[0,2π], v∈[-1,1].
const RANGO_MUESTREO = 10;
const PUNTOS_X = 6;
const PUNTOS_Y = 5;
const PUNTOS_IMPLICITA_3D = 5; // grilla más chica por eje cuando hay x,y,z (5^3=125 puntos)
const VALOR_MAXIMO_RAZONABLE = 1000; // más allá de esto, la curva/superficie ya quedó muy lejos de la vista default
const EPSILON_VARIACION = 1e-6;

function rango(valores) {
  if (valores.length === 0) return 0;
  return Math.max(...valores) - Math.min(...valores);
}

// --- Explícita: f(x,y) ---

function chequearExplicita(evaluador) {
  const total = PUNTOS_X * PUNTOS_Y;
  const muestras = [];
  for (let i = 0; i < PUNTOS_X; i++) {
    const x = -RANGO_MUESTREO + (2 * RANGO_MUESTREO * i) / (PUNTOS_X - 1);
    for (let j = 0; j < PUNTOS_Y; j++) {
      const y = -RANGO_MUESTREO + (2 * RANGO_MUESTREO * j) / (PUNTOS_Y - 1);
      const valor = evaluador(x, y);
      if (Number.isFinite(valor)) muestras.push(valor);
    }
  }

  if (muestras.length < total * 0.5) {
    return { ok: false, motivo: `indefinida (NaN) en ${total - muestras.length}/${total} puntos del rango de muestreo` };
  }
  const min = Math.min(...muestras);
  const max = Math.max(...muestras);
  if (max - min < EPSILON_VARIACION) {
    return { ok: false, motivo: `constante (≈${min.toFixed(4)}) en todo el rango de muestreo` };
  }
  const maximoAbsoluto = Math.max(Math.abs(min), Math.abs(max));
  if (maximoAbsoluto > VALOR_MAXIMO_RAZONABLE) {
    return { ok: false, motivo: `se dispara a valores extremos (hasta ${maximoAbsoluto.toExponential(2)}) dentro del rango de muestreo -- queda fuera de la vista default` };
  }
  return { ok: true };
}

// --- Implícita: izquierda=derecha, en x/y o x/y/z ---
// No hay "rango de valores de la curva" (el evaluador da izq-der, no la
// curva en sí) -- lo que importa es que realmente tenga solución real
// visible: que izq-der cambie de signo (toque cero) dentro del rango de
// muestreo. Si un lado domina siempre al otro (nunca cambia de signo),
// la curva/superficie no pasa por la vista default.

function chequearImplicita(evaluador) {
  const puntos = evaluador.usaZ ? PUNTOS_IMPLICITA_3D : PUNTOS_X;
  const puntosY = evaluador.usaZ ? PUNTOS_IMPLICITA_3D : PUNTOS_Y;
  const puntosZ = evaluador.usaZ ? PUNTOS_IMPLICITA_3D : 1;
  const total = puntos * puntosY * puntosZ;

  const muestras = [];
  for (let i = 0; i < puntos; i++) {
    const x = -RANGO_MUESTREO + (2 * RANGO_MUESTREO * i) / (puntos - 1);
    for (let j = 0; j < puntosY; j++) {
      const y = -RANGO_MUESTREO + (2 * RANGO_MUESTREO * j) / (puntosY - 1);
      if (evaluador.usaZ) {
        for (let k = 0; k < puntosZ; k++) {
          const z = -RANGO_MUESTREO + (2 * RANGO_MUESTREO * k) / (puntosZ - 1);
          const valor = evaluador(x, y, z);
          if (Number.isFinite(valor)) muestras.push(valor);
        }
      } else {
        const valor = evaluador(x, y, 0);
        if (Number.isFinite(valor)) muestras.push(valor);
      }
    }
  }

  if (muestras.length < total * 0.5) {
    return { ok: false, motivo: `indefinida (NaN) en ${total - muestras.length}/${total} puntos del rango de muestreo` };
  }
  const min = Math.min(...muestras);
  const max = Math.max(...muestras);
  // Identidad trivial (ej. "x=x", izq-der ≈ 0 en TODO el rango, sin
  // variación): no describe una curva/superficie real, cualquier punto
  // "cumple" -- se rechaza antes del chequeo de signo porque ahí
  // min<=0<=max daría falso positivo.
  if (max - min < EPSILON_VARIACION) {
    return {
      ok: false,
      motivo: Math.abs(min) < EPSILON_VARIACION
        ? "es una identidad trivial (izquierda−derecha ≈ 0 en todo el rango) -- cualquier punto del plano la cumple, no describe una curva"
        : `constante (izquierda−derecha ≈${min.toFixed(4)}) en todo el rango de muestreo`,
    };
  }
  if (!(min <= 0 && max >= 0)) {
    return {
      ok: false,
      motivo: `no cambia de signo en el rango de muestreo (queda siempre ${min > 0 ? "positiva" : "negativa"}) -- no tiene solución real visible`,
    };
  }
  return { ok: true };
}

// --- Paramétrica: (x,y,z)(u,v), tres líneas ---
// Además de indefinida/dispara-a-valores-extremos, hay que descartar
// degenerada: las tres componentes constantes (colapsa a un punto), o
// las tres dependiendo solo de u o solo de v (da una curva 1D, no una
// superficie) -- ver la nota de armarPromptClaude sobre este caso.

const PUNTOS_U = 6;
const PUNTOS_V = 5;
const U_MIN = 0;
const U_MAX = 2 * Math.PI;
const V_MIN = -1;
const V_MAX = 1;

function chequearParametrica(evaluador) {
  const total = PUNTOS_U * PUNTOS_V;
  const todas = { x: [], y: [], z: [] };
  let finitos = 0;

  // Variación de cada componente al mover u (v fijo) y al mover v (u fijo)
  // -- para detectar degeneración "depende solo de u" o "solo de v".
  const varioConV = { x: false, y: false, z: false };
  const varioConU = { x: false, y: false, z: false };

  for (let i = 0; i < PUNTOS_U; i++) {
    const u = U_MIN + ((U_MAX - U_MIN) * i) / (PUNTOS_U - 1);
    const filaX = [], filaY = [], filaZ = [];
    for (let j = 0; j < PUNTOS_V; j++) {
      const v = V_MIN + ((V_MAX - V_MIN) * j) / (PUNTOS_V - 1);
      const punto = evaluador(u, v);
      const finito = Number.isFinite(punto.x) && Number.isFinite(punto.y) && Number.isFinite(punto.z);
      if (finito) {
        finitos++;
        todas.x.push(punto.x); todas.y.push(punto.y); todas.z.push(punto.z);
        filaX.push(punto.x); filaY.push(punto.y); filaZ.push(punto.z);
      }
    }
    if (rango(filaX) > EPSILON_VARIACION) varioConV.x = true;
    if (rango(filaY) > EPSILON_VARIACION) varioConV.y = true;
    if (rango(filaZ) > EPSILON_VARIACION) varioConV.z = true;
  }
  for (let j = 0; j < PUNTOS_V; j++) {
    const v = V_MIN + ((V_MAX - V_MIN) * j) / (PUNTOS_V - 1);
    const colX = [], colY = [], colZ = [];
    for (let i = 0; i < PUNTOS_U; i++) {
      const u = U_MIN + ((U_MAX - U_MIN) * i) / (PUNTOS_U - 1);
      const punto = evaluador(u, v);
      if (Number.isFinite(punto.x)) colX.push(punto.x);
      if (Number.isFinite(punto.y)) colY.push(punto.y);
      if (Number.isFinite(punto.z)) colZ.push(punto.z);
    }
    if (rango(colX) > EPSILON_VARIACION) varioConU.x = true;
    if (rango(colY) > EPSILON_VARIACION) varioConU.y = true;
    if (rango(colZ) > EPSILON_VARIACION) varioConU.z = true;
  }

  if (finitos < total * 0.5) {
    return { ok: false, motivo: `indefinida (NaN) en ${total - finitos}/${total} puntos de la grilla u∈[0,2π], v∈[-1,1]` };
  }

  const dependeDeU = varioConU.x || varioConU.y || varioConU.z;
  const dependeDeV = varioConV.x || varioConV.y || varioConV.z;
  if (!dependeDeU && !dependeDeV) {
    return { ok: false, motivo: "degenerada: x, y, z quedan constantes en toda la grilla u/v (colapsa a un punto)" };
  }
  if (!dependeDeV || !dependeDeU) {
    return { ok: false, motivo: `degenerada: las tres componentes dependen solo de ${dependeDeU ? "u" : "v"} -- da una curva, no una superficie` };
  }

  const maximoAbsoluto = Math.max(
    ...todas.x.map(Math.abs), ...todas.y.map(Math.abs), ...todas.z.map(Math.abs),
  );
  if (maximoAbsoluto > VALOR_MAXIMO_RAZONABLE) {
    return { ok: false, motivo: `se dispara a valores extremos (hasta ${maximoAbsoluto.toExponential(2)}) dentro de u∈[0,2π], v∈[-1,1]` };
  }
  return { ok: true };
}

function formulaSeVeBien(tipo, evaluador) {
  if (tipo === "explicita") return chequearExplicita(evaluador);
  if (tipo === "implicita") return chequearImplicita(evaluador);
  if (tipo === "parametrica") return chequearParametrica(evaluador);
  return { ok: false, motivo: `tipo de fórmula desconocido: ${tipo}` };
}

export function validarVisual(data) {
  const errores = [];

  if (typeof data !== "object" || data === null) {
    return { ok: false, errores: ["la raíz no es un objeto"] };
  }

  // Normalizo: formato viejo { formula } -> lista de una.
  let lista;
  if (Array.isArray(data.formulas)) {
    lista = data.formulas;
  } else if (typeof data.formula === "string") {
    lista = [data.formula];
  } else {
    return { ok: false, errores: ['falta "formulas" (array) o "formula" (string)'] };
  }

  if (lista.length === 0) {
    return { ok: false, errores: ['"formulas" está vacío'] };
  }
  if (lista.length > MAX_FORMULAS_VISUAL) {
    return { ok: false, errores: [`"formulas" tiene ${lista.length} items (máximo ${MAX_FORMULAS_VISUAL})`] };
  }

  const vistas = new Set();
  lista.forEach((item, i) => {
    const prefijo = `formulas[${i}]`;
    const texto = typeof item === "string" ? item : (item && typeof item === "object" ? item.formula : undefined);

    if (typeof texto !== "string" || texto.trim() === "") {
      error(errores, `${prefijo}: falta la fórmula o no es string`);
      return;
    }
    if (item && typeof item === "object" && item.color !== undefined && item.color !== null
        && !(typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color))) {
      error(errores, `${prefijo}: "color" tiene que ser un hex #rrggbb`);
    }

    const clave = texto.replace(/\s+/g, "").toLowerCase();
    if (vistas.has(clave)) {
      error(errores, `${prefijo}: fórmula repetida (${texto})`);
      return;
    }
    vistas.add(clave);

    const tipo = detectarTipoFormula(texto);
    try {
      let evaluador;
      if (tipo === "implicita") evaluador = compilarImplicita(texto);
      else if (tipo === "parametrica") evaluador = compilarParametricaMultilinea(texto);
      else evaluador = compilarFormula(texto);

      const chequeoVisual = formulaSeVeBien(tipo, evaluador);
      if (!chequeoVisual.ok) {
        error(errores, `${prefijo} (${tipo}) compila pero no se ve bien: ${chequeoVisual.motivo}`);
      }
    } catch (err) {
      error(errores, `${prefijo} (${tipo}) no compila con la gramática del frontend: ${err.message}`);
    }
  });

  return { ok: errores.length === 0, errores: errores.length > 0 ? errores : null };
}
