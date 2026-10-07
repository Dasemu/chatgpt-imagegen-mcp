# Deployment

Target: Debian or Ubuntu (one of the last three major releases) in an LXC container or VPS, running under systemd behind nginx. Docker is not used for deployment.

## 1. System packages

```bash
apt update && apt install -y git xvfb curl ca-certificates python3 python3-venv   # python3 only for self-heal
# Node.js >= 20 via NodeSource (see https://github.com/nodesource/distributions)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
```

`xvfb` provides the virtual display: Chromium runs headed inside Xvfb by default because ChatGPT/Cloudflare blocks headless Chromium more often.

## 2. User and code

```bash
useradd --system --create-home --home-dir /opt/chatgpt-imagegen-mcp --shell /bin/bash mcp
sudo -u mcp git clone <repo-url> /opt/chatgpt-imagegen-mcp
cd /opt/chatgpt-imagegen-mcp
sudo -u mcp npm ci
npx playwright install-deps chromium          # as root: installs Chromium system libraries
sudo -u mcp npx playwright install chromium   # as mcp: downloads the browser
sudo -u mcp npm run build
```

## 3. Configuration

```bash
sudo -u mcp cp .env.example .env && chmod 600 .env
```

Edit `.env` (bearer token, `UPDATE_TOKEN`, media/profile paths, ...). Generate secrets with `openssl rand -hex 32`.

## 4. ChatGPT login

The persistent Chromium profile must be logged in to chatgpt.com once. See [chatgpt-session.md](chatgpt-session.md).

## 5. systemd and sudoers

```bash
cp deploy/chatgpt-imagegen-mcp.service /etc/systemd/system/
install -m 0440 deploy/sudoers.chatgpt-imagegen-mcp /etc/sudoers.d/chatgpt-imagegen-mcp
visudo -cf /etc/sudoers.d/chatgpt-imagegen-mcp
systemctl daemon-reload && systemctl enable --now chatgpt-imagegen-mcp.service
journalctl -u chatgpt-imagegen-mcp.service -f
```

The sudoers rule only lets `mcp` restart this one service; the update script needs it. Adjust paths in the unit if you install elsewhere (and add any custom media/profile/log directories to `ReadWritePaths`).

## 6. nginx

Include `deploy/nginx-location.conf` in your TLS `server` block, then `nginx -t && systemctl reload nginx`. The service listens on `127.0.0.1:8088`; the MCP endpoint is `https://<host>/chatgptimagegen/mcp` with bearer auth. Set `TRUST_PROXY=1` in `.env` so rate limiting sees real client IPs.

## 7. Updates

See [update.md](update.md).
