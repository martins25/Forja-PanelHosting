# Forja — Documento de diseño técnico

Versión 0.1 · octubre 2026 · Estado: borrador aprobado para empezar la fase 0

Prototipo visual de referencia (9 pantallas): https://claude.ai/artifact/Fx8gG4eLoS62GRaGsg2o1j

---

## 1. Objetivo y alcance

Panel de hosting propio, gratuito y a medida, para un VPS con entre 5 y 20 webs:

- Webs en **Node.js, PHP, Python, estáticas o con Dockerfile propio**.
- **Aislamiento fuerte por cuenta**: si comprometen una web, no puede leer ni tocar las demás.
- **Cero puertos entrantes**: todo se publica por **túneles de Cloudflare**, y cada cuenta puede usar
  el túnel de Forja o el de su **propia cuenta de Cloudflare**.
- **Despliegue desde Git** (GitHub como opción principal, Gitea opcional) con webhook: cada push sincroniza y redespliega.
- **Dos roles**: administrador (todo) y cliente (solo sus cuentas).
- Estados del sitio: **en línea, mantenimiento y desactivado**, cada uno con su página de aviso.
- Bases de datos **MariaDB, MySQL o PostgreSQL**, con gestor web opcional (**phpMyAdmin, Adminer o pgAdmin**).
- **Backups** locales con descarga en .zip (archivos + volcado de BD). Copia externa opcional (S3/R2).
- **Estadísticas** sin cookies y sin guardar IPs.
- **Let's Encrypt** con un botón (validación DNS-01 por la API de Cloudflare).

**Fuera de alcance en la v1:** correo electrónico, revendedores, varios servidores, facturación y DNS propio.

---

## 2. Decisiones técnicas

| Pieza | Elección | Motivo |
|---|---|---|
| SO del VPS | Debian 12 | Estable y con soporte largo; Podman y systemd modernos |
| Agente privilegiado | **Go**, binario estático | Binario pequeño, tipado, sin runtime; ideal para el único componente que corre como root |
| API del panel | **Node 22 + TypeScript + Fastify** | Ecosistema conocido; Fastify es rápido y valida esquemas de forma nativa |
| Base de datos del panel | **SQLite** + Drizzle ORM | Un solo archivo, cero mantenimiento, de sobra para 1 servidor |
| Interfaz | **React + Vite + TypeScript** | SPA servida por la propia API |
| Validación de entradas | Zod (API) y validadores propios (agente) | Doble validación: la API valida y el agente vuelve a validar |
| Contenedores | **Podman rootless** + Quadlet (unidades systemd) | Cada cuenta ejecuta sus contenedores con su propio usuario sin privilegios |
| Proxy inverso | **Caddy** con su API de administración en `localhost:2019` | Rutas por API sin tocar archivos; ACME integrado |
| Certificados | Caddy + módulo `caddy-dns/cloudflare` (compilado con xcaddy) | DNS-01 sin abrir el puerto 80 |
| Túneles | `cloudflared`, **un contenedor por conexión de Cloudflare** | Cada cuenta de Cloudflare tiene su túnel y su token, aislados |
| Backups | restic (repositorio local) + export .zip bajo demanda | Incremental, cifrado, y se puede añadir un destino externo sin cambiar nada |
| Cifrado de secretos | libsodium (secretbox), clave maestra en `/etc/forja/master.key` (0600, root) | Lo descifra el agente, no la API |
| Autenticación | Cloudflare Access delante + sesión propia + TOTP o passkey | Defensa en profundidad: aunque Access fallara, hace falta login y segundo factor |

---

## 3. Arquitectura

```
                  Internet
                     │  HTTPS (certificado de Cloudflare)
          ┌──────────┴───────────┐
          │      Cloudflare       │  WAF · Access (panel, gestores BD, SFTP)
          └──┬────────────────┬───┘
     túnel Forja        túnel cliente X      (un cloudflared por cuenta de Cloudflare)
          │                  │
┌─────────┴──────────────────┴──────────────────────────── VPS (Debian 12) ─┐
│  cloudflared-forja     cloudflared-<conexión>        (contenedores)        │
│          │                  │                                               │
│          └────────┬─────────┘                                               │
│                   ▼                                                         │
│            Caddy :80 (solo localhost)  ── API admin :2019 (solo localhost)   │
│        ┌──────────┼──────────────┬───────────────────────┐                  │
│        ▼          ▼              ▼                       ▼                  │
│   panel-api   cuenta A        cuenta B             páginas de aviso         │
│   :7000       (usuario A,     (usuario B,          (mantenimiento /         │
│   usuario     Podman rootless Podman rootless       desactivado)            │
│   `forja`     + su red)       + su red)                                     │
│        │                                                                    │
│        │ HTTP sobre socket Unix /run/forja/agent.sock (solo uid `forja`)    │
│        ▼                                                                    │
│   forja-agent (root) ── useradd, podman, caddy API, restic, cloudflared…    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Principio clave:** la API (expuesta a internet a través de Access) nunca tiene privilegios.
Lo único que puede hacer es pedir al agente acciones concretas y validadas.

---

## 4. Componentes

### 4.1 forja-agent (Go, root)
- Escucha en `/run/forja/agent.sock` (0660, grupo `forja-agent`). Comprueba con `SO_PEERCRED`
  que el proceso que llama es el usuario `forja`.
- Protocolo: HTTP/1.1 sobre el socket, JSON. `POST /v1/actions/<nombre>` con un cuerpo validado.
- Lista cerrada de acciones (ver §7). Cada acción tiene:
  `Validate(params) error`, `Execute(ctx, params) (Result, error)` y una entrada de auditoría.
- Las acciones largas (despliegues, backups) devuelven un `job_id`; su progreso y su log se consultan
  con `GET /v1/jobs/<id>` (y por streaming para el log del build).
- Nunca usa shell. Binarios con ruta absoluta y argumentos en array.
- Unidad systemd con hardening: `ProtectHome=read-only` donde aplique, `PrivateTmp`, `NoNewPrivileges`
  cuando la acción lo permita, `ReadWritePaths` limitado a `/srv/forja`, `/etc/forja`, `/var/lib/forja`.

### 4.2 panel-api (Node, usuario `forja`)
- Escucha en `127.0.0.1:7000`. Solo la alcanza Caddy (y Caddy solo vía el túnel con Access).
- Valida el JWT de Cloudflare Access (cabecera `Cf-Access-Jwt-Assertion`, firma con las claves del equipo de Access).
- Sesión propia (cookie `HttpOnly`, `Secure`, `SameSite=Strict`) + TOTP o WebAuthn obligatorio.
- Autorización por recurso en cada ruta (ver §9).
- Recibe los webhooks de GitHub y Gitea en una ruta pública separada (`/hooks/...`), sin Access,
  verificando la firma HMAC.
- Worker interno de estadísticas (§8.7) y planificador (backups, renovaciones, comprobaciones).

### 4.3 panel-web (React)
- SPA estática servida por la API. Pantallas según el prototipo.
- Dos layouts: administrador y cliente. El cliente nunca recibe datos de otras cuentas: lo filtra la API, no la interfaz.

### 4.4 Caddy
- Escucha en `127.0.0.1:80`. Configuración generada por el agente a partir del estado en SQLite
  (fuente de verdad única) y aplicada con `POST /load` a la API admin. Nunca se edita a mano.
- Por sitio: ruta hacia el contenedor de la app, o hacia la página de aviso según el estado.
- Logs de acceso en JSON por sitio en `/srv/forja/accounts/<cuenta>/logs/access.log`, rotados.

### 4.5 Cuentas y contenedores
- Cada cuenta es un usuario Linux `fj-<cuenta>` con shell `/usr/sbin/nologin`, home en
  `/srv/forja/accounts/<cuenta>` (0750) y `subuid`/`subgid` propios.
- Sus contenedores se ejecutan con Podman rootless bajo ese usuario, con unidades **Quadlet**.
- Una red de Podman por cuenta. Las apps publican su puerto solo en `127.0.0.1:<puerto asignado>`.
- Límites de CPU, memoria y pids por contenedor (los del plan) y cuota de disco por usuario (XFS/ext4 quotas).

### 4.6 Bases de datos
- **Una instancia de motor por cuenta y motor** (contenedor rootless en la red de la cuenta).
  Una cuenta con MariaDB y PostgreSQL tiene dos contenedores. Coste: más RAM; a cambio, aislamiento total.
- Varias bases de datos de la misma cuenta y el mismo motor comparten instancia, con usuario propio por base.
- Gestores web (phpMyAdmin, Adminer, pgAdmin): contenedor bajo demanda en la red de la cuenta,
  publicado en `db-<cuenta>.<dominio-panel>` detrás de Access. Se apaga solo tras 30 min sin uso.

### 4.7 Túneles de Cloudflare
- Tabla `cf_connections`: cada conexión guarda el token de API (cifrado), el account ID y el tunnel ID.
- Un contenedor `cloudflared` por conexión, en la red Podman de la cuenta. Su ingress (remoto, vía API) apunta cada dominio a `http://10.255.0.1:80`,
  dirección de una interfaz dummy `forja0` (unidad `forja-ingress.service`). Caddy tiene dos servidores: `127.0.0.1:80` (con la ruta del panel) y `10.255.0.1:80` (solo sitios); enruta por `Host`.
  Cada conexión sirve a **una sola cuenta**, que ejecuta su contenedor: así ninguna otra cuenta puede obtener el token del túnel.
  El token vive en `/srv/forja/cloudflared/<id>.env`, de root y fuera de los homes, legible solo por el grupo privado de la cuenta
  (`useradd --user-group`; el agente se niega si el grupo no es privado). `host_account_id` recuerda qué cuenta lo recibió:
  una conexión no puede pasar a otra cuenta, hay que crear un túnel nuevo (A conoce el token y podría seguir conectándose).
  Índice único en `accounts.cf_connection_id`. Tras crear la primera cuenta, `deploy/check-isolation.sh <slug>` debe pasar.
  Así el contenedor no alcanza el loopback del host (API del panel, admin de Caddy), aunque un cliente cambie su ingress en Cloudflare.
- Al crear o borrar dominios, el agente sincroniza las rutas del túnel y los CNAME por la API de Cloudflare.
- Permisos mínimos del token: `Account › Cloudflare Tunnel: Edit` y `Zone › DNS: Edit` solo en las zonas usadas.

---

## 5. Aislamiento por cuenta (resumen)

| Capa | Cómo se aísla |
|---|---|
| Archivos | Usuario Linux propio, home 0750, sin acceso a otros homes |
| Procesos | Podman rootless con user namespace: root del contenedor = usuario sin privilegios del host |
| Red | Red Podman por cuenta; puertos solo en localhost; sin ruta entre redes de cuentas |
| Recursos | cgroups v2 (CPU, RAM, pids) + cuota de disco |
| Datos | Motor de BD por cuenta, usuario por base de datos |
| Secretos | Cifrados; se inyectan como variables solo al contenedor de su sitio |
| Panel | Rol cliente limitado por la API a sus cuentas |

---

## 6. Modelo de datos (SQLite)

```
users            id, email, role(admin|client), password_hash(argon2id), totp_secret_enc,
                 webauthn_credentials, created_at, last_login_at, disabled
user_accounts    user_id, account_id                      -- qué cuentas ve un cliente
plans            id, name, cpu_millis, memory_mb, disk_mb, max_sites, max_databases
accounts         id, slug, linux_user, uid, plan_id, cf_connection_id, status(active|suspended), created_at
sites            id, account_id, primary_domain, runtime(node|php|python|static|docker),
                 runtime_version, source(github|gitea|upload|template), repo, branch,
                 install_cmd, build_cmd, start_cmd, internal_port, public_dir,
                 mode(online|maintenance|disabled), notice_title, notice_message, notice_eta,
                 autodeploy, stats_enabled, created_at
domains          id, site_id, hostname, kind(primary|alias|redirect), cert(cloudflare|letsencrypt),
                 cert_expires_at
deployments      id, site_id, commit_sha, commit_message, trigger(webhook|manual|rollback),
                 status(queued|running|succeeded|failed), started_at, finished_at, log_path
env_vars         id, site_id, key, value_enc
databases        id, account_id, engine(mariadb|mysql|postgres), name, db_user,
                 password_enc, web_tool(phpmyadmin|adminer|pgadmin|none)
cf_connections   id, name, owner_user_id, cf_account_id, api_token_enc, tunnel_id,
                 tunnel_token_enc, host_account_id, managed_by(admin|client), status
git_integrations id, provider(github|gitea), base_url, owner_user_id, credentials_enc, webhook_secret_enc
backups          id, account_id, site_id, kind(snapshot|export), restic_snapshot_id,
                 size_bytes, includes, created_at, status
backup_remotes   id, name, kind(s3|r2), endpoint, bucket, region, access_key_enc, secret_key_enc,
                 enabled, created_at
stats_daily      site_id, day, path, country, referrer_host, device, browser,
                 views, visits, uniques, status_2xx, status_4xx, status_5xx
                 PRIMARY KEY (site_id, day, path, country, referrer_host, device, browser)
removal_requests id, site_id, requested_by, reason, status(open|done|rejected), created_at
audit_log        id, at, actor_user_id, actor_kind(user|system|webhook), action,
                 target_type, target_id, params_redacted, result(ok|error), error_code
sessions         id, user_id, created_at, expires_at, ip_hash, user_agent
webhook_deliveries id, provider, delivery_id, site_id, received_at, signature_ok, processed
```

---

## 7. API del agente (lista cerrada)

Transporte: `POST /v1/actions/<acción>`, cuerpo JSON. Respuesta: `{ok, result}` o
`{ok:false, error:{code, message}}`. Acciones largas: `{ok, job_id}`.

| Acción | Parámetros principales | Notas |
|---|---|---|
| `system.info` | — | CPU, RAM, disco, versiones, estado de servicios |
| `account.create` | slug, plan limits | Crea el usuario, el home, subuid/subgid, la red Podman y la cuota |
| `account.suspend` / `account.resume` | slug | Para o arranca todos sus contenedores; sus sitios pasan a página de desactivado |
| `account.delete` | slug, keep_backups_days | Borrado diferido: primero suspende y conserva backups |
| `site.create` | account, site spec | Escribe las unidades Quadlet y registra rutas |
| `site.deploy` | site_id, commit | Job: clona/actualiza, construye la imagen, arranca la nueva versión, healthcheck y cambio de tráfico sin caída |
| `site.rollback` | site_id, deployment_id | Reutiliza la imagen anterior |
| `site.set_mode` | site_id, mode, notice | online, maintenance o disabled; regenera Caddy |
| `site.restart` / `site.delete` | site_id | |
| `site.env.apply` | site_id | Descifra e inyecta las variables y reinicia |
| `caddy.sync` | — | Regenera la configuración completa desde el estado y la carga |
| `cf.connection.apply` | account_slug, connection_id, state(present\|absent), tunnel_id, tunnel_token | `present`: recrea el contenedor `cloudflared-<id>` como `fj-<cuenta>` en su red, con el token en un env file 0600. `absent`: lo para y borra. El agente no tiene BD: la API descifra y pasa los datos |
| `cf.routes.sync` | connection_id, cf_account_id, tunnel_id, api_token, domains[] | Reemplaza el ingress del túnel (cada dominio → `http://10.255.0.1:80`, más catch-all 404) y hace upsert de CNAME proxied. Resultado por dominio con códigos fijos (`ZONE_NOT_FOUND`, `DNS_CONFLICT`, `CF_ERROR`); no borra CNAME huérfanos, no pisa CNAME ajenos y se niega a reemplazar un ingress con reglas que no sean de Forja |
| `cert.request` / `cert.renew` | account_slug, domain, cf_api_token | Registra el dominio en `/srv/forja/certs/state.json`, guarda el token en `/srv/forja/certs/tokens/<cuenta>.token` (root:caddy 0640) y envía a Caddy `apps/tls` (política ACME con DNS-01 de Cloudflare, el token por `{file.*}`, nunca en la config). `caddy.sync` reincorpora esa política en cada recarga completa. `renew` actualiza el token y reaplica; la renovación la hace Caddy dentro de su ventana, el agente no borra certificados. Resultado: `{domain, status(pending\|active\|expired), issued_at, expires_at}` leído del `.crt` que guarda Caddy |
| `cert.status` | account_slug, domain | Solo lectura: estado del certificado guardado (para pasar de `pending` a `active`) |
| `db.create` / `db.drop` | account, engine, name | Arranca el motor de la cuenta si no existe |
| `db.dump` | database_id | Job; deja el volcado en el home de la cuenta |
| `db.set_password` | database_id | |
| `dbtool.start` / `dbtool.stop` | account, tool | Gestor web bajo demanda |
| `files.list` / `files.read` / `files.write` / `files.delete` / `files.mkdir` / `files.upload` | account, path | Siempre resuelto y confinado al home de la cuenta; como usuario de la cuenta |
| `logs.tail` | site_id, source, lines | app, access o error |
| `backup.run` | scope | Job: snapshot restic |
| `backup.export` | site_id | Job: genera el .zip (archivos + volcado) con descarga temporal firmada |
| `backup.restore` | snapshot_id, site_id | Job; requiere confirmación doble en el panel |
| `backup.sync_remote` | account_slug, remote_kind, endpoint, bucket, region, access_key, secret_key | `restic copy` del repo local al bucket S3/R2 (`s3:<endpoint>/<bucket>/<slug>`). Las claves van solo por variables de entorno (`AWS_*`), nunca por argumentos |
| `backup.restore_remote` | account_slug, restic_snapshot_id, target, confirm, + datos del remoto | Copia el snapshot del remoto al repo local (lo crea si no existe; exige la clave `<slug>.key`) y ejecuta el flujo de `backup.restore` |
| `backup.test_remote` | datos del remoto | Abre o crea un repo vacío `forja-connection-test` en el bucket para probar credenciales y escritura |
| `stats.read_logs` | site_id, since_offset | Devuelve líneas nuevas del access.log para el worker de estadísticas |

Toda acción: valida → registra el inicio en auditoría → ejecuta → registra el resultado.

---

## 8. Flujos principales

### 8.1 Crear un sitio
1. La API valida el formulario (Zod) y comprueba los límites del plan.
2. `account.create` si es una cuenta nueva.
3. `site.create`; `db.create` si se pidió base de datos; las credenciales se cifran y se añaden a `env_vars`.
4. `cf.routes.sync` en la conexión elegida y `caddy.sync`.
5. Si viene de Git: registra el webhook (API de GitHub o Gitea) con un secreto aleatorio.
6. `site.deploy` con el último commit de la rama.

### 8.2 Despliegue por webhook
1. `POST /hooks/github/<site_id>` (o `/hooks/gitea/<site_id>`): verifica `X-Hub-Signature-256` (GitHub, `sha256=<hex>`) o `X-Gitea-Signature` (Gitea, `<hex>`) con HMAC-SHA256 en tiempo constante. La ruta debe coincidir con el `source` del sitio.
2. Idempotencia por `delivery_id`. Se ignoran pushes a otras ramas.
3. Encola `site.deploy` (un despliegue a la vez por sitio; los siguientes sustituyen al pendiente).
4. Despliegue sin caída: la nueva versión arranca en otro puerto, pasa el healthcheck y Caddy cambia
   de puerto. La anterior se para a los 30 s. Si falla, se queda la anterior y se avisa.

### 8.3 Mantenimiento y desactivado
- **Mantenimiento**: el contenedor sigue en marcha. Caddy responde a los visitantes con la página
  de aviso, `HTTP 503` y `Retry-After`. Opcional: dejar pasar a quien tenga sesión en el panel
  (cookie firmada de bypass) para probar.
- **Desactivado**: el contenedor se para. Caddy sirve la página de «sitio no disponible» con `503`.
- **Permisos**: el cliente puede poner y quitar el mantenimiento. Desactivar, activar y borrar es solo del administrador.
  El cliente puede «Solicitar baja» (crea un `removal_request` y avisa al administrador).

### 8.4 Conexión de Cloudflare de un cliente
1. El cliente pega su token de API en su panel. La API lo cifra y llama al agente.
2. El agente verifica los permisos del token (`/user/tokens/verify` y listado de zonas),
   crea el túnel si no existe, guarda el token del túnel y levanta su `cloudflared`.
3. `cf.routes.sync` publica sus dominios.

### 8.5 Certificados de Let's Encrypt
- Con el túnel, el tráfico ya va cifrado (certificado de Cloudflare hacia el visitante; túnel cifrado hasta el VPS).
- Let's Encrypt es opcional por dominio: Caddy lo emite por DNS-01 con el token de la conexión de Cloudflare
  de esa cuenta y lo renueva solo. En la interfaz, cada dominio muestra «Protegido por Cloudflare» o «Let's Encrypt propio».

### 8.6 Backups
- Diario a las 04:00: snapshot restic de `/srv/forja/accounts/*` (excepto cachés) y volcado de cada BD justo antes.
  Retención: 7 diarios (configurable).
- **Descargar .zip**: job `backup.export` → archivo temporal en `/var/lib/forja/exports`,
  enlace firmado de un solo uso que caduca en 15 minutos, y borrado tras la descarga.
- Destino externo opcional (S3 o Cloudflare R2) como segundo repositorio restic.

### 8.7 Estadísticas sin cookies
- Origen: logs JSON de Caddy por sitio. El worker lee incrementalmente con `stats.read_logs`.
- País: cabecera `Cf-IPCountry`. **La IP no se guarda nunca.**
- Visitantes únicos: `hash(ip + user_agent + sitio + sal_diaria)`; la sal se genera cada día y se borra al cerrar el día.
  Solo se guarda el contador agregado, nunca el hash.
- Bots: filtro por user agent conocido y por heurística (sin JS ni assets, rutas típicas de escaneo); se cuentan aparte.
- Retención: logs en bruto 7 días; agregados `stats_daily` 13 meses.

---

## 9. Permisos

| Acción | Administrador | Cliente |
|---|---|---|
| Ver el servidor, planes y otras cuentas | ✔ | ✘ |
| Crear o borrar cuentas, usuarios del panel y planes | ✔ | ✘ |
| Crear sitios | ✔ | ✔ en sus cuentas, dentro de los límites del plan (configurable) |
| Desplegar, ver logs, variables, archivos y BD de sus sitios | ✔ | ✔ |
| Poner y quitar mantenimiento | ✔ | ✔ |
| Desactivar, activar o borrar un sitio | ✔ | ✘ (puede solicitar la baja) |
| Configurar su conexión de Cloudflare y GitHub | ✔ | ✔ |
| Emitir certificados de sus dominios | ✔ | ✔ |
| Descargar backups de sus sitios | ✔ | ✔ |
| Restaurar backups | ✔ | ✘ (configurable) |
| Ver la auditoría | completa | solo la de sus cuentas |

---

## 10. Rutas en el servidor

```
/srv/forja/accounts/<cuenta>/        home de fj-<cuenta> (0750)
    app/                             código desplegado (se sustituye en cada despliegue)
    storage/                         datos persistentes de la app (volumen)
    logs/                            app.log, access.log (JSON de Caddy)
    db/<motor>/                      datos de sus motores de BD
/etc/forja/                          configuración, master.key (0600 root)
/var/lib/forja/panel.db              SQLite del panel (propiedad de forja)
/var/lib/forja/restic/               repositorio de backups local
/var/lib/forja/exports/              zips temporales
/run/forja/agent.sock                socket del agente
```

---

## 11. Decisiones aplazadas

- Correo: fuera. Se recomienda un proveedor externo.
- Varios servidores: el modelo de datos tiene `account` como unidad de reparto para poder añadir `server_id` más adelante.
- Cliente que crea sus propios sitios: activable por plan.
