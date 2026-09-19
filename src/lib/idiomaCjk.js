/**
 * FIX (compilación rota en japonés/chino/coreano): pdflatex no puede
 * tipografiar NINGÚN ideograma CJK ni su puntuación de ancho completo
 * (｜：（）、。), sin importar qué \usepackage{...} tenga cargado --
 * inputenc[utf8] solo define cómo pdflatex LEE los bytes de entrada, no
 * le da los glifos: para eso hace falta un motor que sepa dibujar esos
 * caracteres, más una fuente que los tenga. Por eso cualquier tema
 * generado en un idioma CJK (ej. "ガロア理論" en ja) fallaba SIEMPRE en
 * compile.js con "! LaTeX Error: Unicode character ... not set up for
 * use with LaTeX", ya de entrada, sin importar si el resto del LaTeX
 * generado por IA#3 estaba bien armado o no.
 *
 * La solución probada (ver notas de la sesión del 19/09 -- se compiló
 * un .tex de prueba con ガロア理論 real y salió sin errores fatales,
 * tanto en pdf como en epub) es compilar con xelatex en vez de pdflatex
 * para estos idiomas, con xeCJK + una fuente Noto Sans CJK de la
 * variante correspondiente (instaladas vía el Dockerfile, ver
 * fonts-noto-cjk). tex4ebook soporta lo mismo con su flag -x/--xetex.
 *
 * Este archivo centraliza el criterio "¿este idioma es CJK?" y qué
 * fuente le corresponde, para que compile.js (elige el motor) y
 * prompts/ia3.js (arma el preámbulo que tiene que llevar el .tex que
 * genera IA#3) usen exactamente el mismo criterio sin duplicarlo.
 */

// Fuente Noto Sans CJK por variante (las 4 vienen en el paquete
// fonts-noto-cjk de Debian/Ubuntu -- confirmado con `fc-list :lang=ja`
// en el contenedor de compilación). Códigos de idioma normalizados a
// minúsculas antes de buscar acá.
const FUENTE_CJK_POR_IDIOMA = {
  ja: "Noto Sans CJK JP",
  ko: "Noto Sans CJK KR",
  zh: "Noto Sans CJK SC",
  "zh-cn": "Noto Sans CJK SC",
  "zh-hans": "Noto Sans CJK SC",
  "zh-sg": "Noto Sans CJK SC",
  "zh-tw": "Noto Sans CJK TC",
  "zh-hant": "Noto Sans CJK TC",
  "zh-hk": "Noto Sans CJK TC",
  "zh-mo": "Noto Sans CJK TC",
};

/**
 * @param {string} idioma - código ISO del idioma destino (ej. "ja", "es")
 * @returns {boolean} true si este idioma necesita xelatex+xeCJK en vez
 *   de pdflatex para poder compilar.
 */
export function esIdiomaCJK(idioma) {
  return Object.prototype.hasOwnProperty.call(FUENTE_CJK_POR_IDIOMA, (idioma || "").toLowerCase());
}

/**
 * @param {string} idioma - código ISO del idioma destino
 * @returns {string} nombre de la fuente Noto Sans CJK a usar en
 *   \setCJKmainfont{...}. Default a la variante japonesa si por algún
 *   motivo se llama con un idioma no-CJK (no debería pasar si el call
 *   site chequea esIdiomaCJK() antes, pero mejor un default razonable
 *   que un undefined suelto en medio del preámbulo LaTeX).
 */
export function fuenteCJKPara(idioma) {
  return FUENTE_CJK_POR_IDIOMA[(idioma || "").toLowerCase()] || "Noto Sans CJK JP";
}

/**
 * Motor de LaTeX a usar para compilar el contenido de este idioma.
 */
export function motorLatexPara(idioma) {
  return esIdiomaCJK(idioma) ? "xelatex" : "pdflatex";
}
