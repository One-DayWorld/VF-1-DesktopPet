# Macross — VF-1 Desktop Pet for macOS

A macOS desktop companion that lives on your screen as a 3D **VF-1S Valkyrie** (the iconic transformable fighter from *Macross / Robotech*). It patrols the edges of your display, monitors your terminal for Claude Code prompts, talks back via TTS, and exposes a HUD-style cockpit panel for chat, mission tracking, market data, and more.

Built with Electron + Three.js. Apple Silicon and Intel both supported.

---

## Table of Contents

1. [What it is](#1-what-it-is)
2. [Quick Start](#2-quick-start)
3. [Pet Behaviors](#3-pet-behaviors)
4. [Cockpit Panel — 7 Tabs](#4-cockpit-panel--7-tabs)
5. [AI Providers](#5-ai-providers)
6. [Claude Code Terminal Integration](#6-claude-code-terminal-integration)
7. [Configuration & Permissions](#7-configuration--permissions)
8. [Architecture](#8-architecture)
9. [Building from Source](#9-building-from-source)
10. [Packaging a DMG Installer](#10-packaging-a-dmg-installer)
11. [Data Storage](#11-data-storage)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. What it is

Macross is a transparent always-on-top window rendering a 3D VF-1S Valkyrie model with full transformation support (Fighter ↔ Gerwalk ↔ Battloid). Click the model and a cockpit-style control panel slides out with seven tabs.

Beyond the cosmetic, it integrates with:
- **Claude Code** — flashes alarms when a permission prompt is waiting in your terminal, plays a "task complete" voice and bubble when an agent finishes
- **macOS Reminders** — read/write your tasks
- **Multiple LLM backends** — Qwen, DeepSeek, Doubao, Ollama
- **Web search** (via metaso.cn MCP) for real-time queries

The pet itself is not the AI — it's a **frontend container**. The intelligence comes from whichever LLM you bind in `CONFIG`.

---

## 2. Quick Start

### Option A: Install the prebuilt DMG (recommended for end users)

1. Download `Macross-1.0.0-arm64.dmg` (Apple Silicon) from the Releases page
2. Double-click → drag the app into `Applications`
3. First launch: macOS will warn the app is unsigned. Right-click → **Open** → confirm. (Or run `xattr -dr com.apple.quarantine /Applications/Macross.app`)
4. Grant **System Settings → Privacy & Security → Accessibility** permission to Macross (required to read terminal contents)
5. Open the panel via `CONFIG` → fill in at least one LLM API key (see [§5](#5-ai-providers))

### Option B: Run from source (for development)

Requires **Node.js 18+** and **npm**. On Apple Silicon Macs, also ensure Xcode Command Line Tools are installed (`xcode-select --install`).

```bash
git clone <this repo>
cd DesktopPet
npm install                  # ~300 MB, mostly Electron + Three.js
npm start
```

If `npm start` reports `Electron failed to install correctly`, the binary download failed (often a network issue with GitHub releases). Use the China mirror:

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
rm -rf node_modules/electron
npm install electron --save-dev
npm start
```

---

## 3. Pet Behaviors

The VF-1 is much more than a static sprite. It has a full behavioral state machine:

### Idle State
- Faces the camera (slight downward camera tilt to show the cockpit)
- Subtle vertical breathing motion (no left/right sway by design)
- Eye light pulses softly

### Edge Patrol (default ON, toggle in `CONFIG → 机体设置`)
When idle, the VF-1 randomly patrols the four screen corners:
- **Horizontal edges** (top/bottom): transforms to **Fighter**, banks left/right with the flight direction (90° yaw lock to face flight direction), wings wag like real cruise turbulence
- **Vertical edges** (sides): transforms to **Gerwalk**, hovers facing the camera, blue-white feet thrusters, slight pitch oscillation simulating thrust corrections
- **Random maneuvers** trigger every ~22 seconds during patrol:
  - `barrel-roll` — full 360° roll (horizontal flight only)
  - `wing-dip` — sharp ±26° banking salute
  - `wag` — yaw oscillation tail-wag
  - `hop` — sudden upward thrust pulse (vertical hover)
  - `look-around` — model "scans" left and right
  - `shimmy` — quick lateral position shifts
- Direction (clockwise vs counter-clockwise) randomly flips at corners with 30% probability
- All maneuvers self-cancel if you drag the pet, a Claude alarm fires, a break reminder fires, etc.

### Reactive States
| Trigger | Behavior |
|---|---|
| Claude Code permission prompt detected | Eyes flash gold, target-lock HUD pulses, voice repeats "发现不明物体" every 30s |
| Claude Code task done | Voice says "任务已完成", persistent bubble until you click |
| Click while task-done active | Brings the matching terminal window to front, dismisses bubble |
| Break reminder timer fires | Flies to screen center (Battloid form), speaks the reminder, returns home |
| Lid closed / system sleep | Timers pause; on wake, break-reminder counter resets to avoid burst-firing all skipped reminders |

### Mouse Hit Zone
The window itself is 180×350 transparent, but only the central rectangle (where the model is rendered) captures clicks. Click on transparent areas passes through to whatever's behind.

---

## 4. Cockpit Panel — 7 Tabs

Click the VF-1 to open the panel (380×600 HUD-styled window).

| Tab | Purpose |
|---|---|
| **CHAT** | LLM chat with quick-action sidebar (weather, calendar, news, sports, AI self-check). Buttons to open ChatGPT / DeepSeek / Qwen / Doubao / ICA in browser. AI suggestions for daily actions. |
| **WORKFLOW** | Define & save reusable AI prompts ("workflows") for one-click execution |
| **YES BOT** | Live monitor of all terminal sessions, tracking which one is awaiting Claude Code permission |
| **WINDOWS** | Lists currently running macOS apps and their windows; click to bring to front |
| **MRKT** | Real-time market data (indices, forex, etc.) |
| **MISSION** | Two-column todo manager; reads/writes macOS native Reminders |
| **CONFIG** | Pet name & avatar, break reminder, edge patrol toggle, reminder list selection, AI provider, API keys |

All tabs share the same HUD chrome — chamfered corners (`clip-path: polygon`), animated 1.5px gradient borders, glowing pill-shaped section titles, scan-line decorations.

---

## 5. AI Providers

Macross supports four LLM backends via the same OpenAI-compatible interface. Configure in `CONFIG → AI 后台`:

| Provider | Default Model | Endpoint | API Key Source |
|---|---|---|---|
| **Qwen** (千问) | `qwen-plus` | DashScope (Alibaba Cloud) | https://dashscope.console.aliyun.com |
| **DeepSeek** | `deepseek-chat` | api.deepseek.com | https://platform.deepseek.com |
| **Doubao** (豆包) | `doubao-1-5-pro-32k` | Volcengine Ark | https://console.volcengine.com/ark |
| **Ollama** | `llama3` (local) | localhost:11434 | None (local) |

> Web search via Metaso (https://metaso.cn) is independent of the LLM provider. If you also fill in a Metaso key in `CONFIG → 网页搜索`, the AI will be able to search the live web for sports scores, news, stock prices, etc.

API keys are stored locally in `~/.desktop-pet/data.json` and never transmitted except to the respective provider's API.

---

## 6. Claude Code Terminal Integration

This is the killer feature: the VF-1 watches for Claude Code permission prompts in your terminal and physically alerts you (visual + voice). It also notifies you when an agent finishes.

### How it works

```
Claude Code prompts for permission
        ↓
~/.claude/settings.json hook fires zaku-notify.sh
        ↓
zaku-notify.sh writes /tmp/zaku_claude_pending (with the tty path)
        ↓
Macross polls the flag every 800ms → triggers alarm UI + voice loop
        ↓
You click the VF-1 → Macross brings the matching terminal window to front
        ↓
Claude finishes → Stop hook writes /tmp/zaku_task_done
        ↓
VF-1 says "任务已完成" with persistent bubble until clicked
```

### First-launch auto-configuration

You don't have to manually edit `~/.claude/settings.json`. On every launch, Macross runs `ensureClaudeHooksInstalled()` which:

1. Extracts `zaku-notify.sh` from the app bundle to `~/.macross/zaku-notify.sh` (chmod 755)
2. Reads (or creates) `~/.claude/settings.json`
3. Injects four hooks: `PermissionRequest`, `PostToolUse`, `PermissionDenied`, `Stop`
4. Idempotent — re-running with the same paths is a no-op; updated paths are refreshed

Filtering for false positives:
- Claude Code internal tools (`TaskCreate`, `TaskUpdate`, `LSP`, etc.) are whitelisted and don't trigger alarms
- `permission_mode === "bypassPermissions"` mode is silenced (no UI is shown anyway)
- The `tty` resolver walks up the parent process chain up to 12 hops to find a real tty (works with Claude's wrapper processes)

### Supported terminals

- Terminal.app (full support)
- iTerm2 (full support — uses windowName matching)
- Other terminals (WezTerm, Warp, Alacritty, Hyper) — falls back to activating Terminal.app, may not focus the exact window

---

## 7. Configuration & Permissions

### Required macOS permissions

After install, grant the following:

| Setting Path | Why |
|---|---|
| Privacy & Security → **Accessibility** | Read terminal contents (for Claude Code prompt detection) |
| Privacy & Security → **Automation** → Macross → **Terminal** / **iTerm** | Bring matching terminal window to front on click |
| Privacy & Security → **Automation** → Macross → **System Events** | Window manager (WINDOWS tab) |
| Privacy & Security → **Automation** → Macross → **Reminders** | MISSION tab read/write |

If a radar overlay shows on the pet's body marked "AX OFFLINE", it means the Accessibility permission isn't granted. Fix it in System Settings, the radar disappears within 30 seconds (auto-polled).

### CONFIG tab settings

- **机体设置** (Pet Config): unit name (defaults to "VF-1S"), avatar
- **休息提醒** (Break Reminder): toggle + interval; the VF-1 will fly to screen center and remind you to take a break
- **边沿巡航** (Edge Patrol): toggle on/off; default on
- **提醒事项列表** (Reminder List): which macOS Reminders list to read (defaults to default list)
- **AI 后台** (AI Backend): pick provider
- **API Keys**: per-provider tokens
- **网页搜索** (Web Search): Metaso key for real-time queries

---

## 8. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ main.js (Node.js main process, ~3000 LOC)                │
│  • Two BrowserWindows: petWindow (180×350 transparent)   │
│    and panelWindow (380×600)                             │
│  • IPC handlers: chat, reminders, files, ax-permission,  │
│    open-external, set-edge-patrol, ...                   │
│  • LLM clients (OpenAI-compatible for all 4 providers)   │
│  • Edge patrol loop (every 1.5s, picks corners,          │
│    coordinates form changes & yaw)                       │
│  • Break reminder + flag-file watchers (Claude Code)     │
│  • powerMonitor suspend/resume hooks                     │
│  • AppleScript bridges (Reminders, terminal focus)       │
│  • Claude Code hooks auto-installer                      │
│                                                          │
│ preload.js — exposes window.petAPI via contextBridge     │
├─────────────────┬────────────────────────────────────────┤
│ pet.html        │ panel.html                             │
│ Renderer A      │ Renderer B                             │
│  Three.js scene │  HUD-themed 7-tab UI                   │
│  GLB loader     │  Chat history, MISSION list,           │
│  Mood machine   │  CONFIG forms, Workflows               │
│  Edge patrol    │  Live polling: term sessions,          │
│   visual layer  │   reminders, market data               │
│  Maneuver state │  Calls window.petAPI.* for everything  │
│  Hit-zone mouse │                                        │
│   passthrough   │                                        │
└─────────────────┴────────────────────────────────────────┘
```

### File layout

```
DesktopPet/
├── main.js              # Main process, IPC, LLM, Claude hooks, patrol logic
├── preload.js           # contextBridge exposing window.petAPI
├── pet.html             # 3D VF-1 renderer (Three.js)
├── panel.html           # Cockpit UI (HUD theme)
├── store.js             # Persistence (~/.desktop-pet/data.json)
├── scripts/
│   └── zaku-notify.sh   # Claude Code hook script (auto-installed to ~/.macross/)
├── assets/
│   ├── vf-1-strike/vf1.glb       # Main model (VF-1S Skull One)
│   ├── zaku-sd/sd_ms-06f_zaku_ii.glb  # Legacy alternate model
│   ├── GLTFLoader.js
│   └── BufferGeometryUtils.js
├── build/
│   ├── icon.icns        # Mac app icon
│   └── app_icon_src.png # Source PNG for icon
└── package.json
```

### Key technical details

- **Window transparency**: `transparent: true, frame: false` BrowserWindow with hit-zone mouse passthrough via `setIgnoreMouseEvents(true, { forward: true })` (toggled on mousemove based on whether cursor is over the model's bounding rect)
- **Form transformation**: The GLB has a single animation track `__ActionLegGERWALKgunner` whose time parameter manually drives the morph (Fighter ↔ Gerwalk ↔ Battloid)
- **Yaw control**: Inner `model.rotation.y` controls heading (90° lock during horizontal patrol via `BASE_YAW_PATROL_LEFT/RIGHT`); outer `modelGroup.rotation.x/z` handles patrol-mode banking and bob
- **Speech**: Web SpeechSynthesis API with `cancel() + resume()` workaround for Chromium's silent-pause bug after long idle
- **TTS voice**: Prefers Tingting → Yu-shu → Li-Mu → Sinji → Meijia (best Chinese voices available on macOS)

---

## 9. Building from Source

```bash
git clone <this repo>
cd DesktopPet
npm install
npm start
```

Hot reload isn't built-in. Edit code and restart.

To debug:
- The pet window has DevTools enabled — right-click the pet → Inspect Element
- Main-process logs go to the terminal where you ran `npm start`
- Renderer logs go to DevTools console

---

## 10. Packaging a DMG Installer

```bash
# Apple Silicon only
npm run build -- --mac --arm64

# Intel only
npm run build -- --mac --x64

# Both (universal package, larger)
npm run build
```

Output goes to `dist/Macross-1.0.0-<arch>.dmg`. The build is **ad-hoc signed** (no Apple Developer ID), so users will see Gatekeeper warnings on first launch — they need to right-click → Open or run `xattr -dr com.apple.quarantine`.

If you have an Apple Developer account, edit `package.json`'s `build.mac` config to add `identity` and remove `gatekeeperAssess: false`.

### Icon

The build/icon.icns is generated from `build/app_icon_src.png` (1254×1254 PNG) via `iconutil`. To replace:

```bash
SRC="build/app_icon_src.png"
ICONSET="build/icon.iconset"
mkdir -p "$ICONSET"
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_1024x1024.png"
sips -z 512  512  "$SRC" --out "$ICONSET/icon_512x512@2x.png"
sips -z 512  512  "$SRC" --out "$ICONSET/icon_512x512.png"
sips -z 512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png"
sips -z 256  256  "$SRC" --out "$ICONSET/icon_256x256.png"
sips -z 256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png"
sips -z 128  128  "$SRC" --out "$ICONSET/icon_128x128.png"
sips -z 64   64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"
sips -z 32   32   "$SRC" --out "$ICONSET/icon_32x32.png"
sips -z 32   32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"
sips -z 16   16   "$SRC" --out "$ICONSET/icon_16x16.png"
iconutil -c icns "$ICONSET" -o build/icon.icns
```

---

## 11. Data Storage

Everything is local — no telemetry, no cloud sync.

| Data | Location |
|---|---|
| Pet state (name, avatar, position, AI provider) | `~/.desktop-pet/data.json` |
| Chat history (last 40 messages) | `~/.desktop-pet/data.json` |
| API keys (Qwen, DeepSeek, Doubao, Metaso) | `~/.desktop-pet/data.json` |
| Edge-patrol & break-reminder settings | `~/.desktop-pet/data.json` |
| Reminders (MISSION tab) | macOS native Reminders.app |
| Claude Code hook script | `~/.macross/zaku-notify.sh` |
| Claude Code hook config | `~/.claude/settings.json` (auto-injected, idempotent) |

`data.json` is plain JSON. You can manually edit, back up, or delete it (deletion resets to defaults).

---

## 12. Troubleshooting

**The radar overlay won't disappear, even after granting Accessibility permission**
- macOS sometimes won't refresh the trust state for unsigned apps
- Try: `tccutil reset Accessibility com.ace.vf1desktoppet` then re-grant

**Click on VF-1 doesn't bring the terminal to front (after task complete)**
- The Automation permission for Terminal/iTerm wasn't granted
- Check `System Settings → Privacy & Security → Automation → Macross`
- Or run once manually to trigger the dialog: `osascript -l JavaScript -e 'Application("Terminal").activate()'`

**`Electron failed to install correctly` on `npm start`**
- Binary download failed. Use a mirror:
  ```bash
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  rm -rf node_modules/electron
  npm install electron --save-dev
  ```

**App icon shows the old version after upgrade**
- macOS icon cache. Reset with:
  ```bash
  sudo rm -rf /Library/Caches/com.apple.iconservices.store
  killall Dock
  killall Finder
  ```

**No voice / TTS silent**
- Chromium's SpeechSynthesis enters a silent-paused state after long idle. The current code calls `cancel() + resume()` before each `speak()` to mitigate this; if it still fails, check `Audio MIDI Setup` for the default output device

**Break reminder fires repeatedly after waking from sleep**
- Fixed in the current version. The `_systemJustResumed` flag (set in both `suspend` and `resume` events) prevents the first post-wake `setInterval` tick from triggering. If you still see this, check the console log for `[BREAK] system suspend/resume` events

---

## License

The project ships with two GLB models from external creators:
- `assets/vf-1-strike/vf1.glb` — VF-1S Skull One Valkyrie (Macross franchise)
- `assets/zaku-sd/sd_ms-06f_zaku_ii.glb` — SD Zaku II (Gundam franchise)

Both are used for personal/educational purposes. If redistributing, please respect the original creators' licenses.

The application code is provided as-is. *Macross* is a trademark of Big West / Tatsunoko Production.

---

**Roy Focker, callsign Skull One. Standing by.** 🦅
