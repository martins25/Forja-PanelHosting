# Forja — panel de hosting a medida

Panel web para gestionar un VPS con varias webs aisladas (Node, PHP, Python, estáticas o Dockerfile),
publicadas por túneles de Cloudflare sin ningún puerto entrante abierto.
Dos roles: **administrador** (lo ve todo) y **cliente** (solo sus cuentas).

## Lee según la tarea, no todo de golpe
- Arquitectura, modelo de datos, API del agente, flujos: `docs/DISENO.md`
- Modelo de amenazas y reglas de seguridad: `docs/SEGURIDAD.md`
- Fases, tareas y criterios de terminado: `docs/ROADMAP.md` (la fase actual está marcada con ▶)

## Estructura
```
agent/       Go. Binario forja-agent. Corre como root. Escucha SOLO en /run/forja/agent.sock
panel/api/   Node 22 + TypeScript + Fastify + Drizzle (SQLite). Corre como usuario `forja`, sin privilegios
panel/web/   React + Vite + TypeScript. SPA servida por la API
deploy/      Caddy, unidades systemd, plantillas de páginas de aviso, script de instalación
docs/
```

## Comandos
- Agente: `cd agent && go test ./... && go vet ./...`
- API: `cd panel/api && pnpm test && pnpm typecheck && pnpm lint`
- Web: `cd panel/web && pnpm test && pnpm typecheck && pnpm lint`
- Todo: `make check` (solo al cerrar una tarea)

Ejecuta los tests del módulo que estás tocando, no los de todo el repo.

## Reglas que no se rompen nunca
1. El panel NUNCA ejecuta comandos del sistema. Todo lo privilegiado pasa por el agente.
2. El agente solo acepta acciones de una lista cerrada (`agent/internal/actions`). Cada acción valida
   sus parámetros con un esquema estricto ANTES de hacer nada.
3. Prohibido montar comandos con strings: siempre `exec.Command(bin, args...)`, nunca `sh -c`.
   En Node, nada de `child_process`.
4. Todo valor que acabe en una ruta o en un argumento (usuario, dominio, base de datos, rama, ruta de archivo)
   se valida con las funciones de `agent/internal/validate` (listas blancas). Las rutas se resuelven
   (incluidos symlinks) y se comprueba que quedan dentro del home de la cuenta.
5. Todo cambio (agente y panel) se registra en la auditoría: quién, qué, sobre qué recurso y resultado.
6. Autorización por recurso en cada endpoint: un cliente solo toca las cuentas que tiene asignadas.
   Cada endpoint nuevo lleva un test que demuestra que un cliente NO accede a recursos ajenos.
7. Secretos (tokens de Cloudflare y GitHub, contraseñas de BD) cifrados en reposo. Nunca en logs,
   nunca en respuestas de la API (como mucho, los 4 últimos caracteres).
8. Webhooks: verificar la firma HMAC en tiempo constante antes de procesar nada.
9. No añadas dependencias sin justificarlo en el commit. Prefiere la librería estándar.

## Convenciones
- Código, identificadores y comentarios en inglés. Textos de la interfaz en español (`panel/web/src/i18n/es.ts`).
- Commits en español: `tipo(ámbito): descripción` (feat, fix, refactor, test, docs, chore).
- Una rama por tarea: `fase-N/descripcion-corta`.
- El agente devuelve errores tipados con código; la API los traduce. Nunca se envían trazas al navegador.
- Tests: Go con `testing` + testify; API con vitest; web con vitest + Testing Library.

## Cómo trabajar
- Tarea grande o que toca varios módulos: primero un plan, espera aprobación y luego implementa.
- Pasos pequeños: una función o archivo, su test, y al siguiente.
- Para terminar una tarea usa la skill `/cerrar-tarea`.
- Si algo contradice `docs/DISENO.md`, para y pregunta en vez de improvisar.
- No recorras directorios enteros: busca con grep/glob y abre solo lo necesario.
- Salidas largas (tests completos, logs): delega en el subagente `ejecutor-tests`.

## Instrucciones de compactación
Al compactar conserva: fase y tarea actuales, decisiones tomadas, archivos modificados,
tests que fallan y por qué. Descarta salidas completas de comandos y contenido de archivos ya leídos.
