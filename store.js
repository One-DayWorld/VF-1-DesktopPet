const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.desktop-pet');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const XP_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2200, 3100, 4300, 6000];

const DEFAULT_STATE = {
  pet: { name: '骷髅一号', level: 1, xp: 0, mood: 'happy', avatar: '🐕' },
  chatHistory: [],
  aiProvider: 'qwen',
  apiKeys: { qwen: '', deepseek: '', doubao: '', ollama: '', metaso: '' },
  petPosition: { x: 100, y: 100 },
  reminderList: '',
  workflows: [],
  alertSoundEnabled: true,
  breakReminder: { enabled: true, intervalMin: 60 },
  edgePatrol:    { enabled: true }
};

function calcLevelFromXP(xp) {
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    const merged = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_STATE)), data);
    // migrate old single apiKey field (远古版本: 只有一个 apiKey 字段)
    if (data.apiKey && !merged.apiKeys.qwen) {
      merged.apiKeys.qwen = data.apiKey;
      delete merged.apiKey;
    }
    merged.apiKeys = Object.assign({}, DEFAULT_STATE.apiKeys, merged.apiKeys);
    // 旧版 provider claude/openai 改名为 qwen/doubao — 字段直接搬, key 不能复用 (sk-ant 在 DashScope 上不通)
    // 所以只迁移 provider 选择, 不迁移 apiKey, 用户重填即可
    if (merged.aiProvider === 'claude') merged.aiProvider = 'qwen';
    if (merged.aiProvider === 'openai') merged.aiProvider = 'doubao';
    // 清理已经无效的旧 key 字段, 不让它们一直挂在 data.json 里
    if (merged.apiKeys.claude !== undefined) delete merged.apiKeys.claude;
    if (merged.apiKeys.openai !== undefined) delete merged.apiKeys.openai;
    // deep merge pet to fill any missing fields
    merged.pet = Object.assign({}, DEFAULT_STATE.pet, merged.pet);
    // deep merge breakReminder for older data files that don't have this field
    merged.breakReminder = Object.assign({}, DEFAULT_STATE.breakReminder, merged.breakReminder || {});
    merged.edgePatrol    = Object.assign({}, DEFAULT_STATE.edgePatrol,    merged.edgePatrol    || {});
    // always recalculate level from XP to ensure consistency
    merged.pet.level = calcLevelFromXP(merged.pet.xp || 0);
    return merged;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function save(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

function addXP(state, amount) {
  state.pet.xp += amount;
  state.pet.level = calcLevelFromXP(state.pet.xp);
  return state;
}

function getXPProgress(state) {
  const level = state.pet.level;
  const maxLevel = XP_THRESHOLDS.length;
  if (level >= maxLevel) return { current: state.pet.xp, needed: XP_THRESHOLDS[maxLevel - 1], percent: 100 };
  const currentThreshold = XP_THRESHOLDS[level - 1] || 0;
  const nextThreshold = XP_THRESHOLDS[level];
  const progress = state.pet.xp - currentThreshold;
  const needed = nextThreshold - currentThreshold;
  return { current: state.pet.xp, needed: nextThreshold, percent: Math.floor((progress / needed) * 100) };
}

module.exports = { load, save, addXP, getXPProgress, XP_THRESHOLDS };
