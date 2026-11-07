#!/usr/bin/env bash
# Builds dist/forja_<version>_amd64.deb.
#
# Usage: deploy/build-deb.sh [--artifacts-only | --package-only]
#   (no flag)         compile everything and build the .deb
#   --artifacts-only  only compile agent, API and web into build/deb/ (used by debian/rules)
#   --package-only    only assemble the .deb from an existing build/deb/
#
# Build host requirements: Linux amd64, Go (version in agent/go.mod), Node 22 (the API's native
# modules, argon2 and better-sqlite3, are compiled for this Node ABI; the package depends on
# nodejs >= 22), pnpm, a C/C++ toolchain + python3 (node-gyp), dpkg-deb.
# Version: first entry of deploy/deb/debian/changelog.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEBIAN_DIR="deploy/deb/debian"
BUILD="build/deb"
OUT="dist"

mode="all"
case "${1:-}" in
  "") ;;
  --artifacts-only) mode="artifacts" ;;
  --package-only) mode="package" ;;
  *) echo "uso: $0 [--artifacts-only | --package-only]" >&2; exit 2 ;;
esac

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

version="$(sed -n '1s/^[^(]*(\([^)]*\)).*/\1/p' "$DEBIAN_DIR/changelog")"
[ -n "$version" ] || die "no se pudo leer la versión de $DEBIAN_DIR/changelog"

# ---------------------------------------------------------------------------------------------
build_artifacts() {
  for tool in go node pnpm; do
    command -v "$tool" >/dev/null || die "falta '$tool' en el PATH"
  done
  [ "$(uname -m)" = "x86_64" ] || die "el paquete es amd64 y los módulos nativos de la API se compilan aquí: compila en una máquina x86_64"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" = "22" ] || die "hace falta Node 22 (hay $(node --version)): los módulos nativos deben coincidir con el Node del servidor"

  rm -rf "$BUILD"
  mkdir -p "$BUILD"

  log "1/3 Agente (Go)"
  # Static binary: it runs as root on the target, so avoid depending on its libc.
  (cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o "$ROOT/$BUILD/forja-agent" ./cmd/forja-agent)

  log "2/3 API (pnpm)"
  # Work on a copy so the developer's node_modules/dist are never touched.
  api_work="$BUILD/.api-work"
  mkdir -p "$api_work"
  tar -C panel/api --exclude=./node_modules --exclude=./dist -cf - . | tar -C "$api_work" -xf -
  # pnpm refuses to run install scripts (native builds) unless allowed. Both spellings:
  # `allowBuilds` (pnpm >= 11) and `onlyBuiltDependencies` (pnpm 10).
  cat > "$api_work/pnpm-workspace.yaml" <<'YAML'
allowBuilds:
  argon2: true
  better-sqlite3: true
  esbuild: true
onlyBuiltDependencies:
  - argon2
  - better-sqlite3
  - esbuild
YAML
  (
    cd "$api_work"
    # Dev dependencies are needed to compile (tsc) ...
    pnpm install --frozen-lockfile=false
    pnpm build
    # ... tsc does not copy the .sql migrations (docs/OPERACION.md, pending #2).
    mkdir -p dist/db
    rm -rf dist/db/migrations
    cp -r src/db/migrations dist/db/migrations
    # No tests, type declarations or source maps in the package.
    find dist \( -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \
      -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' \) -delete
    # ... and the final node_modules only has production dependencies.
    rm -rf node_modules
    pnpm install --prod --frozen-lockfile=false
  )
  mkdir -p "$BUILD/api"
  cp -a "$api_work/dist" "$api_work/node_modules" "$api_work/package.json" "$BUILD/api/"
  [ -f "$api_work/pnpm-lock.yaml" ] && cp -a "$api_work/pnpm-lock.yaml" "$BUILD/api/"
  [ -f "$BUILD/api/dist/index.js" ] || die "la compilación de la API no generó dist/index.js"
  [ -f "$BUILD/api/dist/db/migrations/meta/_journal.json" ] || die "faltan las migraciones en dist/db/migrations"
  rm -rf "$api_work"

  log "3/3 Web (pnpm)"
  web_work="$BUILD/.web-work"
  mkdir -p "$web_work"
  tar -C panel/web --exclude=./node_modules --exclude=./dist -cf - . | tar -C "$web_work" -xf -
  cat > "$web_work/pnpm-workspace.yaml" <<'YAML'
allowBuilds:
  esbuild: true
onlyBuiltDependencies:
  - esbuild
YAML
  (
    cd "$web_work"
    pnpm install --frozen-lockfile=false
    pnpm build
  )
  [ -f "$web_work/dist/index.html" ] || die "la compilación de la web no generó dist/index.html"
  # Only the built SPA goes in the package (no src/, node_modules/ or tests).
  mkdir -p "$BUILD/web"
  cp -a "$web_work/dist" "$BUILD/web/dist"
  rm -rf "$web_work"

  # Files that need a different name than in the repository (dh_install cannot rename).
  mkdir -p "$BUILD/caddy.service.d" "$BUILD/containers.conf.d"
  cp deploy/caddy-forja.conf "$BUILD/caddy.service.d/forja.conf"
  cp deploy/containers-forja.conf "$BUILD/containers.conf.d/50-forja.conf"
}

# ---------------------------------------------------------------------------------------------
build_package() {
  command -v dpkg-deb >/dev/null || die "falta dpkg-deb"
  [ -d "$BUILD/api" ] && [ -d "$BUILD/web" ] && [ -f "$BUILD/forja-agent" ] \
    || die "faltan artefactos en $BUILD/: ejecuta antes sin --package-only"

  log "Ensamblando el paquete"
  pkg_root="build/deb-root"
  rm -rf "$pkg_root"
  mkdir -p "$pkg_root/DEBIAN"

  # forja.dirs: one directory per line
  while IFS= read -r dir; do
    case "$dir" in ''|'#'*) continue ;; esac
    mkdir -p "$pkg_root/$dir"
  done < "$DEBIAN_DIR/forja.dirs"

  # forja.install: "<source> <destination directory>" (same semantics as dh_install)
  while read -r src dest; do
    case "$src" in ''|'#'*) continue ;; esac
    [ -e "$src" ] || die "forja.install: no existe $src"
    mkdir -p "$pkg_root/$dest"
    cp -a "$src" "$pkg_root/$dest/"
  done < "$DEBIAN_DIR/forja.install"

  # Permissions that dpkg-deb would otherwise take from the build host's umask
  chmod -R u+rw,go+r,go-w "$pkg_root"
  chmod 0755 "$pkg_root/usr/local/bin/forja-agent" "$pkg_root/usr/share/forja/check-isolation.sh"
  chmod 0644 "$pkg_root"/lib/systemd/system/forja-*.service \
    "$pkg_root"/etc/systemd/system/caddy.service.d/forja.conf \
    "$pkg_root"/etc/containers/containers.conf.d/50-forja.conf \
    "$pkg_root"/etc/sysctl.d/99-forja-userns.conf
  find "$pkg_root" -type d -exec chmod 0755 {} +
  # /etc/forja holds keys: the postinst enforces 0700, but ship it that way too
  chmod 0700 "$pkg_root/etc/forja"

  # Package documentation
  install -d "$pkg_root/usr/share/doc/forja"
  install -m 0644 "$DEBIAN_DIR/copyright" "$pkg_root/usr/share/doc/forja/copyright"
  gzip -9n -c "$DEBIAN_DIR/changelog" > "$pkg_root/usr/share/doc/forja/changelog.Debian.gz"
  chmod 0644 "$pkg_root/usr/share/doc/forja/changelog.Debian.gz"

  # Maintainer scripts and conffiles
  for script in postinst prerm postrm; do
    install -m 0755 "$DEBIAN_DIR/$script" "$pkg_root/DEBIAN/$script"
  done
  install -m 0644 "$DEBIAN_DIR/conffiles" "$pkg_root/DEBIAN/conffiles"

  # control: binary stanza of debian/control, plus the fields that live in the source stanza
  # (Maintainer, Section, Priority) and the ones computed here (Version, Installed-Size)
  installed_size="$(du -sk --exclude=DEBIAN "$pkg_root" | cut -f1)"
  {
    sed -n '/^Package:/p' "$DEBIAN_DIR/control"
    echo "Version: $version"
    sed -n -e '/^Section:/p' -e '/^Priority:/p' -e '/^Maintainer:/p' "$DEBIAN_DIR/control"
    echo "Installed-Size: $installed_size"
    sed -n '/^Package:/,$p' "$DEBIAN_DIR/control" | sed '1d'
  } > "$pkg_root/DEBIAN/control"

  mkdir -p "$OUT"
  deb="$OUT/forja_${version}_amd64.deb"
  dpkg-deb --root-owner-group --build "$pkg_root" "$deb"
  rm -rf "$pkg_root"

  log "Listo: $deb"
  dpkg-deb --info "$deb" | sed -n '1,/^ Description/p'
  echo
  echo "Instalar: sudo apt install ./$deb   (resuelve las dependencias)"
}

case "$mode" in
  all) build_artifacts; build_package ;;
  artifacts) build_artifacts ;;
  package) build_package ;;
esac
