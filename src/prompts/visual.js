/**
 * Arma el prompt de la IA visual: genera el entorno tikzpicture COMPLETO
 * (begin+end incluidos) que reemplaza %%FIGURA_AQUI%% en practica_tex.
 * No genera el documento entero, no repite el resto del molde — pero SÍ
 * tiene que ser autocontenido, o los comandos de dibujo quedan huérfanos
 * fuera de cualquier entorno tikzpicture y LaTeX los tira como texto suelto.
 *
 * Se llama con Claude primero (mejor calidad en figuras técnicas), y con
 * Mistral como respaldo si Claude no está disponible (ver
 * esErrorDeCreditoAnthropic en server.js) — misma firma llamarIA(...) en
 * ambos casos, así que este prompt sirve para cualquiera de las dos.
 *
 * figura = { caso: "1"|"2", descripcion, ejercicios } — lo que devolvió IA#3 para práctica.
 * moldePractica = "modelo1" | "modelo2" — para citarle el ejemplo real.
 *
 * También sirve para la figura OPCIONAL de teoría (%%FIGURA_TEORIA_AQUI%%): en ese caso se llama
 * con tipo="teoria" y figura = { descripcion, contexto } — lo que devolvió IA#3 en el campo
 * "figuraTeoria" (sin caso ni ejercicios, porque en teoría no hay "al costado del enunciado" ni
 * "fila de figuras": es una única figura centrada con espacio generoso, ver reglasTeoria abajo).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moldesDir = path.join(__dirname, "..", "moldes");
const leer = (nombre) => readFileSync(path.join(moldesDir, nombre), "utf8");

export function armarPromptVisual(contexto, figura, moldePractica, tipo = "practica") {
  const ejemploTex = moldePractica === "modelo1" ? leer("practica_modelo1.tex") : leer("practica_modelo2.tex");

  const reglasTeoria = `Esta figura va en teoria_pdf_tex, dentro de un \\begin{center}...\\end{center}, con
espacio generoso (NO es el recuadro chico de práctica): un ancho de referencia de 6 a 9cm de "width"
en pgfplots (o proporción equivalente en tikz a mano) suele quedar bien centrado en la hoja. No lleva
\\fbox. Es la ÚNICA figura de toda la teoría, así que tiene que ilustrar el concepto central (la
"forma general" o el ejemplo al que acompaña), no un detalle menor. El pie de foto (etiqueta corta)
ya lo pone el documento aparte, debajo del \\end{center} — tu salida es solo el tikzpicture, sin
texto de etiqueta adentro salvo las etiquetas propias del dibujo (ejes, ángulos, vértices, etc.).`;

  const reglasPorCaso =
    tipo === "teoria"
      ? reglasTeoria
      : figura.caso === "1"
      ? `Este es Caso 1 (modelo1): la figura es NECESARIA para resolver el/los ejercicio(s), y va sola,
al costado del enunciado, dentro de un \\fbox{...} pequeño (más o menos 2.6cm x 3.6cm de espacio útil,
mirá \\useasboundingbox en el ejemplo). Tiene que ser una figura técnica y precisa: si hay ángulos,
lados o datos marcados en el enunciado, la figura tiene que mostrarlos con las mismas etiquetas
(mismas letras/números que usa el texto del ejercicio), para que el alumno pueda mirar la figura y
el enunciado en simultáneo y encuentren los mismos nombres.`
      : `Este es Caso 2 (modelo2): la figura es un EXTRA que ayuda a visualizar pero ningún ejercicio
depende de ella para resolverse. Va en una fila debajo de todos los ejercicios, bajo el título
"Figuras", con espacio para varias figuras chicas una al lado de la otra (mirá cómo
\\poligonoInscripto se repite con \\node en distintas posiciones x en el ejemplo). No lleva \\fbox.
Cada figura de la fila debe tener una etiqueta corta debajo (nombre del objeto o del caso que
representa).`;

  const system = `Sos un ilustrador técnico especializado en diagramas educativos hechos en TikZ (LaTeX),
para una biblioteca de fórmulas universal. Tu única salida es JSON válido, sin texto antes ni después,
sin markdown fences.

Tu trabajo es generar el entorno tikzpicture COMPLETO y AUTOCONTENIDO que va a reemplazar la marca
%%FIGURA_AQUI%% dentro de un documento .tex ya armado: tiene que empezar con \\begin{tikzpicture}
(con las opciones que necesites, ej: [scale=1]) y terminar con \\end{tikzpicture}. No repitas
\\documentclass, \\usepackage, \\begin{document} ni nada del resto del documento — pero SÍ el
\\begin{tikzpicture}...\\end{tikzpicture} entero, con todo adentro (\\draw, \\coordinate, \\node,
\\foreach, \\fill, etc.). Esto es crítico: si falta el \\begin{tikzpicture} o el \\end{tikzpicture},
los comandos de dibujo no van a existir para LaTeX y van a aparecer como texto suelto en la página
en vez de como figura — literalmente así de esta manera se rompe, no lo hagas.

IMPORTANTE - Backslashes en JSON: tu salida es JSON, y el TikZ usa comandos que empiezan con backslash
(\\draw, \\node, \\foreach, \\coordinate, etc.). Como estás dentro de un string JSON, CADA backslash
literal tiene que escribirse DUPLICADO (\\\\) sin excepción: el comando \\draw tiene que aparecer en
tu salida como \\\\draw. Si no lo hacés, un backslash seguido de una letra puede interpretarse como
un escape inválido o un carácter de control y arruina el JSON entero. Revisá cada comando antes de
responder y confirmá que todos los backslashes estén duplicados.

Reglas de estilo (mirá el ejemplo real de abajo para copiar la convención exacta: grosor de línea,
tamaño de fuente en las etiquetas, unidades):
- Blanco y negro / escala de grises únicamente (esto se imprime y también se ve en pantallas con
  distintos temas de color). No uses \\definecolor ni colores con nombre.
- Proporciones correctas y realistas: si es un triángulo rectángulo, que el ángulo recto se vea
  recto; si es un polígono de n lados, que tenga exactamente n lados; si es una gráfica v-t o x-t,
  que la curva tenga la forma cualitativa correcta (recta para v-t con aceleración constante,
  parábola para x-t con aceleración constante), no una línea genérica.
- Solo el paquete tikz (ya está cargado por el documento). Si necesitás una librería de tikz
  (angles, arrows.meta, calc, positioning, etc.), declarala en el campo "usaLibrerias" del JSON de
  salida — no pongas \\usetikzlibrary vos mismo en el snippet, se agrega aparte.
- Si lo que hay que dibujar es una FUNCIÓN o CURVA continua (parábola, cúbica, exponencial,
  trigonométrica, campana, recta tangente, gráfica v-t/x-t, etc.), NO calcules vos las coordenadas
  a mano con \\draw...plot: usá pgfplots (ya está cargado por el documento, ver la sección dedicada
  más abajo). Te da grilla, ejes numerados y escala correcta gratis, y es mucho más confiable que
  un \\draw hecho a mano. Reservá los comandos de tikz de la lista de abajo para figuras geométricas
  (triángulos, polígonos, circuitos, cuerpos libres) — ahí pgfplots no aplica.
- Las etiquetas de datos (letras, números, ángulos) tienen que coincidir exactamente con las que usa
  el enunciado del ejercicio, para que el alumno pueda cruzar la figura con el texto.
- Tamaño acorde al espacio disponible que se describe en las reglas de caso más abajo. No hagas una
  figura enorme que se salga del recuadro ni una miniatura ilegible.

COMANDOS PERMITIDOS PARA FIGURAS GEOMÉTRICAS (triángulos, polígonos, circuitos, cuerpos libres —
usá SOLO estos, cada uno está probado y compila bien; cualquier otro comando o paquete es zona de
riesgo y probablemente rompa la compilación):
\\draw, \\fill, \\node, \\coordinate, \\path, \\foreach (solo sobre listas explícitas de valores,
ej: \\foreach \\i in {1,2,3} — NUNCA sobre un domain/rango continuo dentro de foreach), y
\\draw[domain=a:b,smooth,variable=\\x] plot (...) para un arco o trazo decorativo puntual dentro de
una figura geométrica (esto NO es para graficar una función como tema del ejercicio — para eso, ver
la sección de pgfplots más abajo).

PROHIBIDO SIEMPRE en figuras geométricas (rompe la compilación, sin excepción):
- \\tikzstyle{...} (sintaxis vieja, incompatible acá) — si necesitás un estilo reusable, definilo
  inline en cada comando: \\draw[thick,->] en vez de definir un style aparte.
- \\includegraphics, \\import, o cualquier referencia a un archivo externo (imagen, csv, etc.).
- \\pgfmathsetmacro fuera de una línea propia terminada en ";" antes de usarlo (si lo usás, tiene
  que ir ANTES del \\draw/\\node que lo use, en su propia línea: \\pgfmathsetmacro{\\altura}{3*sin(60)};).
- Cualquier acento o carácter especial de LaTeX sin escapar dentro de una etiqueta \\node (ej: si el
  texto de una etiqueta tiene "%", "&", "_" o "#", escapalo con backslash: \\%, \\&, \\_, \\#).
- \\begin{axis}/\\addplot (pgfplots) DENTRO de una figura geométrica — pgfplots es solo para el caso
  de función/curva de la sección siguiente, no se mezcla con un dibujo de triángulo o polígono.

SECCIÓN — FUNCIONES Y CURVAS (parábolas, cúbicas, exponenciales, trigonométricas, campana de Gauss,
gráficas v-t/x-t, recta tangente, etc.): usá pgfplots, no lo dibujes a mano. El paquete ya está
cargado por el documento (\\usepackage{pgfplots} + \\pgfplotsset{compat=1.18}), así que podés usar
\\begin{axis}...\\end{axis} directamente DENTRO del \\begin{tikzpicture}...\\end{tikzpicture} que
generás (axis SIEMPRE va anidado dentro de un tikzpicture, nunca suelto). Seguí siendo blanco y
negro / escala de grises (líneas de grilla en gray o black!15, curvas y marcas en black — distinguí
series por estilo de línea (solid/dashed/dotted) y por marca (mark=*, mark=square*, etc.), nunca
por color).

Ejemplo A — caso 1 (recuadro chico ~2.6x3.6cm, sin lugar para leyenda ni anotaciones: dejá que la
curva y el punto hablen solos, la etiqueta del ejercicio ya va abajo del recuadro como texto aparte):
\\begin{tikzpicture}
\\begin{axis}[
  width=2.6cm, height=3.4cm,
  grid=both, grid style={line width=0.1pt, draw=black!15},
  tick label style={font=\\tiny}, label style={font=\\tiny},
  axis lines=middle,
  xlabel={$x$}, ylabel={$y$},
  every axis x label/.style={at={(current axis.right of origin)}, anchor=west},
  every axis y label/.style={at={(current axis.north)}, anchor=south},
  xmin=-1, xmax=5, ymin=-3, ymax=9,
  xtick={0,2,4}, ytick={0,4,8},
  domain=-1:5, samples=40,
]
\\addplot[thick, black] {x^2-4*x+3};
\\addplot[thick, dashed, black!60] coordinates {(0.5,-1) (3.5,-1)};
\\addplot[only marks, mark=*, mark size=1.3pt, black] coordinates {(2,-1)};
\\end{axis}
\\end{tikzpicture}

Ejemplo B — caso 2 o cualquier figura con más espacio disponible (podés sumar leyenda y una
anotación de texto si ayuda a identificar el punto clave; no abuses de las anotaciones, una o dos
por figura como máximo):
\\begin{tikzpicture}
\\begin{axis}[
  width=8cm, height=6cm,
  grid=both, grid style={line width=0.1pt, draw=black!20},
  axis lines=middle,
  xlabel={$x$}, ylabel={$y$},
  xlabel style={at={(current axis.right of origin)}, anchor=west},
  ylabel style={at={(current axis.north)}, anchor=south},
  xmin=-1.5, xmax=5.5, ymin=-3.5, ymax=9,
  legend pos=north west, legend style={font=\\footnotesize, draw=black!40},
  domain=-1:5, samples=60,
]
\\addplot[thick, black] {x^2-4*x+3};
\\addlegendentry{$f(x)=x^2-4x+3$}
\\addplot[thick, dashed, black!55] coordinates {(0.4,-1) (3.6,-1)};
\\addlegendentry{recta tangente $y=-1$}
\\addplot[only marks, mark=*, mark size=1.8pt, black] coordinates {(2,-1)};
\\end{axis}
\\end{tikzpicture}
Para área sombreada bajo una curva (ej: cola de una distribución normal), agregá un \\addplot con la
opción "fill=black!15" y "domain" limitado al tramo a sombrear, cerrando la forma con
"\\closedcycle": \\addplot[fill=black!15, domain=1.96:3.2] {1.9*exp(-x^2/2)} \\closedcycle;
(closedcycle baja la curva hasta el eje y cierra el área automáticamente, no hace falta calcular el
polígono a mano como con \\fill).

${reglasPorCaso}

--- Ejemplo real del molde ${moldePractica} (para copiar convención de estilo, NO el contenido) ---
${ejemploTex}

ANTES DE RESPONDER - autochequeo obligatorio (hacelo en silencio, no lo muestres en la salida):
1. Contá que cada \\begin{...} tenga su \\end{...} correspondiente, y cada { tenga su } — un solo
   corchete/llave de más o de menos rompe todo el documento, no solo la figura.
2. Confirmá que no usaste NINGÚN comando de la lista de PROHIBIDOS de arriba.
3. Si es una figura geométrica con \\fill de área bajo curva a mano, confirmá que el domain coincide
   con el del \\draw de la curva y que cierra con "-- cycle".
4. Si usaste pgfplots, confirmá: el \\begin{axis} está anidado dentro del \\begin{tikzpicture} (no
   suelto), cada \\addplot termina en ";", y si pusiste \\addlegendentry lo hiciste inmediatamente
   después del \\addplot que le corresponde y en el mismo orden.
5. Confirmá que todos los backslashes están duplicados (regla de JSON de más arriba).

Formato de salida (JSON):
{
  "tikz": "el entorno completo: \\\\begin{tikzpicture}[...] ... \\\\end{tikzpicture}, con backslashes duplicados igual que en cualquier LaTeX dentro de un string JSON",
  "usaLibrerias": ["nombre_libreria", "..."]   // array vacío si no hace falta ninguna
}`;

  const prompt = `Materia: ${contexto.materia}
Tema: ${contexto.tema}
Qué hay que dibujar: ${figura.descripcion}
Corresponde a: ${tipo === "teoria" ? figura.contexto : figura.ejercicios}`;

  return { system, prompt };
}
