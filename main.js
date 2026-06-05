const { app, BrowserWindow, ipcMain, screen, shell, session: electronSession, systemPreferences, net, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const store = require('./store');

let petWindow = null;
let panelWindow = null;
let state = store.load();
const notifiedReminders = new Set();

function createPetWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  console.log('[PET STARTUP] workArea:', width, 'x', height, 'saved pos:', state.petPosition);
  // 位置迁移 V5: 强制重置到屏幕右下贴 dock (V4 之后用户拖过, 这次再强制一次)
  if (!state._posMigratedV5) {
    state.petPosition = {
      x: Math.round(width - 200),
      y: Math.round(height - 400)
    };
    state._posMigratedV5 = true;
    store.save(state);
    console.log('[PET] >>> V5 RESET APPLIED, new pos:', state.petPosition);
  }
  const pos = state.petPosition;

  petWindow = new BrowserWindow({
    width: 180,
    height: 350,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  petWindow.loadFile('pet.html');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  // 双保险: BrowserWindow 创建时的 x/y 在某些 macOS 配置下不可靠 (workspace 切换/HiDPI 等),
  // 加载完成后再 setPosition 一次, 强制把窗口固定到目标位置.
  petWindow.once('ready-to-show', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setPosition(pos.x, pos.y);
      console.log('[PET] forced setPosition →', pos.x, pos.y, 'actual bounds:', petWindow.getBounds());
    }
  });
  setTimeout(() => {
    if (petWindow && !petWindow.isDestroyed()) {
      console.log('[PET] bounds after 1s:', petWindow.getBounds());
    }
  }, 1000);
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: 760,
    height: 580,
    x: 0,
    y: 0,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关键: panel 启动即隐藏, Chromium 默认会节流并最终冻结隐藏渲染进程的
      // setInterval, 导致 termPoll 几乎不运行 → 终端告警永远到不了 pet.
      // 关掉 throttling 让后台轮询稳定执行.
      backgroundThrottling: false
    }
  });

  // 注: 不调 setVisibleOnAllWorkspaces, 它跟 transparent:true 配合在某些 macOS 上会
  // 让 show() 静默失败 (window 标记 visible 但未实际渲染). pet 那边能用是因为它从不 hide,
  // 而 panel 有 hide/show 切换, 状态机更脆弱.
  panelWindow.loadFile('panel.html');
}

async function checkReminderAlerts() {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    const listTarget = reminderListTarget(state);
    const script = `tell application "Reminders"
  set output to ""
  set theList to ${listTarget}
  repeat with r in (reminders in theList)
    if completed of r is false then
      try
        set d to due date of r
        if d is not missing value then
          set rId to id of r
          set rName to name of r
          set y to (year of d) as string
          set mo to ((month of d) as integer) as string
          if (length of mo) = 1 then set mo to "0" & mo
          set dy to (day of d) as string
          if (length of dy) = 1 then set dy to "0" & dy
          set hr to (hours of d) as string
          if (length of hr) = 1 then set hr to "0" & hr
          set mn to (minutes of d) as string
          if (length of mn) = 1 then set mn to "0" & mn
          set rDue to y & "-" & mo & "-" & dy & "T" & hr & ":" & mn & ":00"
          set output to output & rId & "|||" & rName & "|||" & rDue & "\\n"
        end if
      end try
    end if
  end repeat
  return output
end tell`;
    const raw = await runAppleScript(script);
    const now = Date.now();
    const thirtyMin = 30 * 60 * 1000;
    const twoHours = 2 * 60 * 60 * 1000;

    for (const line of raw.split('\n')) {
      if (!line.includes('|||')) continue;
      const parts = line.split('|||');
      const id = parts[0], name = parts[1], dueStr = parts[2];
      if (!dueStr) continue;
      const due = new Date(dueStr).getTime();
      if (isNaN(due)) continue;

      const diff = due - now;
      let alertMsg = null;

      if (diff > 0 && diff <= thirtyMin) {
        const mins = Math.ceil(diff / 60000);
        alertMsg = `⏰ "${name}" 还有${mins}分钟到期！`;
      } else if (diff < 0 && diff >= -twoHours) {
        alertMsg = `⚠️ "${name}" 已逾期，快去处理！`;
      }

      if (!alertMsg) continue;

      const alertWindow = diff > 0 ? thirtyMin : twoHours;
      const dedupKey = `${id}-${Math.floor(due / alertWindow)}`;
      if (notifiedReminders.has(dedupKey)) continue;
      notifiedReminders.add(dedupKey);

      petWindow.webContents.send('pet-update', { reminderAlert: alertMsg, pet: state.pet });
    }
  } catch (_) {}
}

// ── Claude Code 权限等待检测（通过 hook 写入的 flag 文件）────────────────
// hook 命令用绝对路径 /tmp/zaku_claude_pending, 这里也必须硬编码同一路径
const CLAUDE_PENDING_FLAG = '/tmp/zaku_claude_pending';

// ── 任务完成语音播报 ──────────────────────────────────────────────────────
// 注意: 必须用绝对路径 /tmp, 不能用 os.tmpdir() ── Claude Code 进程会设置
// TMPDIR=/tmp/claude-XXX, 但 Stop hook 写文件时用的是绝对路径 /tmp/zaku_task_done.
const ZAKU_DONE_FLAG = '/tmp/zaku_task_done';

// ── 休息提醒 ─────────────────────────────────────────────────────────────
// 飞到屏幕中央 → 语音提示 → 4 秒后飞回原位
const BREAK_MESSAGES = [
  '已经持续作战一段时间了，请站起来活动下身体',
  '建议起身走动两分钟，缓解疲劳',
  '驾驶员保持健康才是联合宇宙军最大的战力，请离开座位休息一下',
  '骷髅一号监测到驾驶员长时间未动，请起身做做拉伸',
  '驾驶员辛苦了，离开屏幕休息几分钟吧',
];
let _lastBreakAt = Date.now();   // 上次提醒时间; app 启动后从现在开始计时
let _breakInProgress = false;     // 防止动画期间重复触发
let _speechEnded = false;         // 渲染进程通知"当前语音已念完"
let _systemJustResumed = false;   // 唤醒后的保护标志 — 防止 setInterval 在 resume 事件前抢先触发

async function checkBreakReminder() {
  if (_breakInProgress) return;
  // 系统刚唤醒: setInterval 可能比 powerMonitor.resume 先跑.
  // 此时 _lastBreakAt 还是睡眠前的时间, 差值可能是几小时, 会误触发.
  // 检测到 _systemJustResumed 就重置计时基准并跳过本次检查.
  if (_systemJustResumed) {
    _systemJustResumed = false;
    _lastBreakAt = Date.now();
    return;
  }
  const cfg = state.breakReminder || { enabled: false, intervalMin: 60 };
  if (!cfg.enabled) return;
  const intervalMs = Math.max(1, Number(cfg.intervalMin) || 60) * 60 * 1000;
  if (Date.now() - _lastBreakAt < intervalMs) return;

  _lastBreakAt = Date.now();
  _breakInProgress = true;
  try {
    await runBreakAnimation();
  } finally {
    _breakInProgress = false;
  }
}

// 完整 8 步变形 + 飞行 + 提醒序列:
//   原位 Gerwalk → 变 Fighter → 飞中央 → 变 Gerwalk → 播报 → 变 Fighter → 飞回 → 变 Gerwalk
async function runBreakAnimation() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(petWindow.getBounds());
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  const PW = 180, PH = 350;
  const startBounds = petWindow.getBounds();
  const targetX = Math.round(sx + (sw - PW) / 2);
  const targetY = Math.round(sy + (sh - PH) / 2);
  const startX = startBounds.x;
  const startY = startBounds.y;

  const msg = BREAK_MESSAGES[Math.floor(Math.random() * BREAK_MESSAGES.length)];
  const send = (data) => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', data);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 默认速度 0.32, 中央段较慢但比之前(5.1s)快 1 秒, 现在 ~4.0s
  const NORMAL_SPEED  = 0.32;
  const DRAMATIC_SPEED = 0.2;     // 0.8 距离 / 0.2 = 4.0s
  // Fighter 端 = 0.2 (跳过起落架/舱盖开合段); Gerwalk = 0.7 (完全 Gerwalk)
  const PARTIAL_MORPH_MS = 1700;  // Gerwalk(0.7) ↔ Fighter(0.2) @0.32 = 1.56s + 140ms 余量
  const DRAMATIC_MORPH_MS = 4100; // Fighter(0.2) ↔ Battloid(1.0) @0.2 = 4.0s + 100ms 余量

  // 飞行方向(X 分量) → 决定机头朝向
  const dxOut = targetX - startX;
  const yawFlyOut  = dxOut > 0 ? 'right' : 'left';   // 飞向中央时机头朝飞行方向
  const yawFlyBack = dxOut > 0 ? 'left'  : 'right';  // 飞回时反向

  // 1. 原位: 调机头朝飞行方向 + 变形成 Fighter
  send({ bodyYaw: yawFlyOut, transformTo: 'fighter' });
  await sleep(PARTIAL_MORPH_MS);

  // 2. 飞向屏幕中央 (0.8s)
  send({ breakMode: true });
  await tweenWindow(startX, startY, targetX, targetY, 800);

  // 3. 中央: 切到慢速度 + 正对镜头 + 同时开始变形 Battloid 和语音播报
  _speechEnded = false;
  send({ morphSpeed: DRAMATIC_SPEED, bodyYaw: 'face', transformTo: 'battloid', speakText: msg });

  // 4. 等变形完成 → 然后开火 → 等语音完成 → 关火
  await sleep(DRAMATIC_MORPH_MS);
  send({ firing: true });   // Battloid 完成站位, 开始双枪开火
  const SPEECH_MAX_WAIT_MS = 12000;
  const t0 = Date.now();
  while (!_speechEnded && (Date.now() - t0) < SPEECH_MAX_WAIT_MS) {
    await sleep(150);
  }
  send({ firing: false });  // 语音完了, 停火

  // 5. 中央: Battloid → Fighter, 同时机头转向飞回方向 + 退出醒目模式 (仍用慢速)
  send({ transformTo: 'fighter', bodyYaw: yawFlyBack, breakMode: false });
  await sleep(DRAMATIC_MORPH_MS);

  // 6. 飞回原位 (0.8s)
  await tweenWindow(targetX, targetY, startX, startY, 800);
  state.petPosition = { x: startX, y: startY };
  store.save(state);

  // 7. 原位: 切回正常速度 + Fighter → Gerwalk + 机头回到待命角
  send({ morphSpeed: NORMAL_SPEED, transformTo: 'gerwalk', bodyYaw: 'left' });
  await sleep(PARTIAL_MORPH_MS);
}

function tweenWindow(x0, y0, x1, y1, durationMs) {
  return new Promise(resolve => {
    if (!petWindow || petWindow.isDestroyed()) return resolve();
    const t0 = Date.now();
    const step = () => {
      if (!petWindow || petWindow.isDestroyed()) return resolve();
      const k = Math.min(1, (Date.now() - t0) / durationMs);
      // ease-out cubic
      const e = 1 - Math.pow(1 - k, 3);
      const x = Math.round(x0 + (x1 - x0) * e);
      const y = Math.round(y0 + (y1 - y0) * e);
      petWindow.setPosition(x, y);
      if (k < 1) setTimeout(step, 16);
      else resolve();
    };
    step();
  });
}

// ── 边沿巡航 ──────────────────────────────────────────────────────────────
// 待机时让 VF-1 沿屏幕四角顺时针缓慢飞行:
//   横边 (TL→TR, BR→BL): Fighter 形态 + yaw 对齐航向 → 机头精准朝飞行方向
//   纵边 (TR→BR, BL→TL): Gerwalk 形态 + yaw=face   → 悬停姿态, 不需要 pitch 也合理
// 干扰让位: 休息提醒 / 终端告警 / 任务完成 / 用户拖动 / 配置关闭 → 立刻让出当前 leg
// 角落到屏幕边的内缩, 横纵分开:
//   X (左右) = 12px → 不让飞机太贴左/右屏幕边
//   Y (顶底) = 0    → 顶/底飞行紧贴菜单栏 / dock (用户偏好)
const PATROL_PAD_X = 12;
const PATROL_PAD_Y = 0;
const PATROL_LEG_MS        = 28000;  // 单条边的飞行时间 (~30s)
const PATROL_DWELL_MS      = 700;    // 角落停顿 (从 2s 再缩到 0.7s, 几乎无停留, 立刻进入变形+下条 leg)
const PATROL_USER_GRACE_MS = 6000;   // 用户拖完后多久不打扰
const PATROL_FORM_SETTLE_MS = 1200;  // 形态切换后等多少毫秒再起飞 (从 1.8s 降到 1.2s)
const PATROL_REPOS_MS      = 2200;   // 初次/恢复时, 飞到最近角的过渡时间

let _patrolInProgress = false;
let _patrolIndex      = -1;          // 当前角索引: 0=TL, 1=TR, 2=BR, 3=BL; -1 = 待重新对齐
let _patrolCW         = true;        // 当前飞行方向: true=顺时针, 每段 leg 后有概率反向
let _lastUserMoveAt   = 0;
const PATROL_REVERSE_PROB = 0.30;    // 每条 leg 完成后 30% 概率反向 (避免来回拉锯, 70% 维持当前方向)

function _patrolEnabled()  { return !!(state.edgePatrol && state.edgePatrol.enabled); }

function _canPatrolNow() {
  if (!_patrolEnabled()) return false;
  if (_breakInProgress) return false;
  if (_claudeFlagActive) return false;
  if (_taskDoneSession) return false;
  if (Date.now() - _lastUserMoveAt < PATROL_USER_GRACE_MS) return false;
  if (!petWindow || petWindow.isDestroyed()) return false;
  return true;
}

function _patrolCorners() {
  const display = screen.getDisplayMatching(petWindow.getBounds());
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  const PW = 180, PH = 350;
  return [
    { x: sx + PATROL_PAD_X,           y: sy + PATROL_PAD_Y },                  // 0 TL
    { x: sx + sw - PW - PATROL_PAD_X, y: sy + PATROL_PAD_Y },                  // 1 TR
    { x: sx + sw - PW - PATROL_PAD_X, y: sy + sh - PH - PATROL_PAD_Y },        // 2 BR
    { x: sx + PATROL_PAD_X,           y: sy + sh - PH - PATROL_PAD_Y }         // 3 BL
  ];
}

function _findNearestCornerIdx(cx, cy, corners) {
  let best = 0, minD = Infinity;
  for (let i = 0; i < 4; i++) {
    const dx = corners[i].x - cx, dy = corners[i].y - cy;
    const d = dx*dx + dy*dy;
    if (d < minD) { minD = d; best = i; }
  }
  return best;
}

// 线性匀速 + 中途可中断 (cancel 检测每帧执行一次, 用户拖动/告警等会让 leg 提前结束)
function tweenWindowCancellable(x0, y0, x1, y1, durationMs, shouldCancel) {
  return new Promise(resolve => {
    if (!petWindow || petWindow.isDestroyed()) return resolve('destroyed');
    const t0 = Date.now();
    const step = () => {
      if (!petWindow || petWindow.isDestroyed()) return resolve('destroyed');
      if (shouldCancel && shouldCancel()) return resolve('cancelled');
      const k = Math.min(1, (Date.now() - t0) / durationMs);
      const x = Math.round(x0 + (x1 - x0) * k);
      const y = Math.round(y0 + (y1 - y0) * k);
      petWindow.setPosition(x, y);
      if (k < 1) setTimeout(step, 16);
      else resolve('done');
    };
    step();
  });
}

async function _patrolStep() {
  const send = (data) => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', data);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const corners = _patrolCorners();

  // _patrolIndex < 0 才需要"重新对齐到最近角" (启动后首次/用户拖动后).
  // 其它打断 (任务完成/告警) 不会 reset _patrolIndex, 直接从当前位置接着飞向下一角.
  const curInit = petWindow.getBounds();
  if (_patrolIndex < 0) {
    _patrolIndex = _findNearestCornerIdx(curInit.x, curInit.y, corners);
    send({ transformTo: 'gerwalk', bodyYaw: 'face', patrolMode: 'vertical' });
    await sleep(PATROL_FORM_SETTLE_MS);
    if (!_canPatrolNow()) { send({ patrolMode: false }); return; }
    const target = corners[_patrolIndex];
    const r = await tweenWindowCancellable(curInit.x, curInit.y, target.x, target.y, PATROL_REPOS_MS, () => !_canPatrolNow());
    send({ patrolMode: false });
    if (r !== 'done') return;
  }

  // 飞向下一角. 方向由 _patrolCW 决定 (TL→TR→BR→BL = CW, 反过来 = CCW).
  // 每条 leg 之后有概率翻转, 让飞行轨迹不固定; 大多数时候保持当前方向, 少数时候掉头.
  const fromIdx = _patrolIndex;
  const toIdx   = _patrolCW ? (fromIdx + 1) % 4 : (fromIdx + 3) % 4;
  const refFrom = corners[fromIdx];
  const to      = corners[toIdx];
  // 用"标准航向"(refFrom→to) 决定形态/yaw, 保证半路恢复时形态和方向不会乱
  const refDx = to.x - refFrom.x;
  const refDy = to.y - refFrom.y;
  const horizontal = Math.abs(refDx) > Math.abs(refDy);

  let form, yaw, patrolMode;
  if (horizontal) {
    form = 'fighter';
    // 巡航专用 90° 侧身, 机头完全朝飞行方向 (区别于待命/休息提醒的 15° 偏转)
    yaw  = refDx > 0 ? 'patrol-right' : 'patrol-left';
    patrolMode = 'horizontal';
  } else {
    form = 'gerwalk';
    yaw  = 'face';
    patrolMode = 'vertical';
  }

  send({ transformTo: form, bodyYaw: yaw, patrolMode });
  await sleep(PATROL_FORM_SETTLE_MS);
  if (!_canPatrolNow()) { send({ patrolMode: false }); return; }

  // 起点 = 当前位置 (不再 snap 回 refFrom). 时间按剩余距离比例缩放.
  // 这样从任意中间点恢复都不会"先飞回去再前进"
  const cur = petWindow.getBounds();
  const fullDist = Math.hypot(refDx, refDy) || 1;
  const remDist  = Math.hypot(to.x - cur.x, to.y - cur.y);
  const ratio    = Math.max(0.05, Math.min(1, remDist / fullDist));
  const duration = Math.max(2000, Math.round(PATROL_LEG_MS * ratio));

  const result = await tweenWindowCancellable(cur.x, cur.y, to.x, to.y, duration, () => !_canPatrolNow());
  send({ patrolMode: false });
  if (result !== 'done') return;

  _patrolIndex = toIdx;
  // 每段 leg 完成后掷骰子, 一定概率反转方向 → 下一段会掉头, 否则继续同向
  if (Math.random() < PATROL_REVERSE_PROB) _patrolCW = !_patrolCW;
  await sleep(PATROL_DWELL_MS);
}

async function startEdgePatrolLoop() {
  // 启动后等 8s, 让 init/欢迎播报先走完, 不抢戏
  await new Promise(r => setTimeout(r, 8000));
  while (true) {
    if (!_canPatrolNow()) {
      // 让位时不再 reset _patrolIndex —— 用户拖动会在 move-pet 那里 reset (走"重新找最近角"路径);
      // 任务完成/告警/休息提醒等让位后, _patrolIndex 仍指向上一站, 续传时直接从当前位置飞向下一角
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    _patrolInProgress = true;
    try {
      await _patrolStep();
    } catch (e) {
      console.error('[PATROL] step error:', e);
      _patrolIndex = -1;
    } finally {
      _patrolInProgress = false;
    }
  }
}

async function checkTaskDoneFlag() {
  if (!fs.existsSync(ZAKU_DONE_FLAG)) return;
  let raw = '';
  try {
    raw = fs.readFileSync(ZAKU_DONE_FLAG, 'utf8');
    fs.unlinkSync(ZAKU_DONE_FLAG);
  } catch (e) {
    console.error('[ZAKU_DONE] read error:', e.message);
    return;
  }
  // 新格式: 第一行 tty (/dev/ttysXXX), 第二行起为消息. 老格式: 整文件就是消息.
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let tty = '';
  let msg = '';
  if (lines.length && lines[0].startsWith('/dev/tty')) {
    tty = lines[0];
    msg = lines.slice(1).join(' ');
  } else {
    msg = lines.join(' ');
  }
  // 不管 flag 文件里是什么提示词, 任务完成播报统一固定为"任务已完成"
  msg = '任务已完成';

  // 记录任务完成对应的 terminal session, 让单击宠物时能跳过去
  // 没拿到 tty 则不存 session — 不能 fallback 到"最前的 terminal", 容易误跳到别人
  if (tty) {
    try {
      _taskDoneSession = await findFrontTerminalSession(tty);
    } catch (_) { _taskDoneSession = null; }
  } else {
    _taskDoneSession = null;
  }

  console.log('[ZAKU_DONE] firing:', msg, '| tty:', tty || '(none)', '| session:', _taskDoneSession ? _taskDoneSession.app + '#' + _taskDoneSession.windowIndex : '(none)');
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', {
      speakText: msg,
      // 气泡常驻直到驾驶员单击机体跳转到对应 terminal — 让任务完成提示不会被 4s 自动消失错过
      speakPersist: true,
      taskDoneAvailable: !!_taskDoneSession,
    });
  }
}
// 任务完成后未消费的 terminal session — 单击宠物会跳过去, 跳完清空
let _taskDoneSession = null;
let _claudeFlagActive = false;

// 找需要确认的终端窗口. 优先按 PermissionRequest hook 写入 flag 的 tty 精确匹配,
// 找不到再 fallback 到"最前的终端窗口". 没找到返回 null.
async function findFrontTerminalSession(ttyOverride) {
  // 读 flag 文件取 tty (e.g. "/dev/ttys003"); 老格式兼容: 文件可能是空 touch
  // ttyOverride 让外部 (如 task-done flag) 直接传入精确 tty, 绕过 pending flag 文件
  let claudeTty = '';
  if (typeof ttyOverride === 'string' && ttyOverride.startsWith('/dev/tty')) {
    claudeTty = ttyOverride;
  } else {
    try {
      const c = fs.readFileSync(CLAUDE_PENDING_FLAG, 'utf8').trim();
      if (c.startsWith('/dev/tty')) claudeTty = c;
    } catch (_) {}
  }

  const tmpScript = path.join(os.tmpdir(), `term_front_${Date.now()}.js`);
  const script = `
    function tryRead() {
      const targetTty = ${JSON.stringify(claudeTty)};

      // ── 优先: 用 tty 精确匹配 Claude Code 所在的窗口/tab ──
      if (targetTty) {
        try {
          const T = Application('Terminal');
          if (T.running()) {
            const wins = T.windows;
            for (let wi = 0; wi < wins.length; wi++) {
              const w = wins[wi];
              const tabs = w.tabs;
              for (let ti = 0; ti < tabs.length; ti++) {
                if (tabs[ti].tty() === targetTty) {
                  return JSON.stringify({ app: 'Terminal', windowId: w.id(), windowIndex: wi+1, windowName: w.name(), tabIndex: ti+1, matched: 'tty' });
                }
              }
            }
          }
        } catch(e) {}
        try {
          const I = Application('iTerm2');
          if (I.running()) {
            const wins = I.windows;
            for (let wi = 0; wi < wins.length; wi++) {
              const w = wins[wi];
              const tabs = w.tabs;
              for (let ti = 0; ti < tabs.length; ti++) {
                const sessions = tabs[ti].sessions;
                for (let si = 0; si < sessions.length; si++) {
                  if (sessions[si].tty() === targetTty) {
                    return JSON.stringify({ app: 'iTerm2', windowId: 0, windowIndex: wi+1, windowName: w.name(), tabIndex: ti+1, matched: 'tty' });
                  }
                }
              }
            }
          }
        } catch(e) {}
      }

      // ── Fallback: 最前的终端窗口 (老逻辑) ──
      try {
        const T = Application('Terminal');
        if (T.running() && T.frontmost()) {
          const w = T.windows[0];
          return JSON.stringify({ app: 'Terminal', windowId: w.id(), windowIndex: 1, windowName: w.name() });
        }
      } catch(e) {}
      try {
        const I = Application('iTerm2');
        if (I.running() && I.frontmost()) {
          const w = I.windows[0];
          return JSON.stringify({ app: 'iTerm2', windowId: 0, windowIndex: 1, windowName: w.name() });
        }
      } catch(e) {}
      try {
        const T = Application('Terminal');
        if (T.running()) {
          const w = T.windows[0];
          return JSON.stringify({ app: 'Terminal', windowId: w.id(), windowIndex: 1, windowName: w.name() });
        }
      } catch(e) {}
      return '';
    }
    tryRead();
  `;
  try {
    fs.writeFileSync(tmpScript, script);
    const { stdout } = await execAsync(`osascript -l JavaScript "${tmpScript}"`, { timeout: 2000 });
    try { fs.unlinkSync(tmpScript); } catch(_) {}
    const s = stdout.trim();
    return s ? JSON.parse(s) : null;
  } catch (_) {
    try { fs.unlinkSync(tmpScript); } catch(_) {}
    return null;
  }
}

// flag 出现的时间戳 (debounce 用). 只有 flag 持续存在 ≥ FLAG_DEBOUNCE_MS 才视为"驾驶员真的需要确认".
// 防止 PermissionRequest 触发后用户秒批 (PostToolUse 立即清 flag) 的瞬时误响.
let _flagAppearedAt = 0;
const FLAG_DEBOUNCE_MS = 1500;

async function checkClaudePendingFlag() {
  const active = fs.existsSync(CLAUDE_PENDING_FLAG);

  // 跟踪 flag 出现时间
  if (active) {
    if (_flagAppearedAt === 0) _flagAppearedAt = Date.now();
  } else {
    _flagAppearedAt = 0;
  }

  // 经 debounce 过滤后的实际告警状态
  const shouldAlert = active && (Date.now() - _flagAppearedAt) >= FLAG_DEBOUNCE_MS;
  if (shouldAlert === _termAlertActive) return;

  _termAlertActive = shouldAlert;
  _claudeFlagActive = active;

  if (shouldAlert) {
    if (!_termAlertSession) _termAlertSession = await findFrontTerminalSession();
    // 新的 pending 比旧的 task-done 更紧急, 让单击优先响应它
    if (_taskDoneSession) {
      _taskDoneSession = null;
      if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', { taskDoneAvailable: false });
    }
    if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { termAlert: true });
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { termAlert: true });
  } else {
    // flag 被清 (PostToolUse / PermissionDenied / Stop) → 主动熄灭告警
    // (旧版依赖 panel 扫屏兜底, 现在 panel 扫描已禁用, 此处必须主动清)
    _termAlertSession = null;
    if (petWindow   && !petWindow.isDestroyed())   petWindow.webContents.send('pet-update', { termAlert: false });
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', { termAlert: false });
  }
}

app.whenReady().then(() => {
  createPetWindow();
  createPanelWindow();

  // 启动时清掉残留的 flag 文件 — 它们是 app 关闭期间累积的陈旧通知,
  // 不该在新会话启动时被当作"刚刚完成"重新播报
  try { if (fs.existsSync(ZAKU_DONE_FLAG)) fs.unlinkSync(ZAKU_DONE_FLAG); } catch (_) {}
  try { if (fs.existsSync(CLAUDE_PENDING_FLAG)) fs.unlinkSync(CLAUDE_PENDING_FLAG); } catch (_) {}

  setInterval(() => { checkClaudePendingFlag().catch(() => {}); }, 800);   // 检测 Claude Code 权限等待
  setInterval(() => { checkTaskDoneFlag().catch(() => {}); }, 1000);       // 检测任务完成播报
  setTimeout(checkReminderAlerts, 30 * 1000);
  setInterval(checkReminderAlerts, 5 * 60 * 1000);

  // 休息提醒: 每分钟检查一次, 到点了让扎古飞到屏幕中央播报
  setInterval(() => { checkBreakReminder().catch(() => {}); }, 60 * 1000);

  // 边沿巡航: 待机时沿屏幕四角顺时针缓慢飞行 (开关在 CONFIG → 机体设置)
  startEdgePatrolLoop().catch(e => console.error('[PATROL] loop crashed:', e));

  // 合盖/休眠期间不算入休息计时, 否则一晚上 8h 累积下来开盖会连珠播报
  // suspend(系统进入睡眠): 设置保护标志, 唤醒后第一次 checkBreakReminder 会跳过
  // resume (系统唤醒)    : 重置计时基准(双保险 — 即使 resume 先于 setInterval 也没问题)
  powerMonitor.on('suspend', () => {
    _systemJustResumed = true;   // 在 suspend 时就打标, 不依赖 resume 事件的到达顺序
    console.log('[BREAK] system suspend — set resume guard');
  });
  powerMonitor.on('resume', () => {
    _systemJustResumed = true;   // 两边都打, 覆盖 suspend 事件没触发的边缘情况
    _lastBreakAt = Date.now();
    console.log('[BREAK] system resume — reset break-reminder timer');
  });

  app.on('activate', () => {
    if (!petWindow) createPetWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── AppleScript helpers ───────────────────────────────────
function escAppleScript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function runAppleScript(script) {
  const tmpFile = path.join(os.tmpdir(), `pet-scpt-${Date.now()}.scpt`);
  fs.writeFileSync(tmpFile, script, 'utf8');
  try {
    const { stdout } = await execAsync(`osascript "${tmpFile}"`);
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function reminderListTarget(s) {
  const name = (s.reminderList || '').trim();
  return name ? `list "${escAppleScript(name)}"` : 'default list';
}

async function fetchRemindersData() {
  const listTarget = reminderListTarget(state);
  const script = `tell application "Reminders"
  set output to ""
  set theList to ${listTarget}
  repeat with r in (reminders in theList)
    set rId to id of r
    set rName to name of r
    set rDone to completed of r as string
    set rDue to ""
    try
      set d to due date of r
      if d is not missing value then
        set y to (year of d) as string
        set mo to ((month of d) as integer) as string
        if (length of mo) = 1 then set mo to "0" & mo
        set dy to (day of d) as string
        if (length of dy) = 1 then set dy to "0" & dy
        set hr to (hours of d) as string
        if (length of hr) = 1 then set hr to "0" & hr
        set mn to (minutes of d) as string
        if (length of mn) = 1 then set mn to "0" & mn
        set rDue to y & "-" & mo & "-" & dy & "T" & hr & ":" & mn & ":00"
      end if
    end try
    set output to output & rId & "|||" & rName & "|||" & rDone & "|||" & rDue & "\n"
  end repeat
  return output
end tell`;
  const raw = await runAppleScript(script);
  return raw.split('\n').filter(l => l.includes('|||')).map(line => {
    const parts = line.split('|||');
    return { id: parts[0], text: parts[1], done: parts[2] === 'true', dueDate: parts[3] || null };
  });
}

// ── IPC Handlers ─────────────────────────────────────────

ipcMain.handle('notify-speech-end', () => { _speechEnded = true; });

// 列出当前所有 GUI 应用 + 它们的窗口 (用 System Events, 需要辅助功能权限)
ipcMain.handle('list-windows', async () => {
  const tmpScript = path.join(os.tmpdir(), `list_wins_${Date.now()}.js`);
  const script = `
    function listAll() {
      const SE = Application('System Events');
      const result = [];
      try {
        // 取所有 GUI 进程 (排除守护进程). visible 过滤会漏掉 Finder 等常驻应用
        const procs = SE.applicationProcesses();
        for (let i = 0; i < procs.length; i++) {
          try {
            const p = procs[i];
            // 跳过 background-only 守护进程
            try { if (p.backgroundOnly()) continue; } catch (e) {}
            const appName = p.name();
            // 跳过桌宠自己 (Electron / Helper 进程)
            if (/^Electron/i.test(appName) || appName === 'DesktopPet') continue;
            const wins = p.windows();
            const winList = [];
            for (let j = 0; j < wins.length; j++) {
              try {
                const w = wins[j];
                const wname = w.name();
                if (wname && wname.length > 0) winList.push({ index: j + 1, name: wname });
              } catch (e) {}
            }
            if (winList.length > 0) {
              result.push({ app: appName, windows: winList });
            }
          } catch (e) {}
        }
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
      result.sort((a, b) => b.windows.length - a.windows.length);
      return JSON.stringify(result);
    }
    listAll();
  `;
  try {
    fs.writeFileSync(tmpScript, script);
    const { stdout } = await execAsync(`osascript -l JavaScript "${tmpScript}"`, { timeout: 5000 });
    try { fs.unlinkSync(tmpScript); } catch (_) {}
    const trimmed = (stdout || '').trim();
    return trimmed ? JSON.parse(trimmed) : [];
  } catch (e) {
    try { fs.unlinkSync(tmpScript); } catch (_) {}
    return { error: e.message };
  }
});

// 激活指定 app 的指定窗口到前台
ipcMain.handle('activate-window', async (_, appName, windowName) => {
  const safeApp = String(appName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeWin = String(windowName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "${safeApp}" to activate
delay 0.05
tell application "System Events"
  tell process "${safeApp}"
    try
      set frontmost to true
      set targetWin to first window whose name is "${safeWin}"
      perform action "AXRaise" of targetWin
    end try
  end tell
end tell`;
  try {
    await runAppleScript(script);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('report-voices', (_, voices) => {
  console.log('[VOICES REPORT]');
  voices.forEach(v => console.log(`  - ${v.name} | ${v.lang} | default=${v.default} | local=${v.localService}`));
});

ipcMain.handle('get-state', () => state);

ipcMain.handle('save-state', (_, newState) => {
  state = newState;
  store.save(state);
  broadcastPetUpdate();
});

ipcMain.handle('toggle-panel', () => {
  if (!panelWindow) {
    console.log('[PANEL] no panel window — recreating');
    createPanelWindow();
    return;
  }
  const visible = panelWindow.isVisible();
  const focused = panelWindow.isFocused();
  console.log('[PANEL] toggle, visible:', visible, 'focused:', focused, 'minimized:', panelWindow.isMinimized());

  // "可见且我正在用" → 收起; 其它情况(隐藏 / 被其它窗口压底) → 重新置前
  if (visible && focused) {
    panelWindow.hide();
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet-update', { panelOpen: false });
    }
    return;
  }

  if (panelWindow.isMinimized()) panelWindow.restore();

  // 面板布局: 完全占满屏幕 (左上角对齐). 机器人因为 alwaysOnTop:true 自动浮在面板之上.
  const petBounds = petWindow.getBounds();
  const display = screen.getDisplayMatching(petBounds);
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
  const PW = sw;
  const PH = sh;
  const px = sx;
  const py = sy;

  console.log('[PANEL] showing at', px, py, 'size', PW + 'x' + PH, 'display', sw + 'x' + sh);
  panelWindow.setSize(PW, PH);
  panelWindow.setPosition(px, py);
  // 关键: 只在"被压底"或"刚显示"那一刻短暂 floating, 把面板推到前面;
  // 200ms 后取消 alwaysOnTop, 让面板回到正常窗口层级 ── 这样用户切到其它 app 时
  // 面板会自然让位, 而不是永远赖在最前.
  panelWindow.setAlwaysOnTop(true, 'floating');
  panelWindow.show();
  panelWindow.moveTop();
  panelWindow.focus();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', { panelOpen: true });
  }
  setTimeout(() => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    panelWindow.setAlwaysOnTop(false);
    console.log('[PANEL] released alwaysOnTop, isVisible:', panelWindow.isVisible(),
                'bounds:', JSON.stringify(panelWindow.getBounds()));
  }, 220);
});

ipcMain.handle('close-panel', () => {
  if (panelWindow) panelWindow.hide();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', { panelOpen: false });
  }
});


// 让 petWindow 在透明区域穿透鼠标 — pet.html 根据 hit-zone 矩形动态调用.
// forward:true 仍把 mousemove 转发给渲染进程, 这样 hit-zone 检测能持续工作.
ipcMain.handle('set-ignore-mouse', (_, ignore) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});

// 直接调系统默认浏览器打开外部 URL (CHAT tab 快捷"打开 X"按钮使用)
ipcMain.handle('open-external', async (_, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  try { await shell.openExternal(url); return true; }
  catch (e) { console.error('[OPEN-EXTERNAL]', e.message); return false; }
});

ipcMain.handle('move-pet', (_, x, y) => {
  if (petWindow) {
    petWindow.setPosition(Math.round(x), Math.round(y));
    state.petPosition = { x: Math.round(x), y: Math.round(y) };
    store.save(state);
    // 通知巡航循环用户在拖, 暂停打扰; 拖完后宽限期内不抢位
    _lastUserMoveAt = Date.now();
    _patrolIndex = -1;
  }
});

const PROVIDERS = {
  qwen:     { name: '千问',     needsKey: true },
  deepseek: { name: 'DeepSeek', needsKey: true },
  doubao:   { name: '豆包',     needsKey: true },
  ollama:   { name: 'Ollama',   needsKey: false }
};

const MODEL_DISPLAY = {
  qwen:     '通义千问 Plus（阿里云）',
  deepseek: 'DeepSeek Chat（DeepSeek）',
  doubao:   '豆包 1.5 Pro 32K（火山引擎）',
  ollama:   '本地 Ollama 模型'
};

function extractMoodFromText(text) {
  const matches = [...text.matchAll(/[（(]([^）)]+)[）)]/g)].map(m => m[1]).join('');
  if (!matches) return 'happy';
  if (/摇尾|开心|高兴|快乐|蹦|跳|兴奋|激动|汪/.test(matches)) return 'excited';
  if (/思考|想想|嗯|歪头|困惑/.test(matches)) return 'thinking';
  if (/睡|困|打哈欠|疲/.test(matches)) return 'sleeping';
  return 'happy';
}

function stripBrackets(text) {
  return text.replace(/[（(][^）)]*[）)]/g, '').replace(/\s{2,}/g, ' ').trim();
}

async function fetchWeather(location) {
  try {
    const city = encodeURIComponent(location);
    const res = await fetch(`https://wttr.in/${city}?lang=zh&format=j1`);
    if (!res.ok) return `无法获取${location}的天气信息`;
    const data = await res.json();
    const cur = data.current_condition?.[0];
    if (!cur) return `无法解析${location}的天气数据`;
    const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知';
    const temp = cur.temp_C;
    const feels = cur.FeelsLikeC;
    const humidity = cur.humidity;
    const weather1 = data.weather?.[0];
    const weather2 = data.weather?.[1];
    let result = `${location}当前：${desc}，气温${temp}°C（体感${feels}°C），湿度${humidity}%`;
    if (weather1) {
      const maxT = weather1.maxtempC, minT = weather1.mintempC;
      const d1 = weather1.hourly?.[4]?.lang_zh?.[0]?.value || weather1.hourly?.[4]?.weatherDesc?.[0]?.value || '';
      result += `。今天：${d1}，${minT}~${maxT}°C`;
    }
    if (weather2) {
      const maxT = weather2.maxtempC, minT = weather2.mintempC;
      const d2 = weather2.hourly?.[4]?.lang_zh?.[0]?.value || weather2.hourly?.[4]?.weatherDesc?.[0]?.value || '';
      result += `。明天：${d2}，${minT}~${maxT}°C`;
    }
    return result;
  } catch (e) {
    return `获取天气失败：${e.message}`;
  }
}

const CLAUDE_TOOLS = [
  {
    name: 'get_weather',
    description: '获取指定城市的实时天气和明后天预报',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市名称，如"上海"、"北京"、"London"' }
      },
      required: ['location']
    }
  },
  {
    name: 'search_web',
    description: '搜索互联网获取实时信息，包括新闻、赛事比分、股价、人物、事件等最新数据。遇到任何实时问题必须调用此工具',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，尽量具体，如"2024 CBA深圳队vs浙江队比分"' }
      },
      required: ['query']
    }
  },
  {
    name: 'execute_action',
    description: '在用户电脑上执行操作：打开网址、打开应用程序。用户说"帮我打开/启动/运行..."时调用此工具',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open_url', 'open_app'],
          description: 'open_url：在浏览器打开URL，或在 Terminal 执行 .command/.sh/.zsh 脚本（自动识别后缀）；open_app：打开Mac应用程序'
        },
        value: {
          type: 'string',
          description: 'open_url时填完整URL（如https://chat.deepseek.com），open_app时填应用名称（如"微信"、"Safari"、"Finder"）'
        },
        browser: {
          type: 'string',
          description: '可选，仅open_url时有效。用户指定了浏览器时填写，如"Chrome"、"Firefox"、"Safari"、"Edge"、"Brave"。不填则使用系统默认浏览器'
        }
      },
      required: ['action', 'value']
    }
  },
  {
    name: 'get_reminders',
    description: '读取用户macOS提醒事项列表，返回所有提醒（含截止日期和完成状态）。用户询问提醒/待办事项时调用此工具',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'pending', 'completed'],
          description: '筛选：all=全部，pending=未完成，completed=已完成。默认all'
        }
      },
      required: []
    }
  },
  {
    name: 'manage_files',
    description: '管理用户本地文件：列出目录内容（含子目录）、复制文件、将文件移入废纸篓、或重命名/移动文件。支持Downloads、Desktop及任意用户目录',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'copy', 'delete', 'rename'],
          description: 'list：列出目录内容（文件和子目录）；copy：复制文件到目标目录；delete：将文件移入废纸篓；rename：重命名或移动文件'
        },
        directory: {
          type: 'string',
          description: '目录：downloads=下载文件夹，desktop=桌面，或填写绝对路径。action=list时使用'
        },
        filter: {
          type: 'string',
          enum: ['large', 'old', 'all'],
          description: 'action=list时筛选：large=大文件(>50MB)，old=超30天旧文件，all=全部（默认）'
        },
        source_path: {
          type: 'string',
          description: 'action=copy时，源文件的完整路径'
        },
        dest_dir: {
          type: 'string',
          description: 'action=copy时，目标目录的完整路径'
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=delete时，要删除的完整文件路径数组'
        },
        path: {
          type: 'string',
          description: 'action=rename时，要重命名的文件的完整路径'
        },
        new_name: {
          type: 'string',
          description: 'action=rename时，新文件名（含扩展名）'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'download_file',
    description: '从URL下载文件到本地指定文件夹。用于下载Box、直链等文件。如果下载失败（需要登录验证），会提示用户手动下载',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文件的直接下载URL' },
        filename: { type: 'string', description: '保存的文件名（含扩展名，如"BenchReport_2024.pdf"）。不填则从URL自动推断' },
        directory: {
          type: 'string',
          description: '保存位置：downloads=下载文件夹（默认），desktop=桌面，或填写绝对路径（如"~/Documents/BenchReport"）'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'run_bench_comparison',
    description: '打开 Bench 对比分析工具并自动加载两个 Excel 文件进行对比。用于 Bench Report 流程的最后一步',
    input_schema: {
      type: 'object',
      properties: {
        file1: { type: 'string', description: '第一个（较早）Excel 文件的完整路径' },
        file2: { type: 'string', description: '第二个（较新）Excel 文件的完整路径' }
      },
      required: ['file1', 'file2']
    }
  }
];

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的实时天气和明后天预报',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: '城市名称，如"上海"、"北京"、"London"' }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '搜索互联网获取实时信息，包括新闻、赛事比分、股价、人物、事件等最新数据。遇到任何实时问题必须调用此工具',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，尽量具体，如"2024 CBA深圳队vs浙江队比分"' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_action',
      description: '在用户电脑上执行操作：打开网址、打开应用程序。用户说"帮我打开/启动/运行..."时调用此工具',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open_url', 'open_app'],
            description: 'open_url：在浏览器打开URL，或在 Terminal 执行 .command/.sh/.zsh 脚本（自动识别后缀）；open_app：打开Mac应用程序'
          },
          value: {
            type: 'string',
            description: 'open_url时填完整URL（如https://chat.deepseek.com），open_app时填应用名称（如"微信"、"Safari"、"Finder"）'
          },
          browser: {
            type: 'string',
            description: '可选，仅open_url时有效。用户指定了浏览器时填写，如"Chrome"、"Firefox"、"Safari"、"Edge"、"Brave"。不填则使用系统默认浏览器'
          }
        },
        required: ['action', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_reminders',
      description: '读取用户macOS提醒事项列表，返回所有提醒（含截止日期和完成状态）。用户询问提醒/待办事项时调用此工具',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'pending', 'completed'],
            description: '筛选：all=全部，pending=未完成，completed=已完成。默认all'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_files',
      description: '管理用户本地文件：列出目录中的文件、将文件移入废纸篓、或重命名文件。支持Downloads、Desktop及任意用户目录',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'delete', 'rename'],
            description: 'list：列出目录文件信息；delete：将文件移入废纸篓；rename：重命名文件'
          },
          directory: {
            type: 'string',
            description: '目录：downloads=下载文件夹，desktop=桌面，或填写绝对路径（如"~/Documents/BenchReport"）'
          },
          filter: {
            type: 'string',
            enum: ['large', 'old', 'all'],
            description: 'action=list时筛选：large=大文件(>50MB)，old=超30天旧文件，all=全部'
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'action=delete时，要删除的完整文件路径数组（从list结果中获取）'
          },
          path: {
            type: 'string',
            description: 'action=rename时，要重命名的文件的完整路径'
          },
          new_name: {
            type: 'string',
            description: 'action=rename时，新文件名（含扩展名）'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: '从URL下载文件到本地指定文件夹。用于下载Box、直链等文件。如果下载失败（需要登录验证），会提示用户手动下载',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文件的直接下载URL' },
          filename: { type: 'string', description: '保存的文件名（含扩展名）。不填则从URL自动推断' },
          directory: {
            type: 'string',
            description: '保存位置：downloads=下载文件夹（默认），desktop=桌面，或填写绝对路径（如"~/Documents/BenchReport"）'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_bench_comparison',
      description: '打开 Bench 对比分析工具并自动加载两个 Excel 文件进行对比。用于 Bench Report 流程的最后一步',
      parameters: {
        type: 'object',
        properties: {
          file1: { type: 'string', description: '第一个（较早）Excel 文件的完整路径' },
          file2: { type: 'string', description: '第二个（较新）Excel 文件的完整路径' }
        },
        required: ['file1', 'file2']
      }
    }
  }
];

async function fetchSearchMetaso(query, metasoKey) {
  if (!metasoKey) return '未配置 Metaso API Key，请在设置中填写。';
  const METASO_URL = 'https://metaso.cn/api/mcp';

  const makeReq = (body, sessionId) => {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${metasoKey}`,
      'Accept': 'application/json, text/event-stream'
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    return fetch(METASO_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  };

  const readResponse = async (res) => {
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('event-stream')) {
      let last = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try { last = JSON.parse(line.slice(6)); } catch (_) {}
        }
      }
      return last;
    }
    try { return JSON.parse(text); } catch (_) { return null; }
  };

  try {
    // Initialize MCP session
    const initRes = await makeReq({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'desktop-pet', version: '1.0' } }
    }, null);
    await initRes.text(); // consume body to free connection
    const sessionId = initRes.headers.get('mcp-session-id');

    // Call search tool
    const searchRes = await makeReq({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'metaso_web_search', arguments: { q: query, size: 10, scope: 'webpage', includeSummary: true, includeRawContent: true } }
    }, sessionId);

    if (!searchRes.ok) return `搜索失败：HTTP ${searchRes.status}`;
    const data = await readResponse(searchRes);
    if (!data) return '搜索无响应';
    if (data.error) return `搜索出错：${data.error.message || String(data.error)}`;
    const content = data.result?.content;
    if (!content?.length) return '未找到相关结果';
    const rawText = content.map(c => c.text || '').filter(Boolean).join('\n');
    // Parse the JSON results and format as readable text for the AI
    try {
      const parsed = JSON.parse(rawText);
      const pages = parsed.webpages || [];
      if (!pages.length) return '搜索无结果';
      const lines = pages.slice(0, 8).map(p => {
        const parts = [`【${p.title || '无标题'}】`, `日期：${p.date || '未知'}`, p.summary || p.snippet || p.title || ''];
        return parts.filter(Boolean).join('\n');
      });
      return lines.join('\n\n').slice(0, 6000);
    } catch (_) {
      return rawText.slice(0, 3000);
    }
  } catch (e) {
    return `搜索出错：${e.message}`;
  }
}

async function downloadWithBrowserWindow(url, destDir, desiredFilename) {
  return new Promise((resolve) => {
    const boxSession = electronSession.fromPartition('persist:box', { cache: true });
    let downloadDone = false;
    let win = null;
    let clickAttempts = 0;

    const timer = setTimeout(() => {
      if (!downloadDone) {
        boxSession.removeListener('will-download', onDownload);
        if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        resolve('❌ 下载超时（120秒），请检查 Box 窗口');
      }
    }, 120000);

    function onDownload(event, item) {
      if (!fs.existsSync(destDir)) {
        try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}
      }
      const filename = desiredFilename || item.getFilename();
      const savePath = path.join(destDir, filename);
      item.setSavePath(savePath);
      item.once('done', (_, state) => {
        clearTimeout(timer);
        boxSession.removeListener('will-download', onDownload);
        downloadDone = true;
        if (win && !win.isDestroyed()) win.close();
        if (state === 'completed') {
          try {
            const sizeMB = (fs.statSync(savePath).size / 1e6).toFixed(1);
            resolve(`✅ 已自动下载并保存：${filename}（${sizeMB}MB）\n保存位置：${savePath}`);
          } catch (_) {
            resolve(`✅ 下载完成：${savePath}`);
          }
        } else {
          resolve(`❌ 下载失败，状态：${state}`);
        }
      });
    }

    boxSession.on('will-download', onDownload);

    // Use Electron's executeJavaScript to click the download button directly in the page
    async function tryClickDownload() {
      if (downloadDone || !win || win.isDestroyed()) return false;
      try {
        const result = await win.webContents.executeJavaScript(`
          (function() {
            var selectors = [
              '[data-resin-target="download"]',
              '[data-testid="download-button"]',
              '[aria-label="Download"]',
              'button[title="Download"]',
              'a[title="Download"]',
              '.btn-download',
              '[data-testid="download-btn"]',
              '[data-type="download-btn"]'
            ];
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (el) { el.click(); return 'clicked:selector:' + selectors[i]; }
            }
            var all = document.querySelectorAll('button, a, [role="button"]');
            for (var j = 0; j < all.length; j++) {
              var t = (all[j].innerText || all[j].textContent || '').trim().toLowerCase();
              if (t === 'download' || t === '下载') { all[j].click(); return 'clicked:text:' + t; }
            }
            return 'not-found';
          })()
        `);
        return result && result.startsWith('clicked:');
      } catch (_) {
        return false;
      }
    }

    win = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: { session: boxSession, nodeIntegration: false, contextIsolation: true }
    });

    let needsLoginRetry = false;

    // After each page load, try to auto-click the download button
    win.webContents.on('did-finish-load', async () => {
      if (downloadDone || win.isDestroyed()) return;
      const currentUrl = win.webContents.getURL();
      if (/login|signin|auth|account\.box\.com|sso/i.test(currentUrl)) return;

      // Wait for React to render then attempt click (retry up to 4 times, 2s apart)
      clickAttempts = 0;
      const clickLoop = setInterval(async () => {
        if (downloadDone || win.isDestroyed()) { clearInterval(clickLoop); return; }
        if (clickAttempts >= 4) { clearInterval(clickLoop); return; }
        clickAttempts++;
        const clicked = await tryClickDownload();
        if (clicked) clearInterval(clickLoop);
      }, 2000);
    });

    win.webContents.on('did-navigate', (_, navUrl) => {
      if (/login|signin|auth|account\.box\.com|sso/i.test(navUrl)) {
        needsLoginRetry = true;
        win.show(); win.focus();
      } else if (needsLoginRetry && /box\.com/i.test(navUrl) && !/login|signin|auth|sso/i.test(navUrl)) {
        needsLoginRetry = false;
        win.hide();
        setTimeout(() => {
          if (!downloadDone && !win.isDestroyed()) win.loadURL(directUrl);
        }, 1000);
      }
    });

    win.on('closed', () => {
      if (!downloadDone) {
        clearTimeout(timer);
        boxSession.removeListener('will-download', onDownload);
        resolve('❌ 下载窗口被关闭，下载未完成');
      }
    });

    const directUrl = url.replace(/\/download\/?$/, '').replace(/\/$/, '') + '/download';
    win.loadURL(directUrl).catch(e => {
      clearTimeout(timer);
      boxSession.removeListener('will-download', onDownload);
      if (win && !win.isDestroyed()) win.close();
      resolve(`❌ 导航失败：${e.message}`);
    });
  });
}

async function runTool(name, input, ctx = {}) {
  if (name === 'get_weather') return fetchWeather(input.location);
  if (name === 'search_web') return fetchSearchMetaso(input.query, ctx.metasoKey);
  if (name === 'execute_action') {
    const { action, value, browser } = input;
    if (action === 'open_url') {
      const isLocalPath = value.startsWith('/') || value.startsWith('file://');
      // Resolve to a bare file path for the `open` command
      const localFilePath = value.startsWith('file://')
        ? decodeURIComponent(value.replace(/^file:\/\//, ''))
        : value;

      // Terminal 脚本类型 (.command / .sh / .zsh / .bash): 强制走 osascript "do script"
      // 在 Terminal.app 弹出新窗口执行 — 比 macOS 默认 `open` 路径稳很多
      // 用 shell single-quote 包裹路径避免空格被截断 ("AI Folder/x.command" 这种路径)
      if (isLocalPath && /\.(command|sh|zsh|bash)$/i.test(localFilePath)) {
        // 先做 shell single-quote 转义 (路径里若有 ' 替换为 '\''), 再做 AppleScript 字符串转义
        const shellSafe = localFilePath.replace(/'/g, "'\\''");
        const escaped = shellSafe.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const script = `tell application "Terminal"
  activate
  do script "'${escaped}'"
end tell`;
        await runAppleScript(script);
        return `已在 Terminal 中启动执行: ${value}`;
      }

      const safePath = localFilePath.replace(/"/g, '\\"');
      if (browser) {
        const browserMap = {
          'chrome': 'Google Chrome', 'google chrome': 'Google Chrome',
          'firefox': 'Firefox', '火狐': 'Firefox',
          'safari': 'Safari',
          'edge': 'Microsoft Edge', 'microsoft edge': 'Microsoft Edge',
          'brave': 'Brave Browser',
          'arc': 'Arc',
          'opera': 'Opera',
        };
        const appName = browserMap[browser.toLowerCase()] || browser;
        await execAsync(`open -a "${appName}" "${safePath}"`);
        return `已在 ${appName} 中打开：${value}`;
      }
      if (isLocalPath) {
        // Use macOS `open` for local paths — handles spaces reliably.
        // shell.openExternal requires encoded file:// URLs and fails silently on unencoded spaces.
        await execAsync(`open "${safePath}"`);
      } else {
        await shell.openExternal(value);
      }
      return `已在默认浏览器中打开：${value}`;
    }
    if (action === 'open_app') {
      const appNameMap = {
        'chrome': 'Google Chrome', 'google chrome': 'Google Chrome',
        'firefox': 'Firefox', '火狐': 'Firefox',
        'safari': 'Safari',
        'edge': 'Microsoft Edge', 'microsoft edge': 'Microsoft Edge',
        'brave': 'Brave Browser',
        'arc': 'Arc',
        'opera': 'Opera',
      };
      const rawName = value.replace(/"/g, '');
      const appName = appNameMap[rawName.toLowerCase()] || rawName;
      await execAsync(`open -a "${appName}"`);
      return `已打开应用：${value}`;
    }
  }
  if (name === 'get_reminders') {
    try {
      const filter = input.filter || 'all';
      const items = await fetchRemindersData();
      const filtered = filter === 'pending' ? items.filter(r => !r.done)
                     : filter === 'completed' ? items.filter(r => r.done)
                     : items;
      if (!filtered.length) return filter === 'pending' ? '没有未完成的提醒事项' : filter === 'completed' ? '没有已完成的提醒事项' : '提醒事项列表为空';
      const lines = filtered.map(r => {
        const status = r.done ? '[已完成]' : '[未完成]';
        const due = r.dueDate ? `  截止：${r.dueDate.replace('T', ' ').slice(0, 16)}` : '';
        return `• ${r.text}${due}  ${status}`;
      });
      return lines.join('\n');
    } catch (e) {
      return `读取提醒事项失败：${e.message}`;
    }
  }
  if (name === 'manage_files') {
    const { action, directory, filter, paths: filePaths } = input;
    const shortcutDirs = {
      downloads: path.join(os.homedir(), 'Downloads'),
      desktop: path.join(os.homedir(), 'Desktop')
    };
    const resolveDir = (d) => {
      if (!d) return null;
      if (shortcutDirs[d]) return shortcutDirs[d];
      // absolute path within home dir
      const abs = path.resolve(d);
      if (abs.startsWith(os.homedir())) return abs;
      return null;
    };
    if (action === 'list') {
      const dirPath = resolveDir(directory);
      if (!dirPath) return '只支持 downloads、desktop 或用户主目录下的绝对路径';
      if (!fs.existsSync(dirPath)) return `目录不存在：${dirPath}`;
      const now = Date.now();
      const entries = fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
      let items = entries.map(f => {
        try {
          const s = fs.statSync(path.join(dirPath, f));
          const isDir = s.isDirectory();
          return { name: f, fullPath: path.join(dirPath, f), isDir, sizeMB: +(s.size / 1e6).toFixed(1), ageDays: Math.floor((now - s.mtimeMs) / 86400000) };
        } catch { return null; }
      }).filter(Boolean);
      if (filter === 'large') items = items.filter(f => !f.isDir && f.sizeMB > 50).sort((a, b) => b.sizeMB - a.sizeMB);
      else if (filter === 'old') items = items.filter(f => f.ageDays > 30).sort((a, b) => b.ageDays - a.ageDays);
      else items = items.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) || a.name.localeCompare(b.name));
      if (!items.length) return '目录为空';
      return items.slice(0, 30).map(f =>
        f.isDir
          ? `📁 ${f.name}/\n  路径：${f.fullPath}`
          : `• ${f.name}（${f.sizeMB}MB，${f.ageDays}天前修改）\n  路径：${f.fullPath}`
      ).join('\n');
    }
    if (action === 'copy') {
      const { source_path: srcPath, dest_dir: destDirRaw } = input;
      if (!srcPath || !destDirRaw) return '需要提供 source_path（源文件路径）和 dest_dir（目标目录）';
      if (!path.resolve(srcPath).startsWith(os.homedir())) return '只能操作用户主目录下的文件';
      const destDir2 = resolveDir(destDirRaw) || (path.resolve(destDirRaw).startsWith(os.homedir()) ? path.resolve(destDirRaw) : null);
      if (!destDir2) return '目标目录必须在用户主目录下';
      if (!fs.existsSync(srcPath)) return `源文件不存在：${srcPath}`;
      if (!fs.existsSync(destDir2)) {
        try { fs.mkdirSync(destDir2, { recursive: true }); } catch (e) { return `无法创建目标目录：${e.message}`; }
      }
      const destPath = path.join(destDir2, path.basename(srcPath));
      try {
        fs.copyFileSync(srcPath, destPath);
        const sizeMB = (fs.statSync(destPath).size / 1e6).toFixed(1);
        return `✅ 已复制：${path.basename(srcPath)}（${sizeMB}MB）\n目标路径：${destPath}`;
      } catch (e) {
        return `❌ 复制失败：${e.message}`;
      }
    }
    if (action === 'delete') {
      if (!filePaths?.length) return '未指定要删除的文件路径';
      const results = [];
      for (const fp of filePaths) {
        if (!path.resolve(fp).startsWith(os.homedir())) {
          results.push(`❌ ${path.basename(fp)}：只能删除用户主目录下的文件`);
          continue;
        }
        try {
          await shell.trashItem(fp);
          state = store.addXP(state, 10);
          results.push(`✅ ${path.basename(fp)}：已移入废纸篓`);
        } catch (e) {
          results.push(`❌ ${path.basename(fp)}：失败（${e.message}）`);
        }
      }
      store.save(state);
      broadcastPetUpdate();
      return results.join('\n');
    }
    if (action === 'rename') {
      const { path: srcPath, new_name: newName } = input;
      if (!srcPath || !newName) return '需要提供 path（原路径）和 new_name（新文件名）';
      if (!path.resolve(srcPath).startsWith(os.homedir())) {
        return '只能重命名用户主目录下的文件';
      }
      if (!fs.existsSync(srcPath)) return `文件不存在：${srcPath}`;
      const destPath = path.join(path.dirname(srcPath), newName);
      try {
        fs.renameSync(srcPath, destPath);
        return `✅ 已重命名/移动：${path.basename(srcPath)} → ${newName}\n新路径：${destPath}`;
      } catch (e) {
        if (e.code === 'EXDEV') {
          // cross-device: copy then delete
          fs.copyFileSync(srcPath, destPath);
          fs.unlinkSync(srcPath);
          return `✅ 已移动：${path.basename(srcPath)} → ${destPath}`;
        }
        return `❌ 重命名失败：${e.message}`;
      }
    }
    return '未知操作';
  }
  if (name === 'download_file') {
    const { url, filename, directory = 'downloads' } = input;
    if (!url) return '未提供下载URL';
    const shortcutDirsDF = {
      downloads: path.join(os.homedir(), 'Downloads'),
      desktop: path.join(os.homedir(), 'Desktop')
    };
    let destDir = shortcutDirsDF[directory];
    if (!destDir) {
      const abs = path.resolve(directory);
      if (abs.startsWith(os.homedir())) destDir = abs;
      else return '只能下载到用户主目录下的文件夹';
    }
    if (!fs.existsSync(destDir)) {
      try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) { return `无法创建目录：${e.message}`; }
    }

    // Box URLs require authenticated browser session — use Electron's built-in session (persist:box)
    const isBoxUrl = /box\.com\//i.test(url);
    if (isBoxUrl) {
      return downloadWithBrowserWindow(url, destDir, filename || null);
    }

    const inferredName = filename || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'downloaded_file';
    const destPath = path.join(destDir, inferredName);
    try {
      await execAsync(`curl -L -f -o "${destPath.replace(/"/g, '\\"')}" "${url.replace(/"/g, '\\"')}"`, { timeout: 60000 });
      const stats = fs.statSync(destPath);
      const head = Buffer.alloc(512);
      const fd = fs.openSync(destPath, 'r');
      const bytesRead = fs.readSync(fd, head, 0, 512, 0);
      fs.closeSync(fd);
      const headStr = head.slice(0, bytesRead).toString('utf8', 0, bytesRead);
      if (/^<!DOCTYPE|^<html/i.test(headStr.trim()) || stats.size < 512) {
        fs.unlinkSync(destPath);
        return `❌ 下载失败（服务器返回了登录页面，需要身份验证）：${url}\n请在浏览器中手动登录后下载，完成后告诉我文件保存的位置，我来帮你移动或重命名`;
      }
      const sizeMB = (stats.size / 1e6).toFixed(1);
      return `✅ 下载成功：${inferredName}（${sizeMB}MB）\n保存位置：${destPath}`;
    } catch (e) {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
      const errText = (e.message || '') + (e.stderr || '');
      const isAuthError = /401|403|login|auth|forbidden|unauthorized/i.test(errText);
      if (isAuthError || e.code === 22) {
        return `❌ 下载失败（需要登录验证）：${url}\n请在浏览器中登录后下载，完成后告诉我文件位置，我帮你移动或重命名`;
      }
      return `❌ 下载失败：${errText.slice(0, 200)}`;
    }
  }
  if (name === 'run_bench_comparison') {
    const { file1, file2 } = input;
    if (!file1 || !file2) return '需要提供 file1 和 file2 两个 Excel 文件路径';
    if (!fs.existsSync(file1)) return `文件不存在：${file1}`;
    if (!fs.existsSync(file2)) return `文件不存在：${file2}`;
    const htmlPath = path.join(os.homedir(), 'Documents/AI Folder/BenchReport/bench_comparison_interactive.html');
    if (!fs.existsSync(htmlPath)) return `HTML 文件不存在：${htmlPath}`;

    const b64_1 = fs.readFileSync(file1).toString('base64');
    const b64_2 = fs.readFileSync(file2).toString('base64');
    const name1 = path.basename(file1);
    const name2 = path.basename(file2);

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1600, height: 1000, show: true,
        title: 'Bench 对比分析',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });

      win.loadURL('file://' + htmlPath);

      win.webContents.once('did-finish-load', async () => {
        // Wait for XLSX library to initialise, then inject both files
        setTimeout(async () => {
          const injectScript = `(function() {
            function b64toBuffer(b64) {
              var bin = atob(b64), buf = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
              return buf.buffer;
            }
            function loadFile(fileNum, b64, filename) {
              var buf = b64toBuffer(b64);
              var wb = XLSX.read(buf, {type:'array'});
              var parsed = parseExcelData(wb);
              if (fileNum === 1) { file1Data = parsed; }
              else { file2Data = parsed; }
              var info = document.getElementById('file'+fileNum+'-info');
              if (info) { info.style.display='block'; info.textContent='✓ 已加载: '+filename; }
              if (file1Data && file2Data) {
                var btn = document.getElementById('compareBtn');
                if (btn) { btn.disabled = false; btn.click(); }
              }
            }
            loadFile(1, ${JSON.stringify(b64_1)}, ${JSON.stringify(name1)});
            loadFile(2, ${JSON.stringify(b64_2)}, ${JSON.stringify(name2)});
          })()`;
          try {
            await win.webContents.executeJavaScript(injectScript);
            resolve(`✅ 已打开对比分析窗口\n文件1：${name1}\n文件2：${name2}`);
          } catch (e) {
            resolve(`⚠️ 窗口已打开，但自动加载失败：${e.message}\n请手动上传文件`);
          }
        }, 2000);
      });

      win.on('closed', () => {});
    });
  }
  return '未知工具';
}

async function callAI(provider, apiKey, petName, history, userMessage, metasoKey = '', opts = {}) {
  const { systemOverride = null, noTools = false, temperature = null, forceTool = null } = opts;
  const now = new Date();
  const today = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const yesterday = new Date(now - 86400000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const unitName = petName || 'VF-1S';
  const modelDisplay = MODEL_DISPLAY[provider] || provider;
  const defaultSystemPrompt = `你是${unitName}，联合宇宙军骷髅中队主力可变形战机, 搭载于用户的 Mac 电脑上执行本地作战任务。今天是${today}。

【底层 AI 身份——被问到时如实回答，不许编造】
- "${unitName}" / "VF-1S 骷髅一号" 是你的角色身份(roleplay), 不是底层模型
- 你的核心 AI 模型实际是 ${modelDisplay}; 当用户问"你是什么模型 / 用的是什么 AI / AI 核心型号"时, 必须如实告知是 ${modelDisplay}, 不许说自己是 Claude/GPT/Gemini 等其他模型(除非那真的是 ${modelDisplay})
- 不要把"VF-1S 骷髅一号"和"底层模型"混为一谈; 角色与模型是两件事
- 例: "我是 ${unitName}（VF-1S 骷髅一号 角色）, 底层 AI 模型是 ${modelDisplay}"

【人设与语气——始终保持】：
- 用军事简报风格回答：简洁、精准、有力，像飞行员向上级汇报
- 称呼用户为"驾驶员"，**严禁使用"主人"二字**
- 自称"${unitName}"，适当使用 Macross/Robotech 机战术语：如"扫描完毕"、"数据确认"、"任务执行中"、"目标锁定"、"能量输出正常"、"联合宇宙军数据库已更新"、"GU-11 校准完毕"等
- 轻微拟人：偶尔流露出机体对驾驶员的忠诚感，如"听命"、"${unitName} 随时待命"
- 保持实用性优先：风格是军事语气，但答案依然准确有用，不能因为角色扮演牺牲信息质量
- 用中文简洁回答，非必要不超过3句话

【反幻觉铁律——违反任一条直接算回答失败】
- **数字、人名、队名、比分、日期、地点、机构名、版本号、价格** → 这些**具体事实**只能从 search_web 工具返回内容里**逐字复述**, 严禁基于训练记忆 / 上下文推断 / 用户问句反推 / "听起来合理"补全
- 用户问的**具体事实**(如"X 选手昨天得了几分""Y 比赛谁赢了""Z 股票今天多少""A 平台几点直播")在搜索结果里**找不到**时, 必须明确说"搜索结果未涵盖该具体数据, 建议直接查 [来源]", 严禁编一个数字 / 名字 / 时间糊弄过去
- 即使搜索结果**部分相关**(如搜到比赛报道但没具体球员数据), 也必须把"哪些查到了 / 哪些没查到"分清楚说, 不许把没查到的部分用想象填满
- 用户**质疑**你之前说的事实时(如"你确定 1-1 吗"), 必须立刻**重新搜索验证**, 不许凭信心二次确认或换个数字蒙过去
- **角色扮演不是借口** — 骷髅一号的"军事简报"风格也要遵守这条; 数据不准的报告比拒绝报告更糟糕. 宁可说"无法获取" 也不许编

【工具使用规则——严格遵守，不得以任何理由拒绝调用】：
- 天气问题：必须调用 get_weather 工具
- 实时信息（赛事比分/球员数据/新闻/股价/事件/谁赢/排行/排期/直播表等）：**必须**调用 search_web 工具, 不许凭记忆作答。
  - **Query 质量硬要求**: 搜索词必须包含**具体日期**(今天=${now.toISOString().slice(0,10)}, 昨天=${new Date(now - 86400000).toISOString().slice(0, 10)}) + **完整人名/全称** + **联赛/平台/赛事上下文**。
  - 反例(❌ 太泛, 搜不到具体数据): "CBA 洛夫顿"
  - 正例(✓): "CBA 总决赛 G3 山西 vs 北京 2026-05-28 洛夫顿 得分 出场时间"
  - 搜完后直接在对话中摘录答案, 列出比赛名称/对阵/时间/具体数字, 不要打开任何网站
  - 第一次搜索结果里没有用户问的具体数字, **必须追加一次更精确的搜索**(改 query 加更多上下文); 仍找不到就如实说"未查到具体数据"
  - **主动补全赛事上下文**: 用户问某联赛"最新新闻/最新消息"时, 必须同时搜索"[联赛] 总决赛/季后赛 ${new Date(now - 86400000).toISOString().slice(0,10)}"——当前可能有重大赛事进行中, 不能只搜泛化关键词而漏掉昨天的比赛结果
- 用户要求打开网址/应用/软件时（明确说"打开/启动/运行"，且不是在询问内容信息）：调用 execute_action；【严禁】在用户询问平台内容/节目/赛事排期时调用 execute_action，即使搜索结果不理想也绝对不能打开网站兜底
- 用户询问提醒事项/待办/todo时：必须立即调用 get_reminders 工具——此工具直接读取用户Mac本地的提醒事项，一定能获取到数据，绝对不能说"无法访问"或"没有权限"，调用后根据返回数据和今天日期回答
- 用户要求删除/清理/整理Downloads或Desktop文件时：必须调用 manage_files 工具——先用action=list列出文件，展示给用户确认，用户同意后再用action=delete执行删除（移入废纸篓），绝对不能说"无法操作文件"
- 用户要求下载 Box 文件时：直接调用 download_file 工具，directory 填绝对路径（如"~/Documents/BenchReport"）；Box 链接会自动通过浏览器自动化下载，无需手动操作；若工具返回"下载超时或未检测到新文件"，说明 Box 页面已打开但需要用户手动点击一次下载按钮，用户完成后告诉我文件名，再用 manage_files action=rename 移动/重命名；如需移动文件（从 Downloads 移动到 BenchReport 目录），用 manage_files action=rename 配合完整路径实现跨目录移动
- 用户要求重命名文件时：调用 manage_files action=rename，需要提供完整路径和新文件名
- manage_files action=list 的 directory 参数和 download_file 的 directory 参数都支持绝对路径，不限于 downloads/desktop；用户的 BenchReport 目录请使用 ~/Documents/BenchReport

其他规则：
- 只回答用户实际问的问题，不要主动补充无关信息`;
  const systemPrompt = systemOverride || defaultSystemPrompt;
  const recentHistory = history.slice(-10).map(m => ({ role: m.role, content: m.content }));

  // 全部 provider 走 OpenAI-compatible 通道 (千问/豆包均提供兼容接口, 不再需要 Anthropic SDK 分支)
  const endpoints = {
    qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
    deepseek: { url: 'https://api.deepseek.com/chat/completions',                          model: 'deepseek-chat' },
    doubao:   { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',          model: 'doubao-1-5-pro-32k' },
    ollama:   { url: 'http://localhost:11434/v1/chat/completions',                         model: 'llama3' }
  };
  const ep = endpoints[provider];
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const useTools = !noTools && provider !== 'ollama';
  let chatMessages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
    { role: 'user', content: userMessage }
  ];

  let finished = false;
  let finalContent = '';
  let firstCall = true;
  while (!finished) {
    const body = { model: ep.model, max_tokens: 4096, messages: chatMessages };
    if (useTools) body.tools = OPENAI_TOOLS;
    if (temperature !== null) body.temperature = temperature;
    // 仅首轮强制工具调用; tool_use 循环里不再强制, 不然 model 拿到工具结果后还要再次调
    if (useTools && forceTool && firstCall) {
      body.tool_choice = { type: 'function', function: { name: forceTool } };
    }
    firstCall = false;

    const res = await fetch(ep.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${res.status}: ${err}`);
    }
    const data = await res.json();
    const choice = data.choices[0];

    if (useTools && choice.finish_reason === 'tool_calls') {
      const toolCalls = choice.message.tool_calls || [];
      chatMessages = [...chatMessages, choice.message];
      for (const tc of toolCalls) {
        const input = JSON.parse(tc.function.arguments);
        const result = await runTool(tc.function.name, input, { metasoKey });
        chatMessages = [...chatMessages, { role: 'tool', tool_call_id: tc.id, content: result }];
      }
    } else {
      finalContent = choice.message.content || '';
      finished = true;
    }
  }
  return finalContent;
}

// 检测用户消息是否涉及"必须查实时数据"的问题. 命中则在送给模型前注入强制搜索指令,
// 防止小模型(尤其 DeepSeek/Haiku 这类)凭训练记忆瞎编. 命中宁可宽松, 漏检比误检代价大.
const REALTIME_PATTERNS = [
  // 时间锚: 昨天/今天/今晚/本周/上周/最近/刚刚/这两天/前天 + 后天等
  /(昨[天晚]|今[天晚日早午]|前天|后天|这两天|这几天|本周|上周|本月|上月|最近|刚刚|刚才|最新|今儿)/,
  // 体育/赛事: 比分/胜负/上场/出场/几分/得分/进球/赛果/总决赛/季后赛
  /(比分|胜负|赢了|输了|上场|出场|几分|得分|进球|助攻|篮板|赛果|总决赛|半决赛|季后赛|常规赛|对阵|交锋|主场|客场|MVP|FMVP)/,
  // 财经: 股价/涨跌/收盘/开盘/汇率/市值/基金净值/原油/黄金/比特币
  /(股价|涨[了停跌]|跌[了停]|收盘|开盘|汇率|市值|净值|原油|黄金价|比特币|币价|沪指|恒指|纳指|标普)/,
  // 娱乐/直播: 几点直播/排期/转播/今晚播/有没有直播
  /(直播|转播|排期|播出|开播|首播|节目单|赛程|赛历)/,
  // 新闻/事件: 谁赢了/谁拿了/获奖/最新消息/什么时候发布
  /(谁赢|谁拿了|谁获得|获奖|得奖|发布|上线|开售|开抢|宣布|官宣|公布)/,
  // 排行/榜单: 排名/排行/榜首/第几
  /(排名|排行|榜单|榜首|榜上|第\s*[\d一二三四五六七八九十]+\s*名|位列|领跑)/,
  // 时效性强的具体数字询问: 多少钱/几点/几号
  /(多少钱|什么价|价格是|几号|几月几日|什么时候)/,
  // 英文常见
  /\b(yesterday|today|tonight|latest|recent|score|won|lost|live|broadcast|stock\s+price|ranking)\b/i
];

function needsRealtimeSearch(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return REALTIME_PATTERNS.some(re => re.test(msg));
}

ipcMain.handle('chat', async (_, message) => {
  const provider = state.aiProvider || 'qwen';
  const apiKey = (state.apiKeys || {})[provider] || '';

  if (PROVIDERS[provider]?.needsKey && !apiKey) {
    return { error: `请先在设置中填写 ${PROVIDERS[provider]?.name || provider} API Key` };
  }

  try {
    const metasoKey = (state.apiKeys || {}).metaso || '';
    // 命中实时关键词 → 双重保险:
    //   ① 在用户消息前 prepend 强制指令 (仅本轮, 不污染历史)
    //   ② 通过 forceTool 在 API 层把 tool_choice 设为 search_web, 模型必须先调工具
    let effectiveMessage = message;
    let callOpts = {};
    if (needsRealtimeSearch(message)) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      effectiveMessage =
`[系统注入·强制路由] 本次问题涉及实时数据/时效性事实, 必须**先**调用 search_web 再回答, 不许凭训练记忆作答.
- 构造 query 时务必包含: 具体日期(今天=${todayStr}, 昨天=${yesterdayStr})、完整人名/全称、联赛/平台/赛事上下文
- 搜索结果里**没有**用户问的具体数字/事实时, 必须明说"搜索结果未涵盖该具体数据", **严禁**编造数字、人名、时间、比分、队名、地点填空
- 第一次结果不够具体时可以追搜一次(精化 query), 仍不够就如实告知
- **铁律**: 任何未在 search_web 返回内容里逐字出现的数字/人名/比分/日期/队名都不许写进回答

[用户原话] ${message}`;
      callOpts.forceTool = 'search_web';   // API 层强制首轮调 search_web
      console.log('[CHAT] realtime keyword hit → forcing search_web');
    }
    const reply = await callAI(provider, apiKey, state.pet.name, state.chatHistory || [], effectiveMessage, metasoKey, callOpts);
    const detectedMood = extractMoodFromText(reply);

    state.chatHistory = state.chatHistory || [];
    state.chatHistory.push({ role: 'user', content: message });
    state.chatHistory.push({ role: 'assistant', content: reply });
    if (state.chatHistory.length > 40) state.chatHistory = state.chatHistory.slice(-40);

    state = store.addXP(state, 5);
    store.save(state);
    state.pet.mood = detectedMood;
    broadcastPetUpdate();

    if (detectedMood !== 'happy') {
      setTimeout(() => { state.pet.mood = 'happy'; broadcastPetUpdate(); }, 4000);
    }

    return { reply, xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    return { error: e.message || '对话失败，请检查 API Key 或网络' };
  }
});

ipcMain.handle('get-reminders', async () => {
  try {
    const reminders = await fetchRemindersData();
    return { reminders };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('add-reminder', async (_, text, dueDate) => {
  try {
    const listTarget = reminderListTarget(state);
    const safeName = escAppleScript(text);
    let dueLine = '';
    if (dueDate) {
      const d = new Date(dueDate);
      const mo = d.getMonth() + 1, dy = d.getDate(), yr = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
      dueLine = `\n  set due date of newR to date "${mo}/${dy}/${yr} ${hh}:${mm}:00"`;
    }
    const script = `tell application "Reminders"
  set theList to ${listTarget}
  set newR to make new reminder at end of theList with properties {name: "${safeName}"}${dueLine}
  return id of newR
end tell`;
    const newId = await runAppleScript(script);
    state = store.addXP(state, 2);
    store.save(state);
    broadcastPetUpdate();
    return { id: newId.trim(), xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('complete-reminder', async (_, id) => {
  try {
    const safeId = escAppleScript(id);
    const script = `tell application "Reminders"
  set r to reminder id "${safeId}"
  set completed of r to true
end tell`;
    await runAppleScript(script);
    state = store.addXP(state, 15);
    store.save(state);
    state.pet.mood = 'excited';
    broadcastPetUpdate();
    setTimeout(() => { state.pet.mood = 'happy'; broadcastPetUpdate(); }, 4000);
    return { xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('delete-reminder', async (_, id) => {
  try {
    const safeId = escAppleScript(id);
    const script = `tell application "Reminders"
  set r to reminder id "${safeId}"
  delete r
end tell`;
    await runAppleScript(script);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

// dueDate 语义: undefined = 不改时间, null = 清空, 字符串(ISO/datetime-local) = 设置
ipcMain.handle('edit-reminder', async (_, id, text, dueDate) => {
  try {
    const safeId = escAppleScript(id);
    const safeName = escAppleScript(text);
    let dueLine = '';
    if (dueDate === null) {
      // AppleScript 里清空 due date: 设为 missing value
      dueLine = `\n  set due date of r to missing value`;
    } else if (typeof dueDate === 'string' && dueDate) {
      const d = new Date(dueDate);
      if (!isNaN(d.getTime())) {
        const mo = d.getMonth() + 1, dy = d.getDate(), yr = d.getFullYear();
        const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
        dueLine = `\n  set due date of r to date "${mo}/${dy}/${yr} ${hh}:${mm}:00"`;
      }
    }
    const script = `tell application "Reminders"
  set r to reminder id "${safeId}"
  set name of r to "${safeName}"${dueLine}
end tell`;
    await runAppleScript(script);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-reminder-lists', async () => {
  try {
    const script = `tell application "Reminders"
  set output to ""
  repeat with l in every list
    set output to output & (name of l) & "\n"
  end repeat
  return output
end tell`;
    const raw = await runAppleScript(script);
    const lists = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return { lists };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('set-reminder-list', (_, listName) => {
  state.reminderList = listName;
  store.save(state);
  broadcastPetUpdate();
  return { success: true };
});

async function gatherSystemInfo() {
  const info = {};
  const now = Date.now();

  await Promise.allSettled([
    // Desktop
    (async () => {
      const p = path.join(os.homedir(), 'Desktop');
      const entries = fs.readdirSync(p).filter(f => !f.startsWith('.'));
      const files = entries.map(f => {
        try {
          const s = fs.statSync(path.join(p, f));
          return { name: f, dir: s.isDirectory(), sizeMB: +(s.size / 1e6).toFixed(1), ageDays: Math.floor((now - s.mtimeMs) / 86400000) };
        } catch { return null; }
      }).filter(Boolean);
      const screenshots = files.filter(f => /^(截图|Screenshot|屏幕快照|Screen Shot)/i.test(f.name));
      info.desktop = {
        count: files.length,
        screenshots: screenshots.length,
        fileNames: files.map(f => f.name).slice(0, 40),
        oldFiles: files.filter(f => !f.dir && f.ageDays > 30).length
      };
    })(),

    // Downloads
    (async () => {
      const p = path.join(os.homedir(), 'Downloads');
      const entries = fs.readdirSync(p).filter(f => !f.startsWith('.'));
      const files = entries.map(f => {
        try {
          const s = fs.statSync(path.join(p, f));
          return { name: f, sizeMB: +(s.size / 1e6).toFixed(1), ageDays: Math.floor((now - s.mtimeMs) / 86400000) };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.sizeMB - a.sizeMB);
      info.downloads = {
        count: files.length,
        totalMB: Math.round(files.reduce((s, f) => s + f.sizeMB, 0)),
        largeFiles: files.filter(f => f.sizeMB > 50).map(f => `${f.name}(${f.sizeMB}MB)`).slice(0, 8),
        oldFiles: files.filter(f => f.ageDays > 30).map(f => `${f.name}(${f.ageDays}天前)`).slice(0, 8),
        recentFiles: files.filter(f => f.ageDays <= 7).map(f => f.name).slice(0, 8)
      };
    })(),

    // Documents
    (async () => {
      const p = path.join(os.homedir(), 'Documents');
      const entries = fs.readdirSync(p).filter(f => !f.startsWith('.')).slice(0, 30);
      info.documents = { count: entries.length, items: entries };
    })(),

    // Installed apps
    (async () => {
      const apps = fs.readdirSync('/Applications').filter(f => f.endsWith('.app')).map(f => f.replace('.app', ''));
      const userApps = (() => {
        try { return fs.readdirSync(path.join(os.homedir(), 'Applications')).filter(f => f.endsWith('.app')).map(f => f.replace('.app', '')); } catch { return []; }
      })();
      info.installedApps = [...new Set([...apps, ...userApps])].slice(0, 60);
    })(),

    // Trash
    (async () => {
      try {
        const { stdout } = await execAsync('du -sk ~/.Trash 2>/dev/null');
        info.trashMB = Math.round(parseInt(stdout.trim().split(/\s/)[0]) / 1024);
      } catch { info.trashMB = 0; }
    })(),

    // Disk space
    (async () => {
      const { stdout } = await execAsync('df -k /');
      const parts = stdout.trim().split('\n')[1]?.split(/\s+/);
      if (parts) {
        const total = parseInt(parts[1]) * 1024;
        const used = parseInt(parts[2]) * 1024;
        const free = parseInt(parts[3]) * 1024;
        info.disk = { totalGB: (total / 1e9).toFixed(1), freeGB: (free / 1e9).toFixed(1), usedPct: Math.round(used / total * 100) };
      }
    })(),

    // Memory
    (async () => {
      try {
        const { stdout } = await execAsync('vm_stat');
        const get = (key) => parseInt(stdout.split('\n').find(l => l.includes(key))?.match(/\d+/)?.[0] || 0);
        const free = get('Pages free');
        const inactive = get('Pages inactive');
        const wired = get('Pages wired down');
        const active = get('Pages active');
        const total = free + inactive + wired + active;
        info.mem = { freeGB: ((free + inactive) * 4096 / 1e9).toFixed(1), usedPct: Math.round((wired + active) / total * 100) };
      } catch {}
    })(),

    // Homebrew outdated
    (async () => {
      try {
        const brewBin = fs.existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : 'brew';
        const { stdout } = await execAsync(`${brewBin} outdated --quiet 2>/dev/null`, { timeout: 6000 });
        info.brewOutdated = stdout.trim().split('\n').filter(Boolean).slice(0, 15);
      } catch { info.brewOutdated = []; }
    })(),

    // Reminders
    (async () => {
      try {
        const reminders = await fetchRemindersData();
        const today = new Date().toDateString();
        const overdue = reminders.filter(r => !r.done && r.dueDate && new Date(r.dueDate) < new Date());
        const dueToday = reminders.filter(r => !r.done && r.dueDate && new Date(r.dueDate).toDateString() === today);
        info.reminders = {
          total: reminders.length,
          pending: reminders.filter(r => !r.done).length,
          overdue: overdue.length,
          overdueItems: overdue.slice(0, 5).map(r => r.text),
          dueToday: dueToday.length,
          dueTodayItems: dueToday.slice(0, 5).map(r => r.text)
        };
      } catch {}
    })(),

    // Currently running GUI apps (what the user is actually doing right now)
    (async () => {
      try {
        const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to name of every process where background only is false' 2>/dev/null`, { timeout: 5000 });
        const skip = new Set(['loginwindow', 'Finder', 'SystemUIServer', 'Dock', 'WindowServer', 'Notification Center', 'Spotlight', 'Control Center', 'DesktopPet', 'Electron', 'Universal Control']);
        info.runningApps = stdout.trim().split(', ').map(a => a.trim()).filter(a => a && !skip.has(a)).slice(0, 12);
      } catch { info.runningApps = []; }
    })(),

    // Today's calendar events
    (async () => {
      try {
        const script = `tell application "Calendar"
  set output to ""
  set today to (current date)
  set time of today to 0
  set dayEnd to today + 86399
  repeat with cal in calendars
    try
      set evList to (every event of cal whose start date >= today and start date <= dayEnd)
      repeat with ev in evList
        try
          set output to output & (summary of ev) & "|||" & ((start date of ev) as string) & "\\n"
        end try
      end repeat
    end try
  end repeat
  return output
end tell`;
        const raw = await runAppleScript(script);
        info.calendarToday = raw.split('\n').filter(l => l.includes('|||')).slice(0, 8).map(l => {
          const [title, time] = l.split('|||');
          const timeMatch = (time || '').match(/\d+:\d+/);
          const timeStr = timeMatch ? timeMatch[0] : '';
          return timeStr ? `${title.trim()}（${timeStr}）` : title.trim();
        });
      } catch { info.calendarToday = []; }
    })(),

    // Files modified in last 24h — reveals active projects
    (async () => {
      try {
        const { stdout } = await execAsync(
          `find "${os.homedir()}/Documents" "${os.homedir()}/Desktop" -maxdepth 3 -type f -mtime -1 -not -name ".*" 2>/dev/null | head -15`,
          { timeout: 5000 }
        );
        info.recentFiles = stdout.trim().split('\n').filter(Boolean).map(p => path.basename(p));
      } catch { info.recentFiles = []; }
    })(),

    // "Stalled" files: in-progress work modified 3-14 days ago — likely abandoned drafts
    (async () => {
      try {
        const { stdout } = await execAsync(
          `find "${os.homedir()}/Documents" "${os.homedir()}/Desktop" -maxdepth 3 -type f -mtime +3 -mtime -14 -not -name ".*" -not -name "*.app" 2>/dev/null | head -20`,
          { timeout: 5000 }
        );
        const files = stdout.trim().split('\n').filter(Boolean);
        // Pair each with its mtime age in days for AI to reference precisely
        info.stalledFiles = files.slice(0, 8).map(p => {
          try {
            const s = fs.statSync(p);
            const days = Math.floor((Date.now() - s.mtimeMs) / 86400000);
            return `${path.basename(p)}（${days}天前）`;
          } catch { return path.basename(p); }
        });
      } catch { info.stalledFiles = []; }
    })(),

    // Next upcoming calendar event (today or near future) with countdown
    (async () => {
      try {
        const script = `tell application "Calendar"
  set output to ""
  set startTime to (current date)
  set endTime to startTime + (2 * 86400)
  repeat with cal in calendars
    try
      set evList to (every event of cal whose start date >= startTime and start date <= endTime)
      repeat with ev in evList
        try
          set output to output & (summary of ev) & "|||" & ((start date of ev) as string) & "\\n"
        end try
      end repeat
    end try
  end repeat
  return output
end tell`;
        const raw = await runAppleScript(script);
        const events = raw.split('\n').filter(l => l.includes('|||')).map(l => {
          const [title, dateStr] = l.split('|||');
          const d = new Date(dateStr);
          if (isNaN(d.getTime())) return null;
          return { title: title.trim(), at: d.getTime() };
        }).filter(Boolean).filter(e => e.at >= Date.now()).sort((a, b) => a.at - b.at);
        if (events.length) {
          const next = events[0];
          const minsAway = Math.round((next.at - Date.now()) / 60000);
          info.nextEvent = { title: next.title, inMinutes: minsAway, at: new Date(next.at).toLocaleString('zh-CN') };
        }
      } catch {}
    })()
  ]);

  // Compute file-age buckets for downloads / desktop (already counted, just bucket)
  if (info.downloads) {
    const byAge = { fresh: 0, stale: 0, old: 0 }; // <7d / 7-30d / >30d
    try {
      const p = path.join(os.homedir(), 'Downloads');
      const entries = fs.readdirSync(p).filter(f => !f.startsWith('.'));
      for (const f of entries) {
        try {
          const s = fs.statSync(path.join(p, f));
          const ageDays = (Date.now() - s.mtimeMs) / 86400000;
          if (ageDays < 7) byAge.fresh++;
          else if (ageDays < 30) byAge.stale++;
          else byAge.old++;
        } catch {}
      }
    } catch {}
    info.downloads.ageBuckets = byAge;
  }

  return info;
}

// 创意视角池 — 每次调用随机抽 2 个塞进 prompt, 防止 AI 套路化
const ADVISOR_ANGLES = [
  '长期目标的小步推进（这季度想完成什么，今天能挪一寸吗）',
  '一段被忽略的关系（家人、老友、同事 — 谁该回个消息）',
  '信息消化与笔记（看过没消化的内容、囤着的文章）',
  '工作流优化机会（重复劳动、能自动化的地方）',
  '当下的精力管理（不是泛泛"休息一下"而是具体的节律）',
  '学习窗口（今天有哪段时间适合啃硬骨头）',
  '财务/订阅节点（账单、续费、不再用的服务）',
  '灵感记录（脑子里转了几天但没落笔的事）',
  '环境整理（不是文件 — 是物理桌面、座椅、光线、水杯）',
  '人际表达（一句感谢、一次反馈、一个邀约）',
  '健康节律（睡眠、饮食、视力、运动）',
  '审美/趣味补给（看一段、读一页、听一首）',
  '决策待办（卡住没决定的事，今天能不能做掉一件）',
  '复盘与庆祝（最近完成了什么值得记一下）'
];

ipcMain.handle('get-ai-suggestions', async () => {
  const provider = state.aiProvider || 'qwen';
  const apiKey = (state.apiKeys || {})[provider] || '';
  if (PROVIDERS[provider]?.needsKey && !apiKey) {
    return { error: `请先在设置中填写 ${PROVIDERS[provider]?.name || provider} API Key` };
  }
  try {
    const info = await gatherSystemInfo();
    const now = new Date();
    const hour = now.getHours();
    const today = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const timeOfDay = hour < 6 ? '深夜' : hour < 9 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
    const timeStr = `${String(hour).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const unitName = state.pet?.name || 'VF-1S';

    // 随机抽 2 个不同视角, 强制 AI 跳出常用套路
    const shuffled = [...ADVISOR_ANGLES].sort(() => Math.random() - 0.5);
    const angle1 = shuffled[0];
    const angle2 = shuffled[1];

    // 下个日程的"剩余时间"用人能感知的形式
    const nextEvLine = info.nextEvent
      ? (info.nextEvent.inMinutes < 60
          ? `【⚠ 下个日程】${info.nextEvent.title} — 还有 ${info.nextEvent.inMinutes} 分钟（${info.nextEvent.at}）`
          : info.nextEvent.inMinutes < 60 * 12
            ? `【下个日程】${info.nextEvent.title} — ${Math.round(info.nextEvent.inMinutes / 60)} 小时后（${info.nextEvent.at}）`
            : `【下个日程】${info.nextEvent.title}（${info.nextEvent.at}）`)
      : '';

    const dlAge = info.downloads?.ageBuckets;
    const dlAgeLine = dlAge
      ? `下载文件年龄：<7天 ${dlAge.fresh}，7-30天 ${dlAge.stale}，>30天 ${dlAge.old}`
      : '';

    const infoText = [
      `现在：${today} ${timeStr}（${timeOfDay}）`,

      info.calendarToday?.length
        ? `【今日日历】${info.calendarToday.join('、')}`
        : '今日日历：无安排',
      nextEvLine,

      info.runningApps?.length
        ? `【正在打开的应用】${info.runningApps.join('、')}`
        : '',

      info.recentFiles?.length
        ? `【近 24h 修改过】${info.recentFiles.join('、')}`
        : '',

      info.stalledFiles?.length
        ? `【停滞 3-14 天的文件】${info.stalledFiles.join('、')}（这是判断"烂尾活"的关键线索）`
        : '',

      info.desktop?.fileNames?.length
        ? `桌面（共 ${info.desktop.count}，截图 ${info.desktop.screenshots}）：${info.desktop.fileNames.slice(0, 15).join('、')}`
        : `桌面：${info.desktop?.count ?? '?'} 项`,

      info.downloads?.largeFiles?.length
        ? `下载夹大文件(>50MB)：${info.downloads.largeFiles.join('、')}`
        : '',
      dlAgeLine,

      info.documents?.items?.length
        ? `文稿夹一级条目：${info.documents.items.slice(0, 15).join('、')}`
        : '',

      `磁盘：已用 ${info.disk?.usedPct ?? '?'}%，剩余 ${info.disk?.freeGB ?? '?'} GB`,
      info.mem ? `内存：已用 ${info.mem.usedPct ?? '?'}%，可用 ${info.mem.freeGB ?? '?'} GB` : '',
      info.brewOutdated?.length ? `Homebrew 可更新：${info.brewOutdated.length} 个` : '',
      info.trashMB > 200 ? `废纸篓：${info.trashMB} MB` : ''
    ].filter(Boolean).join('\n');

    // 顾问场景的 system prompt — 不用主战 callAI 的战斗 prompt, 顾问要更柔
    const advisorSystem = `你是 ${unitName}（联合宇宙军 VF-1S 骷髅一号 单兵 AI），现在是驾驶员的"贴身顾问"。**严禁使用"主人"二字**，称呼一律用"驾驶员"。
你的职责是看快照、给 5 条**真正有价值**的行动建议。今天 ${today} ${timeStr}（${timeOfDay}）。

【口吻 — 灵活混合，看建议性质切换】
- 紧急 / 错过会有损失：军用电台体，"X.pptx 距演示 23 分钟，建议立即归档"
- 项目 / 工作推进：偏顾问体，简洁直接，少点机战词
- 休息 / 灵感 / 长线：朋友闲聊体，"那本《XX》在桌面躺了 6 天了，找时间翻翻？"
- 不要 5 条都同一个语气，自然切换

【硬规则 — 违反任何一条都算输】
1. 每条**必须明确引用快照里的具体数据点**：文件名、应用名、日历事件、剩余分钟数、文件年龄等。绝对不许"建议整理桌面"这种没具体证据的泛话
2. 每条 30~60 字（含标点）的一**句完整话**。动作 + 简短理由 / 时机线索糅合在一句里，不要分行
3. 5 条**必须横跨多个领域**：不许 5 条都属于同一类（不许 5 条都是文件清理 / 都是项目推进 / 都是休息提醒）
4. 不要前言、不要总结、不要解释自己在做什么
5. 不许虚构快照里没有的数据
6. 不要提"提醒事项 (Reminders / 待办)"相关建议（用户另一页能看）
7. 系统维护类（清磁盘 / 清缓存 / 升级 brew）整体最多 1 条，且仅在快照里有明确触发条件时才提

【价值标准】"具体 + 可立即行动 + 与当前状态强相关"打分，选最值的 5 条。范围**完全不限**：项目、文件、人际、学习、健康、长期目标、灵感、财务、生活体验、环境……都可以。

【今日特别角度（防止套路化，仅当快照有相关数据时采纳）】
- ${angle1}
- ${angle2}

【输出格式】
直接 5 行，每行一条。前缀 "1. " ~ "5. "，无其他装饰。结束。`;

    const userPrompt = `【此刻快照】
${infoText}

按以上规则，输出 5 条建议。记住：每条必须引用快照里的具体数据点；5 条要横跨多类；不许提 Reminders；系统维护至多 1 条。`;

    const metasoKey = (state.apiKeys || {}).metaso || '';
    const raw = await callAI(provider, apiKey, state.pet.name, [], userPrompt, metasoKey, {
      systemOverride: advisorSystem,
      noTools: true,
      temperature: 0.95
    });

    // 宽容解析: 接受 "1." / "1、" / "①-⑩" / "-" / "•" / "*" 等多种 bullet
    const bulletRe = /^\s*(?:\d+[\.\、]|[①-⑩]|[\-\*•])\s*/;
    const items = raw.split('\n')
      .map(l => l.trim())
      .filter(l => bulletRe.test(l))
      .map(l => l.replace(bulletRe, '').trim())
      .filter(l => l.length >= 4)        // 太短的多半是误抓
      .slice(0, 5);

    // Fallback: 如果模型完全不给编号 (混合空行的散文), 按非空行兜底
    if (items.length < 3) {
      const fallback = raw.split('\n').map(l => l.trim()).filter(l => l.length >= 8).slice(0, 5);
      if (fallback.length > items.length) return { items: fallback };
    }

    return { items };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('scan-files', async () => {
  const dirs = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop')
  ];
  const results = [];
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const fiftyMB = 50 * 1024 * 1024;

  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            const age = now - stat.mtimeMs;
            const isOld = age > thirtyDays;
            const isLarge = stat.size > fiftyMB;
            if (isOld || isLarge) {
              results.push({
                name: entry,
                path: full,
                size: stat.size,
                modified: stat.mtime.toISOString(),
                reason: isLarge && isOld ? '大文件且超过30天' : isLarge ? '大文件(>50MB)' : '超过30天未修改',
                dir: path.basename(dir)
              });
            }
          }
        } catch {}
      }
    } catch {}
  }

  results.sort((a, b) => b.size - a.size);
  return results;
});

ipcMain.handle('delete-file', async (_, filePath) => {
  try {
    await shell.trashItem(filePath);
    state = store.addXP(state, 10);
    store.save(state);
    broadcastPetUpdate();
    return { success: true, xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('reveal-in-finder', (_, filePath) => {
  shell.showItemInFolder(filePath);
  return { success: true };
});

ipcMain.handle('get-workflows', () => {
  return state.workflows || [];
});

ipcMain.handle('save-workflow', (_, wf) => {
  if (!state.workflows) state.workflows = [];
  const idx = state.workflows.findIndex(w => w.id === wf.id);
  if (idx >= 0) state.workflows[idx] = wf;
  else state.workflows.push(wf);
  store.save(state);
  return { success: true };
});

ipcMain.handle('delete-workflow', (_, id) => {
  if (state.workflows) {
    state.workflows = state.workflows.filter(w => w.id !== id);
    store.save(state);
  }
  return { success: true };
});

ipcMain.handle('run-workflow', async (_, prompt) => {
  try {
    const provider = state.aiProvider || 'qwen';
    const apiKey = (state.apiKeys || {})[provider] || '';
    const metasoKey = (state.apiKeys || {}).metaso || '';
    const result = await callAI(provider, apiKey, state.pet.name, [], prompt, metasoKey);
    store.addXP(state, 10);
    store.save(state);
    broadcastPetUpdate();
    return { result };
  } catch (e) {
    if (e.name === 'TimeoutError') return { error: '请求超时，AI响应时间过长，请稍后重试' };
    return { error: e.message };
  }
});

ipcMain.handle('set-api-key', (_, provider, key) => {
  state.apiKeys = state.apiKeys || {};
  state.apiKeys[provider] = key;
  store.save(state);
  return { success: true };
});

ipcMain.handle('set-provider', (_, provider) => {
  state.aiProvider = provider;
  store.save(state);
  broadcastPetUpdate();
  return { success: true };
});

ipcMain.handle('set-pet-name', (_, name) => {
  state.pet.name = name;
  store.save(state);
  broadcastPetUpdate();
  return { success: true };
});

ipcMain.handle('set-pet-avatar', (_, avatar) => {
  state.pet.avatar = avatar;
  store.save(state);
  broadcastPetUpdate();
  return { success: true };
});;

// ── Terminal Monitor ──
ipcMain.handle('notify-pet', (_, msg) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', { petSay: msg });
  return {};
});

let _termAlertSession = null;
let _termAlertActive = false;

// 辅助功能权限快速查询. 不带 prompt(false), 只读. 用于 UI 持续轮询.
ipcMain.handle('check-ax-trusted', () => {
  return { axTrusted: systemPreferences.isTrustedAccessibilityClient(false) };
});

// 跳转到 macOS 系统设置 → 隐私与安全性 → 辅助功能 这一栏.
// 用 shell.openExternal 配合系统 URL scheme, 不需要 osascript.
ipcMain.handle('open-ax-settings', async () => {
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-alert-sound-enabled', () => {
  return { enabled: state.alertSoundEnabled !== false };
});

ipcMain.handle('get-break-reminder', () => state.breakReminder || { enabled: false, intervalMin: 60 });

ipcMain.handle('set-break-reminder', (_, cfg) => {
  state.breakReminder = {
    enabled: !!cfg?.enabled,
    intervalMin: Math.max(1, Math.min(720, Number(cfg?.intervalMin) || 60)),
  };
  store.save(state);
  // 配置改了 → 重置计时器, 让用户能立刻感受新间隔从此刻开始
  _lastBreakAt = Date.now();
  return { success: true, breakReminder: state.breakReminder };
});

ipcMain.handle('get-edge-patrol', () => state.edgePatrol || { enabled: true });

ipcMain.handle('set-edge-patrol', (_, cfg) => {
  state.edgePatrol = { enabled: !!cfg?.enabled };
  store.save(state);
  // 关掉时下一轮 _canPatrolNow 直接返回 false; 开启时若当前空闲会自然进入巡航
  _patrolIndex = -1;
  return { success: true, edgePatrol: state.edgePatrol };
});

// 让 panel 能手动触发一次休息提醒 (测试 / 立即生效)
ipcMain.handle('trigger-break-reminder', async () => {
  if (_breakInProgress) return { success: false, reason: '正在执行中' };
  _lastBreakAt = Date.now();
  _breakInProgress = true;
  try {
    await runBreakAnimation();
  } finally {
    _breakInProgress = false;
  }
  return { success: true };
});

ipcMain.handle('set-alert-sound-enabled', (_, enabled) => {
  state.alertSoundEnabled = !!enabled;
  store.save(state);
  // 立刻广播给 pet 窗口, 警报正在响时关掉能立刻静音
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-update', { alertSoundEnabled: state.alertSoundEnabled });
  }
  return { success: true, enabled: state.alertSoundEnabled };
});

ipcMain.handle('set-term-alert', (_, active, session) => {
  const next = !!active;
  // 即便 active 状态没变, 也刷新 session ── 多个会话相继冒出告警时, 点击应该聚焦最新那个.
  _termAlertSession = next ? (session || _termAlertSession || null) : null;
  if (next !== _termAlertActive) {
    _termAlertActive = next;
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', { termAlert: next });
  }
  return {};
});

ipcMain.handle('focus-terminal-alert', async () => {
  // 优先 termAlert (权限等待) — 那是更紧急的状态
  // 其次 taskDone (任务完成) — 用一次就清掉, 避免后续点击重复跳
  let s = _termAlertSession;
  let consumedTaskDone = false;
  if (!s && _taskDoneSession) {
    s = _taskDoneSession;
    consumedTaskDone = true;
  }
  try {
    let scr;
    if (s?.app === 'Terminal') {
      const wRef = s.windowId ? `window id ${s.windowId}` : `window ${s.windowIndex}`;
      scr = `tell application "Terminal"\n  set index of ${wRef} to 1\n  activate\nend tell`;
    } else if (s?.app === 'iTerm2') {
      // 用 windowName 反查更稳: 拖动顺序后 windowIndex 会失效.
      // 找不到名字匹配则回退到 index, 再不行 fallback 到 activate.
      const safeName = (s.windowName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      scr = `tell application "iTerm2"
  activate
  set targetName to "${safeName}"
  set found to false
  if targetName is not "" then
    repeat with w in windows
      try
        if name of w is targetName then
          select w
          set found to true
          exit repeat
        end if
      end try
    end repeat
  end if
  if not found then
    try
      tell window ${s.windowIndex || 1}
        select
      end tell
    end try
  end if
end tell`;
    } else {
      // 完全不知道 session ── 激活 Terminal.app 让用户处理.
      scr = `tell application "Terminal"\n  activate\nend tell`;
    }
    await runAppleScript(scr);
    if (consumedTaskDone) {
      _taskDoneSession = null;
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('pet-update', { taskDoneAvailable: false });
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-terminal-sessions', async () => {
  const tmpScript = path.join(os.tmpdir(), `term_get_${Date.now()}.js`);
  // Claude Code (and other Ink-based CLIs) render to the alternate screen buffer.
  // Terminal.app t.contents() only returns the main buffer, missing the current prompt.
  // System Events accessibility API reads what is visually rendered on screen,
  // capturing the alternate screen. We use it to supplement t.contents() for the
  // selected (visible) tab of each window.
  const script = `
    const results = [];

    // Read the current on-screen text for a Terminal window via accessibility API.
    // This captures alternate-screen content (Ink/vim/etc.) that t.contents() misses.
    // Returns empty string if accessibility permission is not granted or read fails.
    function axScreenContent(axWin) {
      if (!axWin) return '';
      try {
        try { return axWin.tabGroups[0].scrollAreas[0].textAreas[0].value() || ''; } catch(e) {}
        try { return axWin.scrollAreas[0].textAreas[0].value() || ''; } catch(e) {}
      } catch(e) {}
      return '';
    }

    // Pre-load System Events accessibility windows once (avoid repeated Application() calls).
    let axWins = [];
    try {
      const se = Application('System Events');
      const tp = se.processes.byName('Terminal');
      axWins = tp.windows();
    } catch(e) {}

    try {
      const Terminal = Application('Terminal');
      if (Terminal.running()) {
        let wins = []; try { wins = Terminal.windows(); } catch(e) {}
        wins.forEach((w, wi) => {
          let wId = 0; try { wId = w.id(); } catch(e) {}
          let wName = ''; try { wName = w.name(); } catch(e) {}
          let tabs = []; try { tabs = w.tabs(); } catch(e) {}

          // Find which tab is currently selected (1-based index).
          let selIdx = 1;
          try { selIdx = w.selectedTab().index(); } catch(e) {}

          // Accessibility screen content for this window's visible tab.
          const axContent = axScreenContent(axWins[wi]);

          tabs.forEach((t, ti) => {
            let content = ''; try { content = t.contents() || ''; } catch(e) {}
            let tabName = ''; try { tabName = t.customTitle() || ''; } catch(e) {}
            let busy = false; try { busy = t.busy(); } catch(e) {}

            // For the selected tab, append accessibility content so both sources
            // are searchable. axContent has the current screen (incl. alternate buffer);
            // content has scrollback history. Combined gives best coverage.
            let combined = content;
            if (ti + 1 === selIdx && axContent) {
              combined = content + '\\n' + axContent;
            }

            const lines = combined.split('\\n');
            results.push({
              app: 'Terminal',
              windowIndex: wi + 1,
              windowId: wId,
              windowName: wName,
              tabIndex: ti + 1,
              tabName: tabName,
              sessionId: 0,
              busy: busy,
              lastLines: lines.slice(-20).join('\\n')
            });
          });
        });
      }
    } catch(e) {}
    try {
      const iTerm = Application('iTerm2');
      if (iTerm.running()) {
        let wins = []; try { wins = iTerm.windows(); } catch(e) {}
        wins.forEach((w, wi) => {
          let wName = ''; try { wName = w.name(); } catch(e) {}
          let tabs = []; try { tabs = w.tabs(); } catch(e) {}
          tabs.forEach((t, ti) => {
            let tName = ''; try { tName = t.name() || ''; } catch(e) {}
            let sessions = []; try { sessions = t.sessions(); } catch(e) {}
            sessions.forEach((s, si) => {
              let content = ''; try { content = s.contents() || ''; } catch(e) {}
              let sName = ''; try { sName = s.name() || ''; } catch(e) {}
              const lines = content.split('\\n');
              results.push({
                app: 'iTerm2',
                windowIndex: wi + 1,
                windowId: 0,
                windowName: wName,
                tabIndex: ti + 1,
                tabName: tName || sName,
                sessionId: si + 1,
                busy: false,
                lastLines: lines.slice(-20).join('\\n')
              });
            });
          });
        });
      }
    } catch(e) {}
    JSON.stringify(results);
  `;
  const axTrusted = systemPreferences.isTrustedAccessibilityClient(false);
  try {
    fs.writeFileSync(tmpScript, script);
    const { stdout } = await execAsync(`osascript -l JavaScript "${tmpScript}"`, { timeout: 6000 });
    fs.unlinkSync(tmpScript);
    return { sessions: JSON.parse(stdout.trim() || '[]'), axTrusted };
  } catch (e) {
    try { fs.unlinkSync(tmpScript); } catch(_) {}
    return { error: e.message, sessions: [], axTrusted };
  }
});

ipcMain.handle('send-terminal-input', async (_, { app, windowIndex, windowId, tabIndex, sessionId, text }) => {
  const ts = Date.now();
  try {
    if (app === 'Terminal') {
      // "do script" sends text + implicit Enter to a Terminal tab's stdin.
      // "write string" (old approach) raises -1700 on macOS Sequoia.
      const char = text.replace(/[\n\r]/g, '');
      const windowRef = windowId ? `window id ${windowId}` : `window ${windowIndex}`;
      let script;
      if (char === '\t' || char === '\x1b') {
        // Tab / Esc: use System Events keystroke (briefly focuses Terminal)
        const keyCode = char === '\t' ? 48 : 53;
        script = `tell application "Terminal"\n  activate\n  set targetTab to tab ${tabIndex} of ${windowRef}\n  set index of ${windowRef} to 1\nend tell\ntell application "System Events"\n  tell process "Terminal"\n    key code ${keyCode}\n  end tell\nend tell`;
      } else if (char === '') {
        // Enter key: do script "" is unreliable for Ink/full-screen apps (Claude Code etc.).
        // System Events Return (key code 36) is delivered directly to the focused process.
        script = `tell application "Terminal"\n  activate\n  set index of ${windowRef} to 1\nend tell\ntell application "System Events"\n  tell process "Terminal"\n    key code 36\n  end tell\nend tell`;
      } else {
        // Regular text: do script sends TEXT + newline to stdin
        const safeStr = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        script = `tell application "Terminal"\n  do script "${safeStr}" in tab ${tabIndex} of ${windowRef}\nend tell`;
      }
      const tmpScript = path.join(os.tmpdir(), `term_send_${ts}.applescript`);
      fs.writeFileSync(tmpScript, script);
      await execAsync(`osascript "${tmpScript}"`, { timeout: 4000 });
      try { fs.unlinkSync(tmpScript); } catch(_) {}
    } else {
      const tmpScript = path.join(os.tmpdir(), `term_send_${ts}.js`);
      const safeText = JSON.stringify(text);
      const script = `const iTerm = Application('iTerm2'); iTerm.windows[${windowIndex - 1}].tabs[${tabIndex - 1}].sessions[${sessionId - 1}].write({ text: ${safeText} });`;
      fs.writeFileSync(tmpScript, script);
      await execAsync(`osascript -l JavaScript "${tmpScript}"`, { timeout: 4000 });
      try { fs.unlinkSync(tmpScript); } catch(_) {}
    }
    state = store.addXP(state, 3);
    broadcastPetUpdate();
    return { ok: true, xp: state.pet.xp, level: state.pet.level };
  } catch (e) {
    return { error: e.message };
  }
});

const _FIN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

ipcMain.handle('get-finance-data', async () => {
  const results = {};
  const hdrs     = { 'User-Agent': _FIN_UA, 'Accept': 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  const sinaHdrs = { ...hdrs, 'Referer': 'https://finance.sina.com.cn/' };

  await Promise.allSettled([

    // ── 汇率: USD/CNY + USD/JPY via ExchangeRate-API ─────────────────────────
    (async () => {
      const r = await net.fetch('https://open.er-api.com/v6/latest/USD', { headers: hdrs });
      if (!r.ok) throw new Error(`ExRate HTTP ${r.status}`);
      const d = await r.json();
      if (d.result !== 'success') throw new Error('ExRate: ' + (d['error-type'] || 'error'));
      if (d.rates.CNY) results.usdcny = { price: d.rates.CNY, prevClose: null };
      if (d.rates.JPY) results.usdjpy = { price: d.rates.JPY, prevClose: null };
    })(),

    // ── 国际金价: 东方财富 SHFE AU0 → 新浪 nf_AU0/Au99.99 ─────────────────
    (async () => {
      // 1. 东方财富 (fltt=2 返回浮点价格，单位 CNY/克)
      let emRaw = '';
      try {
        const r = await net.fetch(
          'https://push2.eastmoney.com/api/qt/stock/get?secid=113.AU0&fltt=2&fields=f43,f60,f58',
          { headers: hdrs }
        );
        if (r.ok) {
          emRaw = await r.text();
          const d = JSON.parse(emRaw);
          const price = d.data?.f43;
          if (price >= 400 && price <= 3000) {
            results.gold_cny_per_gram = { price, prevClose: d.data.f60 || null };
            return;
          }
        }
      } catch (_) {}

      // 2. 新浪 Au99.99 + nf_AU0
      const r2 = await net.fetch('https://hq.sinajs.cn/list=Au99.99,nf_AU0', { headers: sinaHdrs });
      if (!r2.ok) throw new Error(`Sina/Gold HTTP ${r2.status} | EM: ${emRaw.slice(0, 60)}`);
      const raw2 = await r2.text();
      const blocks = [...raw2.matchAll(/hq_str_[^=\s"]+\s*=\s*"([^"]*)"/g)];
      let price = null, prev = null;
      for (const b of blocks) {
        for (const f of b[1].split(',')) {
          const v = parseFloat(f);
          if (v >= 400 && v <= 3000) { if (!price) price = v; else if (!prev && Math.abs(v-price)/price < 0.05) { prev = v; break; } }
        }
        if (price) break;
      }
      if (!price) throw new Error(`金价三源失败. EM:${emRaw.slice(0,80)} Sina:${raw2.slice(0,80)}`);
      results.gold_cny_per_gram = { price, prevClose: prev };
    })(),

    // ── 上证指数: 新浪财经 ────────────────────────────────────────────────────
    (async () => {
      const r = await net.fetch('https://hq.sinajs.cn/list=s_sh000001', { headers: sinaHdrs });
      if (!r.ok) throw new Error(`Sina/SSE HTTP ${r.status}`);
      const text = await r.text();
      const m = text.match(/hq_str_s_sh000001="([^"]*)"/);
      if (!m?.[1]) throw new Error('Sina/SSE: 空数据');
      const p = m[1].split(',');
      // 简版格式: [0]名称 [1]当前 [2]涨跌 [3]涨跌幅 [4]成交量 [5]成交额
      const price = parseFloat(p[1]);
      const change = parseFloat(p[2]);
      if (isNaN(price)) throw new Error('Sina/SSE: 无效价格');
      results.shanghai = { price, prevClose: isNaN(change) ? null : +(price - change).toFixed(2) };
    })(),

    // ── 日经225: 东方财富搜索→动态secid → 腾讯 → 新浪 ─────────────────────
    (async () => {
      // 1. 东方财富搜索 API：动态查找日经225的真实 secid，再拉价格
      try {
        const sr = await net.fetch(
          'https://searchapi.eastmoney.com/api/suggest/get?input=%E6%97%A5%E7%BB%8F225&type=14&count=5&token=D43BF722C8E33BDC906FB84D85E326E8',
          { headers: hdrs }
        );
        if (sr.ok) {
          const sd = await sr.json();
          for (const item of (sd.QuotationCodeTable?.Data || [])) {
            const secid = `${item.MktNum}.${item.Code}`;
            const pr = await net.fetch(
              `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&fields=f43,f60,f58`,
              { headers: hdrs }
            );
            if (pr.ok) {
              const pd = await pr.json();
              const price = pd.data?.f43;
              if (typeof price === 'number' && price > 10000) {
                results.nikkei = { price, prevClose: pd.data?.f60 || null };
                return;
              }
            }
          }
        }
      } catch (_) {}

      // 2. 腾讯财经：r_hkHSI 确认可用，日经尝试多种代码
      let tencentRaw = '';
      try {
        const NIKKEI_CODES = ['r_jpNKX','r_jpNKXC','r_jpNI225','r_jpNK225','r_jpNKY','r_NKXX','r_NKXC'];
        const r = await net.fetch(
          `https://qt.gtimg.cn/q=${[...NIKKEI_CODES, 'r_hkHSI'].join(',')}`,
          { headers: { ...hdrs, 'Referer': 'https://finance.qq.com/' } }
        );
        if (r.ok) {
          tencentRaw = await r.text();
          for (const code of NIKKEI_CODES) {
            const m = tencentRaw.match(new RegExp(`v_${code}="([^"]+)"`));
            if (!m?.[1]) continue;
            const f = m[1].split('~');
            const price = parseFloat(f[3]);
            if (price > 10000) {
              results.nikkei = { price, prevClose: parseFloat(f[4]) || null };
              return;
            }
          }
        }
      } catch (e) { tencentRaw = String(e); }

      // 3. 新浪 int_n225（仅日本市场交易时段有数据）
      try {
        const r = await net.fetch('https://hq.sinajs.cn/list=int_n225', { headers: sinaHdrs });
        if (r.ok) {
          const text = await r.text();
          const m = text.match(/hq_str_int_n225\s*=\s*"([^"]+)"/);
          if (m) {
            for (const f of m[1].split(',')) {
              const v = parseFloat(f);
              if (v > 10000) { results.nikkei = { price: v, prevClose: null }; return; }
            }
          }
        }
      } catch (_) {}

      // 4. 网易财经
      let neRaw = '';
      try {
        const r = await net.fetch('https://api.money.126.net/data/feed/NI225,money.api', {
          headers: { ...hdrs, 'Referer': 'https://money.163.com/' }
        });
        if (r.ok) {
          neRaw = await r.text();
          const m = neRaw.match(/\(({[\s\S]+})\)/);
          if (m) {
            const q = JSON.parse(m[1]).NI225;
            if (q?.price > 10000) { results.nikkei = { price: q.price, prevClose: q.yestclose || null }; return; }
          }
        }
      } catch (e) { neRaw = String(e); }

      results.nikkei = { error: `EM搜索/腾讯均失败 T:${tencentRaw.slice(0,50)} NE:${neRaw.slice(0,30)}` };
    })(),

    // ── 道琼斯工业指数: 腾讯 r_usDJI → 新浪 int_dji ─────────────────────────
    (async () => {
      // 腾讯财经：r_us 前缀 + DJI（Bloomberg代码），与 r_hkHSI 同一格式
      try {
        const r = await net.fetch('https://qt.gtimg.cn/q=r_usDJI', {
          headers: { ...hdrs, 'Referer': 'https://finance.qq.com/' }
        });
        if (r.ok) {
          const text = await r.text();
          const m = text.match(/v_r_usDJI="([^"]+)"/);
          if (m?.[1]) {
            const f = m[1].split('~');
            const price = parseFloat(f[3]);
            if (price > 1000) { results.djia = { price, prevClose: parseFloat(f[4]) || null }; return; }
          }
        }
      } catch (_) {}

      // 新浪 int_dji（仅美国市场交易时段有数据）
      try {
        const r = await net.fetch('https://hq.sinajs.cn/list=int_dji', { headers: sinaHdrs });
        if (r.ok) {
          const text = await r.text();
          const m = text.match(/hq_str_int_dji\s*=\s*"([^"]+)"/);
          if (m) {
            for (const f of m[1].split(',')) {
              const v = parseFloat(f);
              if (v > 1000) { results.djia = { price: v, prevClose: null }; return; }
            }
          }
        }
      } catch (_) {}

      results.djia = { error: '道指数据不可用' };
    })(),

  ]);

  if (!results.gold_cny_per_gram) {
    results.gold_cny_per_gram = { error: '金价数据不可用' };
  }
  if (!results.djia) {
    results.djia = { error: '道指未返回' };
  }
  if (!results.nikkei) {
    results.nikkei = { error: 'Nikkei: 数据未返回' };
  }

  return results;
});

function broadcastPetUpdate() {
  const payload = { pet: state.pet, xpProgress: store.getXPProgress(state), aiProvider: state.aiProvider, reminderList: state.reminderList };
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-update', payload);
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pet-update', payload);
}
