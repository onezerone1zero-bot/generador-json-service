// Dispara la generación de practice/exam/formula en generador-json-service
// justo después de que el tema queda confirmado en subject_JSON (KV) --
// ver el call site en generar.js, después de agregarTemaAMateria().
//
// Fire-and-forget a propósito: NO se espera (no se hace `await` del
// resultado en el call site) para no duplicar el tiempo de respuesta de
// /generar, /aviso-tema-auto y /crear-tema-callback -- generador-json-service
// puede tardar varios minutos (2 IAs x 3 tipos). Tampoco aborta el flujo
// principal si falla: mismo criterio que avisarCallback en callback.js.
// Si hace falta enterarse de un fallo sin ir a buscar logs a mano, se
// puede pasar a un patrón de callback como el que ya usa analyzer_con_vi.

import { fetchConTimeout } from "./fetchTimeout.js";

const GENERADOR_JSON_URL = process.env.GENERADOR_JSON_URL;
const GENERADOR_JSON_SERVICE_KEY = process.env.GENERADOR_JSON_SERVICE_KEY;
const TIMEOUT_MS = 60_000;

/**
 * Dispara POST /generar-json en generador-json-service para los 3 tipos
 * (practice, exam, formula). No devuelve nada útil al caller a propósito
 * (fire-and-forget) -- no hagas `await` de esto en generar.js.
 *
 * Incluye reintentos con backoff exponencial (2s, 4s, 8s) ante errores
 * transitorios como 429 Too Many Requests.
 */
export function dispararGeneradorJson(materia, tema, idioma = "es") {
  if (!GENERADOR_JSON_URL || !GENERADOR_JSON_SERVICE_KEY) {
    console.warn(
      "[generador-json] GENERADOR_JSON_URL o GENERADOR_JSON_SERVICE_KEY no configuradas, salteo la llamada"
    );
    return;
  }

  console.log(`[generador-json] disparando practice+exam+formula para ${materia} / ${tema} (idioma: ${idioma})`);

  // Función interna async que maneja los reintentos
  (async () => {
    const body = JSON.stringify({
      materia,
      tema,
      tipos: ["practice", "exam", "formula"],
      idioma,
    });

    // MAX_REINTENTOS y DELAYS: antes eran 4 intentos con backoff 2s/4s/8s
    // (~14s de espera total). Si generador-json-service está ocupado con
    // un job anterior -- que puede tardar "varios minutos" (2 IAs x 3
    // tipos, ver comentario arriba) -- 14s no alcanza ni de cerca: se
    // agotan los reintentos mientras el otro job todavía está corriendo.
    // Ahora son 7 intentos con backoff creciente hasta un techo de 60s
    // (~3.5 minutos de espera total), més alineado con cuánto puede tardar
    // realmente el job que está bloqueando.
    const DELAYS_MS = [2000, 4000, 8000, 16000, 30000, 60000, 60000];
    const MAX_REINTENTOS = DELAYS_MS.length + 1; // 1 intento inicial + reintentos
    let intento = 1;

    while (intento <= MAX_REINTENTOS) {
      try {
        const resp = await fetchConTimeout(
          `${GENERADOR_JSON_URL}/generar-json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${GENERADOR_JSON_SERVICE_KEY}`,
            },
            body,
          },
          TIMEOUT_MS
        );

        if (resp.ok) {
          const data = await resp.json();
          if (!data.ok) {
            console.warn(
              `[generador-json] ${materia} / ${tema}: terminó con errores parciales:`,
              data.errores || data
            );
          } else {
            console.log(`[generador-json] ${materia} / ${tema}: listo (practice+exam+formula en KV)`);
          }
          return; // éxito, salimos
        }

        // Si es 429 (Too Many Requests), reintentamos con backoff
        if (resp.status === 429) {
          if (intento < MAX_REINTENTOS) {
            const delay = DELAYS_MS[intento - 1];
            console.warn(
              `[generador-json] 429 Too Many Requests, reintento ${intento + 1}/${MAX_REINTENTOS} en ${delay}ms para ${materia}/${tema}`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            intento++;
            continue;
          } else {
            // Último intento falló
            const errText = await resp.text();
            console.error(
              `[generador-json] falló definitivamente (429) tras ${MAX_REINTENTOS} intentos para ${materia}/${tema}: ${errText}`
            );
            return;
          }
        }

        // Otros errores (500, 400, etc.) no se reintentan (no son transitorios)
        const errText = await resp.text();
        console.error(`[generador-json] error HTTP ${resp.status} para ${materia}/${tema}: ${errText}`);
        return;
      } catch (err) {
        // Error de red (fetch falló), reintentamos si queda margen
        if (intento < MAX_REINTENTOS) {
          const delay = DELAYS_MS[intento - 1];
          console.warn(
            `[generador-json] error de red, reintento ${intento + 1}/${MAX_REINTENTOS} en ${delay}ms para ${materia}/${tema}: ${err.message}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          intento++;
          continue;
        } else {
          console.error(
            `[generador-json] no se pudo contactar al service tras ${MAX_REINTENTOS} intentos para ${materia}/${tema}: ${err.message}`
          );
          return;
        }
      }
    }
  })().catch((err) => {
    // Captura final por si algo queda sin atrapar
    console.error(
      `[generador-json] error no capturado para ${materia}/${tema}: ${err.message}`
    );
  });
}
