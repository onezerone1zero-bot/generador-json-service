// Valida la forma de lo que devuelve cada IA antes de guardarlo en KV.
// No valida contenido (eso lo hace Mistral al corregir), solo que la
// estructura sea la que espera el frontend -- así nunca se guarda un
// JSON con forma rota, sea porque Claude se mandó cualquier cosa o
// porque la corrección de Mistral vino incompleta.

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
 * Valida formulas.json: { formulas: [{ nombre, latex }, ...] }
 */
export function validarFormulas(data) {
  const errores = [];

  if (typeof data !== "object" || data === null) {
    return { ok: false, errores: ["la raíz no es un objeto"] };
  }
  if (!Array.isArray(data.formulas) || data.formulas.length === 0) {
    return { ok: false, errores: ['falta "formulas" o está vacío'] };
  }

  data.formulas.forEach((f, i) => {
    const prefijo = `formulas[${i}]`;
    if (typeof f !== "object" || f === null) {
      error(errores, `${prefijo}: no es un objeto`);
      return;
    }
    if (typeof f.nombre !== "string" || f.nombre.trim() === "") {
      error(errores, `${prefijo}: falta "nombre" o no es string`);
    }
    if (typeof f.latex !== "string" || f.latex.trim() === "") {
      error(errores, `${prefijo}: falta "latex" o no es string`);
    }
  });

  return { ok: errores.length === 0, errores: errores.length > 0 ? errores : null };
}
