# Plan: Remote Agent Bridge — Symmetric / Exchangeable

## Context

Both machines run the **same Tiger Cowork codebase**. Either machine can be the orchestrator or the remote worker at any time. Machine A adds Machine B as a Remote Instance, and Machine B adds Machine A — fully peer-to-peer.

No separate "Cloud PC build" is needed. The same code, the same settings UI, the same YAML config system works on both sides.

---

## Architecture (Symmetric)

```
Machine A                              Machine B (Cloud PC)
─────────────────────────────          ─────────────────────────────
Tiger Cowork running                   Tiger Cowork running
Settings > Remote Instances:           Settings > Remote Instances:
  - cloud-pc → http://B:3001             - home-pc → http://A:3001

AgentEditor YAML:                      AgentEditor YAML (optional):
  - id: cloud-researcher                 - id: home-worker
    type: remote                           type: remote
    remote_instance: cloud-pc              remote_instance: home-pc

spawn_subagent({agentId:"cloud-researcher"})    spawn_subagent({agentId:"home-worker"})
        ──────────────────────────→                     ──────────────────────────→
        POST /api/chat/sessions (B)                     POST /api/chat/sessions (A)
        POST .../messages (B)                           POST .../messages (A)
        GET  .../sessions/:id  (poll)                   GET  .../sessions/:id  (poll)
        ←── final assistant message ───                 ←── final assistant message ───
```

**Key insight**: Both machines are receivers by default (REST API always on). Either becomes an orchestrator by adding the other as a Remote Instance and referencing it in YAML.

---

## What Changes in Code (same repo, both machines)

All code changes go into the single Tiger Cowork repo. Both machines pull/update to get the feature.

| File | Change |
|------|--------|
| `server/services/remote.ts` | Activity-based polling (`idleTimeoutMs` + `maxTimeoutMs`) |
| `server/services/toolbox.ts` | `remote_task` tool in `getTools()`; `remote_task` case in `callTool`; remote agent routing in `spawnSubagent`; `AgentConfig.type = "remote"` fields; remote tag in `getManualAgentConfigSummary` |
| `server/services/data.ts` | `remoteInstances?` field in `Settings` interface |
| `server/routes/settings.ts` | Token masking/unmasking; `POST /settings/remote-instances/test` endpoint |
| `client/src/components/AgentEditor.tsx` | `isRemote`, `remoteInstance`, `remoteUrl`, `remoteToken` on `AgentNode`; indigo node + ↗ REMOTE badge; Remote panel in sidebar; YAML serialize/deserialize |
| `client/src/pages/SettingsPage.tsx` | "Remote Instances" section (add / test / delete) |
| `client/src/utils/api.ts` | `testRemoteInstance(id)` |

---

## Timeout Strategy: Activity-Based

```
lastActivityAt = now
lastMessageCount = 0
hardDeadline = now + max_timeout (default 30 min)

each poll (every 2s):
  fetch session → count messages
  if messages.length > lastMessageCount:
    lastActivityAt = now      ← remote swarm still working
    lastMessageCount = messages.length
  if now - lastActivityAt > idle_timeout (default 60s):
    → abort (stuck/dead)
  if now > hardDeadline:
    → abort (safety cap)
  if last message role === "assistant":
    → return result ✓
```

---

## Step-by-Step Implementation

### 1. `server/services/remote.ts`
- Replace fixed `timeoutMs` with `idleTimeoutMs` (default 60s) + `maxTimeoutMs` (default 1800s)
- Keep `timeoutMs` as legacy alias → treated as `maxTimeoutMs`
- Track `lastMessageCount`; reset `lastActivityAt` on new messages
- Infinite loop; exit conditions: assistant reply found, idle timeout, hard deadline, signal abort

### 2. `server/services/toolbox.ts`

**A. `AgentConfig` interface** — add:
```typescript
type?: "remote";
remote_instance?: string;
remote_url?: string;
remote_token?: string;
```

**B. `remoteTaskTool`** — replace `timeout` param with:
```
idle_timeout: number (s, default 60)
max_timeout: number (s, default 1800)
```

**C. `callTool` — add `remote_task` case:**
- Resolve instance by id/name from `settings.remoteInstances`
- Fallback: parse `args.instance` as inline `{url, token}` JSON
- Call `remoteTask(instance, args.task, { idleTimeoutMs, maxTimeoutMs, signal })`

**D. `spawnSubagent` — remote routing:**
After YAML config is loaded and `agentDef` is found, if `agentDef.type === "remote"`:
- Resolve instance from `remote_instance` name → `settings.remoteInstances`
- Fallback to `remote_url` + `remote_token` inline
- Call `remoteTask(instance, args.task, { signal })`; skip local sub-agent loop entirely

**E. `getManualAgentConfigSummary`** — tag remote agents:
```
- cloud-researcher ("Cloud Research Team"): worker [REMOTE → cloud-pc]
```
Add note: `Remote agents run on another machine — spawn them normally with agentId.`

### 3. `server/services/data.ts`
```typescript
remoteInstances?: Array<{ id: string; name: string; url: string; token: string }>;
```

### 4. `server/routes/settings.ts`
- **GET `/`**: mask remote instance tokens (show first 8 + `...` + last 4)
- **PUT `/`**: restore original token when masked value sent (match by `id`)
- **POST `/remote-instances/test`**: call `remoteTask` with `"Hello, reply with just pong"`, `idleTimeoutMs: 15000`; return `{ ok, message }`

### 5. `client/src/components/AgentEditor.tsx`

**`AgentNode` interface additions:**
```typescript
isRemote: boolean;
remoteInstance: string;   // saved instance name/id
remoteUrl: string;        // inline URL fallback
remoteToken: string;      // inline token
```

**Canvas rendering for remote agents:**
- Node fill: `#6366f1` (indigo)
- Badge: `↗ REMOTE` in top-right corner
- Footer: show `remoteInstance` name (not model)

**Side panel when `isRemote = true`:**
- Show: Remote Instance dropdown (from `settings.remoteInstances`), OR URL + Token fields
- Show: Idle Timeout (s) + Max Timeout (s) fields
- Hide: model selector, persona, responsibilities, bus/mesh/p2p toggles

**YAML round-trip:**
```yaml
- id: cloud-researcher
  name: Cloud Research Team
  role: worker
  type: remote
  remote_instance: cloud-pc
```

### 6. `client/src/pages/SettingsPage.tsx`

New **Remote Instances** section (after MCP Servers):
```
Remote Instances
Delegate tasks to Tiger Cowork on other machines.

  cloud-pc  http://192.168.1.x:3001
            abc12345...ef56   [Test ✓]  [Delete]

  Name:  [_____________]
  URL:   [http://_______:3001]
  Token: [_____________]       [Add Instance]
```
- Test button → `api.testRemoteInstance(id)` → inline ✓/✗
- Save via global Save button

### 7. `client/src/utils/api.ts`
```typescript
testRemoteInstance: (id: string) =>
  request("/settings/remote-instances/test", { method: "POST", body: JSON.stringify({ id }) }),
```

---

## Setup on Each Machine (same steps, both sides)

### Prerequisites
- Both machines have Tiger Cowork running with the updated code
- Both are network-reachable to each other (LAN, VPN, or public IP)
- Each machine knows the other's URL and `ACCESS_TOKEN`

### Steps (repeat on each machine)

1. **Run Tiger Cowork** as usual — no special mode needed
2. **Get the ACCESS_TOKEN** from the machine's `.env` / startup config
3. **On Machine A** → Settings → Remote Instances → Add:
   - Name: `cloud-pc`
   - URL: `http://<Cloud-PC-IP>:3001`
   - Token: Cloud PC's `ACCESS_TOKEN`
   - Click **Test** → expect "pong"
4. **On Machine B** (Cloud PC) → Settings → Remote Instances → Add:
   - Name: `home-pc`
   - URL: `http://<Machine-A-IP>:3001`
   - Token: Machine A's `ACCESS_TOKEN`
   - Click **Test** → expect "pong"

Now either machine can be the orchestrator.

---

## Usage (either machine can orchestrate)

**Machine A orchestrates Cloud PC:**
```yaml
agents:
  - id: orchestrator
    role: orchestrator
  - id: cloud-researcher
    type: remote
    remote_instance: cloud-pc
```
```
spawn_subagent({ agentId: "cloud-researcher", task: "Research X" })
```

**Cloud PC orchestrates Machine A:**
```yaml
agents:
  - id: orchestrator
    role: orchestrator
  - id: home-worker
    type: remote
    remote_instance: home-pc
```

**Ad-hoc (no YAML):**
```
remote_task({ instance: "cloud-pc", task: "Summarize this doc" })
```

---

## Verification

1. Both machines: Settings → Remote Instances → Test → "pong" ✓
2. Machine A: add `type: remote` agent in AgentEditor → indigo node + ↗ REMOTE badge
3. Chat on Machine A: `"Use cloud-researcher to research quantum computing"` → result comes from Cloud PC
4. Cloud PC chat history → confirm session was created
5. Swap roles: Cloud PC orchestrates Machine A → same result
