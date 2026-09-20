// Espejo fiel (mismo tokenizer, misma multiplicación implícita, mismo
// parser recursivo) del parser seguro de fórmulas de visual.js
// (FUNCIONES_PERMITIDAS_FORMULA / tokenizarFormula / evaluarTokensFormula /
// compilarFormula / compilarImplicita / compilarParametricaMultilinea).
// Existe para que este service pueda validar, ANTES de guardar en KV, que
// una fórmula generada por IA realmente compila con la misma gramática
// que el frontend va a usar para graficarla -- si esta copia queda
// desincronizada de la de visual.js, la validación puede aprobar
// fórmulas que el frontend no puede graficar, o rechazar fórmulas
// válidas.
//
// Soporta los 3 formatos que arma prompts.js (ver armarPromptClaude,
// tipo "visual"):
//   1) explícita: expresión evaluable en x,y -- compilarFormula()
//   2) implícita: "izquierda=derecha" en x/y o x/y/z -- compilarImplicita()
//   3) paramétrica: 3 líneas "x=...\ny=...\nz=..." en u/v --
//      compilarParametricaMultilinea()
//
// PARÁMETRO ANIMABLE: visual.js (detectarLetrasParametroGlobal) trata
// cualquier nombre suelto de UNA sola letra que no sea x/y/z/u/v/e/pi ni
// una función permitida como un parámetro animable: le arma un slider
// propio (valor inicial 1, rango [-5,5]) en vez de rechazarlo. Esta copia
// hace lo mismo (ver detectarLetrasParametro/compilarExpresion) para que
// la IA pueda usar letras sueltas (ej. "a*x^2", "x^2+y^2=(3+a)^2") sin que
// el validador las rechace como "nombre no permitido". El valor con el
// que se valida/samplea acá es siempre 1 -- el mismo default con el que
// arranca el slider en visual.js antes de que el usuario lo mueva -- así
// que el chequeo de "se ve bien" de validarEstructura.js (constante,
// indefinida, sin solución real, etc.) ya cubre el caso de una fórmula
// que da algo inútil justo en ese valor inicial.
//
// CONFIRMADO contra visual.js (primaria(), rama "nombre"): "log" y "ln"
// son ambos logaritmo natural -- "log" no tiene despacho especial, cae en
// el genérico `Math[nombre](argFn())`, o sea Math.log; "ln" tiene un caso
// aparte pero también llama a Math.log. Son redundantes a propósito (no
// hay convención "log=base10" acá). "log2" y "log10" sí son Math.log2 y
// Math.log10 -- antes esta lista y el prompt las excluían por error;
// visual.js las soporta hace rato (FUNCIONES_PERMITIDAS_FORMULA, línea
// ~1694). Ya sincronizado: las 27 funciones de esa lista están acá abajo.
//
// SINCRONIZACIÓN: esta gramática está duplicada en visual.js y acá. El
// comentario de una sesión anterior mencionaba también
// functions/api/galeria.js como tercer lugar duplicado -- ese archivo no
// vino en este zip, así que no se pudo revisar ni sincronizar en esta
// pasada. Si existe y toca la fórmula, hay que auditarlo aparte.

const FUNCIONES_UNARIAS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (x) => 1 / Math.tan(x),
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  ln: Math.log,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
};

export const FUNCIONES_PERMITIDAS = Object.keys(FUNCIONES_UNARIAS);

function tokenizarFormula(fuente) {
  const crudos = [];
  let indice = 0;
  while (indice < fuente.length) {
    const caracter = fuente[indice];
    if (/\s/.test(caracter)) { indice++; continue; }
    const numero = fuente.slice(indice).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (numero) { crudos.push({ tipo: "numero", valor: Number(numero[0]) }); indice += numero[0].length; continue; }
    // Caso especial (idéntico a visual.js): "log10"/"log2" tienen dígitos
    // en el nombre, así que hay que reconocerlos ANTES del match genérico
    // [a-zA-Z]+ (que se para en el primer dígito y dejaría "10"/"2"
    // sueltos como token "numero", rompiendo la fórmula). El lookahead
    // "(?=\s*\()" exige que venga un paréntesis después, igual que ahí.
    const digitFn = fuente.slice(indice).match(/^(?:log10|log2)(?=\s*\()/i);
    if (digitFn) { crudos.push({ tipo: "nombre", valor: digitFn[0].toLowerCase() }); indice += digitFn[0].length; continue; }
    const nombre = fuente.slice(indice).match(/^[a-zA-Z]+/);
    if (nombre) { crudos.push({ tipo: "nombre", valor: nombre[0].toLowerCase() }); indice += nombre[0].length; continue; }
    if ("+-*/^(),".includes(caracter)) { crudos.push({ tipo: caracter }); indice++; continue; }
    throw new Error(`Carácter no soportado en la fórmula: ${caracter}`);
  }
  const tokens = [];
  for (let i = 0; i < crudos.length; i++) {
    const token = crudos[i];
    if (i > 0) {
      const previo = crudos[i - 1];
      const previoCierra = previo.tipo === ")" || previo.tipo === "numero" ||
        (previo.tipo === "nombre" && !FUNCIONES_PERMITIDAS.includes(previo.valor));
      const actualAbre = token.tipo === "(" || token.tipo === "numero" || token.tipo === "nombre";
      if (previoCierra && actualAbre) tokens.push({ tipo: "*" });
    }
    tokens.push(token);
  }
  return tokens;
}

// Nombres de UNA letra que aparecen en los tokens y no son ninguna de las
// variables propias del formato (nombresVariables), ni "pi"/"e", ni una
// función permitida -- ver la nota de "PARÁMETRO ANIMABLE" arriba. Espejo
// de detectarLetrasParametroGlobal() de visual.js, acotado a un solo
// conjunto de tokens ya tokenizados (acá se llama una vez por lado de la
// expresión, visual.js lo hace una vez por fórmula completa -- da lo
// mismo porque el resultado se combina en compilarExpresion).
function detectarLetrasParametro(tokens, nombresVariables) {
  const conocidas = new Set([...nombresVariables, "e"]);
  const letras = new Set();
  for (const tok of tokens) {
    if (tok.tipo !== "nombre") continue;
    if (tok.valor === "pi") continue;
    if (Object.prototype.hasOwnProperty.call(FUNCIONES_UNARIAS, tok.valor)) continue;
    if (conocidas.has(tok.valor)) continue;
    if (tok.valor.length === 1) letras.add(tok.valor);
  }
  return letras;
}

// Evalúa contra valores fijos no triviales (cualquier número finito
// alcanza) -- el objetivo no es el resultado numérico, sino que tirar si
// la fórmula usa algo fuera de la gramática permitida.
function evaluarTokensFormula(tokens, variables) {
  if (!tokens.length || tokens.length > 160) throw new Error("La fórmula está vacía o es demasiado compleja.");
  let posicion = 0;
  const actual = () => tokens[posicion];
  function aceptar(tipo) {
    if (actual() && actual().tipo === tipo) { posicion++; return true; }
    return false;
  }
  function exigir(tipo) {
    if (!aceptar(tipo)) throw new Error(`Se esperaba "${tipo}" en la fórmula.`);
  }
  function expresion() {
    let valor = termino();
    while (actual() && (actual().tipo === "+" || actual().tipo === "-")) {
      const operador = actual().tipo;
      posicion++;
      const siguiente = termino();
      valor = operador === "+" ? valor + siguiente : valor - siguiente;
    }
    return valor;
  }
  function termino() {
    let valor = unario();
    while (actual() && (actual().tipo === "*" || actual().tipo === "/")) {
      const operador = actual().tipo;
      posicion++;
      const siguiente = unario();
      valor = operador === "*" ? valor * siguiente : valor / siguiente;
    }
    return valor;
  }
  function unario() {
    if (aceptar("+")) return unario();
    if (aceptar("-")) return -unario();
    return potencia();
  }
  function potencia() {
    const base = primaria();
    return aceptar("^") ? Math.pow(base, unario()) : base;
  }
  function primaria() {
    const token = actual();
    if (!token) throw new Error("Fórmula incompleta.");
    if (aceptar("numero")) return token.valor;
    if (aceptar("nombre")) {
      if (Object.prototype.hasOwnProperty.call(variables, token.valor)) return variables[token.valor]();
      if (token.valor === "pi") return Math.PI;
      if (token.valor === "e") return Math.E;
      if (!Object.prototype.hasOwnProperty.call(FUNCIONES_UNARIAS, token.valor)) throw new Error(`Función o nombre no permitido: ${token.valor}`);
      exigir("(");
      const argumento = expresion();
      exigir(")");
      return FUNCIONES_UNARIAS[token.valor](argumento);
    }
    if (aceptar("(")) {
      const valor = expresion();
      exigir(")");
      return valor;
    }
    throw new Error("Token inesperado en la fórmula.");
  }
  const resultado = expresion();
  if (posicion !== tokens.length) throw new Error("Token inesperado en la fórmula.");
  return resultado;
}

// Compila una expresión genérica sobre el set de variables dado (ej.
// ["x","y"], ["x","y","z"], ["u","v"]). Valida gramática/nombres con una
// pasada de prueba (valores ficticios no nulos) y devuelve un evaluador
// variádico evaluador(v1, v2, ...) -- un valor faltante se toma como 0,
// igual que hacía el "y" opcional en la versión anterior de
// compilarFormula.
//
// Además de nombresVariables, cualquier letra suelta detectada por
// detectarLetrasParametro() se acepta como parámetro animable y se fija
// en 1 (mismo default que visual.js) tanto en la pasada de validación
// como en el evaluador real -- ver la nota de "PARÁMETRO ANIMABLE" al
// inicio del archivo.
function compilarExpresion(fuente, nombresVariables, maxLen) {
  const limpio = String(fuente || "").trim();
  if (!limpio || limpio.length > maxLen) {
    throw new Error(`La expresión debe tener entre 1 y ${maxLen} caracteres.`);
  }
  const tokens = tokenizarFormula(limpio);
  const letrasParametro = detectarLetrasParametro(tokens, nombresVariables);

  const dummy = {};
  nombresVariables.forEach((nombre, i) => { dummy[nombre] = () => 1.37 + i * 0.41; });
  letrasParametro.forEach((letra) => { dummy[letra] = () => 1; });
  evaluarTokensFormula(tokens.slice(), dummy); // valida gramática y nombres

  return (...valores) => {
    const vars = {};
    nombresVariables.forEach((nombre, i) => {
      vars[nombre] = () => (valores[i] === undefined ? 0 : valores[i]);
    });
    letrasParametro.forEach((letra) => { vars[letra] = () => 1; });
    const resultado = evaluarTokensFormula(tokens.slice(), vars);
    return Number.isFinite(resultado) ? resultado : null;
  };
}

/**
 * Compila (valida) una fórmula EXPLÍCITA f(x,y). Tira si la fórmula usa
 * algo fuera de la gramática permitida, o si excede longitud/complejidad.
 * Devuelve un evaluador (x, y) => number|null.
 */
export function compilarFormula(origen) {
  const evaluador = compilarExpresion(origen, ["x", "y"], 400);
  evaluador.tipo = "explicita";
  return evaluador;
}

/**
 * Compila (valida) una fórmula IMPLÍCITA "izquierda=derecha", en x/y (2D)
 * o x/y/z (superficie 3D, si la fórmula usa "z"). Devuelve un evaluador
 * (x, y, z?) => number|null que da (izquierda - derecha) -- cero indica
 * un punto de la curva/superficie de solución. evaluador.usaZ indica si
 * la fórmula depende de z.
 */
export function compilarImplicita(origen) {
  const limpio = String(origen || "").trim();
  if (!limpio || limpio.length > 400) {
    throw new Error("La fórmula implícita debe tener entre 1 y 400 caracteres.");
  }
  const partes = limpio.split("=");
  if (partes.length !== 2 || !partes[0].trim() || !partes[1].trim()) {
    throw new Error('La fórmula implícita necesita exactamente un "=" con algo de cada lado.');
  }
  const [fuenteIzq, fuenteDer] = partes.map((p) => p.trim());

  const nombresUsados = [...tokenizarFormula(fuenteIzq), ...tokenizarFormula(fuenteDer)]
    .filter((t) => t.tipo === "nombre" && t.valor !== "pi" && t.valor !== "e"
      && !Object.prototype.hasOwnProperty.call(FUNCIONES_UNARIAS, t.valor))
    .map((t) => t.valor);
  const usaZ = nombresUsados.includes("z");
  const variables = usaZ ? ["x", "y", "z"] : ["x", "y"];

  const evalIzq = compilarExpresion(fuenteIzq, variables, 400);
  const evalDer = compilarExpresion(fuenteDer, variables, 400);

  const evaluador = (x, y, z) => {
    const args = usaZ ? [x, y, z === undefined ? 0 : z] : [x, y];
    const izq = evalIzq(...args);
    const der = evalDer(...args);
    if (izq === null || der === null) return null;
    return izq - der;
  };
  evaluador.tipo = "implicita";
  evaluador.usaZ = usaZ;
  return evaluador;
}

/**
 * Compila (valida) una fórmula PARAMÉTRICA de 3 líneas ("x=...", "y=...",
 * "z=...", en cualquier orden, separadas por saltos de línea reales),
 * cada una en función de u y/o v. Devuelve un evaluador (u, v) =>
 * {x, y, z} (cada componente number|null).
 */
export function compilarParametricaMultilinea(origen) {
  const fuente = String(origen || "");
  if (!fuente.trim() || fuente.length > 800) {
    throw new Error("La fórmula paramétrica debe tener entre 1 y 800 caracteres (incluyendo saltos de línea).");
  }
  const lineas = fuente.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lineas.length !== 3) {
    throw new Error(`La fórmula paramétrica necesita exactamente 3 líneas ("x=...", "y=...", "z=..."); se encontraron ${lineas.length}.`);
  }

  const partes = {};
  for (const linea of lineas) {
    const m = linea.match(/^([xyz])\s*=\s*(.+)$/i);
    if (!m) throw new Error(`Línea paramétrica inválida (esperaba "x=", "y=" o "z="): "${linea}"`);
    const letra = m[1].toLowerCase();
    if (partes[letra]) throw new Error(`La variable "${letra}" está definida más de una vez en la paramétrica.`);
    partes[letra] = m[2].trim();
  }
  if (!partes.x || !partes.y || !partes.z) {
    throw new Error('La fórmula paramétrica necesita las tres líneas "x=", "y=" y "z=".');
  }

  const evalX = compilarExpresion(partes.x, ["u", "v"], 800);
  const evalY = compilarExpresion(partes.y, ["u", "v"], 800);
  const evalZ = compilarExpresion(partes.z, ["u", "v"], 800);

  const evaluador = (u, v) => ({ x: evalX(u, v), y: evalY(u, v), z: evalZ(u, v) });
  evaluador.tipo = "parametrica";
  evaluador.componentes = { x: evalX, y: evalY, z: evalZ };
  return evaluador;
}

/**
 * Detecta cuál de los 3 formatos usa una fórmula tal como la devuelve la
 * IA, ANTES de intentar compilarla -- así el caller sabe qué función de
 * compilación usar. Heurística: un salto de línea real implica
 * paramétrica (única forma que los usa); si no, un "=" implica implícita
 * (la gramática de expresión no usa "=" para nada más); si no, explícita.
 */
export function detectarTipoFormula(texto) {
  if (typeof texto !== "string") return null;
  if (texto.includes("\n")) return "parametrica";
  if (texto.includes("=")) return "implicita";
  return "explicita";
}
