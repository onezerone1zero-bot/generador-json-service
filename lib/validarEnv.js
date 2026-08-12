// Valida que las variables de entorno necesarias estén seteadas antes de
// arrancar el server -- mismo patrón que generador-service-main: falla
// rápido y con un mensaje claro en vez de romper a mitad de un request.
const REQUERIDAS = [
  "SERVICE_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_NAMESPACE_ID_PRACTICE",
  "CLOUDFLARE_API_TOKEN",
];

export function validarEnv() {
  const faltantes = REQUERIDAS.filter((v) => !process.env[v]);
  if (faltantes.length > 0) {
    console.error(`[validarEnv] Faltan variables de entorno: ${faltantes.join(", ")}`);
    process.exit(1);
  }
}
