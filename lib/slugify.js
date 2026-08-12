// Copia EXACTA de generador-service-main/src/lib/slugify.js -- tiene que
// ser idéntica siempre, porque las keys que arma este service (practice_JSON,
// exam_JSON) tienen que coincidir con el slug del tema que ya usa el otro
// service (subject_JSON) y el frontend. Si tocás una, tocá la otra.
//
// Ejemplo: "Contraste de hipótesis" -> "contraste-de-hipotesis"
export function slugify(texto) {
  return texto
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // saca tildes
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
}
