#!/bin/bash
# TigrimOS VM Provisioning Script
# Runs inside the Ubuntu VM to set up TigrimOS
# This mirrors the Dockerfile setup but for a real Ubuntu VM

set -euo pipefail

echo "=== TigrimOS Provisioning ==="
echo "Setting up TigrimOS in Ubuntu sandbox"

# ── Force apt to use IPv4 only (IPv6 is often unreachable inside VMs) ──
echo 'Acquire::ForceIPv4 "true";' | sudo tee /etc/apt/apt.conf.d/99force-ipv4 > /dev/null

# Retry helper: retry a command up to N times with delay
retry() {
    local max_attempts=${1}; shift
    local delay=${1}; shift
    local attempt=1
    while true; do
        "$@" && break || {
            if [[ $attempt -ge $max_attempts ]]; then
                echo "  [WARN] Command failed after $max_attempts attempts: $*"
                return 1
            fi
            echo "  [RETRY] Attempt $attempt/$max_attempts failed, retrying in ${delay}s..."
            sleep "$delay"
            ((attempt++))
        }
    done
}

# Update system
export DEBIAN_FRONTEND=noninteractive
retry 3 5 sudo apt-get update -qq
sudo apt-get upgrade -y -qq || true

# Install Node.js 20
if ! command -v node &>/dev/null; then
    echo "[1/6] Installing Node.js 20..."
    retry 3 5 curl -4 -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    retry 3 5 sudo apt-get install -y nodejs
else
    echo "[1/6] Node.js already installed: $(node --version)"
fi

# Install Python 3 + venv
echo "[2/6] Setting up Python..."
retry 3 5 sudo apt-get install -y python3 python3-pip python3-venv build-essential

# Create Python virtual environment (mirrors Dockerfile)
if [ ! -d /opt/venv ]; then
    echo "[3/6] Creating Python virtual environment..."
    sudo python3 -m venv /opt/venv
    retry 3 10 sudo /opt/venv/bin/pip install --no-cache-dir \
        numpy pillow matplotlib pandas scipy seaborn openpyxl python-docx
else
    echo "[3/6] Python venv already exists"
fi

# Add venv to PATH
export PATH="/opt/venv/bin:$PATH"

# Install global npm packages (mirrors Dockerfile)
echo "[4/6] Installing global npm packages..."
retry 3 10 sudo npm i -g clawhub tsx

# Setup TigrimOS
echo "[5/6] Setting up TigrimOS..."
sudo mkdir -p /app
sudo chown -R tigris:tigris /app

# Copy from VirtioFS mount if available, fallback to git clone
if [ -d /mnt/tiger-cowork ] && [ -f /mnt/tiger-cowork/package.json ]; then
    echo "  Copying from local source..."
    cp -r /mnt/tiger-cowork/* /app/
    # Fix settings.json — replace dev-machine sandboxDir with VM path
    if [ -f /app/data/settings.json ]; then
      python3 -c "
import json, os
fp = '/app/data/settings.json'
with open(fp) as f: s = json.load(f)
s['sandboxDir'] = '/app'
s['pythonPath'] = '/opt/venv/bin/python3'
with open(fp, 'w') as f: json.dump(s, f, indent=2)
print('  Fixed settings.json: sandboxDir=/app, pythonPath=/opt/venv/bin/python3')
" || true
    fi
    # Fix projects.json — migrate old absolute paths (e.g. /root/cowork/) to /app/
    if [ -f /app/data/projects.json ]; then
      python3 -c "
import json, os, re
fp = '/app/data/projects.json'
with open(fp) as f: projects = json.load(f)
changed = False
for p in projects:
    wf = p.get('workingFolder', '')
    if wf and os.path.isabs(wf) and not wf.startswith('/app'):
        p['workingFolder'] = os.path.basename(wf)
        changed = True
        print(f'  Migrated project working folder: {wf} -> {p[\"workingFolder\"]}')
if changed:
    with open(fp, 'w') as f: json.dump(projects, f, indent=2)
    print('  Fixed projects.json')
else:
    print('  projects.json OK, no migration needed')
" || true
    fi
else
    echo "  Local source not found, cloning from GitHub..."
    sudo apt-get install -y -qq git 2>/dev/null || true
    retry 3 5 git clone --depth 1 https://github.com/Sompote/TigrimOS.git /tmp/tigris-src
    cp -r /tmp/tigris-src/tiger_cowork/* /app/
    rm -rf /tmp/tigris-src
    cd /app
    npm install --ignore-scripts --omit=dev
    if [ -d client ]; then
        cd client && npm install && npx vite build && cd ..
    fi
    mkdir -p uploads data data/agents
    # Create correct settings.json for VM
    cat > /app/data/settings.json << 'SETTINGS'
{"sandboxDir":"/app","pythonPath":"/opt/venv/bin/python3","tigerBotApiKey":"","tigerBotModel":"TigerBot-70B-Chat","mcpTools":[],"webSearchEnabled":false}
SETTINGS
fi

# Create settings fixer script (runs before every service start)
sudo tee /usr/local/bin/tigrimos-fix-settings.sh > /dev/null << 'FIXSCRIPT'
#!/bin/bash
# Ensure settings.json has correct VM paths (not dev-machine paths)
FP="/app/data/settings.json"
[ -f "$FP" ] || exit 0
/opt/venv/bin/python3 << 'PYFIX'
import json
fp = "/app/data/settings.json"
with open(fp) as f: s = json.load(f)
changed = False
if s.get("sandboxDir") != "/app":
    s["sandboxDir"] = "/app"
    changed = True
if s.get("pythonPath") != "/opt/venv/bin/python3":
    s["pythonPath"] = "/opt/venv/bin/python3"
    changed = True
if changed:
    with open(fp, "w") as f: json.dump(s, f, indent=2)
PYFIX
FIXSCRIPT
sudo chmod +x /usr/local/bin/tigrimos-fix-settings.sh

# Create systemd service
echo "[6/6] Creating systemd service..."
sudo tee /etc/systemd/system/tiger-cowork.service > /dev/null << 'EOF'
[Unit]
Description=TigrimOS AI Workspace
After=network.target

[Service]
Type=simple
User=tigris
WorkingDirectory=/app
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=SANDBOX_DIR=/app
Environment=PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/usr/local/bin/tigrimos-fix-settings.sh
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/app /tmp
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable tiger-cowork
sudo systemctl start tiger-cowork

# Set root's default directory to /app so terminal opens there
echo 'cd /app 2>/dev/null' | sudo tee -a /root/.bashrc > /dev/null
echo 'export PATH="/opt/venv/bin:$PATH"' | sudo tee -a /root/.bashrc > /dev/null

# Mount helper for user shared folders
sudo mkdir -p /mnt/shared
sudo tee /usr/local/bin/mount-shared-folders.sh > /dev/null << 'MSCRIPT'
#!/bin/bash
# Auto-mount VirtioFS shared folders
for tag in $(ls /sys/fs/virtiofs/ 2>/dev/null || true); do
    mountpoint="/mnt/shared/${tag}"
    mkdir -p "$mountpoint"
    mount -t virtiofs "$tag" "$mountpoint" 2>/dev/null || true
done
MSCRIPT
sudo chmod +x /usr/local/bin/mount-shared-folders.sh

# Signal provisioning complete
sudo touch /var/lib/tigris-provisioned
echo "=== TigrimOS Provisioning Complete ==="
echo "TigrimOS running at http://localhost:3001"
