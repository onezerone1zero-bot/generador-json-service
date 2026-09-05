import { llamarIA as llamarClaude, esErrorDeCreditoAnthropic } from "./claude.js";
import { llamarIA as llamarMistral, esErrorDeCreditoMistral } from "./mistral.js";
import {
  armarPromptClaude,
  armarPromptMistral,
  armarPromptCorreccionFable,
  armarToolClaude,
  armarToolCorreccion,
} from "../prompts/prompts.js";
import { validarPreguntas, validarFormulas } from "./validarEstructura.js";
import { leerJSON, escribirJSON, borrarJSON, keyPractice, keyExam, keyFormulas } from "./kv.js";
import { slugify } from "./slugify.js";

const MAX_TOKENS_PREGUNTAS_POR_TIPO = {
  practice: 16000,
  exam: 28000,
};
const MAX_TOKENS_FORMULAS = 4000;

const TTL_LOCK_SEGUNDOS = 600;

const MAX_INTENTOS_BORRADOR = 3;

const MODELO_CLAUDE_POR_TIPO = {
  practice: "claude-opus-4-8",
  exam: "claude-opus-4-8",
  formula: "claude-opus-4-8",
};

function validar(tipo, data) {
  return tipo === "formula" ? validarFormulas(data) : validarPreguntas(data);
}

function keyPara(tipo, slugMateria, slugTema, slugTemaCanonico) {
  if (tipo === "practice") return keyPractice(slugMateria, slugTema, slugTemaCanonico);
  if (tipo === "exam") return keyExam(slugMateria, slugTema, slugTemaCanonico);
  return keyFormulas(slugMateria, slugTema, slugTemaCanonico);
}

const IDIOMA = process.env.IDIOMA || "es";

async function intentarCorregirConMistral(tipo, borrador, maxTokens) {
  const { system: sysCorregir, prompt: promptCorregir } = armarPromptMistral(tipo, borrador, IDIOMA);
  try {
    const corregido = await llamarMistral({ system: sysCorregir, prompt: promptCorregir, parseJson: true, maxTokens });
    const validacion = validar(tipo, corregido);
    if (validacion.ok) return corregido;
    console.warn(
      `[generar-json] ${tipo}: la corrección de Mistral no tiene la forma esperada:\n  - ${validacion.errores.join("\n  - ")}`
    );
  } catch (err) {
    if (esErrorDeCreditoMistral(err)) {
      console.warn(`[generar-json] ${tipo}: Mistral sin crédito/cuota (${err.message.slice(0, 200)})`);
    } else {
      console.warn(`[generar-json] ${tipo}: Mistral falló (${err.message.slice(0, 200)})`);
    }
  }
  return null;
}

async function intentarCorregirConOpus(tipo, borrador, maxTokens) {
  const { system: sysCorregir, prompt: promptCorregir } = armarPromptCorreccionFable(tipo, borrador, IDIOMA);
  const toolCorregir = armarToolCorreccion(tipo);
  try {
    const corregido = await llamarClaude({
      system: sysCorregir,
      prompt: promptCorregir,
      model: MODELO_CLAUDE_POR_TIPO[tipo],
      maxTokens,
      tool: toolCorregir,
    });
    const validacion = validar(tipo, corregido);
    if (validacion.ok) return corregido;
    console.warn(
      `[generar-json] ${tipo}: la corrección de Opus no tiene la forma esperada:\n  - ${validacion.errores.join("\n  - ")}`
    );
  } catch (err) {
    if (esErrorDeCreditoAnthropic(err)) {
      console.warn(`[generar-json] ${tipo}: Opus sin crédito/cuota (${err.message.slice(0, 200)})`);
    } else {
      console.warn(`[generar-json] ${tipo}: Opus falló (${err.message.slice(0, 200)})`);
    }
  }
  return null;
}

async function generarUnTipo(tipo, materia, tema, temaCanonico) {
  const slugMateria = slugify(materia);
  const slugTema = slugify(tema);
  const slugTemaCanonico = temaCanonico ? slugify(temaCanonico) : undefined;
  const key = keyPara(tipo, slugMateria, slugTema, slugTemaCanonico);

  const existente = await leerJSON(key, tipo);
  if (existente) {
    if (existente._enGeneracion) {
      console.log(`[generar-json] ${tipo}: ya se está generando en otro request (${key}), no arranco de nuevo`);
    } else {
      console.log(`[generar-json] ${tipo}: ya existe en KV (${key}), no se regenera`);
    }
    return { tipo, slugMateria, slugTema, key, generado: false };
  }

  await escribirJSON(
    key,
    { _enGeneracion: true, iniciadoEn: new Date().toISOString() },
    tipo,
    { ttlSegundos: TTL_LOCK_SEGUNDOS }
  );

  try {
    const { system: sysCrear, prompt: promptCrear } = armarPromptClaude(tipo, materia, tema, IDIOMA);
    const toolCrear = armarToolClaude(tipo);
    const maxTokens = tipo === "formula" ? MAX_TOKENS_FORMULAS : (MAX_TOKENS_PREGUNTAS_POR_TIPO[tipo] ?? 16000);

    let borrador;
    let ultimoError;
    for (let intento = 1; intento <= MAX_INTENTOS_BORRADOR; intento++) {
      console.log(`[generar-json] ${tipo}: Claude arma el borrador (${materia} / ${tema}), intento ${intento}/${MAX_INTENTOS_BORRADOR}`);
      try {
        const candidato = await llamarClaude({
          system: sysCrear,
          prompt: promptCrear,
          model: MODELO_CLAUDE_POR_TIPO[tipo],
          maxTokens,
          tool: toolCrear,
        });
        const validacionCandidato = validar(tipo, candidato);
        if (validacionCandidato.ok) {
          borrador = candidato;
          break;
        }
        ultimoError = new Error(
          `el borrador de Claude no tiene la forma esperada:\n  - ${validacionCandidato.errores.join("\n  - ")}`
        );
        console.warn(`[generar-json] ${tipo}: intento ${intento} inválido (${ultimoError.message}), reintentando...`);
      } catch (err) {
        ultimoError = err;
        console.warn(`[generar-json] ${tipo}: intento ${intento} falló (${err.message.slice(0, 200)}), reintentando...`);
      }
    }

    if (!borrador) {
      throw new Error(`[generar-json] ${tipo}: se agotaron los ${MAX_INTENTOS_BORRADOR} intentos del borrador. Último error: ${ultimoError?.message}`);
    }

    let final = borrador;

    if (MODELO_CLAUDE_POR_TIPO[tipo]) {
      console.log(`[generar-json] ${tipo}: Opus corrige el borrador`);
      const corregidoOpus = await intentarCorregirConOpus(tipo, borrador, maxTokens);
      if (corregidoOpus) {
        final = corregidoOpus;
      } else {
        console.warn(`[generar-json] ${tipo}: Opus no corrigió, pruebo con Mistral como fallback`);
        const corregidoMistral = await intentarCorregirConMistral(tipo, borrador, maxTokens);
        if (corregidoMistral) {
          final = corregidoMistral;
        } else {
          console.warn(`[generar-json] ${tipo}: Mistral tampoco corrigió, me quedo con el borrador sin corregir`);
        }
      }
    } else {
      console.log(`[generar-json] ${tipo}: Mistral corrige el borrador`);
      const corregidoMistral = await intentarCorregirConMistral(tipo, borrador, maxTokens);
      if (corregidoMistral) {
        final = corregidoMistral;
      } else {
        console.warn(`[generar-json] ${tipo}: Mistral no corrigió, me quedo con el borrador de Claude sin corregir`);
      }
    }

    console.log(`[generar-json] ${tipo}: guardando en KV (${key})`);
    await escribirJSON(key, final, tipo);

    return { tipo, slugMateria, slugTema, key, generado: true };
  } catch (err) {
    try {
      await borrarJSON(key, tipo);
    } catch (errBorrado) {
      console.warn(`[generar-json] ${tipo}: no pude liberar el lock (${key}) después del error: ${errBorrado.message}`);
    }
    throw err;
  }
}

export async function generarYGuardarJSON({ materia, tema, tipos = ["practice", "exam", "formula"], temaCanonico }) {
  if (!materia || !tema) {
    throw new Error("Faltan materia o tema");
  }

  const resultados = [];
  const errores = [];

  for (const tipo of tipos) {
    try {
      const resultado = await generarUnTipo(tipo, materia, tema, temaCanonico);
      resultados.push(resultado);
    } catch (err) {
      console.error(`[generar-json] ${tipo} falló:`, err.message);
      errores.push({ tipo, error: err.message });
    }
  }

  return {
    ok: errores.length === 0,
    slugMateria: slugify(materia),
    slugTema: temaCanonico ? slugify(temaCanonico) : slugify(tema),
    resultados,
    errores: errores.length > 0 ? errores : null,
  };
}

export function esErrorDeCredito(err) {
  return esErrorDeCreditoAnthropic(err) || esErrorDeCreditoMistral(err);
}
