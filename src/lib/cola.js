// Serializa las llamadas a generarYPublicar (IA#3/4 + figura + compilación
// pdflatex/tex4ebook + escritura en KV) detrás de una cola persistida en
// Supabase, para que /generar, /aviso-tema-auto y /crear-tema-callback no
// disparen cada uno su propio pipeline en paralelo.
//
// Todo lo que NO es generarYPublicar (auth, /clasificar, IA#2 de
// aviso-tema-auto y crear-tema-callback) sigue corriendo por request como
// antes -- son 1-2 llamadas de IA relativamente baratas, no el paso pesado.
// Solo se encola el paso pesado en sí.
//
// CONCURRENCIA (env var COLA_CONCURRENCIA, default 1): cuántos jobs de
// generarYPublicar corren en simultáneo. Subilo con cuidado -- cada uno
// corre pdflatex/tex4ebook, que son pesados de CPU/RAM. Con el plan más
// chico de Render, 1 es lo seguro.

import { generarYPublicar } from "./generar.js";
import { slugify } from "./slugify.js";
import { avisarCallback } from "./callback.js";
import {
  buscarTrabajoActivo,
  obtenerTrabajo,
  crearTrabajo,
  agregarCallback,
  tomarSiguientePendiente,
  marcarListo,
  marcarFallido,
  reclamarHuerfanos,
} from "./supabaseCola.js";

const CONCURRENCIA = Number(process.env.COLA_CONCURRENCIA || 1);
const SEGUNDOS_ENTRE_BOMBEOS = 30_000;

// id de fila -> [{resolve, reject}]. Vive en memoria a propósito: solo le
// sirve a quien está esperando la respuesta HTTP en ESTE mismo proceso
// (/generar, /aviso-tema-auto). Si el proceso reinicia, esas requests HTTP
// ya murieron con él de todas formas -- lo que sí sobrevive un reinicio es
// la fila en Supabase (ver reclamarHuerfanos).
const esperando = new Map();
let enCurso = 0;
let bombeando = false;

function claveDedup(materia, tema) {
  return `${materia}::${slugify(tema)}`;
}

function resolverEsperas(id, ok, valor) {
  const lista = esperando.get(id);
  if (!lista) return; // ya se resolvió antes (ver reconsultarSiYaTermino), no-op
  esperando.delete(id);
  for (const { resolve, reject } of lista) {
    ok ? resolve(valor) : reject(valor instanceof Error ? valor : new Error(valor));
  }
}

/**
 * Encola un contexto para generarYPublicar, o se engancha a un job activo
 * que ya exista para el mismo materia+tema. callback (opcional) = {url,
 * secret, jobId} para quien necesita que le avisen por HTTP cuando termine
 * (crear-tema-callback) -- si el job ya existía por otro origen, el
 * callback se SUMA sin pisar los que ya había, así que más de un
 * interesado puede esperar el mismo job sin que ninguno se pierda.
 */
async function encolarOEngancharse(contexto, { origen, callback = null }) {
  const clave = claveDedup(contexto.materia, contexto.tema);

  let trabajo = await buscarTrabajoActivo(clave);
  let nosEnganchamos = Boolean(trabajo);

  if (!trabajo) {
    trabajo = await crearTrabajo({
      claveDedup: clave,
      materia: contexto.materia,
      tema: contexto.tema,
      contexto,
      origen,
      callbackInicial: callback,
    });
    // Si crearTrabajo perdió la carrera de creación (409, dos requests
    // casi simultáneos), vuelve marcado __enganchado -- ahí también hay
    // que sumar el callback, no viene incluido.
    nosEnganchamos = trabajo.__enganchado === true;
    if (nosEnganchamos) {
      console.log(`[cola] "${clave}" -- perdimos la carrera de creación, enganchado al job ${trabajo.id}`);
    } else {
      console.log(`[cola] "${clave}" encolado como job ${trabajo.id} (origen=${origen})`);
    }
  } else {
    console.log(`[cola] "${clave}" ya tiene un job en curso (id ${trabajo.id}), me sumo en vez de duplicar`);
  }

  if (callback && nosEnganchamos) {
    await agregarCallback(trabajo.id, callback);
  }

  bombear();
  return { trabajo, nosEnganchamos };
}

/**
 * Si nos enganchamos a un job que ya existía, hay una ventana angosta pero
 * real: puede haber terminado (y ya haber resuelto a todos los que estaban
 * anotados en `esperando`) entre que lo leímos y que nos anotamos acá. Sin
 * este chequeo, quedaríamos esperando un aviso que ya pasó -- la request
 * de /generar o /aviso-tema-auto colgada hasta que Render la corte por
 * timeout. Releemos el estado real y nos resolvemos solos si ya terminó.
 */
async function reconsultarSiYaTermino(id) {
  try {
    const actual = await obtenerTrabajo(id);
    if (!actual) return;
    if (actual.estado === "listo") resolverEsperas(id, true, actual.resultado);
    else if (actual.estado === "fallido") resolverEsperas(id, false, new Error(actual.error || "Falló la generación"));
  } catch (err) {
    console.error(`[cola] no se pudo reconsultar el job ${id}:`, err);
  }
}

function esperarTrabajo(trabajo, nosEnganchamos) {
  if (trabajo.estado === "listo") return Promise.resolve(trabajo.resultado);
  if (trabajo.estado === "fallido") return Promise.reject(new Error(trabajo.error || "Falló la generación"));

  return new Promise((resolve, reject) => {
    const lista = esperando.get(trabajo.id) || [];
    lista.push({ resolve, reject });
    esperando.set(trabajo.id, lista);

    // Solo hace falta el doble chequeo si nos enganchamos a un job que ya
    // existía -- uno recién creado por nosotros no puede haber terminado
    // todavía, así nos ahorramos la relectura extra en el caso común.
    if (nosEnganchamos) reconsultarSiYaTermino(trabajo.id);
  });
}

/**
 * Usado por /generar y /aviso-tema-auto: encola y no devuelve el control
 * hasta que el trabajo esté listo (o falle), preservando el contrato
 * síncrono que ya esperan sus llamadores (el admin/el Worker se quedan
 * esperando la respuesta HTTP).
 */
export async function encolarYEsperar(contexto) {
  const { trabajo, nosEnganchamos } = await encolarOEngancharse(contexto, { origen: "sync" });
  return esperarTrabajo(trabajo, nosEnganchamos);
}

/**
 * Usado por /crear-tema-callback: encola y devuelve enseguida. El worker
 * avisa por callback_url cuando termine (éxito o falla), igual que el
 * fire-and-forget de antes -- la diferencia es que ahora pasa por la cola
 * en vez de arrancar su propio pipeline al toque.
 */
export async function encolarSinEsperar(contexto, { callbackUrl, callbackSecret, jobIdAnalyzer }) {
  await encolarOEngancharse(contexto, {
    origen: "callback",
    callback: { url: callbackUrl, secret: callbackSecret, jobId: jobIdAnalyzer },
  });
}

function bombear() {
  if (bombeando) return;
  bombeando = true;

  (async () => {
    try {
      while (enCurso < CONCURRENCIA) {
        const trabajo = await tomarSiguientePendiente();
        if (!trabajo) break;
        enCurso++;
        procesarUno(trabajo).finally(() => {
          enCurso--;
          bombear();
        });
      }
    } catch (err) {
      console.error("[cola] error bombeando la cola:", err);
    } finally {
      bombeando = false;
    }
  })();
}

/**
 * Avisa a TODOS los interesados en este job, releyendo la fila en vez de
 * confiar en la lista de callbacks que tenía al arrancar -- alguien puede
 * haberse enganchado (sumando su propio callback) mientras generarYPublicar
 * corría, que en un caso con figura/varias rondas puede tardar minutos.
 */
async function avisarTodosLosCallbacks(id, materia, { ok, slug, motivo }) {
  let callbacks = [];
  try {
    const actual = await obtenerTrabajo(id);
    callbacks = Array.isArray(actual?.callbacks) ? actual.callbacks : [];
  } catch (err) {
    console.error(`[cola] no se pudieron releer los callbacks del job ${id}:`, err);
    return;
  }
  for (const cb of callbacks) {
    await avisarCallback(cb.url, cb.secret, { job_id: cb.jobId, ok, materia, slug, motivo });
  }
}

async function procesarUno(trabajo) {
  console.log(`[cola] job ${trabajo.id} arrancando: ${trabajo.materia} / ${trabajo.tema}`);
  try {
    const resultado = await generarYPublicar(trabajo.contexto);
    await marcarListo(trabajo.id, resultado);
    resolverEsperas(trabajo.id, true, resultado);
    await avisarTodosLosCallbacks(trabajo.id, trabajo.materia, { ok: true, slug: resultado.slug, motivo: null });
  } catch (err) {
    console.error(`[cola] job ${trabajo.id} falló:`, err);
    await marcarFallido(trabajo.id, err.message).catch(() => {});
    resolverEsperas(trabajo.id, false, err);
    await avisarTodosLosCallbacks(trabajo.id, trabajo.materia, { ok: false, slug: null, motivo: err.message });
  }
}

export async function iniciarCola() {
  const { abandonados } = await reclamarHuerfanos();
  for (const trabajo of abandonados) {
    // Nadie quedó esperando esto en memoria (proceso nuevo), pero sí puede
    // haber un callback_url persistido (origen "callback") que necesita
    // enterarse de que este job no va a terminar nunca -- mismo tratamiento
    // que un fallo normal en procesarUno().
    await avisarTodosLosCallbacks(trabajo.id, trabajo.materia, {
      ok: false,
      slug: null,
      motivo: trabajo.error,
    });
  }
  bombear();
  // Red de seguridad: si tomarSiguientePendiente() falla de forma
  // transitoria (Supabase caído un instante) justo cuando no hay ninguna
  // request nueva para volver a disparar la cola, esto evita que jobs
  // pendientes se queden esperando indefinidamente.
  setInterval(bombear, SEGUNDOS_ENTRE_BOMBEOS);
}
