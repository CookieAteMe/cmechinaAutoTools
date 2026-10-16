/**
 * popup.js — 控制面板逻辑
 * 数据来源：chrome.storage.local（content script 写入的日志/实时快照/诊断）+ 主动向 content script 请求快照。
 */
'use strict';

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'hnyxSettings';
const LOG_KEY = 'hnyxLogs';
const LIVE_KEY = 'hnyxLive';
const DIAG_KEY = 'hnyxDiag';

let live = null;
let settings = null;

/* ---------- 与 content script 通信 ---------- */
function sendToContent(msg) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { resolve({ ok: false, reason: 'no-tab' }); return; }
      try {
        chrome.tabs.sendMessage(tab.id, msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, reason: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: true });
          }
        });
      } catch (e) {
        resolve({ ok: false, reason: String(e) });
      }
    });
  });
}

function activeTabIsTarget() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      resolve(!!tab && !!tab.url && /^https:\/\/yuancheng\.henanyixue\.com\//.test(tab.url));
    });
  });
}

/* ---------- 渲染 ---------- */
function renderSwitches() {
  if (!settings) return;
  $('swAuto').checked = !!settings.autoSwitch;
  $('swEnd').checked = !!settings.videoEnd;
  $('swCaptcha').checked = !!settings.captchaPause;
  $('swDiag').checked = !!settings.diagnosis;
  $('swFlash').checked = !!settings.titleFlash;
  $('swNotify').checked = !!settings.sysNotify;
  $('swPanel').checked = !!settings.floatingPanel;
}

function renderLive() {
  if (!live) return;
  $('stTitle').textContent = live.courseTitle || '—';
  $('stVideo').textContent = live.videoStateLabel || live.videoState || '—';
  $('progFill').style.width = (live.progressPct || 0) + '%';
  $('progText').textContent = `${live.currentTime || 0}s / ${live.duration || 0}s (${live.progressPct || 0}%)`;

  const capEl = $('stCaptcha');
  if (live.captchaActive) {
    capEl.textContent = live.videoStateLabel === '等待人工验证' ? '弹窗中 · 等待人工完成' : '弹窗中';
    capEl.className = 'v captcha active';
  } else {
    capEl.textContent = '未出现';
    capEl.className = 'v captcha';
  }
  $('stPending').textContent = live.pendingSwitch ? '是' : '否';

  const badge = $('masterBadge');
  if (live.masterPause) {
    badge.textContent = '已暂停';
    badge.className = 'badge paused';
  } else {
    badge.textContent = '运行中';
    badge.className = 'badge running';
  }
}

function renderLogs() {
  chrome.storage.local.get(LOG_KEY, (res) => {
    const arr = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
    $('logCount').textContent = arr.length;
    const list = $('logList');
    list.innerHTML = '';
    arr.slice(-120).forEach((e) => {
      const div = document.createElement('div');
      div.className = 'log-item ' + (e.level || 'info');
      const lt = document.createElement('span'); lt.className = 'lt'; lt.textContent = e.ts || '';
      const lv = document.createElement('span'); lv.className = 'lv'; lv.textContent = (e.level || '').toUpperCase();
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = e.tag || '';
      const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = e.msg || '';
      div.append(lt, lv, tag, msg);
      list.appendChild(div);
    });
    list.scrollTop = list.scrollHeight;
  });
}

function renderDiag() {
  chrome.storage.local.get(DIAG_KEY, (res) => {
    const arr = Array.isArray(res[DIAG_KEY]) ? res[DIAG_KEY] : [];
    const body = $('diagBody');
    if (!arr.length) { body.textContent = '暂无诊断记录（验证码弹窗出现时自动生成）。'; return; }
    const s = arr[0];
    const trans = (s.transitions || []).map((t) => `${t.t} ${t.className}`).join('\n') || '无';
    body.textContent =
      `会话开始：${s.atTs || ''}\n` +
      `观察事件数：${s.events || 0}\n` +
      `状态迁移（sliderContainer 类名变化）：\n${trans}\n` +
      `说明：诊断为纯被动观察；「滑动拼图」校验为前端内置（位置±10px + Y轴轨迹波动），后端学习判定依赖进度上报，插件不自动滑动验证码。`;
  });
}

/* ---------- 事件 ---------- */
function bindEvents() {
  const patch = (key, val) => {
    const p = { [key]: val };
    sendToContent({ type: 'HNYX_SETTINGS', patch: p });
    settings = { ...settings, ...p };
    renderSwitches();
  };
  $('swAuto').addEventListener('change', (e) => patch('autoSwitch', e.target.checked));
  $('swEnd').addEventListener('change', (e) => patch('videoEnd', e.target.checked));
  $('swCaptcha').addEventListener('change', (e) => patch('captchaPause', e.target.checked));
  $('swDiag').addEventListener('change', (e) => patch('diagnosis', e.target.checked));
  $('swFlash').addEventListener('change', (e) => patch('titleFlash', e.target.checked));
  $('swNotify').addEventListener('change', (e) => patch('sysNotify', e.target.checked));
  $('swPanel').addEventListener('change', (e) => patch('floatingPanel', e.target.checked));

  $('btnRescan').addEventListener('click', () => sendToContent({ type: 'HNYX_RESCAN' }));
  $('btnPause').addEventListener('click', () => sendToContent({ type: 'HNYX_PAUSE_ALL' }));
  $('btnResume').addEventListener('click', () => sendToContent({ type: 'HNYX_RESUME_ALL' }));
  $('btnClear').addEventListener('click', () => sendToContent({ type: 'HNYX_CLEAR_LOGS' }));
  $('btnDiagToggle').addEventListener('click', () => $('diagBody').classList.toggle('hidden'));
}

/* ---------- 数据订阅 ---------- */
function subscribeStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[LIVE_KEY]) { live = changes[LIVE_KEY].newValue; renderLive(); }
    if (changes[SETTINGS_KEY]) { settings = changes[SETTINGS_KEY].newValue; renderSwitches(); }
    if (changes[LOG_KEY]) renderLogs();
    if (changes[DIAG_KEY]) renderDiag();
  });
}

/* ---------- 初始化 ---------- */
async function init() {
  bindEvents();
  subscribeStorage();

  const isTarget = await activeTabIsTarget();
  const isSupported = await new Promise((r) => chrome.storage.local.get(SETTINGS_KEY, (res) => r(!!res[SETTINGS_KEY])));

  chrome.storage.local.get([SETTINGS_KEY, LIVE_KEY, DIAG_KEY], (res) => {
    settings = res[SETTINGS_KEY] || { autoSwitch: true, videoEnd: true, captchaPause: true, diagnosis: true, titleFlash: true, sysNotify: true, floatingPanel: true };
    live = res[LIVE_KEY] || null;
    renderSwitches();
    renderLive();
    renderDiag();
  });
  renderLogs();

  if (!isTarget) {
    $('stTitle').textContent = '请打开目标站点页面';
    $('stVideo').textContent = '—';
    $('stCaptcha').textContent = '不在目标站点';
    $('stCaptcha').className = 'v captcha active';
    return;
  }

  const res = await sendToContent({ type: 'HNYX_GET_SNAPSHOT' });
  if (res && res.ok && res.live) {
    live = res.live;
    renderLive();
  } else {
    // content script 尚未就绪（如刚安装未刷新页面）
    $('stTitle').textContent = '内容脚本未响应';
    $('stVideo').textContent = '请刷新课程页后重试';
  }
}

init();
