# Forja — Seguridad

## 1. Modelo de amenazas

| Atacante | Objetivo | Controles principales |
|---|---|---|
| Visitante malicioso de una web | Explotar la app, saltar a otras webs o al host | Podman rootless con user namespace, red por cuenta, límites cgroups, WAF de Cloudflare, sin puertos abiertos |
| Web comprometida (RCE en una app) | Leer datos de otras cuentas, escalar a root | Usuario Linux por cuenta, home 0750, sin socket de Podman ajeno, sin acceso al socket del agente, secretos solo de su sitio |
| Usuario cliente malicioso o con la cuenta robada | Ver o tocar otras cuentas, ejecutar comandos | Autorización por recurso en la API, acciones cerradas en el agente, validación por lista blanca, rutas confinadas, auditoría |
| Sesión de administrador robada | Control total | Access + login propio + segundo factor, sesiones de 8 h, alertas de inicio de sesión, auditoría |
| Webhook falsificado | Desplegar código ajeno | Firma HMAC verificada, idempotencia, solo la rama configurada, repo fijado por sitio |
| Cadena de suministro (dependencias, imágenes) | Código malicioso en el panel o las apps | Lockfiles, `pnpm audit` y `govulncheck` en CI, imágenes base oficiales con digest fijado, mínimas dependencias |
| Fuga de tokens de Cloudflare o GitHub | Tomar el control de DNS o repos | Tokens con permisos mínimos, cifrados en reposo, nunca en logs ni en la API, rotación desde el panel |

## 2. Reglas de código (obligatorias en revisión)

1. **Nada de shell.** Ni `sh -c` en Go ni `child_process` en Node.
2. **Validación por lista blanca** en el agente, aunque la API ya haya validado:
   - slug de cuenta: `^[a-z][a-z0-9-]{2,30}$`
   - hostname: RFC 1123, en minúsculas, sin comodines salvo donde se permitan explícitamente
   - nombre de BD y usuario: `^[a-z][a-z0-9_]{2,40}$`
   - rama de Git: `^[A-Za-z0-9._/-]{1,100}$` sin `..` ni que empiece por `-`
   - comandos de build y arranque: se pasan al contenedor, **nunca** se ejecutan en el host
3. **Rutas**: `filepath.Clean` → `EvalSymlinks` → comprobar el prefijo del home de la cuenta. Las operaciones de archivos
   se ejecutan con el uid de la cuenta, no como root (o con `openat2` y `RESOLVE_BENEATH`).
4. **Argumentos que empiezan por `-`**: rechazarlos, o usar `--` antes de los posicionales.
5. **Autorización**: cada handler de la API obtiene el recurso, comprueba que pertenece a una cuenta del usuario y solo
   entonces actúa. Nada de confiar en IDs que vengan del cliente sin comprobarlos.
6. **Secretos**: tipo `Secret` en Go y en TS que no se serializa en logs (`String()`/`toJSON()` devuelven `***`).
7. **Comparaciones de firmas y tokens** en tiempo constante (`hmac.Equal`, `crypto.timingSafeEqual`).
8. **Errores**: al navegador solo código y mensaje genérico; el detalle va al log interno.
9. **Cabeceras** del panel: CSP estricta (sin inline), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.
10. **CSRF**: cookies `SameSite=Strict` + token CSRF en las peticiones que modifican estado.
11. **Límites de tamaño** en todos los cuerpos de petición y en las subidas de archivos.
12. **Rate limiting** en login, segundo factor y webhooks.

## 3. Hardening del VPS (fase 0)

- Firewall nftables: entrante `drop` por defecto (salvo loopback y conexiones establecidas). Saliente permitido.
- SSH: solo por clave, `PermitRootLogin no`, y accesible únicamente por el túnel con Access.
  Acceso de emergencia por la consola del proveedor.
- `unattended-upgrades` para parches de seguridad.
- `auditd` con reglas para `/etc/forja`, el binario del agente y cambios de usuarios.
- Montaje de `/srv/forja` con `nodev,nosuid`.
- Kernel: `kernel.unprivileged_userns_clone=1` (necesario para Podman rootless); el resto de sysctl endurecidos.
- Opcional: agente de Wazuh si hay manager accesible.

## 4. Checklist de revisión de seguridad (por PR)

- [ ] ¿Algún dato del usuario llega a un comando, una ruta o una consulta sin validar por lista blanca?
- [ ] ¿Cada endpoint nuevo comprueba la propiedad del recurso? ¿Hay un test de acceso cruzado entre clientes?
- [ ] ¿Se registra la acción en la auditoría con los parámetros redactados?
- [ ] ¿Algún secreto puede acabar en logs, errores o respuestas?
- [ ] ¿Las operaciones de archivos están confinadas al home de la cuenta, con symlinks resueltos?
- [ ] ¿Las dependencias nuevas están justificadas y sin vulnerabilidades conocidas?
- [ ] ¿Los contenedores se crean sin `--privileged`, sin montar el socket de Podman y con límites?
