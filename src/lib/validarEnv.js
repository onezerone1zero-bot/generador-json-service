/**
 * Valida que todas las variables de entorno requeridas estén presentes
 * y lanzá error temprano en lugar de fallar silenciosamente más adelante.
 */

const REQUERIDAS = [
  "MISTRAL_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_NAMESPACE_ID",
  "WORKER_URL",
  "SERVICE_KEY",
];

export function validarEnv() {
  const faltantes = REQUERIDAS.filter((key) => !process.env[key]);

  if (faltantes.length > 0) {
    console.error("❌ ERRROR: Variables de entorno faltantes:");
    faltantes.forEach((key) => {
      console.error(`   - ${key}`);
    });
    console.error("\nVer .env.example para referencia");
    process.exit(1);
  }

  console.log("✅ Todas las variables de entorno están configuradas");
}
