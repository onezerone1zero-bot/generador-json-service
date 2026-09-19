/**
 * Sanitizador determinista de LaTeX generado por IA#3 (Mistral).
 *
 * Por qué existe: pedirle a la IA generadora que "no cometa estos errores"
 * en el prompt reduce la frecuencia pero no la elimina — en la práctica
 * (ver logs de producción) el mismo puñado de patrones rotos reaparece una
 * y otra vez, incluso después de que Claude/Mistral ya lo señalaron en una
 * ronda anterior. Este módulo arregla con código (no con otro prompt) los
 * patrones que sabemos que rompen la compilación y que tienen una
 * corrección inequívoca.
 *
 * Filosofía: solo tocamos patrones donde el fix es 100% seguro y no cambia
 * el contenido matemático/semántico del documento, solo la sintaxis LaTeX
 * rota. Si un patrón es ambiguo (¿cómo se arregla "sin saber qué quiso decir
 * la IA"?), NO lo arreglamos acá: lo detectamos y lo reportamos, para que
 * se vea en los logs en vez de subirse roto o arreglarse mal.
 *
 * Tres formas de uso:
 * - aplicarFixesDeterministas(texs): SOLO aplica los fixes de regex (gratis,
 *   sin llamar a ninguna IA). generar.js la llama ADEMÁS apenas sale cada
 *   ronda de generarConMistral, ANTES de gastar en revisarConMistral /
 *   segundaOpinionClaude — así la revisión paga ya no ve (ni gasta plata
 *   señalando) patrones que esto arregla gratis.
 * - detectarProblemasEstructurales(texs): SOLO detecta (sin arreglar, sin
 *   throw) desbalances que no se pueden corregir con seguridad. generar.js
 *   la usa por ronda para saltear la revisión paga cuando ya sabemos que
 *   esa ronda va a ser rechazada igual por un problema estructural.
 * - sanitizarTex(texs): las dos combinadas, con throw si queda algo roto.
 *   Es el gate final antes de compilar (safety net, sin importar qué haya
 *   pasado en las rondas).
 */

const CAMPOS_TEX = ["teoria_pdf_tex", "teoria_epub_tex", "extra_tex", "practica_tex"];

export function sanitizarTex(texs) {
  const { texs: resultado, cambios } = aplicarFixesDeterministas(texs);

  const problemas = detectarProblemasEstructurales(resultado);
  if (problemas.length > 0) {
    throw new Error(
      `sanitizarTex: quedaron problemas estructurales que no se pueden corregir automáticamente ` +
      `sin saber qué quiso decir la IA — revisar el .tex a mano o regenerar:\n- ${problemas.join("\n- ")}`
    );
  }

  return { texs: resultado, cambios };
}

/**
 * Aplica solo los fixes deterministas (sin chequear balance, sin throw).
 * Pensada para correr apenas se genera un tex, antes de cualquier llamada
 * paga de revisión — ver nota de uso arriba.
 */
export function aplicarFixesDeterministas(texs) {
  const resultado = { ...texs };
  const cambios = [];

  for (const campo of CAMPOS_TEX) {
    if (typeof resultado[campo] !== "string") continue;

    let tex = resultado[campo];
    const cambiosCampo = [];

    tex = fixSaltoDeLineaConArgumento(tex, cambiosCampo);
    tex = fixEntornoMultilineaEnCaja(tex, cambiosCampo);
    tex = fixBackslashAntesSignosInvertidos(tex, cambiosCampo);
    tex = fixShorthandoffFaltante(tex, cambiosCampo);
    tex = fixAmssymb(tex, cambiosCampo); // <--- NUEVO FIX

    if (cambiosCampo.length > 0) {
      resultado[campo] = tex;
      cambios.push(`${campo}: ${cambiosCampo.join("; ")}`);
    }
  }

  return { texs: resultado, cambios };
}

/**
 * Detecta (sin arreglar, sin throw) desbalances de \[ \], \( \) y { } en
 * los 4 campos. Devuelve un array de strings, uno por problema encontrado
 * (vacío si está todo bien) — a diferencia de las versiones viejas de este
 * chequeo, no corta en el primer campo roto: junta todos los problemas de
 * los 4 documentos en una sola pasada, para dar el panorama completo de
 * una sola vez (a quien lo lea, sea un humano o la próxima ronda de IA#3).
 */
export function detectarProblemasEstructurales(texs) {
  const problemas = [];

  for (const campo of CAMPOS_TEX) {
    if (typeof texs[campo] !== "string") continue;
    const sinComentarios = quitarComentarios(texs[campo]);

    const aperturasDisplay = (sinComentarios.match(/(?<!\\)\\\[/g) || []).length;
    const cierresDisplay = (sinComentarios.match(/(?<!\\)\\\]/g) || []).length;
    if (aperturasDisplay !== cierresDisplay) {
      problemas.push(
        `${campo}: hay ${aperturasDisplay} "\\[" pero ${cierresDisplay} "\\]" (deberían ser iguales). ` +
        `Rompe la compilación con una cascada tipo "Missing $ inserted" desde el primer \\[ sin cerrar.`
      );
    }

    const aperturasInline = (sinComentarios.match(/(?<!\\)\\\(/g) || []).length;
    const cierresInline = (sinComentarios.match(/(?<!\\)\\\)/g) || []).length;
    if (aperturasInline !== cierresInline) {
      problemas.push(
        `${campo}: hay ${aperturasInline} "\\(" pero ${cierresInline} "\\)" (deberían ser iguales), ` +
        `mismo problema que \\[/\\] pero en modo inline.`
      );
    }

    if (!llavesBalanceadas(texs[campo])) {
      problemas.push(
        `${campo}: las llaves { } no están balanceadas. Típicamente rompe todo el documento desde ` +
        `el punto del desbalance en adelante.`
      );
    }
  }

  return problemas;
}

/**
 * Fix #1 — el más frecuente en los logs: "\[Npt]" (un solo backslash antes
 * del corchete) donde debería ser "\\[Npt]" (doble backslash = salto de
 * línea de LaTeX con espacio extra). Con un solo backslash, "\[" abre modo
 * matemático display y "Npt]" es contenido inválido ahí adentro, lo que
 * causa la cascada clásica de "Missing $ inserted".
 *
 * Detectamos específicamente el patrón "\[<número>pt]" porque es
 * inequívoco: nadie escribe una fórmula que empiece con un número seguido
 * de "pt]" en modo matemático real. Es siempre un typo de \\[Npt].
 * No tocamos otros usos de \[ ... \] (fórmulas reales), solo este patrón.
 */
function fixSaltoDeLineaConArgumento(tex, cambiosCampo) {
  const patron = /(?<!\\)\\\[(\d+(?:\.\d+)?(?:pt|cm|mm|em|ex))\]/g;
  const matches = tex.match(patron);
  if (matches) {
    tex = tex.replace(patron, "\\\\[$1]");
    cambiosCampo.push(`${matches.length}x "\\[Npt]" -> "\\\\[Npt]"`);
  }
  return tex;
}

/**
 * Fix #2 — segundo más frecuente: un entorno matemático multilínea
 * (aligned/align/cases/array) usando \[...\] o $$...$$ DENTRO de un
 * \fbox{\parbox{...}{...}}. Esto no compila de forma confiable: \[...\]
 * hace \par internamente y no está pensado para anidarse dentro de una
 * caja horizontal como \parbox.
 *
 * No podemos "arreglar" el contenido matemático en sí (no sabemos cuál de
 * las líneas del aligned es la más representativa para dejar como fórmula
 * única), así que el fix seguro y automático es: sacar el \[ ... \] (o
 * $$...$$) de adentro del \fbox{\parbox{}} y dejarlo INMEDIATAMENTE
 * DESPUÉS del \fbox, en vez de adentro. Fuera de la caja, \[...\] con
 * aligned adentro compila sin problema. Esto preserva el contenido
 * matemático completo (no se pierde nada) y solo mueve dónde vive.
 *
 * Alcance deliberadamente acotado: solo actuamos si detectamos con
 * confianza el patrón "\fbox{\parbox{...}{ ... \[ ... aligned/align/cases
 * ... \] ... }}" en una sola línea (que es como lo generan los moldes y
 * como aparece en los logs reales). Si la estructura es más compleja o
 * multilínea de otra forma, no adivinamos: lo dejamos para el chequeo de
 * balanceo más abajo, que va a cortar con un mensaje claro si sigue roto.
 */
function fixEntornoMultilineaEnCaja(tex, cambiosCampo) {
  const patronCaja = /\\fbox\{\\parbox\{[^{}]*\}\{[^]*?\}\}/g;

  return tex.replace(patronCaja, (bloqueCompleto) => {
    const tieneEntornoMultilinea = /\\begin\{(aligned|align|cases|array)\}/.test(bloqueCompleto);
    if (!tieneEntornoMultilinea) return bloqueCompleto;

    const matchDisplay =
      bloqueCompleto.match(/\\\[([^]*?)\\\]/) || bloqueCompleto.match(/\$\$([^]*?)\$\$/);
    if (!matchDisplay) return bloqueCompleto;

    const formulaCompleta = matchDisplay[0];
    const bloqueSinFormula = bloqueCompleto.replace(formulaCompleta, "").trim();

    cambiosCampo.push(
      "entorno multilínea (aligned/align/cases/array) sacado de adentro de \\fbox{\\parbox{}} y movido justo después"
    );

    return `${bloqueSinFormula}\n\n${formulaCompleta}`;
  });
}

/**
 * Fix #3 — IA#3 a veces antepone un backslash espurio a los signos de
 * apertura ¿ y ¡ (ej: "\¿Por qué...?", "\¡Cuidado!"), aparentemente por
 * costumbre de "escapar" caracteres especiales que en realidad no
 * necesitan escape acá. Bajo \usepackage[utf8]{inputenc} estos signos se
 * escriben directo, sin backslash.
 *
 * Con el backslash, TeX arma un símbolo de control de un solo carácter
 * ("\¿") que no existe -> "Undefined control sequence". Peor todavía, el
 * backslash interfiere con el mecanismo de inputenc que reconoce el primer
 * byte de una secuencia UTF-8 multibyte, así que el segundo byte de "¿"
 * (0xBF) queda leído suelto -> "Invalid UTF-8 byte" en cascada justo
 * después.
 *
 * No confundir con \'e, \'o, \~n, etc. (acentos clásicos de TeX vía ASCII):
 * esos son válidos y no se tocan. Acá el patrón es específicamente
 * backslash + el carácter UTF-8 ya acentuado/invertido en crudo, que nunca
 * es correcto.
 */
function fixBackslashAntesSignosInvertidos(tex, cambiosCampo) {
  const patron = /\\([¿¡])/g;
  const matches = tex.match(patron);
  if (matches) {
    tex = tex.replace(patron, "$1");
    cambiosCampo.push(`${matches.length}x "\\¿"/"\\¡" -> "¿"/"¡" (backslash espurio quitado)`);
  }
  return tex;
}

/**
 * Fix #4 — babel-spanish + tikz: el paquete [spanish]{babel} activa "<" y
 * ">" como caracteres activos (para las comillas angulares «»), y los
 * reactiva en cada \selectlanguage (que corre automáticamente al entrar al
 * documento) sin importar lo que se haya puesto en el preámbulo. Si el
 * documento tiene \usepackage{tikz} y algún \draw con flechas (->, <-, <->
 * dentro de corchetes, como en los ejes de un gráfico), esos "<"/">" activos
 * rompen la compilación con "Argument of \language@active@arg> has an extra
 * }." (visto en producción: figuras generadas dinámicamente e insertadas en
 * %%FIGURA_AQUI%% con ejes tipo \draw[->]...).
 *
 * El molde ya trae \shorthandoff{<>} justo después de \begin{document} (el
 * único lugar donde realmente sirve — en el preámbulo no alcanza). Este fix
 * es una red de seguridad para si una ronda de regeneración/corrección lo
 * pisa o lo saca por error: si detectamos tikz + flechas + babel spanish
 * SIN shorthandoff ya presente, lo insertamos nosotros mismos justo después
 * del primer \begin{document}. No toca nada más del documento.
 */
function fixShorthandoffFaltante(tex, cambiosCampo) {
  const usaBabelSpanish = /\\usepackage(\[[^\]]*\bspanish\b[^\]]*\])?\{babel\}/.test(tex);
  const usaTikz = /\\usepackage(\[[^\]]*\])?\{[^}]*\btikz\b[^}]*\}/.test(tex);
  const usaFlechas = /\\draw\s*\[[^\]]*[<>]-|\\draw\s*\[[^\]]*-[<>]/.test(tex);
  const yaTieneShorthandoff = /\\shorthandoff\{[^}]*[<>][^}]*\}/.test(tex);

  if (!usaBabelSpanish || !usaTikz || !usaFlechas || yaTieneShorthandoff) {
    return tex;
  }

  const patronBeginDocument = /\\begin\{document\}/;
  if (!patronBeginDocument.test(tex)) return tex;

  tex = tex.replace(patronBeginDocument, "\\begin{document}\n\\shorthandoff{<>}");
  cambiosCampo.push(
    "\\shorthandoff{<>} agregado después de \\begin{document} (faltaba, y hay tikz con flechas + babel spanish)"
  );
  return tex;
}

/**
 * Fix #5 — Inyecta \usepackage{amssymb} en el preámbulo si no está ya cargado.
 * Esto resuelve el clásico error "Undefined control sequence" con \mathbb.
 * Busca \documentclass y, justo después, inserta el paquete si no encuentra
 * ninguna línea que cargue amssymb, amsfonts o un paquete que lo incluya.
 */
function fixAmssymb(tex, cambiosCampo) {
  // Si ya hay algún \usepackage que cargue amssymb o amsfonts, no hacemos nada.
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(amssymb|amsfonts)\b[^}]*\}/.test(tex)) {
    return tex;
  }

  // Buscamos la línea donde está \documentclass, para insertar justo después.
  const matchDocClass = tex.match(/^(\\documentclass.*)$/m);
  if (!matchDocClass) return tex; // no debería pasar, pero por si acaso

  const lineaDocClass = matchDocClass[0];
  const nuevoPreambulo = `${lineaDocClass}\n\\usepackage{amsmath, amssymb, amsfonts}`;

  tex = tex.replace(lineaDocClass, nuevoPreambulo);
  cambiosCampo.push('\\usepackage{amsmath, amssymb, amsfonts} añadido (faltaba para \\mathbb)');
  return tex;
}

/**
 * Chequeo de llaves { } balanceadas, ignorando las que están dentro de
 * comentarios. Exportada (además de usarse desde detectarProblemasEstructurales)
 * para que otros módulos —ej: inserción de figuras— puedan validar un
 * fragmento de LaTeX ANTES de pegarlo a un documento más grande, en vez de
 * enterarse recién acá cuando ya es tarde para descartar solo esa parte.
 */
export function llavesBalanceadas(tex) {
  const sinComentarios = quitarComentarios(tex);
  let profundidad = 0;
  for (const c of sinComentarios) {
    if (c === "{") profundidad++;
    if (c === "}") profundidad--;
  }
  return profundidad === 0;
}

/**
 * Quita comentarios de LaTeX (todo lo que sigue a un % no escapado en cada
 * línea) antes de contar delimitadores/llaves, para no confundirnos con
 * texto explicativo en comentarios que mencione \[ \] { } como ejemplo.
 */
function quitarComentarios(tex) {
  return tex
    .split("\n")
    .map((linea) => {
      const match = linea.match(/(?<!\\)%/);
      return match ? linea.slice(0, match.index) : linea;
    })
    .join("\n");
}