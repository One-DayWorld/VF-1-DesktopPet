// 离屏渲染 Battloid 在不同 (yaw, pitch) 下的静态姿态, 输出 PNG 供肉眼挑选休息提醒中央角度
// 用法: ./node_modules/.bin/electron scripts/capture-pose.js   产物: docs/pose/*.png
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const W = 280, H = 404;
const POSES = [
  { label: 'FINAL_y30_break', yaw: 30, pitch: -0.06 },   // 最终选定: 斜30° + 略挺胸
];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  await win.loadFile(path.join(__dirname, 'pose.html'));
  try { await win.webContents.executeJavaScript('window.__ready.then(() => true)'); }
  catch (e) { console.error('[POSE] 模型加载失败:', e.message); app.exit(1); return; }

  const outDir = path.join(__dirname, '..', 'docs', 'pose');
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of POSES) {
    await win.webContents.executeJavaScript(`window.__pose(${p.yaw}, ${p.pitch})`);
    await sleep(80);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, p.label + '.png'), img.toPNG());
    console.log('[POSE] saved', p.label);
  }
  console.log('[POSE] done →', outDir);
  app.exit(0);
});
