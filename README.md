<div align="center">

# 🛸 Macross — VF-1 Valkyrie Desktop Pet

### Your Claude Code wingman: a transformable 3D **VF-1S Valkyrie** that patrols your macOS desktop, sounds the alarm the moment an agent needs your permission, and reports *"mission complete"* when it lands.

[![Platform](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](https://github.com/One-DayWorld/VF-1-DesktopPet)
[![Electron](https://img.shields.io/badge/Electron-28-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Three.js](https://img.shields.io/badge/Three.js-r158-000000?logo=three.js&logoColor=white)](https://threejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-integrated-D97757)](https://claude.com/claude-code)
[![Stars](https://img.shields.io/github/stars/One-DayWorld/VF-1-DesktopPet?style=social)](https://github.com/One-DayWorld/VF-1-DesktopPet/stargazers)

**English** · [简体中文](./README.zh-CN.md)

![VF-1S Valkyrie — 360° showcase with live Fighter ↔ Battloid transformation](docs/demo.gif)

</div>

---

## ✨ Why you'll want this

- 🤖 **Claude Code radar** — the VF-1 watches your terminal. When Claude Code is waiting on a permission prompt, it flashes gold, pulses a target-lock HUD, and calls out over TTS. When your agent finishes, it announces *"mission complete."* No more babysitting a terminal in another window.
- 🛸 **A real transformable mecha, not a sprite** — full **Fighter ↔ Gerwalk ↔ Battloid** morphing rendered live in Three.js. It cruises the edges of your screen, banks into turns, barrel-rolls, and hovers on glowing thrusters.
- 🎛️ **A cockpit, not a tooltip** — click the model and a HUD-styled control panel slides out: LLM chat, market data, macOS Reminders, terminal session monitor, window switcher, and reusable AI workflows.
- 🧠 **Bring your own brain** — the pet is just the body. Plug in **Qwen, DeepSeek, OpenAI, or Anthropic** as the intelligence, plus optional live web search.
- 🔒 **100% local** — no telemetry, no cloud sync. Keys and state live in a `0600` file in your home directory.

> The pet itself is not the AI — it's a **frontend container**. The intelligence comes from whichever LLM you bind in `CONFIG`.

---

## 🚀 Quick Start

### Option A — Install the prebuilt DMG (end users)

1. Download `Macross-1.0.0-arm64.dmg` (Apple Silicon) from the [Releases](https://github.com/One-DayWorld/VF-1-DesktopPet/releases) page.
2. Drag the app into `Applications`.
3. First launch is unsigned, so macOS Gatekeeper will block it. **Right-click → Open → confirm**, or run:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Macross.app
   ```
4. Grant **System Settings → Privacy & Security → Accessibility** to Macross (needed to read terminal contents).
5. Open the panel via `CONFIG` and add at least one LLM API key.

### Option B — Run from source (developers)

Requires **Node.js 18+**. On Apple Silicon, also `xcode-select --install`.

```bash
git clone https://github.com/One-DayWorld/VF-1-DesktopPet.git
cd VF-1-DesktopPet
npm install          # ~300 MB, mostly Electron + Three.js
npm start
```

<details>
<summary><code>Electron failed to install correctly</code>? (common in CN networks)</summary>

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
rm -rf node_modules/electron
npm install electron --save-dev
npm start
```
</details>

---

## 🤖 The killer feature: Claude Code integration

The VF-1 physically alerts you to what's happening in your Claude Code sessions — visually and by voice — so you can let agents run without staring at a terminal.

```
Claude Code asks for permission
        ↓
~/.claude/settings.json hook fires  vf1-notify.sh
        ↓
vf1-notify.sh writes a flag file (with the tty path)
        ↓
Macross polls every 800ms → gold eyes + target-lock HUD + voice loop
        ↓
You click the VF-1 → it brings the matching terminal window to the front
        ↓
Claude finishes → Stop hook fires → VF-1 announces "mission complete"
```

**Zero manual setup.** On every launch, Macross idempotently installs its hook script to `~/.macross/` and wires the `PermissionRequest` / `PostToolUse` / `PermissionDenied` / `Stop` hooks into `~/.claude/settings.json`. Internal tools (`TaskCreate`, `LSP`, …) and `bypassPermissions` mode are whitelisted so you only get alerted when it actually matters.

**Terminals:** Terminal.app & iTerm2 (full support); WezTerm / Warp / Alacritty / Hyper fall back to focusing Terminal.app.

---

## 🛸 What the pet does

<details open>
<summary><b>Edge patrol</b> (on by default)</summary>

When idle, the VF-1 cruises your four screen corners:
- **Horizontal edges** → transforms to **Fighter**, locks its nose to the flight direction, wings wagging in the airflow.
- **Vertical edges** → transforms to **Gerwalk**, hovers facing you on blue-white foot thrusters.
- **Random maneuvers** every ~22s: barrel-roll, wing-dip salute, tail-wag, thrust hop, look-around scan, lateral shimmy.
- Self-cancels the instant you drag it or an alert fires, then resumes from where it left off.
</details>

<details>
<summary><b>Reactive states</b></summary>

| Trigger | Behavior |
|---|---|
| Claude Code permission prompt | Eyes flash gold, target-lock HUD, voice every 30s |
| Claude Code task done | Voice announce + persistent bubble until clicked |
| Click while task-done active | Brings the matching terminal window to front |
| Break-reminder timer | Flies to screen center, speaks the reminder, returns home |
| Lid close / system sleep | Timers pause; counters reset on wake to avoid burst-firing |
</details>

Click only registers on the model itself — transparent areas pass clicks through to whatever's behind.

---

## 🎛️ Cockpit panel

Click the VF-1 to open a HUD-styled, 7-tab control panel:

| Tab | Purpose |
|---|---|
| **CHAT** | LLM chat with quick-actions (weather, calendar, news, sports) + one-click launchers |
| **WORKFLOW** | Save & one-click-run reusable AI prompts |
| **YES BOT** | Live monitor of which terminal session is awaiting a Claude Code permission |
| **WINDOWS** | List running apps/windows, click to focus |
| **MRKT** | Real-time market data (indices, forex) |
| **MISSION** | Two-column to-do manager, synced with macOS Reminders |
| **CONFIG** | Pet name/avatar, break reminder, edge-patrol toggle + reset, AI provider, API keys |

---

## 🧠 AI providers

Four backends behind one OpenAI-compatible interface — configure under `CONFIG → AI 后台`:

| Provider | Default model | Endpoint | Get a key |
|---|---|---|---|
| **Qwen** (千问) | `qwen-plus` | DashScope (Alibaba Cloud) | [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com) |
| **DeepSeek** | `deepseek-chat` | api.deepseek.com | [platform.deepseek.com](https://platform.deepseek.com) |
| **OpenAI** | `gpt-4o` | api.openai.com | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-opus-4-8` | api.anthropic.com | [console.anthropic.com](https://console.anthropic.com/settings/keys) |

> Optional: add a [Metaso](https://metaso.cn) key under `CONFIG → 网页搜索` to let the AI search the live web for scores, news, and prices.

---

## 🏗️ Architecture

Electron main process (`main.js`) drives two `BrowserWindow`s — a transparent **pet window** (Three.js) and a **cockpit panel** — bridged to the renderers through a locked-down `contextBridge` (`preload.js`).

```
main.js ── IPC ──┬── pet.html      (Three.js VF-1: GLB loader, morph, patrol, maneuvers)
   │             └── panel.html    (HUD 7-tab UI: chat, mission, config, live polling)
   ├── LLM clients (Qwen / DeepSeek / OpenAI / Anthropic)
   ├── Edge-patrol loop + break reminders
   ├── Claude Code flag-file watchers + hook auto-installer
   └── AppleScript bridges (Reminders, terminal focus, window manager)
```

Notable bits: window transparency with hit-zone mouse pass-through; a single GLB animation track manually time-driven for the full morph; SpeechSynthesis with a `cancel()+resume()` workaround for Chromium's silent-pause bug. Full deep-dive in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) <!-- (optional: move the long technical section here) -->.

---

## 🛠️ Build a DMG

```bash
npm run build -- --mac --arm64   # Apple Silicon
npm run build -- --mac --x64     # Intel
npm run build                    # both
```

Output: `dist/Macross-1.0.0-<arch>.dmg` (ad-hoc signed → Gatekeeper warning on first launch). With an Apple Developer ID, add `identity` to `package.json`'s `build.mac` and drop `gatekeeperAssess: false`.

---

## 📦 Data & privacy

Everything is local — no telemetry, no cloud.

| Data | Location |
|---|---|
| Pet state, chat history, API keys, settings | `~/.desktop-pet/data.json` (`0600`) |
| To-dos | macOS native Reminders.app |
| Claude Code hook script + flags | `~/.macross/` (`0700`) |
| Claude Code hook config | `~/.claude/settings.json` (auto-injected, idempotent) |

---

## ❓ Troubleshooting

<details>
<summary>Radar overlay ("AX OFFLINE") won't clear after granting Accessibility</summary>

```bash
tccutil reset Accessibility com.ace.vf1desktoppet
```
…then re-grant. macOS sometimes won't refresh trust state for unsigned apps.
</details>

<details>
<summary>Clicking the VF-1 doesn't focus the terminal after a task completes</summary>

Grant **System Settings → Privacy & Security → Automation → Macross → Terminal/iTerm**, or trigger the dialog once:
```bash
osascript -l JavaScript -e 'Application("Terminal").activate()'
```
</details>

<details>
<summary>No voice / TTS silent</summary>

Chromium's SpeechSynthesis can enter a silent-paused state after long idle; the code calls `cancel()+resume()` before each `speak()` to mitigate. If it persists, check your default output device in Audio MIDI Setup.
</details>

---

## 📜 License & assets

The **application code** is released under the [MIT License](./LICENSE). <!-- ⚠️ add a LICENSE file (see suggestions) -->

The bundled 3D models are **third-party fan-made assets** from the *Macross / Robotech* and *Gundam* franchises, included for personal/educational use only. **They are not covered by this repo's license** — if you redistribute, verify the original creators' terms first. *Macross* is a trademark of Big West / Tatsunoko Production.

---

<div align="center">

If this made you smile, **drop a ⭐ — it helps other pilots find their wingman.**

**Roy Focker, callsign Skull One. Standing by.** 🦅

</div>
