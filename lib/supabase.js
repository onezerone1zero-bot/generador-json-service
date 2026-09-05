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
 * la tabla `kv_entradas`. Upsert por (namespace, materia, idioma): cada
 * regeneración de la misma materia EN EL MISMO IDIOMA pisa el tamaño
 * anterior en vez de sumar filas nuevas (igual criterio que
 * registrarArchivoDefault en el Worker).
 *
 * NOTA DE SCHEMA (corregido tras chequear la tabla real en Supabase):
 * `kv_entradas` nunca tuvo columna `tema` -- agrupa por materia
 * completa, no por tema individual. La versión anterior de este
 * comentario (y del código) asumía una columna `tema` que no existe;
 * se corrigió para que el POST solo mande columnas reales de la tabla
 * (namespace, materia, tamano_bytes, actualizado_at) más `idioma` nueva.
 * Con esto, dos temas de la misma materia siguen sumando al mismo total
 * (eso ya pasaba antes, no es un cambio de comportamiento) -- lo único
 * nuevo es que ahora el total se separa también por idioma.
 *
 * `idioma` (agregado, ver ANALISIS-idioma-generador-json.md): sin esto,
 * generar la misma materia en dos idiomas pisaría el mismo registro de
 * Supabase (mismo namespace+materia), perdiendo el tamaño del primero.
 *
 * REQUIERE (fuera de este repo, ver migracion-kv-entradas-idioma.sql):
 * agregar la columna `idioma` (text, default 'es') a `kv_entradas` y
 * cambiar su UNIQUE de (namespace, materia) a (namespace, materia,
 * idioma) -- si no, el on_conflict de abajo va a fallar.
 *
 * Best-effort: nunca tira -- si Supabase falla, la escritura real a KV
 * (lo importante) ya se hizo antes de llamar acá.
 */
export async function registrarKvEntrada(namespace, materia, idioma, tamanoBytes) {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/kv_entradas?on_conflict=namespace,materia,idioma`,
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
          idioma,
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
