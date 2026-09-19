// Valida la forma de lo que devuelve cada IA antes de guardarlo en KV.
// No valida contenido (eso lo hace el corrector -- Mistral, o Fable
// para exam, ver lib/generar.js), solo que la estructura sea la que
// espera el frontend -- así nunca se guarda un JSON con forma rota,
// sea porque Claude/Fable se mandó cualquier cosa en el borrador o
// porque la corrección vino incompleta.

import { compilarFormula } from "./formulaSegura.js";

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
 * expresión que el frontend (visual.js) tiene que poder compilar y
 * graficar de verdad. Por eso la validación real pasa por
 * formulaSegura.js (mismo parser que usa el frontend), no por un chequeo
 * de llaves balanceadas.
 *
 * Cada fórmula se valida por separado. Si una sola no compila, falla todo
 * el visual.json (mismo criterio que validarPreguntas: nunca se guarda un
 * JSON a medias, así el corrector/reintento lo rehace completo).
 */
export const MAX_FORMULAS_VISUAL = 6;

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

    try {
      compilarFormula(texto);
    } catch (err) {
      error(errores, `${prefijo} no compila con la gramática del frontend: ${err.message}`);
    }
  });

  return { ok: errores.length === 0, errores: errores.length > 0 ? errores : null };
}
