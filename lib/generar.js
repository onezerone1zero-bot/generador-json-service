import { llamarIA as llamarClaude, esErrorDeCreditoAnthropic } from "./claude.js";
import { llamarIA as llamarMistral, esErrorDeCreditoMistral } from "./mistral.js";
import { armarPromptClaude, armarPromptMistral } from "../prompts/prompts.js";
import { validarPreguntas, validarFormulas } from "./validarEstructura.js";
import { leerJSON, escribirJSON, borrarJSON, keyPractice, keyExam, keyFormulas } from "./kv.js";
import { slugify } from "./slugify.js";

const MAX_TOKENS_PREGUNTAS = 16000; // 60 preguntas con enunciado+opciones+explicación pesan bastante
const MAX_TOKENS_FORMULAS = 4000;

// TTL del lock "generación en curso", en segundos. Tiene que alcanzar
// para las 2 llamadas de IA (Claude + Mistral) de un tipo con margen;
// si el proceso se cuelga a mitad de camino, pasado este tiempo la key
// expira sola y un request posterior puede reintentar en vez de quedar
// bloqueado para siempre.
const TTL_LOCK_SEGUNDOS = 600; // 10 min

function validar(tipo, data) {
  return tipo === "formula" ? validarFormulas(data) : validarPreguntas(data);
}

function keyPara(tipo, slugMateria, slugTema) {
  if (tipo === "practice") return keyPractice(slugMateria, slugTema);
  if (tipo === "exam") return keyExam(slugMateria, slugTema);
  return keyFormulas(slugMateria, slugTema);
}

/**
 * Corre el flujo para UN tipo de JSON (practice, exam, o formula):
 * chequea si la key ya existe en KV -> reserva la key (lock) -> Claude
 * crea -> valida forma -> Mistral corrige -> valida forma de nuevo ->
 * guarda el resultado final en KV (pisando el lock).
 *
 * El chequeo + la reserva pasan ANTES de llamar a ninguna IA: así, si
 * llegan dos requests para el mismo materia+tema (doble click, retry
 * por timeout del caller, etc.), el segundo ve la key ya ocupada y
 * corta ahí -- no vuelve a gastar llamadas de Claude/Mistral ni pisa
 * en KV lo que el primero ya guardó.
 *
 * Nota: Cloudflare KV es eventualmente consistente entre edge
 * locations, así que esto no es un lock perfecto para requests que
 * llegan literalmente al mismo milisegundo -- pero cubre el caso real
 * (doble click, retry de un caller con timeout), que es lo que estaba
 * pasando.
 *
 * Si el borrador de Claude no valida, NO se llama a Mistral (no tiene
 * sentido corregir algo con la forma rota) -- se corta ahí con error
 * (y se libera el lock, ver abajo). Si Mistral falla por crédito/cuota,
 * se sigue adelante con el borrador de Claude tal cual (ya validado),
 * en vez de abortar el job entero.
 */
async function generarUnTipo(tipo, materia, tema) {
  const slugMateria = slugify(materia);
  const slugTema = slugify(tema);
  const key = keyPara(tipo, slugMateria, slugTema);

  const existente = await leerJSON(key);
  if (existente) {
    if (existente._enGeneracion) {
      console.log(`[generar-json] ${tipo}: ya se está generando en otro request (${key}), no arranco de nuevo`);
    } else {
      console.log(`[generar-json] ${tipo}: ya existe en KV (${key}), no se regenera`);
    }
    return { tipo, slugMateria, slugTema, key, generado: false };
  }

  // Reservamos la key ANTES de llamar a las IAs -- ver nota arriba.
  await escribirJSON(
    key,
    { _enGeneracion: true, iniciadoEn: new Date().toISOString() },
    { ttlSegundos: TTL_LOCK_SEGUNDOS }
  );

  try {
    console.log(`[generar-json] ${tipo}: Claude arma el borrador (${materia} / ${tema})`);

    const { system: sysCrear, prompt: promptCrear } = armarPromptClaude(tipo, materia, tema);
    const maxTokens = tipo === "formula" ? MAX_TOKENS_FORMULAS : MAX_TOKENS_PREGUNTAS;

    const borrador = await llamarClaude({ system: sysCrear, prompt: promptCrear, parseJson: true, maxTokens });

    const validacionBorrador = validar(tipo, borrador);
    if (!validacionBorrador.ok) {
      throw new Error(
        `[generar-json] ${tipo}: el borrador de Claude no tiene la forma esperada:\n  - ${validacionBorrador.errores.join("\n  - ")}`
      );
    }

    console.log(`[generar-json] ${tipo}: Mistral corrige el borrador`);
    const { system: sysCorregir, prompt: promptCorregir } = armarPromptMistral(tipo, borrador);

    let final = borrador;
    try {
      const corregido = await llamarMistral({ system: sysCorregir, prompt: promptCorregir, parseJson: true, maxTokens });
      const validacionCorregido = validar(tipo, corregido);
      if (validacionCorregido.ok) {
        final = corregido;
      } else {
        console.warn(
          `[generar-json] ${tipo}: la corrección de Mistral no tiene la forma esperada, me quedo con el borrador de Claude:\n  - ${validacionCorregido.errores.join("\n  - ")}`
        );
      }
    } catch (err) {
      if (esErrorDeCreditoMistral(err)) {
        console.warn(`[generar-json] ${tipo}: Mistral sin crédito/cuota (${err.message.slice(0, 200)}), sigo con el borrador de Claude sin corregir`);
      } else {
        console.warn(`[generar-json] ${tipo}: Mistral falló (${err.message.slice(0, 200)}), sigo con el borrador de Claude sin corregir`);
      }
    }

    console.log(`[generar-json] ${tipo}: guardando en KV (${key})`);
    await escribirJSON(key, final);

    return { tipo, slugMateria, slugTema, key, generado: true };
  } catch (err) {
    // Liberamos el lock para que un retry posterior no tenga que
    // esperar los TTL_LOCK_SEGUNDOS -- best-effort, si el borrado
    // falla el TTL lo limpia igual más tarde.
    try {
      await borrarJSON(key);
    } catch (errBorrado) {
      console.warn(`[generar-json] ${tipo}: no pude liberar el lock (${key}) después del error: ${errBorrado.message}`);
    }
    throw err;
  }
}

/**
 * Genera practice.json y exam.json para un tema (y opcionalmente
 * formula.json). tipos: array con los tipos a generar, default
 * ["practice", "exam"].
 *
 * Si uno de los tipos falla (Claude caído, borrador irrecuperable,
 * etc.), NO frena a los demás -- se juntan los resultados y errores de
 * todos, así un fallo puntual en "exam" no te hace perder el "practice"
 * que sí salió bien.
 */
export async function generarYGuardarJSON({ materia, tema, tipos = ["practice", "exam"] }) {
  if (!materia || !tema) {
    throw new Error("Faltan materia o tema");
  }

  const resultados = [];
  const errores = [];

  for (const tipo of tipos) {
    try {
      const resultado = await generarUnTipo(tipo, materia, tema);
      resultados.push(resultado);
    } catch (err) {
      console.error(`[generar-json] ${tipo} falló:`, err.message);
      errores.push({ tipo, error: err.message });
    }
  }

  return {
    ok: errores.length === 0,
    slugMateria: slugify(materia),
    slugTema: slugify(tema),
    resultados,
    errores: errores.length > 0 ? errores : null,
  };
}

/**
 * Detecta si algún error del pipeline es por falta de crédito/cuota en
 * cualquiera de las dos IAs -- usado por server.js para loguear distinto
 * (no es un bug, es un tema de facturación).
 */
export function esErrorDeCredito(err) {
  return esErrorDeCreditoAnthropic(err) || esErrorDeCreditoMistral(err);
}
