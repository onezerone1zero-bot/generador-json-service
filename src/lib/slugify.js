// Replica EXACTAMENTE el slugify() de molde.js (front-end), para que los
// nombres de archivo que generamos acá coincidan siempre con los que
// molde.js arma al pedir la descarga. Si tocás uno, tocá el otro.
//
// Ejemplo: "Ecuaciones lineales" -> "ecuaciones-lineales"
export function slugify(texto) {
  return texto
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // saca tildes
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
}