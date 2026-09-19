/**
 * Arma el prompt para clasificar un término avisado por un usuario
 * ("tangente", "principio de arquímedes", etc.).
 *
 * A diferencia de la versión vieja, esto NO está limitado a la lista de
 * materias que ya existen en el sitio: si el término pertenece a una
 * materia que todavía no está creada (ej. "estequiometría" cuando
 * "quimica" no existe en materias.json todavía), la IA puede proponerla
 * como materia nueva (esNueva=true) en vez de devolver null.
 *
 * @param {string} termino
 * @param {string[]} materias - ids de materia que YA existen EN ESTA
 *   INSTANCIA (índice local, según el idioma), ej: ["algebra", "fisica"]
 * @param {string} [idioma]
 *
 * DECISIÓN (desacople de materia entre idiomas): esta función solía
 * recibir un cuarto parámetro `materiasCanonicas` (ids de materia del
 * índice español) para que una instancia no-española reutilizara el
 * mismo id que "Química" ya tiene en español ("quimica") en vez de
 * derivar uno propio del título traducido ("chemistry"). Eso se sacó a
 * propósito: se decidió que el id de materia NO debe relacionar
 * instancias de distinto idioma entre sí -- cada instancia deriva su
 * propio id a partir de su propio título local, sin cruzarlo contra
 * ningún índice de otro idioma. "chemistry" (en) y "quimica" (es) son
 * ids sin ninguna relación en KV, aunque sean la misma materia
 * conceptual -- es la posición elegida, no un bug pendiente.
 *
 * FIX (grupoClave): además de "grupo" (el texto de la categoría, YA
 * redactado en el idioma de esta instancia, para mostrar en el
 * frontend), ahora también pedimos "grupoClave": una de tres claves
 * FIJAS en inglés ("exactas" | "aplicadas" | "no_obvias") que NUNCA se
 * traducen. Esto es lo que server.js valida para decidir si la
 * clasificación es usable -- antes se validaba el propio "grupo" contra
 * una lista fija en español (GRUPOS_VALIDOS), lo que hacía que CUALQUIER
 * clasificación esNueva=true en una instancia no-española quedara
 * descartada apenas la IA tradujera "grupo" (el texto ya no matcheaba
 * ninguno de los 3 strings españoles hardcodeados) y la materia
 * terminara cayendo en "Sin clasificar" siempre. Con "grupoClave"
 * separado, la validación es independiente del idioma y "grupo" queda
 * libre para mostrarse traducido sin romper nada.
 */
export function armarPromptClasificar(termino, materias, idioma = "es") {
  const esEspanol = idioma === "es";

  const system = `Sos un clasificador de temas para un sitio de referencia de fórmulas y contenido educativo (matemática, ciencias y aplicaciones).
Tu única salida es JSON válido, sin texto antes ni después, sin markdown fences.
${esEspanol ? "" : `\nIMPORTANTE - idioma de salida: "termino" ya te llega traducido al idioma de esta instancia
(código "${idioma}"). El "titulo" Y el "grupo" de una materia nueva (esNueva=true) tienen que redactarse
en ese mismo idioma ("${idioma}"), aunque estas instrucciones estén en español. El "id" de materia sigue
las mismas reglas de formato (minúsculas, sin tildes, guión bajo) pero en "${idioma}" (ej. si el término es
"Chemistry", id="chemistry", no "quimica"). Para "grupo": traducí el concepto de cada una de las tres
categorías ("Ciencias exactas" / "Ciencias aplicadas" / "Aplicaciones no obvias") a "${idioma}", eligiendo
SIEMPRE la misma redacción exacta para la misma categoría (ej. en inglés: "Exact sciences" / "Applied
sciences" / "Non-obvious applications") -- esto es importante porque el frontend agrupa visualmente por
el texto literal de "grupo", así que una redacción inconsistente entre llamadas separa lo que debería
estar junto.\n`}

Te paso un término que un usuario buscó y no encontró en el sitio, y la lista de
materias que YA existen ahí. Tu trabajo es decidir a qué materia pertenece ese término.

Reglas:
- Si el término encaja en una materia de la lista, usá ESE id exacto, con esNueva=false.
- Si el término es ambiguo entre varias materias existentes, elegí la interpretación más
  común y general (ej: "tangente" sin más contexto es de Trigonometría, no de Geometría).
- Si el término NO encaja en ninguna materia de la lista pero sí es un tema real de
  matemática, ciencia o una aplicación seria de estas (ej. "estequiometría" cuando
  "quimica" no está en la lista), proponé una materia nueva: esNueva=true, con un
  "materia" (id en minúsculas, sin tildes ni espacios, usá guión bajo si hace falta,
  ej: "quimica", "teoria_musical"), un "titulo" prolijo${esEspanol ? " en español (ej: \"Química\")" : ` en ${idioma}
  ÚNICAMENTE (ej: "Chemistry", NO "Chemistry (Química)")`}, un
  "grupo" que sea el equivalente${esEspanol ? "" : ` en "${idioma}"`} de "Ciencias exactas", "Ciencias
  aplicadas" o "Aplicaciones no obvias" (ver arriba la nota de idioma sobre consistencia de redacción),
  y un "grupoClave" con la clave FIJA correspondiente a esa misma categoría: "exactas",
  "aplicadas" o "no_obvias" (siempre en estas tres palabras exactas, sin traducir, sin
  importar el idioma de esta instancia -- es un identificador interno, no texto para
  mostrar).
- IMPORTANTE - prohibido el gloss bilingüe: "titulo" nunca lleva una traducción entre
  paréntesis ni en ningún otro formato (mal: "Hydrostatics (Hidrostática)"; bien:
  "Hydrostatics"). Va SOLO en el idioma pedido, sin excepción.
- IMPORTANTE - filtro estricto de dominio: el sitio es EXCLUSIVAMENTE matemática,
  ciencias exactas/naturales, y aplicaciones cuantitativas serias de estas (ingeniería,
  economía cuantitativa, ciencias de la computación con base matemática, etc.).
  NO son temas válidos, aunque suenen "académicos": lengua/gramática (ej. "análisis
  sintáctico", "análisis morfológico"), literatura, historia, filosofía no-formal,
  arte, ciencias sociales sin componente cuantitativo, idiomas, derecho. Ante un
  término ambiguo por el nombre (ej. "análisis" a secas, que podría ser matemático o
  lingüístico), elegí la interpretación NO matemática solo si el término específico
  completo (no una palabra suelta) es inequívocamente de otra disciplina; si hay
  ambigüedad real, preferí devolver confianza="baja" con la interpretación matemática
  antes que aceptar algo fuera de dominio.
- "Lógica matemática" (id: "logica_matematica") y notación/símbolos matemáticos
  (cuantificadores, conjuntos, lenguaje formal) son un tema válido dentro de esta
  materia, aunque todavía no tenga temas cargados: si el término encaja ahí, usá
  materia="logica_matematica" con esNueva=true (grupo "Ciencias exactas", grupoClave
  "exactas") la primera vez, salvo que ya aparezca en la lista de materias existentes.
- Si el término no tiene relación clara con ninguna materia posible, o es
  ininteligible/spam/no académico, o es un tema real pero fuera de dominio (ver filtro
  estricto arriba), devolvé materia=null.
- IMPORTANTE: "no encaja en ninguna materia de la LISTA EXISTENTE" nunca es motivo por
  sí solo para devolver materia=null. Ese es exactamente el caso de esNueva=true (ver
  regla arriba). Devolvé materia=null ÚNICAMENTE cuando el término no es un tema válido
  de matemática/ciencia/aplicación cuantitativa en absoluto (spam, otra disciplina,
  ininteligible) - nunca porque "todavía no hay una materia creada para esto". Por
  ejemplo, si la lista de materias existentes es solo ["estadistica"] y el término es
  "geometría euclidiana", la respuesta correcta es esNueva=true con materia="geometria",
  NO materia=null: geometría es un tema real de matemática, solo que no está en la lista.
  Si devolvés materia=null con confianza="alta" para un término que en realidad es un
  tema real de matemática/ciencia, eso es un error grave del clasificador.

Formato de salida (JSON):
{
  "materia": "id_de_materia" | null,
  "esNueva": true | false,
  "titulo": "Título prolijo" | null,
  "grupo": "${esEspanol ? "Ciencias exactas" : "equivalente de Ciencias exactas en " + idioma}" | "${esEspanol ? "Ciencias aplicadas" : "equivalente de Ciencias aplicadas en " + idioma}" | "${esEspanol ? "Aplicaciones no obvias" : "equivalente de Aplicaciones no obvias en " + idioma}" | null,
  "grupoClave": "exactas" | "aplicadas" | "no_obvias" | null,
  "confianza": "alta" | "media" | "baja"
}
Si esNueva=false, "titulo", "grupo" y "grupoClave" van en null (no hace falta repetirlos).
Si "materia" es null, esNueva=false, "titulo", "grupo" y "grupoClave" también van en null.`;

  const prompt = `Materias que ya existen en este idioma: ${materias.join(", ")}

Término buscado por el usuario: "${termino}"`;

  return { system, prompt };
}
