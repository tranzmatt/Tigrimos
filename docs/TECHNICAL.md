# TigrimOS — Platform Architecture

How the same `tiger_cowork/` web application runs across macOS Apple Silicon, macOS Intel, and Windows.

## Overview

TigrimOS is a two-layer system:

1. **Host wrapper** — a platform-specific launcher that creates a sandboxed Ubuntu environment
2. **tiger_cowork/** — a platform-agnostic Node.js/React web application that runs identically inside every sandbox

```
┌─────────────────────────────────────────────────────┐
│  Host Wrapper (platform-specific)                   │
│  ┌───────────────────────────────────────────────┐  │
│  │  Ubuntu 22.04 Sandbox                         │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  tiger_cowork/  (identical everywhere)  │  │  │
│  │  │  Fastify + React on port 3001           │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Platform Comparison

| | macOS Apple Silicon | macOS Intel | Windows |
|---|---|---|---|
| **Host wrapper** | `TigrimOS.app` (arm64 Swift binary) | `TigrimOS_i.app` (x86_64 Swift binary) | `install_windows.ps1` (PowerShell + WPF) |
| **Sandbox** | Ubuntu arm64 VM via Virtualization.framework | Ubuntu amd64 VM via Virtualization.framework | Ubuntu 22.04 via WSL2 |
| **Boot method** | `VZEFIBootLoader` (UEFI) | `VZLinuxBootLoader` (direct kernel + initrd) | WSL2 kernel (managed by Windows) |
| **VM image** | `ubuntu-22.04-server-cloudimg-arm64` | `ubuntu-22.04-server-cloudimg-amd64` | `wsl --install Ubuntu-22.04` |
| **Disk conversion** | Not needed (raw disk from cloud image) | `qemu-img convert` QCOW2 → raw | Not needed (WSL manages disk) |
| **File sharing** | VirtioFS (read-only default) | VirtioFS (read-only default) | Symlinks to `/mnt/c/...` |
| **UI** | SwiftUI + WKWebView | SwiftUI + WKWebView | Edge app-mode window |
| **Bundle ID** | `com.tigercowork.tigrimos` | `com.tigercowork.tigrimos-intel` | N/A |
| **Min OS** | macOS 13.0 (Ventura) | macOS 13.0 (Ventura) | Windows 10 v2004+ |

## Source Code Structure

```
TigrimOS/
├── Tigris.app/TigrimOS/              # Swift source (shared by both macOS builds)
│   ├── TigrimOSApp.swift             #   App entry point
│   ├── VM/
│   │   ├── VMConfig.swift            #   VM paths, CPU/memory, image URLs
│   │   └── VMManager.swift           #   VM lifecycle, boot, provisioning
│   ├── Views/
│   │   ├── ContentView.swift         #   Main window layout
│   │   ├── TigerCoworkWebView.swift  #   WKWebView embedding port 3001
│   │   ├── ConsoleView.swift         #   VM boot log viewer
│   │   ├── SharedFoldersView.swift   #   Folder sharing UI
│   │   ├── SettingsView.swift        #   App preferences
│   │   └── SetupView.swift           #   First-run setup wizard
│   └── Security/
│       ├── SandboxManager.swift      #   Sandbox policy enforcement
│       └── FileAccessControl.swift   #   Per-folder access control + audit log
│
├── TigrimOS.app/                     # Pre-built macOS app (Apple Silicon)
│   └── Contents/
│       ├── MacOS/TigrimOS            #   Mach-O arm64 binary
│       ├── Resources/
│       │   ├── provision.sh          #   VM provisioning script
│       │   └── cloud-init.yaml       #   Cloud-init user-data
│       └── Info.plist
│
├── TigrimOS_i.app/                   # Pre-built macOS app (Intel)
│   └── Contents/
│       ├── MacOS/TigrimOS_i          #   Mach-O x86_64 binary
│       ├── Resources/                #   Same provision.sh + cloud-init.yaml
│       └── Info.plist
│
├── install_windows.ps1               # Windows installer (PowerShell + WPF GUI)
├── TigrimOSInstaller.bat             # Launcher for install_windows.ps1
├── TigrimOSStart.bat                 # Windows start script
├── TigrimOSStop.bat                  # Windows stop script
│
└── tiger_cowork/                     # The web app (platform-agnostic)
    ├── server/                       #   Fastify + TypeScript backend
    │   ├── index.ts                  #     Entry point (port 3001)
    │   ├── routes/                   #     API endpoints
    │   └── services/                 #     AI, tools, agents, MCP
    ├── client/                       #   React + Vite frontend
    │   ├── src/                      #     React components
    │   └── vite.config.ts
    ├── Tiger_bot/                    #   AI agent configurations
    ├── data/                         #   Runtime data (conversations, memory)
    ├── package.json                  #   v0.4.3 — "cowork"
    └── docs/
        ├── TECHNICAL.md              #   Agent system, tools, protocols
        └── CHANGELOG.md
```

## macOS Build: One Codebase, Two Binaries

The Swift source in `Tigris.app/TigrimOS/` compiles for both architectures. Platform differences are handled with compile-time conditionals:

```swift
// VMManager.swift — boot loader selection
#if arch(arm64)
    // Apple Silicon: UEFI boot
    // arm64 cloud image has GRUB in its EFI partition
    let bootLoader = VZEFIBootLoader()
    bootLoader.variableStore = efiVarStore
#else
    // Intel: direct kernel boot with vmlinuz + initrd
    let bootLoader = VZLinuxBootLoader(kernelURL: kernelURL)
    bootLoader.initialRamdiskURL = initrdURL
    bootLoader.commandLine = "console=hvc0 root=/dev/vda1 rw quiet"
#endif
```

| Difference | ARM (`arch(arm64)`) | Intel |
|---|---|---|
| Boot loader | `VZEFIBootLoader` + EFI variable store | `VZLinuxBootLoader` + vmlinuz + initrd |
| Downloads at first run | arm64 cloud image only | amd64 cloud image + kernel + initrd |
| Disk conversion | Direct raw image | `qemu-img convert` QCOW2 → raw |

Everything else — VM config, VirtioFS mounts, provisioning, networking — is identical.

## macOS: VM Lifecycle

### First Launch (5–10 minutes)

```
App starts
  │
  ├─ 1. Download Ubuntu cloud image (~660 MB)
  │     ARM: ubuntu-22.04-server-cloudimg-arm64.img
  │     Intel: ubuntu-22.04-server-cloudimg-amd64.img
  │
  ├─ 2. Convert disk (Intel only: qemu-img convert QCOW2 → raw)
  │
  ├─ 3. Create cloud-init seed ISO (seed.img)
  │     Sets hostname, creates 'tigris' user, installs packages
  │
  ├─ 4. Download kernel + initrd (Intel only)
  │     ARM uses UEFI boot from disk's EFI partition
  │
  ├─ 5. Boot VM via Virtualization.framework
  │     - CPUs: min(4, physical cores)
  │     - RAM: 4 GB
  │     - Disk: 20 GB expandable
  │
  ├─ 6. Cloud-init provisioning
  │     - Node.js 20, Python 3 venv, clawhub, tsx
  │     - Copy tiger_cowork/ from VirtioFS → /app/
  │     - npm install + vite build
  │     - Create systemd service
  │
  └─ 7. tiger-cowork.service starts → port 3001
        WKWebView loads http://localhost:3001
```

### Subsequent Launches (~30 seconds)

Steps 1–4 are skipped (files cached). The VM boots from the existing disk image and the systemd service starts automatically.

### VM Storage Location

```
~/Library/Application Support/TigrimOS/
├── ubuntu-cloud.qcow2    # Downloaded image (cached)
├── ubuntu-raw.img         # Converted raw disk (VM state persists here)
├── vmlinuz                # Linux kernel (Intel only)
├── initrd                 # Initial ramdisk (Intel only)
├── seed.img               # Cloud-init seed ISO
├── seed/                  # Cloud-init config files
├── machine-id             # VM machine identifier (persisted for EFI)
├── efi-store              # EFI variable store (ARM only)
└── shared_folders.json    # User's shared folder settings
```

## Windows: WSL2 Lifecycle

### Installation (via TigrimOSInstaller.bat)

```
PowerShell installer starts (WPF GUI)
  │
  ├─ 1. Enable WSL2 (may require restart)
  │
  ├─ 2. Install Ubuntu 22.04 as "TigrimOS" distro
  │
  ├─ 3. Inside WSL2:
  │     - Install Node.js 20, Python 3, clawhub, tsx
  │     - Clone/copy tiger_cowork/ → /opt/TigrimOS/tiger_cowork/
  │     - npm install + vite build
  │     - Create .env (PORT=3001)
  │
  ├─ 4. Optionally link a shared folder via symlink
  │
  └─ 5. Start server + open Edge app-mode window
        Desktop shortcut "TigrimOS" created
```

### Subsequent Launches (TigrimOSStart.bat)

```
wsl -d TigrimOS -- tsx server/index.ts  (port 3001)
Edge opens http://localhost:3001 in app mode
```

## How tiger_cowork/ Gets Into the Sandbox

| Platform | Mechanism | Path inside sandbox |
|---|---|---|
| **macOS** | VirtioFS mount (read-only) → copied to `/app/` | `/app/` |
| **Windows** | Git clone or file copy into WSL2 filesystem | `/opt/TigrimOS/tiger_cowork/` |

On macOS, the VirtioFS share is set up in `VMManager.swift`:

```swift
let share = VZVirtioFileSystemDeviceConfiguration(tag: "tiger-cowork")
// Mounts tiger_cowork/ directory read-only into the VM
```

The provisioning script then copies from the mount to `/app/`:

```bash
if [ -d /mnt/tiger-cowork ] && [ -f /mnt/tiger-cowork/package.json ]; then
    cp -r /mnt/tiger-cowork/* /app/
    cd /app && npm install --ignore-scripts --omit=dev
    cd /app/client && npm install && npx vite build
fi
```

## Security Isolation

### macOS VM Sandbox

The systemd service runs with hardened settings:

```ini
[Service]
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/app/data /app/uploads /app/output_file /app/Tiger_bot
ProtectHome=true
PrivateTmp=true
```

- Host filesystem is **invisible** to the VM (no default mounts)
- Shared folders require explicit user opt-in via the Folders tab
- Default share mode is **read-only**; write access requires toggle + VM restart
- VM processes cannot see or affect host processes
- Network is NAT — VM can reach internet but host sees only port 3001

### Windows WSL2 Sandbox

- WSL2 runs in a lightweight Hyper-V VM (process-level isolation)
- Host files accessible only via explicit symlinks in `shared/`
- Server binds to localhost only (port 3001)

## Networking: Local LLM Access

Both platforms set up a `host.local` hostname inside the sandbox so the AI can reach LLM servers running on the host machine:

| Platform | How `host.local` resolves |
|---|---|
| **macOS** | `/opt/setup-host-gateway.sh` adds the VM gateway IP as `host.local` in `/etc/hosts` |
| **Windows** | WSL2 gateway IP (usually `172.x.x.1`) mapped to `host.local` |

This allows TigrimOS to connect to Ollama, llama.cpp, LM Studio, or any OpenAI-compatible server running on the host at `http://host.local:<port>/v1`.
