# Forja — Guía de operación

Cómo instalar, actualizar y recuperar Forja en un VPS. Para la arquitectura completa, ver
[`DISENO.md`](DISENO.md); para el modelo de amenazas, [`SEGURIDAD.md`](SEGURIDAD.md).

> **Cómo leer esta guía.** Describe lo que el repositorio hace *hoy*. Donde el diseño prevé algo que
> el código aún no cumple, aparece un bloque **⚠ Pendiente** con la solución provisional. Los
> pendientes están recogidos en el [apéndice A](#apéndice-a--pendientes-conocidos-que-afectan-a-la-operación);
> conviene resolverlos antes de migrar webs reales (ROADMAP, fase 4).

---

## 1. Requisitos previos

| Requisito | Detalle |
|---|---|
| Sistema | Debian 12 (objetivo de `deploy/install.sh`). Ubuntu 22.04+ debería funcionar, pero el script no está probado ahí: ver nota sobre `kernel.unprivileged_userns_clone` |
| Acceso | `root` en una VM limpia, con salida a internet |
| Go | **1.26 o superior** (`agent/go.mod` declara `go 1.26.0`) |
| Node.js | 22 o superior |
| pnpm | Cualquier versión reciente (`npm install -g pnpm`) |
| Podman | rootless, con `slirp4netns`, `uidmap` y `fuse-overlayfs` |
| Caddy | Compilado con el módulo `caddy-dns/cloudflare` (xcaddy). El Caddy de apt **no** sirve |
| restic | En `/usr/bin/restic` (ruta que usa el agente) |
| SQLite 3 | Cliente `sqlite3`, para inspección y copias manuales de `panel.db` |
| nftables | El script instala un cortafuegos con política `drop` de entrada |
| Red | **Solo salida.** No se abre ningún puerto entrante: los túneles de Cloudflare publican el panel y los sitios |
| Dominio | Con DNS en Cloudflare. Hace falta un token de API con `Account › Cloudflare Tunnel: Edit` y `Zone › DNS: Edit` (solo en las zonas usadas) para túneles y certificados DNS-01 |
| Cloudflare Access | Una aplicación de Access delante del dominio del panel (da el *team domain* y el *audience*) |

> **⚠ Pendiente — versión de Go.** `install.sh` instala Go **1.23.8** si no hay Go, pero el módulo del
> agente exige 1.26. Con el script tal cual, `go build` del agente fallará. Instala Go ≥ 1.26 a mano
> (<https://go.dev/dl/>) antes de compilar, o actualiza `GO_VERSION` en el script.

> **Ubuntu.** `sysctl kernel.unprivileged_userns_clone` solo existe en kernels de Debian. En Ubuntu 22.04
> el comando falla y, con `set -e`, aborta el script: elimina esas dos líneas (Ubuntu ya permite
> *user namespaces* sin privilegios).

---

## 2. Instalación

El script `deploy/install.sh` provisiona la máquina (usuarios, directorios, claves, paquetes,
cortafuegos, unidades). **No compila ni despliega** el agente, la API ni la web: eso se hace a mano
(apartados 2.3 a 2.5). Puedes ejecutar el script entero o seguir los pasos manuales de abajo, que
son lo que hace.

```bash
git clone <repositorio-de-forja> /opt/forja/src && cd /opt/forja/src
sudo bash deploy/install.sh
```

### 2.1 Usuarios, grupos y directorios

```bash
groupadd --system forja-agent
useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/forja \
  --groups forja-agent forja

mkdir -p /srv/forja/accounts /etc/forja /var/lib/forja/restic /var/lib/forja/exports /run/forja /opt/forja
chown root:root /etc/forja               && chmod 0700 /etc/forja
chown forja:forja /var/lib/forja         && chmod 0750 /var/lib/forja
chown root:forja-agent /run/forja        && chmod 0750 /run/forja
```

- `forja` es el usuario **sin privilegios** de la API. Pertenece al grupo `forja-agent`, que es el
  único con acceso al socket del agente.
- El agente corre como `root`; nunca lo hace la API.

### 2.2 Claves

```bash
# Clave maestra (la usa el agente para cifrar/descifrar secretos)
head -c 32 /dev/urandom > /etc/forja/master.key
chmod 0600 /etc/forja/master.key && chown root:root /etc/forja/master.key

# Clave de la aplicación (sesiones y TOTP de la API): 32 bytes en bruto
head -c 32 /dev/urandom > /etc/forja/app.key
chmod 0640 /etc/forja/app.key && chown root:forja-agent /etc/forja/app.key
```

Además la API necesita `FORJA_SECRET_KEY` (64 caracteres hexadecimales = 32 bytes) para cifrar los
secretos que guarda en SQLite (tokens de Cloudflare, contraseñas de BD, secretos de webhook):

```bash
openssl rand -hex 32     # valor para FORJA_SECRET_KEY
```

> **Guarda las tres claves fuera del servidor** (gestor de contraseñas). Sin `FORJA_SECRET_KEY` la
> copia de `panel.db` es ilegible en sus campos cifrados, y sin las claves restic (§5) los backups
> son irrecuperables.

> **⚠ Pendiente — `/etc/forja` es 0700 `root:root`.** El usuario `forja` no puede atravesar el
> directorio, así que no leerá `/etc/forja/app.key` aunque el fichero sea 0640 `root:forja-agent`.
> Ver [apéndice A](#apéndice-a--pendientes-conocidos-que-afectan-a-la-operación), punto 3.

### 2.3 Paquetes del sistema

```bash
apt-get install -y podman slirp4netns uidmap fuse-overlayfs nftables sqlite3 restic unattended-upgrades

# Node 22 + pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
npm install -g pnpm

# Go >= 1.26 (ver nota de la sección 1) y Caddy con el módulo de Cloudflare
GOBIN=/usr/local/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/local/bin/caddy
```

El script también escribe `/etc/nftables.conf` (entrada `drop` salvo loopback y conexiones
establecidas; salida libre) y activa `nftables`.

### 2.4 Compilar e instalar el agente

```bash
cd /opt/forja/src/agent
go build -o /usr/local/bin/forja-agent ./cmd/forja-agent
```

### 2.5 Instalar la API y la web

```bash
# API
cd /opt/forja/src/panel/api
pnpm install            # con dependencias de desarrollo: hacen falta para compilar y para seed-admin (tsx)
pnpm build              # tsc → dist/
cp -r src/db/migrations dist/db/     # tsc NO copia los .sql; ver pendiente abajo
mkdir -p /opt/forja/panel
rsync -a --delete --exclude src /opt/forja/src/panel/api/ /opt/forja/panel/api/
cd /opt/forja/panel/api && pnpm prune --prod   # opcional, tras crear el admin (§2.9)

# Web
cd /opt/forja/src/panel/web
pnpm install && pnpm build      # genera dist/
```

La unidad arranca `node /opt/forja/panel/api/dist/index.js`, de modo que ese es el destino de la API.

> **⚠ Pendiente — migraciones en `dist/`.** `connection.ts` busca las migraciones en
> `dist/db/migrations`, pero `tsc` solo emite `.js`. Sin el `cp -r` de arriba la API falla al
> arrancar con un error de carpeta de migraciones inexistente (debe incluir la subcarpeta `meta/`).
> Solución definitiva: añadir el paso de copia al script `build` de `panel/api/package.json`.

> **⚠ Pendiente — dónde se sirve la SPA.** El diseño (§4.3) dice que la API sirve la SPA, pero el
> código actual de la API **no** registra ningún servidor de estáticos. Copia `panel/web/dist/` a un
> directorio fijo (p. ej. `/opt/forja/panel/web/dist/`) y consérvala ahí; hasta que se implemente el
> servido (en la API o en la ruta del panel de Caddy) el frontend no es accesible.

### 2.6 Unidades systemd, Caddy y contenedores

`install.sh` copia estos ficheros y recarga systemd:

| Fichero del repositorio | Destino | Función |
|---|---|---|
| `deploy/forja-agent.service` | `/etc/systemd/system/` | Agente (root). `FORJA_SOCKET=/run/forja/agent.sock`, `FORJA_AUDIT_LOG=/var/lib/forja/audit.jsonl` |
| `deploy/forja-panel.service` | `/etc/systemd/system/` | API (usuario `forja`, grupo `forja-agent`). **El nombre real es `forja-panel`, no `forja-api`** |
| `deploy/forja-ingress.service` | `/etc/systemd/system/` | Crea la interfaz dummy `forja0` (`10.255.0.1/32`) a la que llegan los túneles |
| `deploy/caddy-forja.conf` | `/etc/systemd/system/caddy.service.d/forja.conf` | Caddy espera a `forja-ingress` |
| `deploy/containers-forja.conf` | `/etc/containers/containers.conf.d/50-forja.conf` | Fija `slirp4netns` y `allow_host_loopback=false`: los contenedores no alcanzan el loopback del host |

Además crea `/srv/forja/cloudflared` (`root:root`, 0711), donde van los ficheros de entorno con el
token de cada túnel.

**No hay Caddyfile estático**: el agente genera la configuración desde el estado en SQLite y la
carga con `POST /load` en la API de administración (`127.0.0.1:2019`) mediante la acción
`caddy.sync`. Nunca la edites a mano. Hay que dejar Caddy arrancado con una configuración mínima
para que la API de administración responda.

Para que Caddy emita certificados DNS-01, su unidad necesita acceso a los ficheros de token que
escribe el agente (`/srv/forja/certs/tokens/<cuenta>.token`, `root:caddy 0640`): el usuario `caddy`
debe existir y ejecutar el Caddy compilado con xcaddy.

Los `Environment=` que falten en `forja-panel.service` (ver §3) se añaden con un *drop-in*, no
editando la unidad del repositorio:

```bash
systemctl edit forja-panel      # crea /etc/systemd/system/forja-panel.service.d/override.conf
```

### 2.7 Arranque

```bash
systemctl daemon-reload
systemctl enable --now forja-ingress forja-agent forja-panel
systemctl enable --now caddy
systemctl status forja-ingress forja-agent forja-panel caddy
```

Orden: `forja-ingress` → `caddy`; `forja-panel` *requiere* `forja-agent`.

### 2.8 Cloudflare Access

1. En Cloudflare Zero Trust crea una aplicación *self-hosted* para el dominio del panel (p. ej.
   `panel.ejemplo.com`) con una política que permita solo a los administradores.
2. Anota el **team domain** (`<equipo>.cloudflareaccess.com`) y el **audience** (AUD tag) de la aplicación.
3. La API valida el JWT de la cabecera `Cf-Access-Jwt-Assertion` contra
   `https://<teamDomain>/cdn-cgi/access/certs` (RS256, con comprobación del *audience*).
4. La ruta pública de webhooks (`/hooks/...`) debe quedar **fuera** de Access: se protege con la
   firma HMAC.

> **⚠ Pendiente — la configuración de Access no se carga al arrancar.** `src/auth/access.ts`
> expone `configureAccess({ teamDomain, audience })`, pero `src/index.ts` no lo llama ni lee estos
> valores de ninguna variable de entorno. Mientras no se cablee, `verifyAccessJWT` lanza
> «Cloudflare Access not configured» y las rutas protegidas por Access no funcionan en producción.
> Cuando se cablee, documentar aquí los nombres de las variables (previsiblemente teamDomain y
> audience) y añadirlos al *drop-in* del punto anterior.

### 2.9 Primera ejecución

```bash
# 1. Arrancar la API una vez: aplica las migraciones y crea /var/lib/forja/panel.db
systemctl restart forja-panel && journalctl -u forja-panel -n 20 --no-pager

# 2. Crear el administrador (pide email y contraseña de mínimo 8 caracteres)
cd /opt/forja/panel/api
sudo -u forja DATABASE_URL=/var/lib/forja/panel.db FORJA_APP_KEY=/etc/forja/app.key \
  pnpm seed-admin
```

`seed-admin` carga `app.key`, aplica migraciones y crea un usuario con rol `admin`. El
segundo factor (TOTP) es opcional a nivel de usuario en el código actual: si el usuario tiene un
secreto TOTP guardado, el login lo exige (`/api/auth/login/totp`).

**Planes.** No hay *seed* de planes en el código: el administrador los crea desde el panel
(sección *Planes*, `POST /api/plans`) con `cpu_millis`, `memory_mb`, `disk_mb`, `max_sites` y
`max_databases`. Crea al menos uno antes de crear la primera cuenta.

**Verificar el aislamiento.** Tras crear la primera cuenta, y antes de publicar ningún sitio:

```bash
sudo bash /opt/forja/src/deploy/check-isolation.sh <slug-de-la-cuenta>
```

Debe terminar con éxito (los contenedores no alcanzan la API del panel ni la API de administración de Caddy).

### 2.10 Alternativa: instalar desde el paquete `.deb`

`deploy/build-deb.sh` (o `make deb`) genera `dist/forja_<versión>_amd64.deb`. Se compila en una
máquina amd64 con Go (el de `agent/go.mod`), **Node 22**, pnpm y toolchain C/C++ + python3 (compilan
`argon2` y `better-sqlite3`). Instalación en el servidor (Debian 12+ / Ubuntu 22.04+):

```bash
apt install ./forja_0.1.0_amd64.deb
```

El paquete sustituye a los pasos 2.1, 2.2, 2.4–2.7 y a la compilación de 2.5: crea usuario/grupo y
directorios, genera `master.key`, `app.key` y `FORJA_SECRET_KEY` (drop-in `0600` en
`/etc/systemd/system/forja-panel.service.d/secrets.conf`) si no existen, aplica las migraciones de
`panel.db` (en una actualización guarda antes `panel.db.pre-<versión>`), habilita y arranca
`forja-ingress`, `forja-agent` y `forja-panel`. Rutas: agente en `/usr/local/bin/forja-agent`, API en
`/opt/forja/panel/api/`, SPA en `/opt/forja/panel/web/dist/`, aislamiento en
`/usr/share/forja/check-isolation.sh`.

Lo que **no** hace: instalar Caddy con el módulo de Cloudflare (la dependencia `caddy` de apt se
satisface con el Caddy de xcaddy solo si lo empaquetas o instalas con `dpkg --force-depends`; el
Caddy de apt no sirve para DNS-01), escribir `/etc/nftables.conf` (hay un ejemplo en
`/usr/share/doc/forja/examples/`), crear el administrador (§2.9, con
`node dist/scripts/seed-admin.js` en vez de `pnpm seed-admin`) ni resolver los pendientes del
apéndice A (3, 5, 6 y 7 siguen afectando al paquete).

`apt remove forja` conserva datos y claves. `apt purge forja` **borra todas las cuentas alojadas,
los repositorios restic locales y `master.key`**; `FORJA_PURGE_KEEP_DATA=1 dpkg --purge forja`
elimina solo el paquete y conserva usuarios, datos y claves.

---

## 3. Configuración

### 3.1 Variables de entorno de la API

| Variable | Obligatoria | Por defecto | Uso |
|---|---|---|---|
| `FORJA_SECRET_KEY` | **Sí** | — | 64 caracteres hex (32 bytes). Cifra con AES-256-GCM los secretos guardados en SQLite. Si falta, las operaciones que cifran lanzan error |
| `FORJA_APP_KEY` | No | `/etc/forja/app.key` | **Ruta** del fichero de 32 bytes con la clave de la aplicación (sesiones, TOTP). Es una ruta, no el valor |
| `DATABASE_URL` | No | `/var/lib/forja/panel.db` | Ruta del fichero SQLite (a pesar del nombre, no es una URL). La unidad ya la fija |
| `FORJA_AGENT_SOCKET` | No | `/run/forja/agent.sock` | Socket Unix del agente. La unidad ya lo fija |
| `NODE_ENV` | — | — | La unidad fija `production` |

La API escucha en `127.0.0.1:7000` (fijo en `src/index.ts`) y registra solo errores
(`logger.level = "error"`).

`FORJA_SECRET_KEY` no está en `forja-panel.service`. Añádela en el *drop-in* sin dejarla legible por
todos (es un secreto):

```ini
# /etc/systemd/system/forja-panel.service.d/secrets.conf   (chmod 0600, root)
[Service]
Environment=FORJA_SECRET_KEY=<64 caracteres hex>
```

### 3.2 Variables del agente

| Variable | Por defecto | Uso |
|---|---|---|
| `FORJA_SOCKET` | `/run/forja/agent.sock` | Socket Unix de escucha |
| `FORJA_AUDIT_LOG` | `/var/lib/forja/audit.jsonl` | Auditoría del agente, una línea JSON por acción |
| `FORJA_ALLOWED_UID` | `0` | UID único (además de root) autorizado a llamar al agente, comprobado con `SO_PEERCRED` |

> **⚠ Pendiente — `FORJA_ALLOWED_UID`.** La unidad no lo define, así que vale 0 y el agente
> **rechaza al usuario `forja`** (`UNAUTHORIZED_PEER`). Añade al *drop-in* del agente el UID real:
> ```bash
> systemctl edit forja-agent        # [Service] Environment=FORJA_ALLOWED_UID=<id -u forja>
> ```

### 3.3 Socket del agente

`/run/forja/agent.sock`, creado por el agente; `/run/forja` es `root:forja-agent` 0750. Sin
puertos TCP. El agente solo atiende `POST /v1/actions/<acción>` de una lista cerrada y valida cada
parámetro antes de ejecutar. Toda acción queda en `audit.jsonl`.

### 3.4 Rutas relevantes

```
/etc/forja/                       master.key, app.key (root)
/srv/forja/accounts/<cuenta>/     home de cada cuenta (fj-<cuenta>)
/srv/forja/cloudflared/<id>.env   token de cada túnel (root)
/srv/forja/certs/                 estado y tokens de Let's Encrypt
/var/lib/forja/panel.db           SQLite del panel (+ -wal y -shm)
/var/lib/forja/audit.jsonl        auditoría del agente
/var/lib/forja/restic/<cuenta>/   repositorio restic de la cuenta
/var/lib/forja/restic/<cuenta>.key  contraseña de ese repositorio
/var/lib/forja/exports/           .tar.gz temporales de exportación
/run/forja/agent.sock             socket del agente
/opt/forja/panel/                 API desplegada
```

Arquitectura, modelo de datos y API del agente completos: [`DISENO.md`](DISENO.md).

---

## 4. Actualización

Las migraciones de Drizzle **se aplican solas** cuando arranca la API (`migrate()` en `index.ts`),
así que el esquema se actualiza al reiniciar `forja-panel`. Las migraciones son solo hacia delante:
no hay *down*. Por eso la copia previa es obligatoria.

```bash
# 0. Revisa qué migraciones nuevas trae la versión
cd /opt/forja/src && git fetch && git diff --stat HEAD origin/main -- panel/api/src/db/migrations

# 1. Copia de seguridad de la BD del panel (ver §5.1)
sqlite3 /var/lib/forja/panel.db ".backup '/var/lib/forja/panel-$(date +%F-%H%M).db'"

# 2. Parar los servicios (los sitios de los clientes siguen en marcha: son contenedores de cada cuenta)
systemctl stop forja-panel forja-agent

# 3. Actualizar el código
cd /opt/forja/src && git pull --ff-only

# 4. Recompilar
(cd agent && go build -o /usr/local/bin/forja-agent ./cmd/forja-agent)
(cd panel/api && pnpm install && pnpm build && cp -r src/db/migrations dist/db/)
rsync -a --delete --exclude src panel/api/ /opt/forja/panel/api/
(cd panel/web && pnpm install && pnpm build)      # y vuelve a copiar dist/ a su destino (§2.5)

# 5. Si cambiaron deploy/*.service o los .conf, reinstálalos
cp deploy/forja-agent.service deploy/forja-panel.service deploy/forja-ingress.service /etc/systemd/system/
systemctl daemon-reload

# 6. Arrancar: el agente primero; la API migra la BD al iniciar
systemctl start forja-agent forja-panel
journalctl -u forja-panel -n 30 --no-pager
```

Después de arrancar:

1. `systemctl status forja-agent forja-panel` debe mostrar ambos activos.
2. Entra al panel y comprueba *Sistema* (`GET /api/system`, acción `system.info` del agente).
3. Si cambió la lógica de rutas de Caddy, ejecuta `caddy.sync` (se hace solo al tocar cualquier sitio).

**Reversión.** Si la migración o el arranque fallan: `systemctl stop forja-panel`, restaura
`panel.db` desde la copia del paso 1 (borra también `panel.db-wal` y `panel.db-shm`), vuelve al
commit anterior (`git checkout <sha>`), recompila y arranca.

> Mientras `forja-panel` está parado no hay panel ni webhooks de despliegue, pero **los sitios
> publicados siguen sirviéndose** (Caddy y los túneles no dependen de la API). El agente parado
> tampoco tira los contenedores de las cuentas.

---

## 5. Backups y restauración

### 5.1 Qué hay que proteger

| Elemento | Dónde | Se cubre con |
|---|---|---|
| Archivos y BD de cada cuenta | `/srv/forja/accounts/<cuenta>/` | Snapshots restic por cuenta (§5.2) |
| BD del panel | `/var/lib/forja/panel.db` | **Manual** (abajo): ningún proceso la copia hoy |
| Claves | `/etc/forja/master.key`, `app.key`, `FORJA_SECRET_KEY` | **Manual**, fuera del servidor |
| Claves restic | `/var/lib/forja/restic/<cuenta>.key` | **Manual**: sin ella el repositorio no se abre |
| Tokens de túnel | `/srv/forja/cloudflared/*.env` | Se regeneran: `cf.connection.apply` los reescribe desde la BD cifrada |

Copia de `panel.db` en caliente y consistente (no copies el fichero a pelo: está en modo WAL):

```bash
sqlite3 /var/lib/forja/panel.db ".backup '/ruta/destino/panel.db'"
```

### 5.2 Backups locales con restic

- Un repositorio restic **por cuenta**: `/var/lib/forja/restic/<slug>/` con su contraseña
  autogenerada en `/var/lib/forja/restic/<slug>.key` (se crea al primer backup).
- `backup.run` vuelca antes cada base de datos de la cuenta y hace un snapshot del home
  (excluyendo cachés). Se lanza desde el panel (*Backups → Crear*, `POST /api/accounts/:id/backups`)
  y queda registrado en la tabla `backups` con el ID del snapshot.
- **Exportar a fichero**: *Backups → Exportar* (`POST …/backups/export`) genera un `.tar.gz` en
  `/var/lib/forja/exports/` con un token aleatorio de un solo uso (descarga en
  `GET …/backups/export/:token`).

> **⚠ Pendiente — planificador.** El diseño (§8.6) prevé un snapshot diario a las 04:00 con
> retención de 7 diarios, pero no hay ningún planificador en la API ni `restic forget` en el agente.
> Hasta entonces los backups son **manuales**; programa temporalmente uno con un temporizador que
> llame a la API, o vigila el crecimiento de `/var/lib/forja/restic`.

### 5.3 Backup externo S3 / Cloudflare R2

El agente incluye las acciones `backup.sync_remote`, `backup.restore_remote` y `backup.test_remote`
(en `agent/internal/actions/backup_sync_remote.go`). Copian el repositorio local de cada cuenta a un
repositorio restic `s3:<endpoint>/<bucket>/<slug>` con **la misma contraseña** que el local
(`restic copy`), y sirven para traer snapshots de vuelta al local. Requisitos del destino:
endpoint `https://host[:puerto]` (R2: `https://<account-id>.r2.cloudflarestorage.com`), bucket,
región y un par de claves de acceso con lectura y escritura sobre el bucket.

> **⚠ Pendiente — no hay configuración en la API/web todavía.** Estas acciones están en desarrollo
> (cambios sin confirmar en el repositorio) y la API no expone aún un endpoint para guardar las
> credenciales del destino. Hasta que exista, este apartado describe el destino técnico, no un
> procedimiento operable desde el panel. Actualizarlo cuando se integre.

### 5.4 Restaurar una cuenta

**Desde el panel** (administrador): *Backups →* snapshot *→ Restaurar* (doble confirmación).
`POST /api/accounts/:id/backups/:backupId/restore` ejecuta `backup.restore` con
`target = all | site:<dominio>`: para los contenedores de la cuenta, restaura y los vuelve a
arrancar (también si falla). Solo se pueden restaurar backups de tipo `snapshot`.

**A mano con restic** (si el panel no funciona):

```bash
slug=miweb
repo=/var/lib/forja/restic/$slug
pw=/var/lib/forja/restic/$slug.key

restic --repo $repo --password-file $pw snapshots
# Inspeccionar sin tocar nada:
restic --repo $repo --password-file $pw restore <snapshot-id> --target /tmp/restaurado
# Restaurar sobre la cuenta (parar antes sus contenedores). Es lo mismo que hace backup.restore:
restic --repo $repo --password-file $pw restore <snapshot-id> --target / \
  --include /srv/forja/accounts/$slug
```

Las rutas dentro del snapshot son absolutas (`/srv/forja/accounts/<slug>/…`), por eso `--target /`
con `--include` las devuelve a su sitio. Comprueba con `restic snapshots` los *paths* antes de
restaurar. El backup **excluye** `node_modules`, `__pycache__`, `.cache` y `vendor`: tras restaurar,
redespliega el sitio para regenerarlos. Los volcados de BD están en `<home>/backups/`; reimpórtalos
en el motor de la cuenta. Arregla propietarios si hace falta
(`chown -R fj-<slug>: /srv/forja/accounts/<slug>`) y arranca de nuevo los contenedores.

### 5.5 Restauración completa en una VM nueva

Requiere haber conservado **fuera del servidor**: `FORJA_SECRET_KEY`, `master.key`, `app.key`, una
copia de `panel.db` y los repositorios restic con sus claves (o el destino S3/R2 más las claves `.key`).

1. **Instalar** la VM nueva: §2.1 a §2.7, **sin** ejecutar `seed-admin`. Usa las mismas
   `master.key`, `app.key` y `FORJA_SECRET_KEY` de siempre (cópialas a `/etc/forja/` con los permisos
   de §2.2 en lugar de generar claves nuevas).
2. Parar `forja-panel`. Copiar la `panel.db` guardada a `/var/lib/forja/panel.db`
   (`chown forja:forja`, 0640). Al arrancar, las migraciones pendientes se aplican solas.
3. Restaurar los repositorios: copiar `/var/lib/forja/restic/` completo (repos + `.key`), o traerlos
   del destino remoto con `backup.restore_remote` cuando esté disponible (§5.3).
4. Arrancar `forja-agent` y `forja-panel`. Por cada cuenta del panel, recrear el usuario Linux y la
   red Podman (`account.create`; el `uid` y `subuid` no tienen por qué coincidir: corrige propietarios
   después) y luego restaurar el snapshot (§5.4).
5. Reaplicar las conexiones de Cloudflare (`cf.connection.apply` recrea el contenedor `cloudflared`
   desde el token cifrado de la BD) y los dominios (`cf.routes.sync`), y lanzar `caddy.sync`.
6. Redesplegar los sitios (`site.deploy`) para reconstruir imágenes y Quadlets.
7. Verificar: `deploy/check-isolation.sh <slug>`, cada dominio, y *Auditoría* en el panel.

> **No probado de extremo a extremo.** La prueba de restauración completa en una VM vacía sigue
> pendiente en el ROADMAP (fase 4). Esta secuencia debe validarse y corregirse con esa prueba.

---

## 6. Monitorización y alertas

### 6.1 Logs

| Qué | Cómo |
|---|---|
| Agente | `journalctl -u forja-agent -f` (JSON por stderr) |
| API | `journalctl -u forja-panel -f` (solo nivel *error*) |
| Caddy | `journalctl -u caddy -f` |
| Interfaz forja0 | `journalctl -u forja-ingress` |
| Auditoría del agente | `tail -f /var/lib/forja/audit.jsonl` |
| Auditoría del panel | Panel → *Auditoría* (`audit_log`; el cliente ve solo la de sus cuentas) |
| Un sitio | Panel → sitio → *Logs* (`logs.tail` con fuente `app`, `build` o `access`; los de build, por despliegue) |
| Acceso JSON | `/srv/forja/accounts/<cuenta>/logs/access.log` |

### 6.2 Alertas por correo

En el panel: *Alertas* → crear **canal** (tipo `email`) y **reglas** que lo asocian a eventos
(p. ej. disco o RAM por encima de un umbral, 90 % por defecto). Los clientes solo reciben eventos de
sus cuentas; los del host (disco/RAM) llegan solo a reglas de administrador. El historial está en
*Alertas → registro* (`GET /api/alerts/log`).

> **⚠ Pendiente — no hay envío real.** `alerts/engine.ts` solo registra la alerta como `queued`; el
> envío por sendmail/SMTP está sin implementar. No hay variables de SMTP definidas. Hasta entonces las
> alertas se ven en el registro del panel, pero **no llegan por correo**. Se recomienda un proveedor
> externo (DISENO §11).

### 6.3 Métricas

- **Servidor**: `GET /api/system` / pantalla *Sistema* (CPU, RAM, disco, versiones, estado de servicios).
- **Por sitio**: *Estadísticas* (`GET /api/sites/:id/stats`; `POST …/stats/refresh` fuerza la lectura de
  logs). Sin cookies y sin guardar IPs; a partir de los logs JSON de Caddy.

---

## 7. Solución de problemas comunes

### 7.1 El agente no arranca o la API no lo alcanza

```bash
systemctl status forja-agent
journalctl -u forja-agent -n 50 --no-pager
ls -l /run/forja/            # agent.sock debe existir
id forja                     # debe incluir el grupo forja-agent
```

- **No existe `/run/forja/agent.sock`**: el agente no llegó a escuchar. Causas habituales: no se
  puede abrir `/var/lib/forja/audit.jsonl` (el agente sale con «failed to open audit log») o el
  directorio no es escribible. La unidad tiene `ProtectSystem=strict`; solo
  `/srv/forja`, `/etc/forja`, `/var/lib/forja` y `/run/forja` son escribibles.
- **`/usr/local/bin/forja-agent` no existe** (estado `203/EXEC`): falta compilarlo (§2.4).
- **`UNAUTHORIZED_PEER` en el log del agente** o 5xx de la API al llamarlo: falta
  `FORJA_ALLOWED_UID` (§3.2) o apunta a un UID que no es el de `forja`.
- **`EACCES` desde la API**: `forja` no está en el grupo `forja-agent`
  (`usermod -aG forja-agent forja`) o `/run/forja` no es `root:forja-agent` 0750.
- La API *requiere* al agente: si el agente cae, `forja-panel` también se detiene.

### 7.2 El túnel de Cloudflare no conecta

Cada conexión es un contenedor `cloudflared-<id>` que corre **como el usuario de la cuenta**.

```bash
# como root, mira los contenedores de la cuenta
sudo -u fj-<slug> -H bash -c 'cd; XDG_RUNTIME_DIR=/run/user/$(id -u) podman ps -a'
sudo -u fj-<slug> -H bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) podman logs cloudflared-<id>'
ip addr show forja0          # debe tener 10.255.0.1/32 y estado UP
```

- **Sin interfaz `forja0`**: `systemctl restart forja-ingress caddy`.
- **El contenedor no arranca**: comprueba `/srv/forja/cloudflared/<id>.env` (root, legible por el
  grupo privado de la cuenta) y que la cuenta esté `active`, no suspendida.
- **El túnel conecta pero el sitio da 404/502**: el ingress del túnel debe apuntar a
  `http://10.255.0.1:80`; vuelve a ejecutar `cf.routes.sync` (códigos `ZONE_NOT_FOUND`,
  `DNS_CONFLICT`, `CF_ERROR` por dominio) y `caddy.sync`.
- **Token inválido o sin permisos**: debe tener `Account › Cloudflare Tunnel: Edit` y
  `Zone › DNS: Edit` en las zonas usadas. Vuelve a pegarlo en el panel.
- **El túnel funciona pero los contenedores alcanzan el loopback del host**: ejecuta
  `deploy/check-isolation.sh <slug>`; si falla, revisa `containers-forja.conf` (backend `slirp4netns`).

### 7.3 Un despliegue falla

1. Panel → sitio → *Despliegues* → ver el log de build (`GET /api/sites/:id/deployments/:deployId/log`),
   o `logs.tail` con `source=build`.
2. `journalctl -u forja-agent` para el error del paso (clonado, build de imagen, *healthcheck*).
3. Si la nueva versión no pasa el *healthcheck*, **se mantiene la anterior** y el despliegue queda
   `failed`. Corrige y relanza, o usa *Rollback* a un despliegue anterior.
4. Webhooks que no despliegan: confirma que `source` del sitio coincide con la ruta
   (`/hooks/github/<id>` o `/hooks/gitea/<id>`), que el secreto HMAC es el mismo en el proveedor y
   que la rama es la configurada (los pushes a otras ramas se ignoran). Un despliegue por sitio a la vez.
5. Las imágenes se construyen con Podman rootless del usuario de la cuenta: un disco o cuota llena
   (`df -h /srv/forja`) es una causa frecuente.

### 7.4 «database is locked» / base de datos bloqueada

La BD del panel usa **SQLite en modo WAL** (`journal_mode = WAL`, `foreign_keys = ON`); junto a
`panel.db` aparecen `panel.db-wal` y `panel.db-shm`, que forman parte de la base: no los borres con
la API en marcha ni copies solo el `.db`.

```bash
systemctl status forja-panel
lsof /var/lib/forja/panel.db* 2>/dev/null     # ¿quién la tiene abierta?
sqlite3 /var/lib/forja/panel.db "PRAGMA journal_mode; PRAGMA integrity_check;"
sqlite3 /var/lib/forja/panel.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

- Suele deberse a un cliente externo de larga duración (p. ej. una sesión `sqlite3` abierta con una
  transacción) o a dos procesos de la API a la vez. Cierra el cliente o para `forja-panel` antes de
  mantenimiento.
- Haz las inspecciones en solo lectura (`sqlite3 -readonly …`) para no competir con la API.
- Si `panel.db` o su directorio no son de `forja` (tras restaurar una copia como root), la API falla
  al escribir: `chown forja:forja /var/lib/forja/panel.db*`.
- Si `integrity_check` no devuelve `ok`: para la API y restaura la copia más reciente (§5.1).

### 7.5 Otros síntomas frecuentes

| Síntoma | Causa y solución |
|---|---|
| La API arranca y se cierra con error de migraciones | Falta `dist/db/migrations` (§2.5) |
| «FORJA_SECRET_KEY must be a 64-char hex string» | Variable ausente o de longitud incorrecta (§3.1) |
| `seed-admin`: «cannot load app key» | `/etc/forja/app.key` no existe o `forja` no puede leerlo (§2.2) |
| `seed-admin`: `tsx` no encontrado | Instalaste solo dependencias de producción; instala las de desarrollo o ejecuta el script antes de `pnpm prune --prod` |
| 401 `NO_ACCESS_TOKEN` / `INVALID_ACCESS_TOKEN` | La petición no pasa por Cloudflare Access, o Access no está configurado (§2.8) |
| El panel responde 404 en `/` | La SPA no se está sirviendo (§2.5) |

---

## Apéndice A — Pendientes conocidos que afectan a la operación

Verificados leyendo el repositorio el 2026-11-07. Conviene cerrarlos (o abrir tarea en el ROADMAP)
antes de la puesta en producción; al hacerlo, actualizar los apartados enlazados.

| # | Pendiente | Dónde se nota | Apartado |
|---|---|---|---|
| 1 | `install.sh` instala Go 1.23.8 pero `agent/go.mod` exige 1.26 | Compilar el agente | §1 |
| 2 | `tsc` no copia las migraciones `.sql` a `dist/` | Arranque de la API | §2.5 |
| 3 | `/etc/forja` es 0700 `root:root`, `forja` no puede leer `app.key` (ni la API tiene una forma de recibirla) | `seed-admin` y arranque | §2.2 |
| 4 | `forja-panel.service` no define `FORJA_SECRET_KEY` | Cifrado de secretos | §3.1 |
| 5 | `forja-agent.service` no define `FORJA_ALLOWED_UID`; el agente rechaza a `forja` | Comunicación API ↔ agente | §3.2 |
| 6 | `index.ts` no llama a `configureAccess()`; sin variables para teamDomain/audience | Autenticación con Access | §2.8 |
| 7 | La API no sirve la SPA | Interfaz web | §2.5 |
| 8 | Sin planificador de backups ni retención (`restic forget`) | Backups | §5.2 |
| 9 | `panel.db` y las claves no se copian automáticamente | Recuperación | §5.1 |
| 10 | Backup externo S3/R2: acciones del agente sin confirmar y sin configuración en la API | Backups remotos | §5.3 |
| 11 | Las alertas por correo solo se encolan, sin envío SMTP | Alertas | §6.2 |
| 12 | Restauración completa en VM vacía sin probar | Recuperación | §5.5 |

El punto 3 se resuelve como decisión de seguridad (no se aplica aquí): o bien abrir `/etc/forja` a
0750 `root:forja-agent` (`master.key` seguiría siendo 0600 root), o bien mover `app.key` a un
directorio propio de la API, o entregarla con `LoadCredential=` de systemd. Debe revisarse con
`docs/SEGURIDAD.md`.
