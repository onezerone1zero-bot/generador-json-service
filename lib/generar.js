import { llamarIA as llamarDeepSeek, esErrorDeCreditoDeepSeek } from "./deepseek.js";
import { llamarIA as llamarChatGPT, esErrorDeCreditoOpenAI } from "./chatgpt.js";
import { armarPromptDeepSeek, armarPromptChatGPT } from "../prompts/prompts.js";
import { validarPreguntas, validarFormulas } from "./validarEstructura.js";
import { escribirJSON, keyPractice, keyExam, keyFormulas } from "./kv.js";
import { slugify } from "./slugify.js";

const MAX_TOKENS_PREGUNTAS = 16000; // 60 preguntas con enunciado+opciones+explicación pesan bastante
const MAX_TOKENS_FORMULAS = 4000;

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
 * DeepSeek crea -> valida forma -> ChatGPT corrige -> valida forma de
 * nuevo -> guarda en KV.
 *
 * A diferencia del pipeline de generador-service-main (que tiene rondas
 * de generar/revisar con posible rechazo y reintento), acá es más simple
 * a propósito: no hay compilación LaTeX que pueda fallar, así que un
 * único pase crear->corregir alcanza. Si en el futuro se necesita que
 * ChatGPT pueda "rechazar y mandar de vuelta" a DeepSeek con
 * correcciones puntuales, este es el lugar para agregar ese loop.
 *
 * Si el borrador de DeepSeek no valida, NO se llama a ChatGPT (no tiene
 * sentido corregir algo con la forma rota) -- se corta ahí con error.
 * Si ChatGPT falla por crédito/cuota, se sigue adelante con el borrador
 * de DeepSeek tal cual (ya validado), en vez de abortar el job entero.
 */
async function generarUnTipo(tipo, materia, tema) {
  const slugMateria = slugify(materia);
  const slugTema = slugify(tema);
  console.log(`[generar-json] ${tipo}: DeepSeek arma el borrador (${materia} / ${tema})`);

  const { system: sysCrear, prompt: promptCrear } = armarPromptDeepSeek(tipo, materia, tema);
  const maxTokens = tipo === "formula" ? MAX_TOKENS_FORMULAS : MAX_TOKENS_PREGUNTAS;

  const borrador = await llamarDeepSeek({ system: sysCrear, prompt: promptCrear, parseJson: true, maxTokens });

  const validacionBorrador = validar(tipo, borrador);
  if (!validacionBorrador.ok) {
    throw new Error(
      `[generar-json] ${tipo}: el borrador de DeepSeek no tiene la forma esperada:\n  - ${validacionBorrador.errores.join("\n  - ")}`
    );
  }

  console.log(`[generar-json] ${tipo}: ChatGPT corrige el borrador`);
  const { system: sysCorregir, prompt: promptCorregir } = armarPromptChatGPT(tipo, borrador);

  let final = borrador;
  try {
    const corregido = await llamarChatGPT({ system: sysCorregir, prompt: promptCorregir, parseJson: true, maxTokens });
    const validacionCorregido = validar(tipo, corregido);
    if (validacionCorregido.ok) {
      final = corregido;
    } else {
      console.warn(
        `[generar-json] ${tipo}: la corrección de ChatGPT no tiene la forma esperada, me quedo con el borrador de DeepSeek:\n  - ${validacionCorregido.errores.join("\n  - ")}`
      );
    }
  } catch (err) {
    if (esErrorDeCreditoOpenAI(err)) {
      console.warn(`[generar-json] ${tipo}: ChatGPT sin crédito/cuota (${err.message.slice(0, 200)}), sigo con el borrador de DeepSeek sin corregir`);
    } else {
      console.warn(`[generar-json] ${tipo}: ChatGPT falló (${err.message.slice(0, 200)}), sigo con el borrador de DeepSeek sin corregir`);
    }
  }

  const key = keyPara(tipo, slugMateria, slugTema);
  console.log(`[generar-json] ${tipo}: guardando en KV (${key})`);
  await escribirJSON(key, final);

  return { tipo, slugMateria, slugTema, key };
}

/**
 * Genera practice.json y exam.json para un tema (y opcionalmente
 * formula.json). tipos: array con los tipos a generar, default
 * ["practice", "exam"].
 *
 * Si uno de los tipos falla (DeepSeek caído, borrador irrecuperable,
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
  return esErrorDeCreditoDeepSeek(err) || esErrorDeCreditoOpenAI(err);
}
