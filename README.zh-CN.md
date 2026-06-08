<div align="center">

# 🛸 Macross — VF-1 瓦尔基里桌面机体

### 你的 Claude Code 僚机:一架会变形的 3D **VF-1S 瓦尔基里**,在你的 macOS 桌面边沿巡航——当 AI 智能体等你授权时拉响警报,任务完成时报告"已着陆"。

[![Platform](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](https://github.com/One-DayWorld/VF-1-DesktopPet)
[![Electron](https://img.shields.io/badge/Electron-28-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Three.js](https://img.shields.io/badge/Three.js-r158-000000?logo=three.js&logoColor=white)](https://threejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-已集成-D97757)](https://claude.com/claude-code)
[![Stars](https://img.shields.io/github/stars/One-DayWorld/VF-1-DesktopPet?style=social)](https://github.com/One-DayWorld/VF-1-DesktopPet/stargazers)

[English](./README.md) · **简体中文**

![VF-1S 瓦尔基里 —— 360° 展示 + Fighter ↔ Battloid 实时变形](docs/demo.gif)

</div>

---

## ✨ 它能做什么

- 🤖 **Claude Code 雷达** —— VF-1 盯着你的终端。Claude Code 卡在授权确认时,机体闪金光、目标锁定 HUD 脉冲、语音呼叫;智能体跑完时,它播报"任务已完成"。再也不用守着另一个窗口里的终端。
- 🛸 **真正会变形的机体,不是贴图** —— Three.js 实时渲染的完整 **Fighter ↔ Gerwalk ↔ Battloid** 三形态变形。它沿屏幕边沿巡航、入弯压坡度、横滚、悬停喷焰。
- 🎛️ **是座舱,不是气泡提示** —— 单击机体,滑出 HUD 风格控制面板:大模型对话、行情、macOS 提醒事项、终端会话监控、窗口切换、可复用的 AI 工作流。
- 🧠 **自带大脑** —— 机体只是躯壳,智能来自你接入的 **千问 / DeepSeek / OpenAI / Anthropic**,还可选联网搜索。
- 🔒 **完全本地** —— 无遥测、无云同步。密钥与状态存在家目录下权限 `0600` 的文件里。

> 机体本身不是 AI,它是一个**前端容器**。智能来自你在 `CONFIG` 里绑定的大模型。

---

## 🚀 快速开始

### 方式 A —— 安装预编译 DMG(普通用户)

1. 从 [Releases](https://github.com/One-DayWorld/VF-1-DesktopPet/releases) 下载 `Macross-1.0.0-arm64.dmg`(Apple Silicon)。
2. 拖进 `应用程序`。
3. 首次启动未签名,会被 Gatekeeper 拦截。**右键 → 打开 → 确认**,或执行:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Macross.app
   ```
4. 到 **系统设置 → 隐私与安全性 → 辅助功能** 给 Macross 授权(读取终端内容需要)。
5. 打开 `CONFIG` 面板,至少填一个大模型 API Key。

### 方式 B —— 源码运行(开发者)

需要 **Node.js 18+**;Apple Silicon 还需 `xcode-select --install`。

```bash
git clone https://github.com/One-DayWorld/VF-1-DesktopPet.git
cd VF-1-DesktopPet
npm install          # 约 300 MB, 主要是 Electron + Three.js
npm start
```

<details>
<summary>报 <code>Electron failed to install correctly</code>?(国内网络常见)</summary>

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
rm -rf node_modules/electron
npm install electron --save-dev
npm start
```
</details>

---

## 🤖 核心卖点:Claude Code 联动

VF-1 用视觉 + 语音把 Claude Code 会话里发生的事"砸"到你眼前,让你放手跑智能体而不必盯着终端。

```
Claude Code 请求授权
        ↓
~/.claude/settings.json 的 hook 触发  vf1-notify.sh
        ↓
vf1-notify.sh 写入 flag 文件(含 tty 路径)
        ↓
Macross 每 800ms 轮询 → 金色眼睛 + 目标锁定 HUD + 循环语音
        ↓
你单击 VF-1 → 它把对应的终端窗口切到最前
        ↓
Claude 完成 → Stop hook 触发 → VF-1 播报"任务已完成"
```

**零手动配置。** 每次启动,Macross 幂等地把 hook 脚本装到 `~/.macross/`,并把 `PermissionRequest` / `PostToolUse` / `PermissionDenied` / `Stop` 四个 hook 写进 `~/.claude/settings.json`。内部工具(`TaskCreate`、`LSP` 等)和 `bypassPermissions` 模式已加白名单,只在真正需要时才告警。

**终端支持:** Terminal.app 与 iTerm2(完整支持);WezTerm / Warp / Alacritty / Hyper 回退到激活 Terminal.app。

---

## 🛸 机体行为

<details open>
<summary><b>边沿巡航</b>(默认开启)</summary>

待机时,VF-1 沿屏幕四角巡航:
- **横边** → 变 **Fighter**,机头锁定航向,机翼随气流轻摆。
- **竖边** → 变 **Gerwalk**,面向你、靠蓝白脚部喷口悬停。
- **随机机动**(约每 22 秒):横滚、压翼致敬、摆尾、推力上跳、左右扫视、横向位移。
- 你一拖动 / 一有告警就立刻让位,之后从中断处续飞。
</details>

<details>
<summary><b>反应状态</b></summary>

| 触发 | 行为 |
|---|---|
| Claude Code 授权确认 | 眼睛闪金光、目标锁定 HUD、每 30 秒语音 |
| Claude Code 任务完成 | 语音播报 + 常驻气泡直到单击 |
| 任务完成态下单击 | 把对应终端窗口切到最前 |
| 休息提醒定时 | 飞到屏幕中央播报,再飞回原位 |
| 合盖 / 系统休眠 | 定时器暂停;唤醒后计数器重置,避免补发一堆提醒 |
</details>

单击只在机体上生效,透明区域的点击会穿透到后面的窗口。

---

## 🎛️ 座舱面板

单击 VF-1 打开 HUD 风格的 7 标签控制面板:

| 标签 | 用途 |
|---|---|
| **CHAT** | 大模型对话 + 快捷动作(天气/日历/新闻/赛事)+ 一键启动器 |
| **WORKFLOW** | 保存并一键运行可复用 AI 提示词 |
| **YES BOT** | 实时监控哪个终端会话在等 Claude Code 授权 |
| **WINDOWS** | 列出运行中的应用/窗口,单击切到最前 |
| **MRKT** | 实时行情(指数、外汇) |
| **MISSION** | 双栏待办,与 macOS 提醒事项双向同步 |
| **CONFIG** | 机体名/头像、休息提醒、边沿巡航开关 + 复位、大模型后台、API Key |

---

## 🧠 大模型后台

四种后台,统一走 OpenAI 兼容接口,在 `CONFIG → AI 后台` 配置:

| 后台 | 默认模型 | 端点 | 获取 Key |
|---|---|---|---|
| **千问** | `qwen-plus` | DashScope(阿里云) | [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com) |
| **DeepSeek** | `deepseek-chat` | api.deepseek.com | [platform.deepseek.com](https://platform.deepseek.com) |
| **OpenAI** | `gpt-4o` | api.openai.com | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-opus-4-8` | api.anthropic.com | [console.anthropic.com](https://console.anthropic.com/settings/keys) |

> 可选:在 `CONFIG → 网页搜索` 填 [Metaso](https://metaso.cn) Key,让 AI 能联网查赛果、新闻、股价。

---

## 🏗️ 架构

Electron 主进程(`main.js`)驱动两个 `BrowserWindow` —— 透明的**机体窗口**(Three.js)和**座舱面板**,通过收紧权限的 `contextBridge`(`preload.js`)与渲染层通信。

```
main.js ── IPC ──┬── pet.html      (Three.js VF-1: GLB 加载、变形、巡航、机动)
   │             └── panel.html    (HUD 7 标签 UI: 对话、任务、配置、实时轮询)
   ├── 大模型客户端(千问 / DeepSeek / OpenAI / Anthropic)
   ├── 边沿巡航循环 + 休息提醒
   ├── Claude Code flag 文件监视 + hook 自动安装
   └── AppleScript 桥(提醒事项、终端聚焦、窗口管理)
```

技术看点:透明窗口 + 命中区鼠标穿透;单条 GLB 动画轨道按时间手动驱动完成三形态变形;SpeechSynthesis 用 `cancel()+resume()` 绕过 Chromium 长时空闲后静音的 bug。

---

## 🛠️ 打包 DMG

```bash
npm run build -- --mac --arm64   # Apple Silicon
npm run build -- --mac --x64     # Intel
npm run build                    # 两者
```

产物:`dist/Macross-1.0.0-<arch>.dmg`(ad-hoc 签名,首次启动有 Gatekeeper 提示)。有 Apple 开发者 ID 的话,在 `package.json` 的 `build.mac` 加 `identity`、去掉 `gatekeeperAssess: false`。

---

## 📦 数据与隐私

全部本地 —— 无遥测、无云同步。

| 数据 | 位置 |
|---|---|
| 机体状态、对话历史、API Key、设置 | `~/.desktop-pet/data.json`(`0600`) |
| 待办 | macOS 原生提醒事项 |
| Claude Code hook 脚本 + flag | `~/.macross/`(`0700`) |
| Claude Code hook 配置 | `~/.claude/settings.json`(幂等自动注入) |

---

## 📜 许可证与素材

**应用代码**以 [MIT 许可证](./LICENSE) 发布。<!-- ⚠️ 记得加 LICENSE 文件 -->

内置 3D 模型为 *Macross / Robotech*、*高达* 系列的**第三方同人素材**,仅供个人/学习使用,**不在本仓库许可证覆盖范围内**;如需再分发请先确认原作者条款。*Macross* 是 Big West / 龙之子的商标。

---

<div align="center">

如果它让你会心一笑,**点个 ⭐ 吧 —— 能帮更多飞行员找到自己的僚机。**

**Roy Focker,呼号 Skull One。待命中。** 🦅

</div>
