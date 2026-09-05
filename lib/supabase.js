const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function registrarKvEntrada(namespace, materia, tema, idioma, tamanoBytes) {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/kv_entradas?on_conflict=namespace,materia,tema,idioma`,
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
