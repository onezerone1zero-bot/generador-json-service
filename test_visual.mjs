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

  // Nuevas funciones sincronizadas
  ["asin(x/20)", true],
  ["cbrt(x)+cbrt(y)", true],
  ["ln(abs(x)+1)-ln(abs(y)+1)", true],

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
