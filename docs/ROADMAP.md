# Forja — Hoja de ruta

Marca la fase actual con ▶ y las tareas terminadas con [x].
Prototipo visual: https://claude.ai/artifact/Fx8gG4eLoS62GRaGsg2o1j

---

## ▶ Fase 0 · Cimientos
Entorno de pruebas y esqueleto del proyecto. Nada visible todavía.

- [ ] VM Debian 12 en Proxmox (2 vCPU, 4 GB, 40 GB) que imite el VPS. Snapshot limpio para volver atrás.
- [ ] Monorepo: `agent/` (Go 1.23+), `panel/api` y `panel/web` (pnpm workspaces), `Makefile` con `check`.
- [ ] CI (GitHub Actions): tests, lint, typecheck, `govulncheck` y `pnpm audit`.
- [ ] Agente: servidor HTTP en socket Unix con verificación `SO_PEERCRED`, registro de acciones, acción `system.info`.
- [ ] Paquete `validate` con los validadores de `docs/SEGURIDAD.md` §2 y tests de casos maliciosos.
- [ ] Paquete `audit`: escritura de eventos (de momento a un archivo JSONL; luego lo consume la API).
- [ ] API: Fastify, Drizzle + SQLite, migraciones, cliente del agente, endpoint `/api/system`.
- [ ] Script `deploy/install.sh` que deja la VM lista: usuarios `forja`, Podman, Caddy (xcaddy con cloudflare), unidades systemd y nftables.

**Hecho cuando:** en la VM, `curl --unix-socket /run/forja/agent.sock .../v1/actions/system.info` responde solo desde el
usuario `forja`, y `make check` pasa en CI.

## Fase 1 · Primera versión usable (solo administrador)
- [ ] Login: validación del JWT de Access + usuario/contraseña (argon2id) + TOTP. Sesiones.
- [ ] `account.create`, con usuario Linux, home, subuids, red Podman, límites y cuota.
- [ ] `site.create` y `site.deploy` para **Node** desde GitHub (primero el repo público, luego con GitHub App).
- [ ] Webhook de GitHub con firma, idempotencia y cola por sitio.
- [ ] `caddy.sync` desde el estado. Despliegue sin caída con healthcheck.
- [ ] `site.set_mode`: en línea, mantenimiento y desactivado, con las páginas de aviso.
- [ ] Logs de la app y del build en directo.
- [ ] Variables de entorno cifradas.
- [ ] Interfaz: panel general, crear sitio y ficha del sitio (pestañas Resumen, Despliegues, Logs, Variables).
- [ ] Auditoría visible en el panel.

**Hecho cuando:** crear un sitio Node desde un repo de GitHub, hacer push y verlo actualizado en la VM sin caída;
ponerlo en mantenimiento y ver la página de aviso con 503.

## Fase 2 · Publicación, datos y archivos
- [ ] Conexiones de Cloudflare: alta con token, túnel, contenedor cloudflared, sincronización de rutas y DNS.
- [ ] Runtimes PHP (Caddy + PHP-FPM en contenedor), Python, estático y Dockerfile.
- [ ] Bases de datos: MariaDB, MySQL y PostgreSQL por cuenta; phpMyAdmin, Adminer y pgAdmin bajo demanda tras Access.
- [ ] Gestor de archivos confinado (listar, subir, editar, borrar) y SFTP enjaulado por el túnel.
- [ ] Backups: snapshot restic diario, descarga .zip con enlace firmado, restauración.
- [ ] Gitea como origen alternativo.

**Hecho cuando:** un sitio PHP con MariaDB y phpMyAdmin está publicado por un túnel de una segunda cuenta de Cloudflare,
y se descarga su .zip con el volcado incluido.

## Fase 3 · Clientes, estadísticas y certificados
- [ ] Usuarios del panel con rol cliente, asignación de cuentas, invitaciones por correo.
- [ ] Layout de cliente: su sitio, su Cloudflare, su GitHub, sus BD, sus backups, sus estadísticas.
- [ ] Solicitud de baja y su flujo para el administrador.
- [ ] Planes con límites aplicados en la creación de recursos.
- [ ] Estadísticas sin cookies (worker, agregados, pantalla).
- [ ] Let's Encrypt por DNS-01 con un botón y renovación automática.
- [ ] Alertas (Telegram y correo): sitio caído, despliegue fallido, disco o RAM altos, backup fallido.

**Hecho cuando:** un usuario cliente entra, solo ve su cuenta, conecta su Cloudflare, despliega desde su GitHub y ve
sus estadísticas; y los tests de acceso cruzado entre clientes pasan.

## Fase 4 · Endurecimiento y paso a producción
- [ ] Revisión de seguridad completa con el subagente `revisor-seguridad` y a mano.
- [ ] Pruebas de abuso: path traversal, inyección en todos los campos, IDOR entre clientes, webhooks falsificados.
- [x] Copia externa opcional (S3/R2): tabla `backup_remotes`, acciones `backup.sync_remote`/`restore_remote`/`test_remote`, página «Copia externa» y botón «Sincronizar a remoto».
- [ ] Prueba de restauración completa en una VM vacía (manual; requiere las claves `/var/lib/forja/restic/*.key` guardadas aparte).
- [ ] Documentación de operación (`docs/OPERACION.md`): instalar, actualizar, recuperar.
- [ ] Migrar las webs reales una a una al VPS.

**Hecho cuando:** restauras el servidor entero en una VM limpia desde los backups y todas las webs vuelven a funcionar.
