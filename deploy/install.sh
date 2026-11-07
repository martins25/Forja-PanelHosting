#!/usr/bin/env bash
set -euo pipefail

# Forja — provisioning script for Debian 12
# Run as root on a fresh VM.

echo "=== Forja: provisioning ==="

# --- System updates ---
apt-get update -qq
apt-get upgrade -y -qq

# --- Users and groups ---
groupadd --system forja-agent 2>/dev/null || true
useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/forja \
  --groups forja-agent forja 2>/dev/null || true

# --- Directories ---
mkdir -p /srv/forja/accounts
mkdir -p /etc/forja
mkdir -p /var/lib/forja/restic
mkdir -p /var/lib/forja/exports
mkdir -p /run/forja
mkdir -p /opt/forja

chown root:root /etc/forja
chmod 0700 /etc/forja
chown forja:forja /var/lib/forja
chmod 0750 /var/lib/forja
chown root:forja-agent /run/forja
chmod 0750 /run/forja

# --- Master key ---
if [ ! -f /etc/forja/master.key ]; then
  head -c 32 /dev/urandom > /etc/forja/master.key
  chmod 0600 /etc/forja/master.key
  chown root:root /etc/forja/master.key
  echo "  Generated master.key"
fi

# --- App key (panel secrets) ---
if [ ! -f /etc/forja/app.key ]; then
  head -c 32 /dev/urandom > /etc/forja/app.key
  chmod 0640 /etc/forja/app.key
  chown root:forja-agent /etc/forja/app.key
  echo "  Generated app.key"
fi

# --- Podman ---
apt-get install -y -qq podman slirp4netns uidmap fuse-overlayfs

# --- Node.js 22 ---
if ! command -v node &>/dev/null || [[ "$(node --version)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# --- pnpm ---
npm install -g pnpm@latest 2>/dev/null || true

# --- Go (for building the agent) ---
if ! command -v go &>/dev/null; then
  GO_VERSION="1.23.8"
  curl -sL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh
fi

# --- Caddy with Cloudflare DNS module ---
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  # Build with xcaddy for the Cloudflare DNS plugin
  GOBIN=/usr/local/bin /usr/local/go/bin/go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
  /usr/local/bin/xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/local/bin/caddy
  echo "  Caddy built with Cloudflare DNS module"
fi

# --- nftables firewall ---
apt-get install -y -qq nftables
cat > /etc/nftables.conf << 'NFTEOF'
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;

    # Allow loopback
    iif lo accept

    # Allow established/related connections
    ct state established,related accept

    # Drop everything else (no open inbound ports)
  }

  chain forward {
    type filter hook forward priority 0; policy drop;
  }

  chain output {
    type filter hook output priority 0; policy accept;
  }
}
NFTEOF
systemctl enable nftables
systemctl restart nftables

# --- Kernel tuning for Podman rootless ---
sysctl -w kernel.unprivileged_userns_clone=1
echo "kernel.unprivileged_userns_clone=1" > /etc/sysctl.d/99-forja-userns.conf

# --- Unattended upgrades ---
apt-get install -y -qq unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades 2>/dev/null || true

# --- Systemd units ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/forja-agent.service" /etc/systemd/system/
cp "$SCRIPT_DIR/forja-panel.service" /etc/systemd/system/
# forja0 (10.255.0.1): the only host address account containers (cloudflared) can reach
cp "$SCRIPT_DIR/forja-ingress.service" /etc/systemd/system/
mkdir -p /etc/systemd/system/caddy.service.d
cp "$SCRIPT_DIR/caddy-forja.conf" /etc/systemd/system/caddy.service.d/forja.conf

# Rootless containers must not reach the host loopback (slirp4netns backend, see the file)
mkdir -p /etc/containers/containers.conf.d
cp "$SCRIPT_DIR/containers-forja.conf" /etc/containers/containers.conf.d/50-forja.conf

# Root-owned home of the tunnel-token env files (outside every account home)
mkdir -p /srv/forja/cloudflared
chown root:root /srv/forja/cloudflared
chmod 0711 /srv/forja/cloudflared

systemctl daemon-reload
systemctl enable forja-ingress forja-agent forja-panel

echo "=== Forja: provisioning complete ==="
echo "  Build and install the agent binary to /usr/local/bin/forja-agent"
echo "  Build and deploy the panel to /opt/forja/panel/"
echo "  Then: systemctl start forja-ingress forja-agent forja-panel"
echo "  After creating the first account: deploy/check-isolation.sh <slug> (must pass before publishing any site)"
