#!/usr/bin/env bash
# Verifies that an account's containers cannot reach the host loopback.
#
# Usage: check-isolation.sh <account-slug>
# Run as root on the VPS once the account exists (account.create). Needs network
# access to pull the busybox image the first time. Exits non-zero if a container
# can reach the panel API, Caddy's admin API or an arbitrary host loopback listener.
set -euo pipefail

slug="${1:?usage: $0 <account-slug>}"
if ! [[ "$slug" =~ ^[a-z][a-z0-9-]{2,30}$ ]]; then
  echo "invalid account slug" >&2
  exit 2
fi
user="fj-${slug}"
net="fj-${slug}"
image="docker.io/library/busybox:1.36"

# slirp4netns exposes the host loopback to the container as 10.0.2.2;
# pasta (when allowed to map it) uses the gateway address.
targets=()
for gw in 10.0.2.2 "$(runuser -u "$user" -- podman run --rm --network "$net" "$image" \
  sh -c "ip route | awk '/default/ {print \$3}'" 2>/dev/null || true)"; do
  [ -n "$gw" ] && targets+=("$gw")
done

# Arbitrary loopback listener owned by this script, plus the real services.
listener_port=39217
python3 -I -c "
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $listener_port)); s.listen(5); time.sleep(60)" &
listener=$!
trap 'kill "$listener" 2>/dev/null || true' EXIT
sleep 1

fail=0
for host in "${targets[@]}"; do
  for port in "$listener_port" 7000 2019; do
    if runuser -u "$user" -- podman run --rm --network "$net" "$image" \
      sh -c "nc -z -w 2 $host $port" >/dev/null 2>&1; then
      echo "FAIL: a container of $slug reaches host loopback via $host:$port"
      fail=1
    else
      echo "ok:   $host:$port is not reachable"
    fi
  done
done

[ "$fail" -eq 0 ] && echo "Isolation check passed for $slug"
exit "$fail"
