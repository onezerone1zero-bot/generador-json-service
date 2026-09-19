import { llamarIA as llamarIAMistral } from "./mistral.js";

// Nombre legible del idioma para el prompt, a partir del código ISO de 2
// letras. Usamos Intl.DisplayNames (nativo de Node) en vez de mantener un
// diccionario a mano -- con 70 idiomas planeados, un dict manual (como
// tenía la versión anterior, con solo en/pt/fr) es deuda técnica seria.
// Si el motor no reconoce el código (raro, pero posible con variantes
// poco comunes), cae de vuelta al código tal cual; Mistral igual suele
// entender un código ISO como referencia de idioma.
let nombresIdioma;
try {
  nombresIdioma = new Intl.DisplayNames(["es"], { type: "language" });
} catch {
  nombresIdioma = null;
}

function nombreIdioma(codigo) {
  try {
    return nombresIdioma?.of(codigo) || codigo;
  } catch {
    return codigo;
  }
}

/**
 * Traduce un término de búsqueda (título de tema) al idioma de esta
 * instancia. Se llama UNA sola vez, al principio del flujo
 * (/aviso-tema-auto, reclasificación en /crear-tema-callback), antes de
 * clasificar o correr IA#2 -- así todo lo que sigue en la cadena (chequeo
 * de duplicados contra el KV de este idioma, tituloNormalizado que decide
 * IA#2, contenido que redacta IA#3) trabaja sobre el mismo término ya
 * traducido, en vez de que cada IA traduzca por su cuenta y arriesgarse a
 * que no coincidan entre sí.
 *
 * FIX (idioma-diffs review): la versión anterior asumía que el término
 * de origen SIEMPRE estaba en español ("Traducís... del español a X" era
 * un texto fijo en el prompt). Eso es incorrecto: el término puede venir
 * de cualquier idioma que estuviera viendo el usuario en el frontend
 * (ej: viendo un tema en inglés, cambia el selector a portugués -- el
 * título reenviado como término de búsqueda está en inglés, no en
 * español), o del aporte de un usuario en analyzer_con_vi -- el propio
 * comentario en /crear-tema-callback (server.js) ya reconocía esto
 * ("no necesariamente el idioma de esta instancia") sin que el código
 * de traducir.js estuviera alineado. Ahora:
 *   - si se conoce el idioma de origen (idiomaOrigen), se lo decimos
 *     explícito a Mistral ("de X a Y"), igual de preciso que antes.
 *   - si no se conoce (caso por defecto, mientras Worker/frontend no
 *     manden ese dato todavía), el prompt le pide a Mistral que detecte
 *     el idioma de origen solo, en vez de asumir español a ciegas.
 *
 * Si esta instancia es la española y no se pasó idiomaOrigen explícito,
 * sigue sin traducir (se asume, como antes, que el término ya está en
 * español) -- ese caso no cambió.
 *
 * Si la traducción falla (Mistral caído, etc.), no corta el flujo: devuelve
 * el término original sin traducir, con un warning en el log. Es mejor
 * intentar clasificar/generar con el término crudo que perder el aviso
 * entero por un fallo de traducción.
 *
 * @param {string} termino
 * @param {string} idioma - idioma DESTINO (el de esta instancia)
 * @param {string|null} [idiomaOrigen] - opcional. Idioma de origen del
 *   término si se conoce (ej: el que estaba viendo el usuario antes de
 *   cambiar el selector, o lo que mande el Worker/analyzer_con_vi en el
 *   futuro). Si no se pasa, o coincide con el idioma destino, no se
 *   fuerza ningún origen y Mistral detecta/skipea solo.
 */
export async function traducirTermino(termino, idioma, idiomaOrigen = null) {
  if (!idioma || idioma === "es") return termino;
  if (idiomaOrigen && idiomaOrigen === idioma) return termino;

  const nombreDestino = nombreIdioma(idioma);
  const nombreOrigen = idiomaOrigen ? nombreIdioma(idiomaOrigen) : null;

  try {
    const system = nombreOrigen
      ? `Traducís términos cortos (títulos de temas de matemática/ciencias) de ${nombreOrigen} a ${nombreDestino}.
Tu única salida es el término traducido, sin comillas, sin explicación, sin texto adicional.
Si el término ya está en ${nombreDestino}, o es un nombre propio/notación que no se traduce (ej: "Teorema de Pitágoras"
mantiene "Pitágoras"), devolvelo tal cual corresponda sin inventar una traducción forzada.`
      : `Traducís términos cortos (títulos de temas de matemática/ciencias) a ${nombreDestino}. El término de
entrada puede venir en cualquier idioma -- detectalo vos mismo a partir del texto, no asumas que es
un idioma en particular.
Tu única salida es el término traducido, sin comillas, sin explicación, sin texto adicional.
Si el término ya está en ${nombreDestino}, o es un nombre propio/notación que no se traduce (ej: "Teorema de Pitágoras"
mantiene "Pitágoras"), devolvelo tal cual corresponda sin inventar una traducción forzada.`;
    const prompt = `Término: "${termino}"`;

    // Tarea trivial (traducir un término corto) -- ministral-3b-2512 tiene
    // 12.5 req/s de cuota vs. 1 req/s de mistral-small-latest, así que esto
    // deja de pisarse con /clasificar (que le pega a Mistral casi al toque).
    const resultado = await llamarIAMistral({ system, prompt, model: "ministral-3b-2512", maxTokens: 100, parseJson: false });
    const traducido = resultado.trim().replace(/^["']|["']$/g, "");

    if (!traducido) {
      console.warn(`[traducir] Mistral devolvió vacío para "${termino}", uso el original sin traducir`);
      return termino;
    }

    console.log(`[traducir] "${termino}"${idiomaOrigen ? ` (${idiomaOrigen})` : ""} -> "${traducido}" (${idioma})`);
    return traducido;
  } catch (err) {
    console.warn(`[traducir] falló traduciendo "${termino}" a ${idioma} (${err.message}), sigo con el original sin traducir`);
    return termino;
  }
}
