/**
 * POST al callback_url que mandó analyzer_con_vi, para avisarle que
 * terminamos (bien o mal) de crear el tema que pidió.
 *
 * No relanza el error si el callback falla (ej: analyzer dormido en
 * Render en ese momento) -- ya hicimos el trabajo real (o fallamos en
 * intentarlo), no tiene sentido reintentar el aviso infinitamente acá.
 * Si el callback se pierde, el job queda "esperando_tema" en Supabase
 * y requiere revisión manual -- ver nota de confiabilidad, mismo caso
 * que el webhook-upload del worker.
 */
import { fetchConTimeout } from "./fetchTimeout.js";

export async function avisarCallback(callbackUrl, secret, payload) {
  try {
    const resp = await fetchConTimeout(
      callbackUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(payload),
      },
      15_000
    );
    if (!resp.ok) {
      console.error(`[callback] respuesta no-ok de analyzer (${resp.status}): ${await resp.text()}`);
    }
  } catch (err) {
    console.error(`[callback] no se pudo avisar a analyzer_con_vi: ${err.message}`);
  }
}
