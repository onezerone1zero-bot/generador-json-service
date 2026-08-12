# generador-json-service

Servicio que genera `practice.json`, `exam.json` y opcionalmente
`formulas.json` para un tema, con pipeline DeepSeek (crea) -> ChatGPT
(corrige) -> guarda en Cloudflare KV (namespace `practice_JSON`).

Pensado para ser llamado por `generador-service-main` después de que
ese service genera el contenido teórico de un tema (mismo `materia` +
`tema`, mismo slug).

## Setup

```bash
cp .env.example .env
# completar las variables
npm install
npm run dev
```

## Variables de entorno

Ver `.env.example`. Todas son requeridas (`lib/validarEnv.js` corta el
arranque si falta alguna).

| Variable | Para qué |
|---|---|
| `SERVICE_KEY` | Auth entre `generador-service-main` y este service (header `Authorization: Bearer ...`). Distinta a la del otro repo. |
| `DEEPSEEK_API_KEY` | IA que crea el borrador |
| `OPENAI_API_KEY` | IA que corrige el borrador |
| `CLOUDFLARE_ACCOUNT_ID` | Cuenta de Cloudflare |
| `CLOUDFLARE_NAMESPACE_ID_PRACTICE` | Namespace ID de KV `practice_JSON` |
| `CLOUDFLARE_API_TOKEN` | Token con permiso `Account > Workers KV Storage > Edit` |

## Endpoint

### `POST /generar-json`

Headers: `Authorization: Bearer <SERVICE_KEY>`

Body:
```json
{
  "materia": "Estadística",
  "tema": "Contraste de hipótesis",
  "tipos": ["practice", "exam"]
}
```

`tipos` es opcional, subset de `["practice", "exam", "formula"]`.
Default: `["practice", "exam"]`.

Respuesta (200):
```json
{
  "ok": true,
  "slug": "contraste-de-hipotesis",
  "resultados": [
    { "tipo": "practice", "slug": "contraste-de-hipotesis", "key": "practice:contraste-de-hipotesis" },
    { "tipo": "exam", "slug": "contraste-de-hipotesis", "key": "exam:contraste-de-hipotesis" }
  ],
  "errores": null
}
```

Si algún tipo falla, `ok` queda en `false` y `errores` trae el detalle,
pero los tipos que sí salieron bien igual se guardan en KV (no se pierde
el trabajo parcial).

### `GET /health`

Chequeo simple, devuelve `{ "ok": true }`.

## Notas

- Las keys de KV combinan **materia + tema**:
  `practice:<slug-materia>--<slug-tema>` (y lo mismo para `exam:` y
  `formulas:`), separados por `--`. Esto evita que dos materias
  distintas con un tema de mismo nombre (ej. "Introducción" en Física
  y en Química) se pisen entre sí. `slugify` usa guiones (no guión
  bajo) y está calcado del repo `generador-service-main`, para que el
  slug sea consistente entre servicios.
- Esta MISMA key la arma también el Worker (`arch-upload-worker`,
  rutas `/practice` y `/exam`) a partir de la URL
  `/practice/<materia>/<tema>` que le pega el frontend — si se cambia
  el formato de key acá, hay que cambiarlo ahí también.
- El schema de pregunta asumido está documentado en `prompts/prompts.js`
  (`PREGUNTA_SCHEMA_EJEMPLO`). Si el frontend espera otra forma, se
  ajusta ahí.
- **Premium**: el service genera y guarda TODOS los modelos
  (`premium: true` y `false`) en KV. El filtrado de qué se sirve
  ocurre en el Worker, no acá — hoy el Worker solo devuelve los
  modelos `premium: false`, porque todavía no existe un sistema de
  pagos conectado al login (la tabla `profile` de Supabase no tiene
  campo de plan/suscripción). Cuando ese sistema exista, el cambio va
  en el Worker, no en este service.
