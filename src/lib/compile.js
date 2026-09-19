import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { motorLatexPara } from "./idiomaCjk.js";

const execFileAsync = promisify(execFile);

async function correr(cmd, args, cwd) {
  try {
    await execFileAsync(cmd, args, { cwd, timeout: 120000 });
  } catch (err) {
    // pdflatex/xelatex devuelven código != 0 seguido aunque el PDF se haya
    // generado (warnings tratados como error de exit code). No abortamos
    // acá: el chequeo real es si el archivo de salida existe después.
    console.warn(`Aviso corriendo ${cmd}: ${err.message.slice(0, 500)}`);
  }
}

/**
 * Compila los 4 .tex a sus archivos finales.
 * Devuelve { teoriaPdf, teoriaEpub, extraPdf, practicaPdf } como Buffers.
 * Lanza si falta algún archivo de salida esperado.
 *
 * @param {string} idioma - idioma destino del contenido (ver
 *   lib/idiomaCjk.js). FIX (compilación rota en ja/zh/ko): pdflatex no
 *   tipografía ideogramas CJK bajo ninguna circunstancia (no es un
 *   problema de qué paquete tenga cargado, el motor mismo no tiene esos
 *   glifos) -- para esos idiomas hay que compilar con xelatex + xeCJK
 *   en vez de pdflatex, y tex4ebook con su flag -x/--xetex. El
 *   preámbulo que arma IA#3 (prompts/ia3.js) ya incluye
 *   fontspec+xeCJK+setCJKmainfont cuando el idioma lo requiere, así que
 *   acá solo hace falta invocar el binario correcto.
 */
export async function compilarTodo(slug, texs, idioma = "es") {
  const dir = await mkdtemp(path.join(tmpdir(), "gen-"));
  const motor = motorLatexPara(idioma);

  try {
    await writeFile(path.join(dir, "teoria.tex"), texs.teoria_pdf_tex);
    await writeFile(path.join(dir, "teoria_epub.tex"), texs.teoria_epub_tex);
    await writeFile(path.join(dir, "extra.tex"), texs.extra_tex);
    await writeFile(path.join(dir, "practica.tex"), texs.practica_tex);

    // 2 pasadas (referencias cruzadas / índices si el molde los usa)
    for (const nombre of ["teoria", "extra", "practica"]) {
      await correr(motor, ["-interaction=nonstopmode", `${nombre}.tex`], dir);
      await correr(motor, ["-interaction=nonstopmode", `${nombre}.tex`], dir);
      // Chequeo real de contenido, no solo de existencia: en nonstopmode
      // el motor puede generar igual un .pdf (a veces de varias páginas)
      // aunque haya tenido un error real adentro — típicamente porque un
      // \fbox/minipage/tikzpicture roto le hace perder todo el contenido de
      // esa página, que queda en blanco, sin que el archivo deje de existir.
      // Por eso no alcanza con "existe el .pdf": hay que mirar el .log.
      await chequearErroresFatales(dir, nombre, motor);
    }

    // tex4ebook para la versión epub de teoría -- con -x usa xelatex por
    // dentro en vez del htlatex/pdftex default, mismo criterio que arriba.
    const argsTex4ebook = motor === "xelatex" ? ["-x", "-f", "epub3", "teoria_epub.tex"] : ["-f", "epub3", "teoria_epub.tex"];
    await correr("tex4ebook", argsTex4ebook, dir);

    const [teoriaPdf, teoriaEpub, extraPdf, practicaPdf] = await Promise.all([
      leerConLog(dir, "teoria"),
      readFile(path.join(dir, "teoria_epub.epub")),
      leerConLog(dir, "extra"),
      leerConLog(dir, "practica"),
    ]);

    return { teoriaPdf, teoriaEpub, extraPdf, practicaPdf };
  } finally {
    // Fase 3 del plan: borrar toda la carpeta temporal (.aux, .4ct, etc.)
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Revisa <nombre>.log en busca de errores fatales de LaTeX (líneas que
 * arrancan con "! ", que es como LaTeX marca cualquier error real, a
 * diferencia de warnings tipo "Overfull \hbox"). Si encuentra alguno, corta
 * ACÁ, antes de llegar a leer/subir el PDF — aunque el archivo exista, no
 * confiamos en que su contenido esté completo.
 */
async function chequearErroresFatales(dir, nombre, motor = "pdflatex") {
  let log;
  try {
    log = await readFile(path.join(dir, `${nombre}.log`), "utf8");
  } catch {
    return; // sin .log no hay nada que chequear acá (leerConLog se ocupa después)
  }

  const errores = log.match(/^!.*(\n.*){0,4}/gm);
  if (errores && errores.length > 0) {
    const detalle = errores.slice(0, 3).join("\n---\n"); // hasta 3 errores, no todo el log
    throw new Error(
      `${motor} tuvo ${errores.length} error(es) real(es) compilando ${nombre}.tex (puede haber ` +
      `generado un .pdf igual, pero con contenido incompleto/en blanco — no se sube).` +
      `\n--- ${nombre}.log ---\n${detalle}`
    );
  }
}

/**
 * Lee el PDF esperado de <nombre>.tex. Si no existe (el motor de LaTeX
 * falló en serio, no solo warning), busca en <nombre>.log el primer "! "
 * (así arranca todo error real de LaTeX) y lo agrega al mensaje de la
 * excepción, para no quedarnos solo con un ENOENT sin pista de qué rompió.
 * La carpeta se borra igual después (ver finally de compilarTodo), pero al
 * menos el motivo real queda logueado antes de perderse.
 */
async function leerConLog(dir, nombre) {
  try {
    return await readFile(path.join(dir, `${nombre}.pdf`));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    let detalle = "";
    try {
      const log = await readFile(path.join(dir, `${nombre}.log`), "utf8");
      const match = log.match(/^!.*(\n.*){0,4}/m); // primer error real + contexto
      detalle = match ? `\n--- ${nombre}.log ---\n${match[0]}` : "";
    } catch {
      // sin .log tampoco: no hay más info que dar
    }
    throw new Error(`No se generó ${nombre}.pdf (falló la compilación).${detalle}`);
  }
}
