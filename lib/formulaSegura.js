// Espejo fiel (mismo tokenizer, misma multiplicación implícita, mismo
// parser recursivo) del parser seguro de fórmulas de visual.js
// (FUNCIONES_PERMITIDAS_FORMULA / tokenizarFormula / evaluarTokensFormula /
// compilarFormula). Existe para que este service pueda validar, ANTES de
// guardar en KV, que una fórmula generada por IA realmente compila con la
// misma gramática que el frontend va a usar para graficarla -- si esta
// copia queda desincronizada de la de visual.js, la validación puede
// aprobar fórmulas que el frontend no puede graficar, o rechazar fórmulas
// válidas.
//
// Recorte deliberado contra el original: acá SOLO se necesita el modo
// escalar f(x,y) -- el generador de "visual" arma únicamente ese tipo de
// fórmula (ver nota en generar.js / prompts.js: la fórmula pre-cargada es
// el valor default del campo "Formula", el usuario elige 2D/3D en el
// frontend después, no la IA). Por eso este archivo NO incluye
// envolverSurface() ni el modo paramétrico (X,Y,Z)(u,v) de tres
// componentes -- si en el futuro se necesita generar también ese modo,
// hay que traer esa parte desde visual.js igual que se hizo con el resto.
//
// El parámetro animado (letra configurable, default "b" en visual.js) NO
// se acepta acá a propósito -- si la IA lo usara, la fórmula seguiría
// siendo válida en el frontend mientras el usuario no cambie la letra en
// el panel, pero dejaría de reconocerse si la cambia. Más simple: la IA
// nunca lo usa, y esta validación lo rechaza como nombre no permitido si
// aparece.
//
// SINCRONIZACIÓN: esta gramática está duplicada en visual.js,
// functions/api/galeria.js, y ahora acá -- si se cambia algo en el
// original (agregar una función, por ejemplo), hay que tocar los tres
// lugares o esta validación va a aceptar o rechazar cosas que el
// frontend no.

export const FUNCIONES_PERMITIDAS = ["sin", "cos", "tan", "sqrt", "abs", "exp", "log"];

function tokenizarFormula(fuente) {
  const crudos = [];
  let indice = 0;
  while (indice < fuente.length) {
    const caracter = fuente[indice];
    if (/\s/.test(caracter)) { indice++; continue; }
    const numero = fuente.slice(indice).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (numero) { crudos.push({ tipo: "numero", valor: Number(numero[0]) }); indice += numero[0].length; continue; }
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

// Evalúa contra x=1.37, y=0.82 (valores fijos, cualquier número finito no
// trivial alcanza) -- el objetivo no es el resultado numérico, sino que
// tirar si la fórmula usa algo fuera de la gramática permitida.
function evaluarTokensFormula(tokens, variables) {
  if (!tokens.length || tokens.length > 120) throw new Error("La fórmula está vacía o es demasiado compleja.");
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
      if (!FUNCIONES_PERMITIDAS.includes(token.valor)) throw new Error(`Función o nombre no permitido: ${token.valor}`);
      exigir("(");
      const argumento = expresion();
      exigir(")");
      return Math[token.valor](argumento);
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

/**
 * Compila (valida) una fórmula escalar f(x,y). Tira si la fórmula usa
 * algo fuera de la gramática permitida, o si excede longitud/complejidad.
 * Devuelve un evaluador (x, y) => number, igual que el original -- aunque
 * el generador de "visual" hoy solo necesita el chequeo (el try/catch),
 * no el evaluador en sí.
 */
export function compilarFormula(origen) {
  const fuente = String(origen || "").trim();
  if (!fuente || fuente.length > 400) throw new Error("La fórmula debe tener entre 1 y 400 caracteres.");

  const tokens = tokenizarFormula(fuente);

  let valorX = 0;
  let valorY = 0;
  const variables = { x: () => valorX, y: () => valorY };
  evaluarTokensFormula(tokens.slice(), variables); // validación en tiempo de parseo

  const evaluador = (x, y) => {
    valorX = x;
    valorY = y === undefined ? 0 : y;
    const resultado = evaluarTokensFormula(tokens.slice(), variables);
    return Number.isFinite(resultado) ? resultado : null;
  };
  evaluador.parametrica = false;
  return evaluador;
}
