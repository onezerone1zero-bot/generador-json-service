// Acceso a la tabla trabajos_generador en Supabase: la cola que serializa
// las llamadas a generarYPublicar. Mismo patrón que trabajos_analyzer en
// analyzer_con_vi (REST directo contra PostgREST, sin librería de Supabase),
// y de hecho puede vivir en el mismo proyecto de Supabase que ya usás ahí.
//
// Requiere estas 2 variables de entorno en Render (las mismas que ya tiene
// analyzer_con_vi):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { fetchConTimeout } from "./fetchTimeout.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// PostgREST siempre responde rápido (es una query directa a Postgres);
// si tarda más que esto es que algo está realmente mal, mejor fallar
// rápido y dejar que reclamarHuerfanos() se ocupe en el próximo boot que
// quedarse esperando sin límite (ver fetchTimeout.js).
const TIMEOUT_MS = 15_000;

// Cuántas veces se le permite a un job volver de "procesando" a "pendiente"
// por haber quedado huérfano (proceso reiniciado a mitad de camino) antes
// de abandonarlo como fallido en vez de reencolarlo de nuevo. Sin este tope,
// un job que dispara una excepción que tumba el proceso (o cae justo en un
// reinicio/deploy) se reprocesa desde cero -- 3 rondas completas de
// Mistral+Claude -- en CADA boot siguiente, para siempre. Requiere la
// columna "intentos" en trabajos_generador (ver migración SQL más abajo).
const MAX_REINTENTOS_HUERFANO = Number(process.env.MAX_REINTENTOS_HUERFANO || 2);

/*
 * Migración SQL necesaria en Supabase (correr una sola vez, en el SQL
 * Editor -- mismo lugar donde se creó el índice único parcial de
 * clave_dedup y la función agregar_callback_trabajo):
 *
 *   alter table trabajos_generador
 *     add column if not exists intentos int not null default 0;
 *
 *   create or replace function reclamar_huerfanos_reintentables(p_max_intentos int)
 *   returns setof trabajos_generador
 *   language sql
 *   as $$
 *     update trabajos_generador
 *     set estado = 'pendiente',
 *         intentos = intentos + 1,
 *         actualizado_en = now()
 *     where estado = 'procesando'
 *       and intentos < p_max_intentos
 *     returning *;
 *   $$;
 *
 * El incremento de "intentos" tiene que ser atómico en la base (no
 * lectura+escritura desde JS) por la misma razón que agregar_callback_trabajo
 * ya es una función de Postgres: si dos procesos llaman reclamarHuerfanos
 * casi al mismo tiempo, ninguno debe pisar el conteo del otro.
 */

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function chequear(resp, contexto) {
  if (!resp.ok) {
    throw new Error(`Supabase falló (${contexto}): ${resp.status} ${await resp.text()}`);
  }
}

/**
 * Busca un trabajo pendiente o en curso con la misma clave de dedup
 * (materia+tema). Si existe, quien pide encolar se suma a esperar ese
 * mismo resultado en vez de disparar un pipeline duplicado.
 */
export async function buscarTrabajoActivo(claveDedup) {
  const resp = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador?clave_dedup=eq.${encodeURIComponent(claveDedup)}` +
      `&estado=in.(pendiente,procesando)&select=*&order=creado_en.asc&limit=1`,
    { headers: headers() },
    TIMEOUT_MS
  );
  await chequear(resp, "buscarTrabajoActivo");
  const filas = await resp.json();
  return filas[0] || null;
}

export async function obtenerTrabajo(id) {
  const resp = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador?id=eq.${id}&select=*`,
    { headers: headers() },
    TIMEOUT_MS
  );
  await chequear(resp, "obtenerTrabajo");
  const filas = await resp.json();
  return filas[0] || null;
}

/**
 * Crea un job nuevo. callbackInicial (opcional) = {url, secret, jobId} para
 * origen='callback' -- se guarda como el primer elemento del array
 * "callbacks" de la fila (puede sumarse más de uno después, ver
 * agregarCallback).
 *
 * clave_dedup tiene un índice único parcial (solo para estado en
 * pendiente/procesando -- ver migración SQL) para que dos requests casi
 * simultáneos para el mismo materia+tema no puedan crear dos filas activas
 * a la vez. Si perdemos esa carrera, Supabase devuelve 409 y nos enganchamos
 * al que ganó en vez de fallar.
 */
export async function crearTrabajo({ claveDedup, materia, tema, contexto, origen, callbackInicial = null }) {
  const resp = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador`,
    {
      method: "POST",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        clave_dedup: claveDedup,
        materia,
        tema,
        contexto,
        origen,
        callbacks: callbackInicial ? [callbackInicial] : [],
      }),
    },
    TIMEOUT_MS
  );

  if (resp.status === 409) {
    const existente = await buscarTrabajoActivo(claveDedup);
    if (existente) return { ...existente, __enganchado: true };
    // Rarísimo: el que ganó la carrera ya terminó entre el 409 y esta
    // relectura (job muy corto). El slot quedó libre de nuevo -- probamos
    // crear una vez más.
    return crearTrabajo({ claveDedup, materia, tema, contexto, origen, callbackInicial });
  }

  await chequear(resp, "crearTrabajo");
  const filas = await resp.json();
  return filas[0];
}

/**
 * Suma un callback a un job que YA existía (nos enganchamos a él en vez de
 * crearlo). Usa una función de Postgres para que el append sea atómico en
 * la base -- si dos "enganches" llegan casi juntos, ninguno pisa al otro
 * (a diferencia de leer el array en JS, mutarlo y volver a escribirlo
 * entero, que sí tendría el mismo tipo de carrera que esto viene a evitar).
 */
export async function agregarCallback(id, callback) {
  const resp = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/rpc/agregar_callback_trabajo`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ p_id: id, p_callback: callback }),
    },
    TIMEOUT_MS
  );
  await chequear(resp, "agregarCallback");
}

/**
 * Toma el próximo pendiente más viejo y lo marca 'procesando' de forma
 * atómica: el PATCH solo pega si la fila sigue en 'pendiente' en ese
 * instante. Si en algún momento corre más de una instancia de este
 * servicio a la vez, esto evita que dos workers agarren el mismo job.
 * Devuelve null si no hay nada pendiente (o si alguien más se lo llevó
 * primero).
 */
export async function tomarSiguientePendiente() {
  const respBuscar = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador?estado=eq.pendiente&select=id&order=creado_en.asc&limit=1`,
    { headers: headers() },
    TIMEOUT_MS
  );
  await chequear(respBuscar, "tomarSiguientePendiente:buscar");
  const candidatos = await respBuscar.json();
  if (candidatos.length === 0) return null;

  const { id } = candidatos[0];
  const respTomar = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador?id=eq.${id}&estado=eq.pendiente`,
    {
      method: "PATCH",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ estado: "procesando", actualizado_en: new Date().toISOString() }),
    },
    TIMEOUT_MS
  );
  await chequear(respTomar, "tomarSiguientePendiente:tomar");
  const filas = await respTomar.json();
  return filas[0] || null;
}

export async function marcarListo(id, resultado) {
  const resp = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador?id=eq.${id}`,
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ estado: "listo", resultado, actualizado_en: new Date().toISOString() }),
    },
    TIMEOUT_MS
  );
  await chequear(resp, "marcarListo");
}

export async function marcarFallido(id, mensajeError) {
  const resp = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador?id=eq.${id}`,
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ estado: "fallido", error: mensajeError, actualizado_en: new Date().toISOString() }),
    },
    TIMEOUT_MS
  );
  await chequear(resp, "marcarFallido");
}

/**
 * Al bootear el servicio: cualquier fila que haya quedado 'procesando' es
 * de un boot anterior (Render corre una sola instancia de este servicio
 * salvo que la escales manualmente), así que nadie la sigue procesando de
 * verdad.
 *
 * Reencola a 'pendiente' (sumando 1 a intentos, atómico vía RPC) SOLO si
 * todavía no agotó MAX_REINTENTOS_HUERFANO. Los que ya lo agotaron se
 * abandonan como 'fallido' acá mismo, en vez de quedar reencolándose para
 * siempre en cada boot si el job es el que está tumbando el proceso.
 *
 * Devuelve { reencolados, abandonados } -- iniciarCola() usa "abandonados"
 * para avisar por callback a quien estaba esperando ese job, ya que de otra
 * forma un job con callback que se abandona acá nunca le avisa a nadie.
 */
export async function reclamarHuerfanos() {
  const respReintentables = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/rpc/reclamar_huerfanos_reintentables`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ p_max_intentos: MAX_REINTENTOS_HUERFANO }),
    },
    TIMEOUT_MS
  );
  await chequear(respReintentables, "reclamarHuerfanos:reintentables");
  const reencolados = await respReintentables.json();
  if (reencolados.length > 0) {
    console.warn(`[cola] ${reencolados.length} job(s) huérfano(s) de un boot anterior, reencolados (intento sumado)`);
  }

  const respAbandonados = await fetchConTimeout(
    `${SUPABASE_URL}/rest/v1/trabajos_generador?estado=eq.procesando&intentos=gte.${MAX_REINTENTOS_HUERFANO}`,
    {
      method: "PATCH",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        estado: "fallido",
        error: `Abandonado: quedó huérfano ${MAX_REINTENTOS_HUERFANO} vez/veces sin completar (el proceso se reinició a mitad de camino repetidamente). Revisar manualmente antes de reintentar.`,
        actualizado_en: new Date().toISOString(),
      }),
    },
    TIMEOUT_MS
  );
  await chequear(respAbandonados, "reclamarHuerfanos:abandonados");
  const abandonados = await respAbandonados.json();
  if (abandonados.length > 0) {
    console.error(
      `[cola] ${abandonados.length} job(s) abandonados tras agotar reintentos de huérfano: ` +
      abandonados.map((j) => `${j.id} (${j.materia}/${j.tema})`).join(", ")
    );
  }

  return { reencolados, abandonados };
}
