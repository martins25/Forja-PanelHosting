# Forja

Panel de hosting para gestionar un VPS con varias webs aisladas (Node.js, PHP, Python, estáticas o Dockerfile), publicadas por **túneles de Cloudflare** sin abrir ningún puerto entrante.

---

## Requisitos mínimos

| Requisito | Detalle |
|---|---|
| **Sistema** | Debian 12+ o Ubuntu 22.04+ (amd64) |
| **Acceso** | `root` en el servidor, con salida a internet |
| **CPU / RAM** | 2 vCPU, 2 GB RAM mínimo (4 GB recomendado) |
| **Disco** | 20 GB libres mínimo (depende del número de sitios) |
| **Node.js** | 22+ |
| **Podman** | Rootless, con `slirp4netns`, `uidmap` y `fuse-overlayfs` |
| **Caddy** | Compilado con el módulo `caddy-dns/cloudflare` (el Caddy de apt **no** sirve; compilar con xcaddy) |
| **restic** | Para backups incrementales |
| **SQLite 3** | Cliente para inspección y copias manuales |
| **Red** | **Solo salida.** No se abre ningún puerto entrante; los túneles de Cloudflare publican todo |
| **Dominio** | Con DNS en Cloudflare. Token de API con permisos `Cloudflare Tunnel: Edit` y `DNS: Edit` |
| **Cloudflare Access** | Una aplicación *self-hosted* delante del dominio del panel |

---

## Instalación

### Opción A: paquete .deb (recomendado)

Descarga el `.deb` desde [Releases](https://github.com/martins25/Forja-PanelHosting/releases/latest) e instala:

```bash
sudo apt install ./forja_0.1.0_amd64.deb
```

El paquete crea el usuario `forja`, genera las claves criptográficas, ejecuta las migraciones de la base de datos y habilita los servicios systemd. No necesitas Go, pnpm ni compilar nada.

### Opción B: compilar desde el código

```bash
# Necesita Go 1.26+, Node 22, pnpm, dpkg-deb
git clone https://github.com/martins25/Forja-PanelHosting.git && cd Forja-PanelHosting
make deb
sudo apt install ./dist/forja_0.1.0_amd64.deb
```

### Opción C: instalación manual

```bash
git clone https://github.com/martins25/Forja-PanelHosting.git /opt/forja/src && cd /opt/forja/src
sudo bash deploy/install.sh
```

Después del script, compila e instala los componentes:

```bash
# 1. Agente (Go, corre como root)
cd /opt/forja/src/agent
go build -o /usr/local/bin/forja-agent ./cmd/forja-agent

# 2. API (Node, corre como usuario forja)
cd /opt/forja/src/panel/api
pnpm install && pnpm build
cp -r src/db/migrations dist/db/

# 3. Interfaz web
cd /opt/forja/src/panel/web
pnpm install && pnpm build
```

### Primer arranque

```bash
# Arrancar servicios
sudo systemctl daemon-reload
sudo systemctl enable --now forja-ingress forja-agent forja-panel caddy

# Crear el administrador
cd /opt/forja/panel/api
sudo -u forja DATABASE_URL=/var/lib/forja/panel.db \
  FORJA_APP_KEY=/etc/forja/app.key node dist/scripts/seed-admin.js
```

### Configurar Cloudflare Access

1. Crea una aplicación *self-hosted* en Cloudflare Zero Trust para el dominio del panel.
2. Anota el **team domain** y el **audience** (AUD tag).
3. Configura ambos valores en la API (variables de entorno o drop-in de systemd).

> Para la guía completa de operación, actualización y recuperación: [`docs/OPERACION.md`](docs/OPERACION.md)

---

## Qué es Forja

Forja es un panel de hosting **autoalojado y gratuito**, diseñado para administrar entre 5 y 20 sitios web en un único VPS. A diferencia de los paneles clásicos, no abre ningún puerto entrante: todo el tráfico entra y sale por túneles de Cloudflare.

### Características principales

- **Múltiples runtimes** — Node.js, PHP (Caddy + PHP-FPM), Python, sitios estáticos y Dockerfile propio, cada uno en su contenedor Podman rootless.
- **Aislamiento fuerte por cuenta** — Cada cuenta tiene su usuario Linux, subuids, red Podman independiente y cuotas de CPU/memoria/disco. Si comprometen una web, no alcanza a las demás.
- **Cero puertos entrantes** — Los sitios se publican a través de túneles de Cloudflare. Cada cuenta puede usar el túnel compartido de Forja o el de su propia cuenta de Cloudflare.
- **Deploy desde Git** — Push a GitHub o Gitea y el sitio se actualiza automáticamente vía webhook, con despliegue blue/green sin caída.
- **Dos roles** — Administrador (gestiona todo) y cliente (solo ve y gestiona sus cuentas asignadas).
- **Bases de datos** — MariaDB, MySQL o PostgreSQL en contenedores, con gestor web opcional (phpMyAdmin, Adminer, pgAdmin).
- **Variables de entorno cifradas** — AES-256-GCM en reposo. La API nunca devuelve valores completos.
- **Backups** — Snapshots incrementales con restic. Exportación en .zip. Copia externa opcional a S3/R2.
- **Certificados Let's Encrypt** — Validación DNS-01 por la API de Cloudflare, con un botón desde el panel.
- **Estadísticas sin cookies** — Agregadas desde los logs de acceso, sin guardar IPs.
- **Alertas por correo** — Configura canales y reglas para recibir avisos de eventos del sistema.
- **Planes con límites** — Define cuotas de sitios, bases de datos, CPU, memoria y disco por cuenta.
- **Auditoría completa** — Cada acción queda registrada: quién, qué, sobre qué recurso y resultado.

### Arquitectura

```
Internet
   │
   ▼
Cloudflare (WAF + Access + túneles)
   │
   ▼ túnel(es)
┌──────────────────────────────────── VPS ──┐
│                                            │
│  Caddy ◄── reverse proxy ──► sitios        │
│    │                                       │
│    ▼                                       │
│  Panel web (React SPA)                     │
│    │                                       │
│    ▼                                       │
│  API (Node + Fastify + SQLite)             │
│    │ socket Unix                           │
│    ▼                                       │
│  Agente (Go, root)                         │
│    │                                       │
│    ▼                                       │
│  Podman rootless ── contenedores aislados  │
└────────────────────────────────────────────┘
```

- **Agente** (`agent/`) — Go. Corre como root, escucha solo en un socket Unix (`/run/forja/agent.sock`). Ejecuta acciones privilegiadas de una lista cerrada, validando cada parámetro antes de actuar.
- **API** (`panel/api/`) — Node 22 + TypeScript + Fastify + Drizzle (SQLite). Corre como usuario `forja` sin privilegios. Nunca ejecuta comandos del sistema directamente.
- **Interfaz** (`panel/web/`) — React + Vite + TypeScript. SPA servida por la API.

### Seguridad

- El panel **nunca** ejecuta comandos del sistema; todo lo privilegiado pasa por el agente.
- El agente solo acepta acciones de una **lista cerrada**, cada una con validación estricta.
- Los secretos se **cifran en reposo** (AES-256-GCM) y nunca aparecen en logs ni respuestas de la API.
- Autorización **por recurso**: un cliente solo accede a las cuentas que tiene asignadas.
- Webhooks con **verificación HMAC** en tiempo constante.
- Rutas y archivos **confinados**: se resuelven symlinks y se comprueba que quedan dentro del home de la cuenta.

> Modelo de amenazas completo: [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md)

---

## Desarrollo

```bash
# Tests del agente
cd agent && go test ./... && go vet ./...

# Tests de la API
cd panel/api && pnpm test && pnpm typecheck && pnpm lint

# Tests de la web
cd panel/web && pnpm test && pnpm typecheck && pnpm lint

# Todo junto
make check
```

### Estructura del proyecto

```
agent/       Go — binario forja-agent (root, socket Unix)
panel/api/   Node 22 + TypeScript + Fastify + Drizzle (SQLite)
panel/web/   React + Vite + TypeScript (SPA)
deploy/      Caddy, unidades systemd, script de instalación, empaquetado .deb
docs/        Diseño técnico, seguridad, roadmap, operación
```

---

## Documentación

- [`docs/DISENO.md`](docs/DISENO.md) — Arquitectura, modelo de datos, flujos
- [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md) — Modelo de amenazas y reglas de seguridad
- [`docs/OPERACION.md`](docs/OPERACION.md) — Instalación, actualización y recuperación
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — Fases y tareas

---

## Licencia

MIT + [Commons Clause](https://commonsclause.com/). Puedes usar, modificar y distribuir Forja libremente, incluso en entornos comerciales. Lo que no puedes es vender Forja como producto. Ver [`LICENSE`](LICENSE).

Proyecto de M4RTINS, con la colaboración de Claude (Anthropic).
