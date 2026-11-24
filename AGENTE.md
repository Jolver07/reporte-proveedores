# Agente de preguntas del reporte

Los visitantes del reporte ven un botón **"Pregúntale al agente"** abajo a la derecha. Ahí pueden escribir preguntas sobre los resultados ("¿qué proveedores tienen más OC vencidas?", "¿cuánto se demoró la cotización en octubre?") y el agente responde con cifras calculadas sobre los datos publicados.

Este archivo es igual en los 3 repositorios (dashboard-compras, reporte-proveedores y tablero-compras).

## Cómo funciona

```
Navegador (página del reporte)                Worker de Cloudflare               Claude
  agente.js  ── pregunta + texto de la página ──▶  /api/agente  ── + clave secreta ──▶  API
             ◀── "consulta esto en los datos" ───                ◀──────────────────
  ejecuta la consulta sobre el Excel
  que la página ya cargó
             ── resultado ──────────────────────▶  …  ──▶  respuesta final
```

- **La clave de Claude nunca llega al navegador.** Está guardada como secreto en el Worker.
- **Las consultas a los datos se ejecutan en el navegador.** Usan el Excel "Seguimiento de Solpeds" que la página ya descargó, sin descargarlo otra vez.
- **El agente ve el texto visible de la página:** indicadores, filtros activos y tablas. Por eso, cuando le preguntan por una cifra que aparece en pantalla, usa esa cifra. Para lo demás calcula desde el Excel (totales, rankings, tiempos entre fechas, detalle de SOLPED y OC).
- **El botón solo aparece cuando el Worker tiene la clave configurada.**

| Archivo | Qué hace |
|---|---|
| `public/agente.js` | Ventana de chat y consultas sobre los datos (igual en los 3 repositorios) |
| `src/agente-worker.js` | Ruta `/api/agente`: guarda la clave y llama a Claude (igual en los 3 repositorios) |
| `wrangler.jsonc` → `ratelimits` | Límite de 20 llamadas por minuto por visitante |

En **reporte-proveedores** los archivos están en `agente-worker.js` (raíz) y en `reporte-proveedores-worker/public/agente.js`.

## Puesta en marcha (una sola vez)

### 1. Crea la clave de Claude
1. Entra a **https://console.anthropic.com** y crea una cuenta, o entra con la de tu empresa.
2. **Billing:** agrega saldo prepago. Se cobra por uso; cada pregunta cuesta del orden de centavos.
3. **Settings → Limits:** pon un **límite de gasto mensual**. Así nunca se gasta más de lo que decidas.
4. **API Keys → Create Key.** Ponle de nombre el reporte (por ejemplo `dashboard-compras`) y copia la clave: empieza con `sk-ant-`. Solo se muestra una vez.
   - Puedes usar la misma clave en los 3 Workers, o una por reporte si quieres ver el gasto de cada uno por separado en la consola.

### 2. Guárdala en cada Worker
En Cloudflare → **Workers & Pages** → el Worker (`dashboard-compras`, `reporte-proveedores` o `tablero-compras`) → **Settings → Variables and Secrets → Add**:
- Type: **Secret**
- Variable name: `ANTHROPIC_API_KEY`
- Value: la clave `sk-ant-…`
- **Deploy**

Repite el paso en los 3 Workers. Los secretos se conservan en los siguientes despliegues.

### 3. Comprueba
- Abre `https://<tu-worker>.workers.dev/api/agente`. Debe mostrar `{"activo":true}`.
- Abre el reporte y recarga con Ctrl+F5. Debe aparecer el botón **"Pregúntale al agente"**.

## Opcional: modelo más económico
Por defecto el agente usa `claude-sonnet-5-5`. Para gastar menos, agrega en el Worker una variable de tipo **Text** llamada `MODELO_AGENTE` con el valor `claude-haiku-5-5`. Responde más rápido, pero razona un poco menos en preguntas complejas.

## Seguridad y costos
- **Quién puede usarlo:** cualquiera que tenga el enlace del reporte. El gasto queda protegido por el límite por visitante (20 llamadas por minuto) y por el límite mensual de la consola de Claude.
- **Para restringir el acceso**, protege el Worker con Cloudflare Zero Trust → Access (política *Allow* para los correos autorizados). Así quedan protegidos también el reporte y `/api/agente`.
- **Qué se envía a Claude:** las preguntas, el texto visible de la página y los resultados de las consultas. El Excel completo no se envía.
- **Uso y gasto:** se consultan en console.anthropic.com → Usage.

## Solución de problemas

| Lo que ves | Causa |
|---|---|
| No aparece el botón | `/api/agente` muestra `{"activo":false}`: falta el secreto `ANTHROPIC_API_KEY`, o el despliegue no terminó. |
| "La clave ANTHROPIC_API_KEY no es válida" | La clave quedó mal pegada (revisa espacios) o fue revocada. |
| "La cuenta de Claude no tiene saldo" | Recarga en console.anthropic.com → Billing. |
| "Se alcanzó el límite de uso de la cuenta de Claude" | Se llegó al límite mensual o al de velocidad de la cuenta. |
| "Demasiadas consultas seguidas" | Un mismo visitante superó 20 llamadas por minuto. Espera un minuto. |
| "El Excel compartido no está disponible" | Todavía no se publicó `fuente-comun.json` desde el Administrador de dashboard-compras. El agente responde solo con lo visible en la página. |

## Cambiar el comportamiento
- **Instrucciones del agente:** función `instrucciones()` en `agente-worker.js`.
- **Descripción de cada reporte:** constante `REPORTE` en el worker de cada repositorio.
- **Preguntas sugeridas, color y título:** atributos `data-sugerencias`, `data-color` y `data-titulo` de la etiqueta `<script src="agente.js">` en `index.html`.
- Si cambias `agente.js` o `agente-worker.js`, copia el mismo archivo a los otros dos repositorios.
