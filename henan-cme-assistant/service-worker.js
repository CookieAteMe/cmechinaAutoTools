/**
 * service-worker.js — 河南医继续教育学习助手 · 后台 Service Worker
 *
 * 职责：
 *  1. 安装时写入默认设置（popup/content 未运行时也保证设置存在）；
 *  2. 系统通知：接收 content script 的 HNYX_NOTIFY（验证码弹窗提醒）→ chrome.notifications；
 *  3. 通知点击 → 聚焦目标站点标签页（仅本地 UI 行为，无任何数据外发）。
 * 原则：不做任何网络请求、不采集任何数据。
 */
'use strict';

const SETTINGS_KEY = 'hnyxSettings';
const NOTIFY_ID = 'hnyx-captcha-notify';
const DEFAULT_SETTINGS = {
  autoSwitch: true,
  videoEnd: true,
  captchaPause: true,
  diagnosis: true,
  titleFlash: true,
  sysNotify: true,
  floatingPanel: true
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    if (!res[SETTINGS_KEY]) {
      chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    }
  });
});

// content script 验证码弹窗提醒 → 系统通知
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'HNYX_PING_SW') {
    sendResponse({ ok: true, sw: true });
    return false;
  }
  if (msg.type === 'HNYX_NOTIFY') {
    try {
      chrome.notifications.create(NOTIFY_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: String(msg.title || '河南医学习助手'),
        message: String(msg.message || '打卡验证码已弹出，请完成滑动拼图验证。'),
        priority: 2
      }, () => {
        sendResponse({ ok: true, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
      });
      return true; // 异步 sendResponse
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
      return false;
    }
  }
  return false;
});

// 点击通知 → 聚焦目标站点标签页（本地 UI 行为）
chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIFY_ID) return;
  chrome.tabs.query({ url: 'https://yuancheng.henanyixue.com/*' }, (tabs) => {
    if (!tabs || !tabs.length) return;
    const tab = tabs[0];
    if (tab.id != null) chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
  });
});
