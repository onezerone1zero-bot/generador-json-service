import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { esIdiomaCJK, fuenteCJKPara } from "../lib/idiomaCjk.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moldesDir = path.join(__dirname, "..", "moldes");

const leer = (nombre) => readFileSync(path.join(moldesDir, nombre), "utf8");

/**
 * Arma el prompt de IA #3: le pasa los moldes reales como referencia exacta
 * y le pide generar los 4 .tex para el tema nuevo.
 *
 * contexto = lo que decidió IA #2:
 *   { materia, tema, esTemaNuevo, moldePractica: "modelo1" | "modelo2", notasIA2 }
 */
export function armarPromptIA3(contexto, correccionesPrevias = null, texsPrevios = null) {
  const moldePracticaTex =
    contexto.moldePractica === "modelo1" ? leer("practica_modelo1.tex") : leer("practica_modelo2.tex");
  const idioma = contexto.idioma || "es";
  const esCJK = esIdiomaCJK(idioma);

  const system = `Sos un generador de material educativo en LaTeX para una biblioteca de fórmulas universal, materia "${contexto.materia}".
Tu única salida es JSON válido, sin texto antes ni después, sin markdown fences.
Tenés que producir 4 documentos LaTeX completos y compilables (${esCJK ? "xelatex" : "pdflatex"} / tex4ebook), siguiendo EXACTAMENTE
la estructura, el paquete de comandos y las convenciones de los moldes que te paso a continuación.
No inventes secciones que no estén en el molde. No cambies el orden de las secciones.

IDIOMA DE SALIDA: todo el TEXTO visible que generes -- teoria_pdf_tex, teoria_epub_tex, extra_tex,
practica_tex, y las descripciones "descripcion"/"contexto" de figura/figuraTeoria -- tiene que estar
escrito en el idioma con código ISO "${idioma}" (si es "es", en español). Esto es solo el texto en
prosa (definiciones, enunciados, explicaciones, etiquetas de figuras): los comandos y la sintaxis de
LaTeX (\\textbf, \\begin{...}, \\frac, nombres de paquetes, etc.) NO se traducen, quedan siempre en su
forma estándar. Si "${idioma}" es "es", esto es exactamente el comportamiento de siempre.
${esCJK ? `
IMPORTANTE - PREÁMBULO PARA IDIOMA CJK ("${idioma}" se compila con xelatex, NO con pdflatex): pdflatex
no puede tipografiar ningún ideograma ni puntuación de ancho completo de "${idioma}", sin importar qué
\\usepackage tenga -- por eso este idioma usa xelatex+xeCJK. Los moldes de más abajo siguen siendo tu
referencia EXACTA para estructura, comandos y convenciones de layout: copiá todo eso igual. Lo único que
cambia es el PREÁMBULO (todo antes de \\begin{document}): en LOS 4 documentos (teoria_pdf_tex,
teoria_epub_tex, extra_tex, practica_tex) tenés que agregar estas 3 líneas, inmediatamente después de
\\documentclass{article} y antes de cualquier otro \\usepackage del molde:
\\usepackage{fontspec}
\\usepackage{xeCJK}
\\setCJKmainfont{${fuenteCJKPara(idioma)}}
El resto de los \\usepackage del molde (inputenc, geometry, amsmath, tikz, pgfplots, needspace, xcolor,
sectsty, helvet, etc.) van igual, en el mismo orden relativo -- estas 3 líneas se INSERTAN, no reemplazan
nada del molde. Esto incluye las figuras en TikZ con etiquetas en "${idioma}": van dentro del mismo
documento (teoria_pdf_tex o practica_tex), así que ya quedan cubiertas por este mismo preámbulo, no
necesitan nada aparte.
` : ""}

IMPORTANTE - Backslashes en JSON: tu salida es JSON, y el LaTeX usa muchísimos comandos que empiezan con
backslash (\textbf, \text, \needspace, \\ para saltos de línea, etc.). Como estás dentro de un string JSON,
CADA backslash literal del LaTeX tiene que escribirse DUPLICADO (\\\\) sin excepción, o el JSON queda roto:
por ejemplo el comando \\textbf{Hola} tiene que aparecer en tu salida como \\\\textbf{Hola}. Si no lo hacés,
un backslash seguido de "n" o "t" se interpreta como salto de línea o tabulación y arruina el documento.
Revisá cada comando LaTeX antes de responder y confirmá que todos los backslashes estén duplicados.

Donde el molde tenga reglas en comentarios (ej: "Errores frecuentes: entre 5 y 10 ejemplos, no inventar hasta
llegar al mínimo"), esas reglas son obligatorias.

IMPORTANTE - fórmulas dentro del recuadro "Forma general" (el \\fbox{\\parbox{...}{...}} al principio de
teoria_pdf_tex y teoria_epub_tex): ese recuadro usa \\[ ... \\] (o \\(...\\)) DENTRO de un \\parbox. Esto
solo compila si la fórmula adentro es una sola línea simple, sin entornos de alineación. Reglas obligatorias
para ese recuadro y para cualquier otra fórmula que seas metas dentro de un \\parbox, \\fbox o \\minipage:
- NUNCA uses \\begin{aligned}, \\begin{align}, \\begin{cases}, \\begin{array} ni ningún entorno matemático
  multilinea dentro de \\[ ... \\] cuando ese \\[ ... \\] está anidado dentro de \\parbox/\\fbox/\\minipage.
  \\begin{aligned} en particular SOLO es válido si está directamente dentro de modo matemático de un
  \\[ ... \\] o $$...$$ que NO esté anidado en una caja de texto; si lo necesitás igual, usá $$\\begin{aligned}...\\end{aligned}$$
  suelto en el cuerpo del documento, nunca dentro del recuadro de "Forma general".
- Si la fórmula general del tema es intrínsecamente multilinea o un sistema de ecuaciones (ej: sistemas
  lineales, fórmulas por casos), NO fuerces todo dentro del recuadro de una sola fórmula: elegí la fórmula
  central más representativa (una sola línea) para el recuadro, y dejá el resto del desarrollo para el
  cuerpo de la teoría (fuera de cualquier \\parbox/\\fbox), donde sí podés usar \\begin{aligned} o
  \\begin{cases} sin problema dentro de \\[ ... \\] o $$...$$ normales.
- Cada \\[ tiene que tener su \\] de cierre, y cada \\( su \\) de cierre, sin excepción; no dejes ninguno
  sin cerrar ni cierres uno que no abriste. Un \\[ sin su \\] correspondiente rompe todo el documento
  desde ese punto en adelante (todo lo que sigue se interpreta como si siguiera en modo matemático).
- Contá las llaves { y } de cada línea con \\parbox/\\fbox antes de responder: ese patrón anida varias
  llaves seguidas (\\fbox{\\parbox{ancho}{...{\\Large...}...}}) y es fácil dejar una de más o de menos,
  lo cual también rompe la compilación desde ese punto.

--- MOLDE: teoría (versión PDF) ---
${leer("teoria_pdf.tex")}

--- MOLDE: teoría (versión EPUB) ---
${leer("teoria_epub.tex")}

--- MOLDE: extra ---
${leer("extra_pdf.tex")}

--- MOLDE: práctica (${contexto.moldePractica}) ---
${moldePracticaTex}

IMPORTANTE - estructura de layout de "practica_tex", NO la alteres:
El molde de arriba tiene una estructura de layout específica (minipages con altura fija
\\textheight, itemsep con "plus 1fill", etc.) que hace que la práctica ocupe la hoja completa
automáticamente al compilar, sin importar cuántos ejercicios tenga. Tenés que copiar esa estructura
EXACTAMENTE, con estas reglas no negociables:
- TODOS los ejercicios van dentro de una única \\begin{enumerate}...\\end{enumerate}, sin cortarlo a
  la mitad ni abrir uno nuevo después. No importa que solo 1 o 2 ejercicios usen la figura: el resto
  de los ejercicios sigue exactamente en el mismo bloque, con el mismo leftmargin.
- En modelo1: ese \\begin{enumerate} completo va dentro de la ÚNICA minipage de la derecha
  (\\begin{minipage}[t][\\textheight]{12.5cm}...\\end{minipage}). No cierres esa minipage antes de
  tiempo ni saques ejercicios afuera de ella — si eso pasa, esos ejercicios cambian de margen y de
  posición en la hoja, que es exactamente el error que hay que evitar.
- En modelo2: el \\begin{enumerate} y el bloque de "Figuras" van dentro de la ÚNICA
  \\begin{minipage}[t][\\textheight]{\\linewidth}...\\end{minipage} que envuelve todo, igual que en
  el molde.
- Los valores con "plus 1fill" (en itemsep, o en el \\vspace antes de "Figuras" en modelo2) son
  intencionales: NO los reemplaces por valores fijos sin "plus". Ese "plus 1fill" es lo que hace que
  LaTeX reparta el espacio sobrante entre los ejercicios al compilar, para que la práctica llene la
  hoja aunque tenga pocos ejercicios. No necesitás calcular ni saber dónde termina la página: eso lo
  resuelve LaTeX automáticamente gracias a la altura fija (\\textheight) de la minipage.

CASO ESPECIAL - figuras que son arreglos numéricos (Triángulo de Pascal,
tablas de verdad, tablas de multiplicación, series triangulares, etc.):
Estas NO van en %%FIGURA_AQUI%% ni se delegan a la IA visual. Generá
directamente en practica_tex el LaTeX de la figura usando \\begin{array}
o \\begin{tabular}, dentro del minipage o del bloque de figuras que
corresponda al molde. Dejá el campo "figura" como null.
Solo usá %%FIGURA_AQUI%% para figuras geométricas reales (triángulos con
medidas, polígonos, circuitos, diagramas de cuerpo libre, gráficas).

IMPORTANTE - la figura de práctica NO la generás vos: en "practica_tex", reemplazá el entorno
tikzpicture COMPLETO de la figura (desde \\begin{tikzpicture} hasta \\end{tikzpicture} inclusive,
con todo lo que tenga adentro) por la línea literal %%FIGURA_AQUI%% — la línea tiene que reemplazar
el \\begin{tikzpicture}...\\end{tikzpicture} entero, no solo lo de adentro. Esto es crítico: si el
placeholder queda afuera de un tikzpicture, o si dejás un \\begin{tikzpicture} o \\end{tikzpicture}
sueltos alrededor del placeholder, la figura no va a compilar (los comandos de dibujo no existen fuera
de ese entorno y LaTeX los va a tirar como texto suelto). Dejá todo lo demás de la estructura
(\\fbox si el molde lo tiene, minipage, posición, \\newcommand que define la figura si el molde la
arma así) exactamente igual — SOLO el/los tikzpicture(s) se reemplazan por el placeholder, entorno
incluido.

Además, agregá un campo "figura" con la descripción de qué hay que dibujar ahí, para que otra IA
especializada en gráficos genere el TikZ real (incluyendo su propio \\begin{tikzpicture}[opciones]
...\\end{tikzpicture} autocontenido). Sé específico: qué objeto es, qué datos/etiquetas debe
llevar (letras, números, ángulos), y a qué ejercicio(s) corresponde:
{
  "caso": "1" | "2",  // 1 = modelo1 (figura NECESARIA para resolver, va al costado con recuadro)
                        // 2 = modelo2 (figura EXTRA que ayuda a visualizar, va abajo en fila, sin recuadro)
  "descripcion": "qué dibujar, con qué etiquetas/datos, en el idioma \\"${idioma}\\"",
  "ejercicios": "a qué ejercicio(s) corresponde, ej: 'ejercicio 3' o 'ejercicios 1, 2 y 6'"
}

IMPORTANTE - FIGURA OPCIONAL EN LA TEORÍA (figuraTeoria):
Además de la figura de práctica, podés incluir UNA figura en la teoría (teoria_pdf_tex) si considerás
que aporta un valor pedagógico real al concepto central. No es obligatoria; solo inclúyela cuando
una visualización (gráfica, diagrama geométrico, esquema de conjuntos, etc.) ayude a entender
mejor la definición o el ejemplo principal que NO se pueda transmitir solo con texto.

Si decidís incluirla, agregá un campo "figuraTeoria" en el JSON de salida con:
{
  "descripcion": "descripción detallada de lo que debe dibujarse (ejes, puntos, curvas, etiquetas)",
  "contexto": "breve texto indicando a qué parte de la teoría acompaña (ej: 'acompaña a la definición de subespacio')"
}
Si no la incluís, omití completamente el campo "figuraTeoria".

La figura se insertará en teoria_pdf_tex reemplazando la marca %%FIGURA_TEORIA_AQUI%% (que vos
mismo debes poner en el lugar adecuado dentro de teoría_pdf_tex, normalmente después de la
definición o en el ejemplo central, dentro de un \\begin{center}...\\end{center}). Si no incluyes
figura, NO pongas esa marca en teoria_pdf_tex.

Formato de salida (JSON):
{
  "teoria_pdf_tex": "...",
  "teoria_epub_tex": "...",
  "extra_tex": "...",
  "practica_tex": "... (con %%FIGURA_AQUI%% en el lugar del TikZ, o sin placeholder si la figura es un arreglo numérico ya insertado directo) ...",
  "figura": { "caso": "1", "descripcion": "...", "ejercicios": "..." } | null, // null si la figura es un arreglo numérico (ver CASO ESPECIAL)
  "figuraTeoria": { "descripcion": "...", "contexto": "..." } | null   // opcional, solo si la teoría se beneficia de una figura
}`;

  let prompt = `Generá el material para:
Materia: ${contexto.materia}
Tema: ${contexto.tema}
Notas de IA #2 (contexto de búsqueda / alcance del tema): ${contexto.notasIA2 || "ninguna"}
`;

  if (correccionesPrevias && texsPrevios) {
    prompt += `\nIMPORTANTE: esta es una regeneración. Abajo tenés el texto EXACTO que generaste en la ronda
anterior (los 4 documentos completos), y las correcciones que pidió el revisor sobre ese texto exacto.

Tu tarea AHORA es tomar ese texto de abajo como punto de partida y aplicarle SOLO los cambios puntuales
que piden las correcciones — no reescribas el resto de los documentos de memoria ni cambies nada que no
esté mencionado en las correcciones. Si una corrección señala una línea o un patrón específico (ej: un
"\\[2pt]" que debería ser "\\\\[2pt]", o una fórmula que hay que sacar de un \\fbox), localizá ESA línea
exacta en el texto de abajo y corregila ahí, dejando el resto del documento idéntico carácter por carácter
salvo por ese fix. Esto es más confiable que reescribir todo de nuevo, porque reescribir de memoria es
la causa más común de que un error ya corregido antes vuelva a aparecer en la ronda siguiente.

--- TEXTO GENERADO EN LA RONDA ANTERIOR (teoria_pdf_tex) ---
${texsPrevios.teoria_pdf_tex || ""}

--- TEXTO GENERADO EN LA RONDA ANTERIOR (teoria_epub_tex) ---
${texsPrevios.teoria_epub_tex || ""}

--- TEXTO GENERADO EN LA RONDA ANTERIOR (extra_tex) ---
${texsPrevios.extra_tex || ""}

--- TEXTO GENERADO EN LA RONDA ANTERIOR (practica_tex) ---
${texsPrevios.practica_tex || ""}

--- CORRECCIONES QUE EL REVISOR PIDIÓ SOBRE ESE TEXTO EXACTO ---
${correccionesPrevias}

Aplicá esos cambios puntuales y devolvé los 4 documentos completos con el fix aplicado, en el mismo
formato JSON de siempre.`;
  } else if (correccionesPrevias) {
    prompt += `\nIMPORTANTE: esta es una regeneración. IA #4 rechazó la versión anterior por lo siguiente,
corregí específicamente estos puntos y no repitas el error:
${correccionesPrevias}`;
  }

  return { system, prompt };
}