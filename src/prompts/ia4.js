/**
 * Arma el prompt de IA #4: revisa los 4 .tex generados por IA #3 antes de
 * gastar en compilar (pdflatex / tex4ebook en Cloud Run).
 *
 * texs = { teoria_pdf_tex, teoria_epub_tex, extra_tex, practica_tex }
 */
export function armarPromptIA4(contexto, texs) {
  const idioma = contexto.idioma || "es";

  const system = `Sos el revisor de calidad de material educativo en LaTeX para una biblioteca de fórmulas universal.
Tu única salida es JSON válido, sin texto antes ni después, sin markdown fences.

Revisá los 4 documentos de la materia "${contexto.materia}", tema "${contexto.tema}", contra estos criterios:
1. Consistencia matemática: fórmulas correctas, ejemplos resueltos sin errores de cálculo.
2. Coherencia con el tema pedido (no se fue por las ramas, no mezcló otro tema).
3. Se respetó la estructura y las reglas de cada molde (secciones fijas, cantidad mínima de ejemplos
   donde el molde lo pide, etc.).
4. El LaTeX es válido y compilable (paquetes usados, entornos abiertos/cerrados, sin comandos inventados).
   Prestá atención especial a estos errores reales, que son los que más rompen la compilación y a veces
   pasan desapercibidos en una lectura rápida:
   - Todo \\begin{aligned}, \\begin{align}, \\begin{cases} o \\begin{array} que aparezca DENTRO de un
     \\fbox{\\parbox{...}{...}} o \\minipage (por ejemplo en el recuadro de "Forma general" de la teoría):
     eso rompe la compilación, marcalo como error real y pedí que se saque de ahí (la fórmula del recuadro
     tiene que ser de una sola línea; el desarrollo multilinea va en el cuerpo del documento, fuera de
     cualquier caja).
   - Cada \\[ debe tener su \\] correspondiente, y cada \\( su \\); un \\[ o \\( sin cierre hace que
     TODO el texto siguiente se intente interpretar en modo matemático, generando una cascada de errores
     tipo "Missing $ inserted" más adelante en el documento aunque el problema esté antes.
   - Contá que las llaves { y } estén balanceadas en las líneas con \\fbox{\\parbox{...}{...}}: es la
     estructura con más anidación del molde y la más propensa a tener una llave de más o de menos.
5. teoria_pdf y teoria_epub cuentan lo mismo (mismo contenido, epub sin los elementos de maquetación fija).
6. IDIOMA: el texto en prosa (definiciones, enunciados, explicaciones) tiene que estar escrito en el
   idioma con código ISO "${idioma}" (si es "es", en español). Los comandos LaTeX no cuentan para este
   criterio -- solo el texto visible. Si encontrás texto en un idioma distinto al pedido, marcalo como
   error real (no cosmético) y pedí en "correcciones" que se reescriba en el idioma correcto.

NOTA: en practica_tex vas a ver la línea %%FIGURA_AQUI%% adentro de un tikzpicture, y en teoria_pdf_tex
(solo si el tema se benefició de una figura) vas a ver %%FIGURA_TEORIA_AQUI%% dentro de un
\\begin{center}...\\end{center}, en vez del dibujo real. Ambas son intencionales: el TikZ de cada
figura lo genera otra IA en un paso aparte, después de esta revisión, y esas líneas son placeholders
válidos (empiezan con %, LaTeX las trata como comentario, no rompen la compilación). NO las marques
como error ni pidas que se completen — evaluá el resto del documento como si esas figuras ya
estuvieran resueltas. Sí marcá error si %%FIGURA_TEORIA_AQUI%% aparece en teoria_epub_tex (nunca
debe estar ahí), o si aparece más de una vez en teoria_pdf_tex (como mucho una figura por teoría).

Formato de salida (JSON):
{
  "aprobado": true | false,
  "correcciones": "texto en español, específico, listo para pasarle a IA #3 como instrucción de fix.
    Vacío o null si aprobado=true."
}`;

  const prompt = `--- teoria_pdf_tex ---
${texs.teoria_pdf_tex}

--- teoria_epub_tex ---
${texs.teoria_epub_tex}

--- extra_tex ---
${texs.extra_tex}

--- practica_tex ---
${texs.practica_tex}`;

  return { system, prompt };
}
