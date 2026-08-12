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

- Las keys de KV (`practice:<slug>`, `exam:<slug>`, `formulas:<slug>`)
  usan `slugify` calcado del repo `generador-service-main`, con
  guiones (no guión bajo), para que el slug sea consistente entre
  servicios.
- El schema de pregunta asumido está documentado en `prompts/prompts.js`
  (`PREGUNTA_SCHEMA_EJEMPLO`). Si el frontend espera otra forma, se
  ajusta ahí.
