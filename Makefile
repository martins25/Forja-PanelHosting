.PHONY: check check-agent check-api check-web deb

check: check-agent check-api check-web

check-agent:
	cd agent && go vet ./... && go test ./...

check-api:
	cd panel/api && pnpm typecheck && pnpm lint && pnpm test

check-web:
	cd panel/web && pnpm typecheck && pnpm lint && pnpm test

# Paquete Debian: dist/forja_<version>_amd64.deb (ver deploy/build-deb.sh)
deb:
	./deploy/build-deb.sh
