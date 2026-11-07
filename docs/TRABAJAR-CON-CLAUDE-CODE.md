# Cómo trabajar Forja con Claude Code (gastando pocos tokens)

## Puesta en marcha (una vez)
1. Instala Claude Code en el portátil e inicia sesión con tu cuenta.
2. Crea el repo `forja` (privado) y copia dentro este kit tal cual. Haz `chmod +x .claude/hooks/filtrar-tests.sh`.
   El hook necesita `jq` instalado.
3. **No ejecutes `/init`**: el `CLAUDE.md` ya está hecho y `/init` lo reescribiría.
4. Instala el plugin de inteligencia de código para Go y para TypeScript: así Claude salta a
   definiciones en vez de leer archivos enteros.
5. Configura la línea de estado para ver el uso de contexto, o consulta `/context` de vez en cuando.

## Qué hay preparado en `.claude/`
| Pieza | Para qué | Cómo se usa |
|---|---|---|
| `CLAUDE.md` (< 200 líneas) | Reglas y mapa del repo. Se carga siempre, por eso es corto y apunta a `docs/` | Automático |
| Skill `accion-agente` | Procedimiento seguro para tocar el agente root | Claude la carga sola cuando toca `agent/` |
| Skill `/cerrar-tarea` | Tests, revisión, docs y mensaje de commit | La lanzas tú al acabar cada tarea |
| Skill `/revision-seguridad` | Revisión ofensiva del diff | La lanzas tú en tareas sensibles |
| Subagente `ejecutor-tests` (Haiku) | Ejecuta tests y devuelve solo los fallos | Lo usan las skills; la salida larga no entra en tu sesión |
| Subagente `revisor-seguridad` (Opus) | Revisor de solo lectura | Lo usa `/revision-seguridad` |
| Hook `filtrar-tests.sh` | Si Claude lanza tests directamente, solo ve los fallos | Automático |
| `settings.json` | Permisos: tests y git de lectura sin preguntar; push, sudo y secretos bloqueados | Automático |

## Hábitos que más tokens ahorran
1. **Una tarea por sesión.** Al terminar: `/cerrar-tarea`, commit y `/clear`. Una sesión larga reenvía todo el
   historial en cada mensaje.
2. **Modelo según la tarea.** Sonnet para implementar (la mayor parte del trabajo). Opus solo para diseñar,
   desatascar problemas difíciles y revisar seguridad. Cambia con `/model`.
3. **Modo plan para lo grande** (Shift+Tab): Claude explora y propone. Corriges el plan antes de que escriba código;
   rehacer código es lo que más gasta.
4. **Prompts concretos**, con archivos y criterio de terminado. Mal: «haz los despliegues». Bien:
   «Implementa `site.set_mode` en `agent/internal/actions` según DISENO §7 y §8.3. Hecho cuando: tests de casos
   maliciosos en verde y Caddy recibe la ruta a la página de aviso».
5. **Para a tiempo**: Esc en cuanto se desvíe; doble Esc o `/rewind` para volver atrás.
6. **`/compact` con foco** si la sesión se alarga: `/compact conserva la tarea actual, decisiones y tests que fallan`.
7. **Pocas MCP.** Usa la CLI `gh` en vez de un servidor MCP de GitHub. Desactiva en `/mcp` lo que no uses.
8. **Mira `/usage`** de vez en cuando: dice qué consume más y propone ajustes.
9. **Esfuerzo bajo para cosas mecánicas** (renombrar, mover, textos): `/effort low`.

## Prompts de arranque por fase

**Fase 0, primera sesión (modo plan, Opus):**
> Lee CLAUDE.md, docs/DISENO.md §2–4 y docs/ROADMAP.md fase 0. Propón la estructura exacta de carpetas y archivos
> del monorepo y el orden de implementación de la fase 0. No escribas código todavía.

**Sesiones de implementación (Sonnet):**
> Tarea de la fase 0: «Paquete validate con los validadores de SEGURIDAD §2». Usa la skill accion-agente como guía de
> tests maliciosos. Hecho cuando: `cd agent && go test ./internal/validate/...` pasa con casos válidos y maliciosos.

**Al terminar cada tarea:**
> /cerrar-tarea
