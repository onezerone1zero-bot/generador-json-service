// Extrae y parsea el JSON de la respuesta de una IA. Misma lógica que
// generador-service-main/src/lib/mistral.js: si la respuesta se corta por
// límite de maxTokens a mitad de un string largo (fácil que pase acá, con
// 60 preguntas por tema), el parseo directo falla -- esto intenta
// recuperar el bloque igual en vez de perder toda la ronda.
// Compartida entre claude.js y mistral.js para no duplicarla.
export function extraerJson(texto, origen) {
  const limpio = texto.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(limpio);
  } catch {
    // seguimos abajo
  }

  const inicio = texto.indexOf("{");
  if (inicio === -1) {
    throw new Error(`No se pudo parsear JSON de ${origen}: no se encontró un bloque JSON válido\nTexto crudo:\n${texto}`);
  }

  let profundidad = 0;
  let dentroString = false;
  let escapando = false;

  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (escapando) {
      escapando = false;
      continue;
    }
    if (c === "\\") {
      escapando = true;
      continue;
    }
    if (c === '"') {
      dentroString = !dentroString;
      continue;
    }
    if (dentroString) continue;
    if (c === "{") profundidad++;
    if (c === "}") {
      profundidad--;
      if (profundidad === 0) {
        const bloque = texto.slice(inicio, i + 1);
        try {
          return JSON.parse(bloque);
        } catch (err) {
          throw new Error(`No se pudo parsear JSON de ${origen}: ${err.message}\nTexto crudo:\n${texto}`);
        }
      }
    }
  }

  // Se acabó el texto con profundidad > 0: quedó truncado. Recuperación
  // heurística igual que en mistral.js/anthropic.js del otro service.
  let bloque = texto.slice(inicio);
  if (dentroString) bloque += '"';
  bloque += "}".repeat(Math.max(profundidad, 0));

  try {
    const resultado = JSON.parse(bloque);
    console.warn(
      `[${origen}] JSON venía truncado (probable límite de maxTokens); ` +
      "se recuperó cerrando el bloque de forma heurística. Revisar si el contenido recuperado es completo."
    );
    return resultado;
  } catch {
    throw new Error(`No se pudo parsear JSON de ${origen}: no se encontró un bloque JSON válido\nTexto crudo:\n${texto}`);
  }
}
