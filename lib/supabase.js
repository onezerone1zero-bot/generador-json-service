// Cliente minimal de Supabase REST -- lo único que necesita este servicio
// es registrar el tamaño de cada entrada de KV (practice/exam/formula) en
// la tabla `kv_entradas`, para el contador de almacenamiento híbrido
// (ver plan-almacenamiento-hibrido). No lee nada de Supabase, solo escribe.
//
// Requiere estas 2 variables de entorno nuevas en Render:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Registra (o actualiza si ya existía) el tamaño de una entrada de KV en
 * la tabla `kv_entradas`. Upsert por (namespace, materia, tema): cada
 * regeneración del mismo tema pisa el tamaño anterior en vez de sumar
 * filas nuevas (igual criterio que registrarArchivoDefault en el Worker).
 * Best-effort: nunca tira -- si Supabase falla, la escritura real a KV
 * (lo importante) ya se hizo antes de llamar acá.
 */
export async function registrarKvEntrada(namespace, materia, tema, tamanoBytes) {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/kv_entradas?on_conflict=namespace,materia,tema`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          namespace,
          materia,
          tema,
          tamano_bytes: tamanoBytes,
          actualizado_at: new Date().toISOString(),
        }),
      }
    );
    if (!resp.ok) {
      const detalle = await resp.text();
      return { ok: false, detalle };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detalle: err.message };
  }
}
