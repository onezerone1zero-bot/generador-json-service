// Envoltorio fino sobre fetch() que agrega un timeout real.
//
// BUG que esto arregla: ningún fetch() de este repo tenía timeout. Si la
// otra punta (Anthropic, Mistral, Supabase, Cloudflare KV, el Worker, o
// generador-json-service) se cuelga -- acepta la conexión pero nunca
// contesta, ni cierra el socket -- la promesa de fetch() no se resuelve
// NI se rechaza. Nunca. Quien esté haciendo `await` de eso se queda
// colgado para siempre, y si esa llamada está adentro de un job de la
// cola (ver cola.js), el job queda en estado "procesando" en Supabase
// eternamente -- nadie lo marca ni "listo" ni "fallido", así que
// buscarTrabajoActivo() lo sigue encontrando activo para siempre.
//
// Peor todavía en mistral.js: TODAS las llamadas a Mistral del proceso
// pasan por una cola en memoria (serializar()). Si una sola llamada se
// cuelga así, la cola entera queda trabada para siempre -- cualquier
// llamada futura a Mistral (de cualquier request, para cualquier tema)
// se pone en fila detrás de la que nunca termina. Esto es lo que pasó el
// 18/09 con "ガロア理論": una vez trabada, ningún reintento sirve de nada
// hasta reiniciar el proceso.
//
// AbortSignal.timeout(ms) (nativo desde Node 17.3, y este repo ya corre
// Node 20 -- ver Dockerfile) dispara un abort automático pasado el
// plazo, así que fetch() SIEMPRE termina resolviendo o rechazando, pase
// lo que pase del otro lado.
export async function fetchConTimeout(url, options = {}, timeoutMs = 20000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // AbortSignal.timeout dispara con name="TimeoutError"; un abort
    // manual (no usado hoy en este repo, pero por si acaso) da
    // "AbortError". Los dos casos son "se agotó el tiempo", así que se
    // normalizan a un mensaje legible en vez de dejar pasar el
    // DOMException crudo.
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // url relativa o inválida, se deja tal cual en el mensaje
      }
      throw new Error(`Timeout (${timeoutMs}ms) esperando respuesta de ${host}`);
    }
    throw err;
  }
}
