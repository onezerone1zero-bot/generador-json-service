import { validarVisual } from "./lib/validarEstructura.js";
import { armarToolClaude } from "./prompts/prompts.js";

const casos = [
  // Explícitas -- deben seguir funcionando como antes
  ["sin(x)*cos(y)", true],
  ["x^2-y^2", true],
  ["0*x+5", false],           // constante
  ["exp(x)", false],          // explota
  ["log(x-100)", false],      // indefinida en casi todo el rango
  ["sqrt(25-x^2-y^2)", false],// medio domo -- indefinida en más de la mitad del rango ±10

  // Nuevas funciones sincronizadas (primera pasada: asin/acos/atan/cbrt/log2/ln)
  ["asin(x/20)", true],
  ["cbrt(x)+cbrt(y)", true],
  ["ln(abs(x)+1)-ln(abs(y)+1)", true],

  // Nuevas funciones sincronizadas (segunda pasada: cot/sec/csc/sinh/cosh/
  // tanh/asinh/acosh/atanh/log10/floor/ceil/round/sign) -- las 14 que le
  // faltaban a formulaSegura.js respecto de FUNCIONES_PERMITIDAS_FORMULA
  // de visual.js.
  ["cosh(x/10)-cosh(y/10)", true],
  ["sinh(x/10)+cosh(y/10)", true],
  ["tanh(x)-tanh(y)", true],
  ["asinh(x/5)+acosh(abs(y/5)+1)", true],
  ["atanh(x/20)", true],            // x/20 ∈ [-0.5,0.5] con x∈±10 -- adentro del dominio (-1,1) en toda la grilla
  ["log10(abs(x)+1)-log10(abs(y)+1)", true], // regresión del bug de tokenizer (dígitos en el nombre de función)
  ["log2(abs(x)+1)-log2(abs(y)+1)", true],   // idem, caso ya cubierto antes pero se repite junto a log10
  ["cot(x/10)+0*y", true],          // x/10 ∈ ±1, la grilla de muestreo no cae justo en un múltiplo de π
  ["sec(x/10)*0.1+0*y", true],
  ["csc(x/10)*0.1+0*y", true],
  ["floor(x/3)-floor(y/3)", true],
  ["ceil(x/3)-ceil(y/3)", true],
  ["round(x)-round(y)", true],
  ["sign(x)-sign(y)", true],        // toma {-1,0,1} en cada eje -- con las grillas de muestreo (x sin 0, y con 0) sí varía

  // Parámetro animable (letra suelta, valor fijo en 1 para esta validación
  // -- mismo default que arranca el slider en visual.js)
  ["a*x^2+0*y", true],              // familia de parábolas y=a*x^2, con a=1 da x^2 -- válida
  ["x^2+y^2=(3+a)^2", true],        // círculo de radio ajustable, con a=1 da radio 4
  ["b*sin(x)*cos(y)", true],
  ["ab*x", false],                  // "ab" son DOS letras pegadas -- no es un parámetro animable válido (visual.js solo reconoce nombres de UNA letra), es un nombre no permitido
  ["a*x+b*y+c", true],              // varias letras sueltas a la vez están permitidas (visual.js les arma un slider a cada una) y esta sí depende de x/y
  ["a+b+c+0*x+0*y", false],         // caso trampa: aunque usa 3 parámetros válidos, con todos fijos en 1 (a=b=c=1) da constante 3 en todo punto -- el chequeo de "se ve bien" lo rechaza igual que rechazaría "0*x+5"

  // Implícitas
  ["x^2+y^2=25", true],           // círculo completo
  ["x^2/9+y^2/4=1", true],        // elipse
  ["x^2+y^2+z^2=25", true],       // esfera 3D
  ["x^2+y^2=-25", false],         // sin solución real (izq siempre >=0, der siempre negativa)
  ["x=x", false],                 // identidad trivial (izq-der ≈ 0 en todo el rango)

  // Paramétrica
  ["x=u\ny=v\nz=u+v", true],       // plano
  ["x=cos(u)\ny=sin(u)\nz=v", true], // cilindro
  ["x=1\ny=2\nz=3", false],        // degenerada: colapsa a un punto
  ["x=u\ny=u\nz=u", false],        // degenerada: depende solo de u
  ["x=v\ny=v\nz=v", false],        // degenerada: depende solo de v

  // Errores de gramática que deben seguir rechazándose
  ["pow(x,2)", false],
  ["y = sin(x)", true],            // "y =" antepuesto: el prompt le pide a la IA que NO lo escriba así, pero es válido como implícita (y-sin(x)=0 es la curva y=sin(x)), el validador no lo rechaza -- es guía de estilo para la IA, no una regla de gramática
];

for (const [formula, esperadoOk] of casos) {
  const resultado = validarVisual({ formulas: [{ formula }] });
  const marca = resultado.ok === esperadoOk ? "OK " : "FAIL";
  console.log(`${marca} esperado=${esperadoOk} real=${resultado.ok}  "${formula.replace(/\n/g, "\\n")}"`);
  if (!resultado.ok) console.log("      →", resultado.errores[0]);
}

console.log("\n--- lista completa (6 max, comparativo) ---");
console.log(JSON.stringify(validarVisual({ formulas: [{ formula: "x^2" }, { formula: "2*x" }] }), null, 2));

console.log("\n--- tool schema (visual) incluye los 3 formatos en la descripción ---");
const tool = armarToolClaude("visual");
console.log(tool.input_schema.properties.formulas.items.properties.formula.description.slice(0, 160) + "...");

console.log("\n--- necesitaHerramienta (camino \"no cobertura\") ---");
const casosNecesitaHerramienta = [
  [{ necesitaHerramienta: { tema: "superficie fractal tipo Mandelbulb", motivo: "no hay comando de fractales 3D en visual.js ni en los 3 formatos de fórmula", herramienta_sugerida: "función nueva en visual.js, o precálculo aparte en Rust/C++ por rendimiento" } }, true],
  [{ necesitaHerramienta: { tema: "corto", motivo: "no alcanza", herramienta_sugerida: "algo" } }, false], // campos < 10 caracteres
  [{ necesitaHerramienta: { tema: "válido y largo de sobra para pasar el mínimo", motivo: "válido y largo de sobra para pasar el mínimo" } }, false], // falta herramienta_sugerida
  [{ formulas: [{ formula: "x^2" }], necesitaHerramienta: { tema: "no debería mandarse junto con formulas, pero si igual llega, se valida solo esto", motivo: "válido y largo de sobra para pasar el mínimo", herramienta_sugerida: "válido y largo de sobra para pasar el mínimo" } }, true], // necesitaHerramienta pisa a "formulas" (ver validarVisual)
];
for (const [data, esperadoOk] of casosNecesitaHerramienta) {
  const resultado = validarVisual(data);
  const marca = resultado.ok === esperadoOk ? "OK " : "FAIL";
  console.log(`${marca} esperado=${esperadoOk} real=${resultado.ok}`);
  if (!resultado.ok) console.log("      →", resultado.errores[0]);
}

console.log("\n--- tool schema (visual) exige formulas O necesitaHerramienta (anyOf) ---");
console.log(JSON.stringify(tool.input_schema.anyOf));
