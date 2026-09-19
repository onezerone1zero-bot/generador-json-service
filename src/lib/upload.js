// lib/upload.js
import { fetchConTimeout } from "./fetchTimeout.js";

const WORKER_URL = process.env.WORKER_URL; // ej: https://arch-upload-worker.tu-cuenta.workers.dev
const WORKER_UPLOAD_KEY = process.env.WORKER_UPLOAD_KEY;

// Más generoso que el resto: son binarios (PDF/epub), y el Worker de
// Cloudflare puede tardar un poco en aceptar el form completo.
const TIMEOUT_MS = 90_000;

// 1. Agregado el parámetro 'tema' y se envía en el form
// 3. Agregado 'idioma' -- el Worker lo usa para decidir la carpeta
//    (default/<idioma>/archivo). La instancia española manda "es" igual
//    que las demás; el Worker decide si eso implica carpeta o no.
//
// DEPENDENCIA DE DEPLOY (idioma-diffs review, issue 3 -- NO se puede
// arreglar desde este repo): este campo "idioma" solo sirve si el Worker
// (arch-upload-worker, repo aparte) ya está actualizado para leerlo y
// separar por carpeta en /default/upload. Si este archivo se deploya
// ANTES que ese cambio en el Worker, el campo se manda pero se ignora, y
// TODO sigue cayendo en la misma carpeta -- con riesgo de que un archivo
// de otro idioma pise al español si dos temas en idiomas distintos
// terminan con el mismo "slug" (ej: slugs cortos o numéricos). Confirmar
// que el endpoint /default/upload del Worker ya está leyendo "idioma"
// del form ANTES de deployar esta versión de generador-service (o
// deployar ambos juntos).
async function subirUno(nombre, buffer, contentType, tema, idioma) {
  const form = new FormData();
  form.append("archivo", new Blob([buffer], { type: contentType }), nombre);
  form.append("nombre", nombre);
  form.append("tema", tema); // Nuevo campo
  form.append("idioma", idioma || "es");

  const resp = await fetchConTimeout(
    `${WORKER_URL}/default/upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${WORKER_UPLOAD_KEY}` },
      body: form,
    },
    TIMEOUT_MS
  );

  if (!resp.ok) {
    throw new Error(`Fallo al subir ${nombre}: ${resp.status} ${await resp.text()}`);
  }
}

// 2. Agregado el parámetro 'tema' y se pasa en las 4 llamadas
// 4. Agregado 'idioma' -- ya no sale de process.env.IDIOMA (la instancia
//    no tiene idioma fijo), sale del contexto de la generación en curso.
export async function subirCompilados(slug, compilados, tema, idioma) {
  await Promise.all([
    subirUno(`${slug}_teoria.pdf`, compilados.teoriaPdf, "application/pdf", tema, idioma),
    subirUno(`${slug}_teoria.epub`, compilados.teoriaEpub, "application/epub+zip", tema, idioma),
    subirUno(`${slug}_practica.pdf`, compilados.practicaPdf, "application/pdf", tema, idioma),
    subirUno(`${slug}_extra.pdf`, compilados.extraPdf, "application/pdf", tema, idioma),
  ]);
}
