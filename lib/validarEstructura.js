// Valida la forma de lo que devuelve cada IA antes de guardarlo en KV.
// No valida contenido (eso lo hace el corrector -- Mistral, o Fable
// para exam, ver lib/generar.js), solo que la estructura sea la que
// espera el frontend -- así nunca se guarda un JSON con forma rota,
// sea porque Claude/Fable se mandó cualquier cosa en el borrador o
// porque la corrección vino incompleta.

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
