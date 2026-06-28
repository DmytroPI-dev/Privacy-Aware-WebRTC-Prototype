# VPS Setup Guide — Secure Messenger with WebRTC/TURN

Complete step-by-step guide for deploying the secure messenger on a VPS that has a **directly-addressed public IP** (no hypervisor NAT). This is the AlexHost/bare-metal model, as opposed to Oracle Cloud which provides transparent hypervisor NAT.

---

## Prerequisites

| Item | Example |
|---|---|
| VPS OS | Ubuntu 24.04 LTS |
| Public IP | `<YOUR_VPS_IP>` |
| App domain | `<YOUR_APP_DOMAIN>` |
| TURN domain | `<YOUR_TURN_DOMAIN>` |
| SSH key | `~/.ssh/your-key` |
| TURN shared secret | output of `openssl rand -hex 32` |

Both DNS A records must point to the VPS IP before starting. Certbot needs HTTP-01 validation on port 80.

---

## Step 1 — Install packages

```bash
apt-get update
apt-get install -y nginx coturn certbot python3-certbot-nginx iptables-persistent
```

> **Note:** Installing `iptables-persistent` will ask to save current IPv4/IPv6 rules — answer **Yes** to both.
> If ufw was previously installed, `iptables-persistent` may conflict with it. Remove ufw afterwards:
> ```bash
> apt-get remove -y ufw
> ```

---

## Step 2 — Configure the firewall (raw iptables)

Do **not** use ufw on this setup — `iptables-persistent` manages rules directly.

```bash
# Allow existing connections and loopback
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT

# SSH
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# HTTP (for certbot renewal)
iptables -A INPUT -p tcp --dport 80 -j ACCEPT

# HTTPS / TURN TLS via nginx stream
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# TURN plain (fallback, not used by browser but needed by coturn)
iptables -A INPUT -p tcp --dport 3478 -j ACCEPT
iptables -A INPUT -p udp --dport 3478 -j ACCEPT

# TURN TLS direct (coturn listens here, nginx proxies to it)
iptables -A INPUT -p tcp --dport 5349 -j ACCEPT
iptables -A INPUT -p udp --dport 5349 -j ACCEPT

# TURN relay UDP range
iptables -A INPUT -p udp --dport 49152:65535 -j ACCEPT
iptables -A INPUT -p tcp --dport 49152:65535 -j ACCEPT

# Drop everything else inbound
iptables -A INPUT -j DROP
```

---

## Step 3 — Obtain TLS certificates

```bash
certbot certonly --nginx \
  -d <YOUR_APP_DOMAIN> \
  -d <YOUR_TURN_DOMAIN> \
  --non-interactive --agree-tos -m admin@example.com
```

Certificates are stored in:
- `/etc/letsencrypt/live/<YOUR_APP_DOMAIN>/`
- `/etc/letsencrypt/live/<YOUR_TURN_DOMAIN>/`

### Fix coturn certificate permissions

coturn runs as the `turnserver` user and cannot read `/etc/letsencrypt/live/` by default:

```bash
# Add turnserver to the ssl-cert group (or create a group that can read LE)
groupadd -f ssl-cert
usermod -aG ssl-cert turnserver

# Allow ssl-cert group to read the live/ and archive/ directories
chmod 750 /etc/letsencrypt/live /etc/letsencrypt/archive
chown root:ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive

# Allow the specific turn cert files
chmod 640 /etc/letsencrypt/archive/<YOUR_TURN_DOMAIN>/privkey*.pem
chown root:ssl-cert /etc/letsencrypt/archive/<YOUR_TURN_DOMAIN>/privkey*.pem
```

Create a renewal hook so these permissions are reapplied after every cert renewal:

```bash
cat > /etc/letsencrypt/renewal-hooks/deploy/coturn-perms.sh << 'EOF'
#!/bin/bash
chmod 640 /etc/letsencrypt/archive/<YOUR_TURN_DOMAIN>/privkey*.pem
chown root:ssl-cert /etc/letsencrypt/archive/<YOUR_TURN_DOMAIN>/privkey*.pem
systemctl reload coturn
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn-perms.sh
```

---

## Step 4 — Configure nginx

Replace `/etc/nginx/nginx.conf` with the following (or add the `stream {}` block to it):

```nginx
user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log error;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    include /etc/nginx/mime.types;
    default_type application/octet_stream;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    log_format messenger_minimal '$remote_addr [$time_local] "$request_method $uri" $status';
    access_log /var/log/nginx/access.log messenger_minimal;
    gzip on;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}

# SNI-routing: demultiplex TLS on public :443 by server name
stream {
    map $ssl_preread_server_name $backend_name {
        <YOUR_TURN_DOMAIN>    coturn_backend;
        <YOUR_APP_DOMAIN> web_backend;
        default               web_backend;
    }

    upstream web_backend {
        server 127.0.0.1:8443;
    }

    upstream coturn_backend {
        server 127.0.0.1:5349;
    }

    server {
        listen 443;
        proxy_pass $backend_name;
        ssl_preread on;
    }
}
```

Create the site config at `/etc/nginx/sites-available/<YOUR_APP_DOMAIN>`:

```nginx
server {
    listen 80;
    server_name <YOUR_APP_DOMAIN> <YOUR_TURN_DOMAIN>;

    # For certbot HTTP-01 renewal
    location /.well-known/acme-challenge/ {
        root /var/www/<YOUR_APP_DOMAIN>;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 8443 ssl;
    server_name <YOUR_APP_DOMAIN>;

    ssl_certificate     /etc/letsencrypt/live/<YOUR_APP_DOMAIN>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<YOUR_APP_DOMAIN>/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /var/www/<YOUR_APP_DOMAIN>;
    index index.html;

    # WebSocket proxy for signaling
    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        access_log off;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        access_log off;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable and test:

```bash
ln -sf /etc/nginx/sites-available/<YOUR_APP_DOMAIN> /etc/nginx/sites-enabled/<YOUR_APP_DOMAIN>
nginx -t
systemctl enable nginx
systemctl restart nginx
```

---

## Step 5 — Configure coturn

**This is the critical section for a directly-addressed VPS.**

Replace `/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349

# CRITICAL: Restricts coturn's internal server_addrs set to 127.0.0.1 only.
# Without this line, coturn calls getifaddrs() and adds the public IP (e.g.
# <YOUR_VPS_IP>) to server_addrs. When both browser peers use the same TURN
# server, CREATE_PERMISSION for the peer's relay address (also <YOUR_VPS_IP>)
# returns "403 Forbidden IP" and ICE permanently fails.
# With listening-ip=127.0.0.1, coturn only knows about 127.0.0.1 as a local
# address, so the public IP is never treated as "self" and CREATE_PERMISSION
# for relay addresses on the public IP succeeds.
listening-ip=127.0.0.1

realm=<YOUR_TURN_DOMAIN>
server-name=<YOUR_TURN_DOMAIN>

# The actual public IP of this VPS
external-ip=<YOUR_VPS_IP>

cert=/etc/letsencrypt/live/<YOUR_TURN_DOMAIN>/fullchain.pem
pkey=/etc/letsencrypt/live/<YOUR_TURN_DOMAIN>/privkey.pem

use-auth-secret
static-auth-secret=<YOUR_TURN_SHARED_SECRET>

min-port=49152
max-port=65535

no-multicast-peers
no-stun
fingerprint

cli-ip=127.0.0.1
cli-port=5766
cli-password=your-cli-password-here

cipher-list="HIGH:!aNULL:!eNULL:!EXPORT:!DES:!MD5:!PSK:!RC4"
log-file=/var/log/coturn/turnserver.log
no-stdout-log
```

```bash
mkdir -p /var/log/coturn
chown turnserver:turnserver /var/log/coturn
systemctl enable coturn
systemctl restart coturn
systemctl is-active coturn
```

## Step 5A — Logging retention and verbosity hardening

The default config above is functional, but not yet aligned with the browser-side cleanup work. Two additional changes are recommended:

1. nginx should keep only minimal HTTP request logs and should not log hidden-functionality paths such as `/ws` and `/api/`.
2. coturn should write only to its own logfile, not duplicate to stdout/journald, and that logfile should be rotated aggressively.

### nginx logging audit result

- Current risk without hardening: `/ws` and `/api/rooms/...` requests are recorded in nginx access logs and can retain room-related traffic traces.
- Recommended state: keep a minimal access log for normal decoy web traffic, disable access logging for `/ws` and `/api/`, and keep only short retention.

Install the logrotate policy from this repo:

```bash
install -m 0644 /path/to/repo/ops/logrotate/nginx-messenger /etc/logrotate.d/nginx
logrotate -f /etc/logrotate.d/nginx
```

Do not install this as a second file alongside the distro-provided nginx policy for the same log paths. Replace the existing `/etc/logrotate.d/nginx` entry instead.

### coturn logging audit result

- Current risk without hardening: coturn keeps relay/session metadata in `/var/log/coturn/turnserver.log` indefinitely unless rotation is configured.
- Recommended state: do not enable `verbose`, keep `no-stdout-log`, log only to the dedicated file, and rotate that file aggressively.

Install the logrotate policy from this repo:

```bash
install -m 0644 /path/to/repo/ops/logrotate/coturn-messenger /etc/logrotate.d/coturn
logrotate -f /etc/logrotate.d/coturn
```

If the OS already ships `/etc/logrotate.d/coturn`, replace it instead of creating a second rule for the same logfile.

### Verify effective logging state

```bash
# nginx should not emit /ws or /api requests into access.log after reload
nginx -t && systemctl reload nginx
tail -n 20 /var/log/nginx/access.log

# coturn should only write to its file and should not duplicate into journald
systemctl restart coturn
journalctl -u coturn -n 20
tail -n 20 /var/log/coturn/turnserver.log

# inspect the installed retention policies
logrotate -d /etc/logrotate.d/nginx
logrotate -d /etc/logrotate.d/coturn
```

Expected result:

- nginx access logs retain only minimal decoy-site requests
- `/ws` and `/api/` traffic is absent from nginx access logs
- coturn writes only to `/var/log/coturn/turnserver.log`
- both nginx and coturn logs are rotated daily and only the latest 3 rotations are retained

---

## Step 6 — iptables NAT rules (hairpin relay fix)

This is the **second critical section** for a directly-addressed VPS.

Because `listening-ip=127.0.0.1` causes coturn relay sockets to bind to `127.0.0.1`, four NAT rules are needed to correctly route relay traffic. The fourth rule (loopback SNAT) is the key fix for hairpin relay when both peers use the same server.

### Why these rules are needed

When both browser clients connect through the same TURN server, ICE produces **hairpin relay candidates**: both Local and Remote candidates share the same public IP (`<YOUR_VPS_IP>`) with different ports. The relay traffic flow is:

```
Browser A → coturn A relay (127.0.0.1:PORT_A) → <YOUR_VPS_IP>:PORT_B
  → iptables DNAT → 127.0.0.1:PORT_B (coturn B's relay socket)
    → coturn B sees source: 127.0.0.1:PORT_A
    → coturn B holds permission for: <YOUR_VPS_IP>
    → source mismatch → DROPPED → ICE fails
```

The loopback SNAT rule fixes this by rewriting the source to `<YOUR_VPS_IP>` before the packet reaches coturn B, so the permission check passes.

On Oracle Cloud this is handled automatically by the hypervisor NAT. On a bare-metal/AlexHost VPS it must be done manually.

> Scope note: the four NAT rules below are the documented fix for UDP relay hairpining on a directly-addressed VPS. If you force browsers onto `turns:443?transport=tcp` for restrictive networks, validate TCP relay and same-server hairpin behavior separately instead of assuming the UDP rules are sufficient.

### Apply the rules

```bash
# Rule 1 – PREROUTING DNAT
# Browser UDP arriving at the public IP on relay ports → redirect to loopback
# (where coturn relay sockets actually bind because of listening-ip=127.0.0.1)
iptables -t nat -A PREROUTING \
  -i eth0 -d <YOUR_VPS_IP> -p udp --dport 49152:65535 \
  -j DNAT --to-destination 127.0.0.1

# Rule 2 – OUTPUT DNAT
# Coturn itself sending relay UDP to the public IP (hairpin path) → redirect to loopback
iptables -t nat -A OUTPUT \
  -d <YOUR_VPS_IP> -p udp --dport 49152:65535 \
  -j DNAT --to-destination 127.0.0.1

# Rule 3 – POSTROUTING SNAT (eth0)
# Relay responses going out to real external clients: rewrite src 127.0.0.1 → public IP
iptables -t nat -A POSTROUTING \
  -s 127.0.0.1 -o eth0 -p udp --sport 49152:65535 \
  -j SNAT --to-source <YOUR_VPS_IP>

# Rule 4 – POSTROUTING SNAT (lo)  ← KEY hairpin fix
# Hairpin relay packets travelling over loopback: rewrite src 127.0.0.1 → public IP
# so coturn B's permission check sees the expected peer address instead of 127.0.0.1
iptables -t nat -A POSTROUTING \
  -s 127.0.0.1 -o lo -p udp --sport 49152:65535 \
  -j SNAT --to-source <YOUR_VPS_IP>
```

### Save rules permanently

```bash
netfilter-persistent save
```

This saves to `/etc/iptables/rules.v4` and `/etc/iptables/rules.v6`. Rules are automatically restored on reboot.

### Verify

```bash
iptables -t nat -S POSTROUTING
# Expected output:
# -A POSTROUTING -s 127.0.0.1/32 -o eth0 -p udp --sport 49152:65535 -j SNAT --to-source <YOUR_VPS_IP>
# -A POSTROUTING -s 127.0.0.1/32 -o lo  -p udp --sport 49152:65535 -j SNAT --to-source <YOUR_VPS_IP>

iptables -t nat -S PREROUTING
# Expected:
# -A PREROUTING -i eth0 -d <YOUR_VPS_IP>/32 -p udp --dport 49152:65535 -j DNAT --to-destination 127.0.0.1

iptables -t nat -S OUTPUT
# Expected:
# -A OUTPUT -d <YOUR_VPS_IP>/32 -p udp --dport 49152:65535 -j DNAT --to-destination 127.0.0.1
```

---

## Step 7 — Deploy the backend

```bash
# Create the systemd service unit
cat > /etc/systemd/system/messenger-backend.service << 'EOF'
[Unit]
Description=Go Messenger Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/usr/local/bin
ExecStart=/usr/local/bin/messenger-backend
Restart=on-failure
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable messenger-backend
```

The backend binary is deployed by running `local-deploy.sh` from your local machine (see Step 8).

---

## Step 8 — Build and deploy the application

From the **local development machine** (not the VPS), in the project root:

```bash
# Set the VPS address if it differs from the default
export REMOTE_HOST=<YOUR_VPS_IP>

bash local-deploy.sh
```

`local-deploy.sh` will:
1. Cross-compile the Go backend for Linux AMD64
2. Build the Vite/React frontend without TURN secrets
3. Upload both artifacts to the VPS via SCP
4. Stop the backend, swap the binaries/files, start the backend, reload nginx
5. Verify the backend health endpoint

### Manual video assets

The coastal hero videos under `frontend/public/media/optimized/` are intentionally not stored in Git to avoid bloating the repository. That means:

1. GitHub Actions deploys will not have those files unless you upload them to the VM manually.
2. The server must keep them under the frontend web root at `media/optimized/`.
3. Both deployment paths intentionally remove `dist/media` before upload, so video assets are never transferred automatically.

Upload them to the VPS after the initial deployment:

```bash
# Example for the GitHub Actions target path
ssh <YOUR_USER>@<YOUR_HOST> 'mkdir -p /var/www/messenger/media/optimized'
scp frontend/public/media/optimized/* <YOUR_USER>@<YOUR_HOST>:/var/www/messenger/media/optimized/
```

If you deploy with `local-deploy.sh`, use the configured `REMOTE_FRONTEND_PATH` instead of `/var/www/messenger` when choosing the remote upload path.

Both deployment paths preserve the existing `media/` directory on the server, so manually uploaded video assets are not removed by later deploys.

### TURN credentials

The frontend no longer receives static TURN credentials at build time. It calls
`/api/turn-credentials`, and the backend signs short-lived credentials with the
shared secret configured in coturn.

Set these values in the local `.env` used by `local-deploy.sh`:

| Variable | Value |
|---|---|
| `TURN_SHARED_SECRET` | same value as `static-auth-secret` in `/etc/turnserver.conf` |
| `TURN_REALM` | `<YOUR_TURN_DOMAIN>` |
| `TURN_TTL_SECONDS` | `600` |
| `TURN_URLS` | optional comma-separated TURN URLs |

For aggressive networks that block UDP and most non-443 egress, leave
`TURN_URLS` empty or set it explicitly to:

```bash
TURN_URLS='turns:turn.example.com:443?transport=tcp'
```

---

## Step 9 — Verification

### Check services are running

```bash
systemctl is-active nginx coturn messenger-backend
```

### Check listeners

```bash
ss -lntup | grep -E ':(80|443|3478|5349|8080|8443)\b'
# Expected:
# tcp  LISTEN  0.0.0.0:80   -> nginx
# tcp  LISTEN  0.0.0.0:443  -> nginx (stream proxy)
# tcp  LISTEN  0.0.0.0:8443 -> nginx (http server)
# tcp  LISTEN  127.0.0.1:5349 -> coturn (TLS)
# tcp  LISTEN  127.0.0.1:3478 -> coturn (plain)
# tcp  LISTEN  127.0.0.1:8080 -> messenger-backend
```

### Check HTTPS

```bash
curl -sI https://<YOUR_APP_DOMAIN>/
# Expected: HTTP/1.1 200 OK

curl -sf https://<YOUR_APP_DOMAIN>/health
# Expected: {"status":"ok"}
```

### Check TURN TLS reachability

```bash
openssl s_client -connect <YOUR_TURN_DOMAIN>:443 -servername <YOUR_TURN_DOMAIN> < /dev/null 2>&1 | grep -E 'subject|Verify'
# Expected: subject with CN=<YOUR_TURN_DOMAIN> and Verify return code: 0
```

### Test TURN relay (from another host)

```bash
# Install coturn tools on another machine, then:
turnutils_uclient -t -S -X -c -v -n 5 \
  -u <YOUR_TURN_USERNAME> -w <YOUR_TURN_PASSWORD> \
  -p 5349 -e <other-host-ip> -r 50000 \
  <YOUR_VPS_IP>
# Expected: TURN allocate success, relay address returned, sent packets > 0
```

---

## Step 10 — Certbot auto-renewal

Certbot installs a systemd timer automatically. Verify it is active:

```bash
systemctl status certbot.timer
# Run a dry-run to test the full renewal + deploy-hook chain:
certbot renew --dry-run
```

The deploy hook at `/etc/letsencrypt/renewal-hooks/deploy/coturn-perms.sh` re-fixes privkey permissions and reloads coturn after every successful renewal.

---

## Architecture summary

```
Internet
  │
  ▼ :443 TCP (TLS)
┌─────────────────────────────────────────┐
│  nginx stream (public :443)             │
│  SNI routing by server_name             │
│    <YOUR_TURN_DOMAIN>  → 127.0.0.1:5349 │
│    <YOUR_APP_DOMAIN> → 127.0.0.1:8443│
└─────────────────────────────────────────┘
  │                         │
  ▼ :5349                   ▼ :8443
┌──────────┐    ┌───────────────────────────┐
│  coturn  │    │  nginx http               │
│ TURN/TLS │    │  serves frontend SPA      │
│ binds on │    │  proxies /ws → :8080      │
│ 127.0.0.1│    └───────────────────────────┘
└──────────┘                │
  │                         ▼ :8080
  │ relay sockets     ┌──────────────┐
  │ 127.0.0.1:49152+  │  Go backend  │
  │                   │  WebSocket   │
  │                   │  signaling   │
  │                   └──────────────┘
  │
  ▼ iptables NAT (4 rules in /etc/iptables/rules.v4)
  PREROUTING:  <YOUR_VPS_IP>:49152-65535 UDP  → DNAT → 127.0.0.1
  OUTPUT:      <YOUR_VPS_IP>:49152-65535 UDP  → DNAT → 127.0.0.1
  POSTROUTING: 127.0.0.1:49152-65535 out eth0 → SNAT → <YOUR_VPS_IP>
  POSTROUTING: 127.0.0.1:49152-65535 out lo   → SNAT → <YOUR_VPS_IP>  ← hairpin fix
```

---

## Key differences from a cloud VPS (Oracle/AWS)

| Aspect | Cloud VM (Oracle) | Bare-metal / AlexHost |
|---|---|---|
| Public IP | Hypervisor NAT → private `10.x.x.x` | Directly on `eth0` |
| getifaddrs() result | Only private `10.x.x.x` | Includes public IP |
| coturn server_addrs | `{10.x.x.x}` | `{<YOUR_VPS_IP>}` (without fix) |
| CREATE_PERMISSION for relay addr | Passes (relay addr ≠ any server addr) | **Fails 403** (relay addr == server addr) |
| Fix needed | None | `listening-ip=127.0.0.1` + 4 iptables NAT rules |
| Hairpin SNAT | Provided by hypervisor | Must be added manually (rule 4) |

---

## Troubleshooting

### ICE state goes `checking → disconnected` immediately (no `connected`)

This is the hairpin relay problem. Check:
1. `listening-ip=127.0.0.1` is present in `/etc/turnserver.conf`
2. All 4 iptables NAT rules are present: `iptables -t nat -L -n`
3. Rules are saved: `cat /etc/iptables/rules.v4 | grep -c DNAT` should return 2

### coturn not starting

```bash
journalctl -u coturn -n 50
# Check for:
# "Cannot open certificate file" → fix cert permissions (Step 3)
# "Cannot bind" → check if port 5349 is free: ss -lntup | grep 5349
```

### nginx error: unknown directive "stream"

The `stream` module requires `libnginx-mod-stream`:
```bash
apt-get install -y libnginx-mod-stream
```

### Certbot renewal fails with "Problem binding to port 80"

nginx must be running and occupying port 80 with the `/.well-known/acme-challenge/` location active for `--nginx` certbot mode.

### TURN credentials wrong / 401 from coturn

Verify `/etc/turnserver.conf` uses `use-auth-secret`, and that
`static-auth-secret` exactly matches the backend `TURN_SHARED_SECRET`.
