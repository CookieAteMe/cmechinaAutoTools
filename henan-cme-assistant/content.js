/**
 * content.js — 河南省继续医学教育学习平台 · 前端 DOM 监测辅助学习
 *
 * 设计原则（与油猴脚本共存、不越界）：
 *   1. 不改写任何 HTMLMediaElement / 其他原型方法；
 *   2. 不劫持、不覆盖页面原生事件（只 addEventListener，被动观察为主，绝不 preventDefault/stopPropagation 页面事件）；
 *   3. 不读取油猴脚本（GM_*）变量、不与其共享任何内部状态；
 *   4. 不绕过后端校验：验证码弹窗出现 → 暂停自动切换 → 被动诊断 → 等待人工完成 → 复核后安全恢复；
 *   5. 数据仅写入 chrome.storage.local（本地），不上传账号 / cookie / 页面数据。
 *
 * 平台事实（已通过对 https://yuancheng.henanyixue.com/ 静态包分析验证，详见《验证码组件技术诊断报告》）：
 *   - 学习页为 Vue SPA（detail-C78Rx8MT.js），课程列表：<li><h3 class="suspension"><span>课程名</span>…；
 *   - 当前课程无 DOM 高亮类，仅存在于 Vue 内部状态，插件以「维护的课程标题 + 播放源变化」定位；
 *   - 播放器组件 playVideo 在打卡时间点（服务端下发 playSrc.clock）暂停并弹出 el-dialog > .vertifyWrap；
 *   - 验证码组件为 Vue SFC（scopeId data-v-befb03b7），校验纯前端：拼图位置 ±10px + Y 轴轨迹标准差非零；
 *   - 切课 = 点击课程列表 li → 播放器以 key 重挂载（video 元素重建、src 变化）。
 */

(() => {
  'use strict';
  if (window.__hnyxContentLoaded) return;
  window.__hnyxContentLoaded = true;

  /* ============================== 常量 ============================== */
  const PREFIX = '[HNYX]';
  const SETTINGS_KEY = 'hnyxSettings';
  const LOG_KEY = 'hnyxLogs';
  const LIVE_KEY = 'hnyxLive';
  const DIAG_KEY = 'hnyxDiag';

  const DEFAULT_SETTINGS = Object.freeze({
    autoSwitch: true,   // 自动切换下一节
    videoEnd: true,     // 视频结束检测
    captchaPause: true, // 验证码弹窗时暂停自动切换
    diagnosis: true,    // 诊断模式（验证码组件被动诊断）
    titleFlash: true,   // 验证码弹窗时标签页标题闪烁提醒
    sysNotify: true,    // 验证码弹窗时系统通知提醒
    floatingPanel: true // 课程页内浮窗控制面板
  });

  const MAX_LOGS = 400;        // 日志环形缓冲上限
  const POLL_MS = 5000;        // 低频轮询兜底
  const STALL_MS = 90000;      // 播放停滞判定阈值（非暂停但进度不动）
  const USER_INT_MS = 600;     // 用户交互后多少毫秒内的 pause 视为用户暂停
  const VIDEO_CLICK_MS = 800;  // 点击视频元素后多少毫秒内的 pause 视为用户暂停
  const BLUR_MS = 1000;        // 窗口失焦后多少毫秒内的 pause 视为失焦暂停
  const RESUME_THROTTLE_MS = 5000; // 安全恢复播放的最小间隔（防与平台/油猴双重触发）
  const SWITCH_RETRIES = 3;    // 切换失败有限重试次数（含首次）
  const SWITCH_VERIFY_MS = 9000; // 切换校验窗口
  const SWITCH_VERIFY_INTERVAL = 400;
  const CAPTCHA_SEL = '.vertifyWrap';
  const END_DEDUPE_MS = 120000; // 同一课程 ended 去重窗口
  const NOTIFY_COOLDOWN_MS = 30000; // 同一验证码会话系统通知冷却
  const FLASH_MS = 900;          // 标题闪烁切换间隔
  const PANEL_LOG_LIMIT = 30;    // 浮窗日志环形上限（内存）

  // 播放器状态（对外口径）
  const VS = {
    NO_PLAYER: 'NO_PLAYER',       // 无播放器
    PLAYING: 'PLAYING',           // 播放中
    USER_PAUSED: 'USER_PAUSED',   // 用户手动暂停
    PLATFORM_PAUSED: 'PLATFORM_PAUSED', // 平台暂停（切后台/打卡等）
    VIDEO_ENDED: 'VIDEO_ENDED',   // 视频结束
    SWITCHING: 'SWITCHING',       // 切换中
    CAPTCHA: 'CAPTCHA',           // 验证码弹窗
    WAIT_MANUAL: 'WAIT_MANUAL',   // 等待人工验证（验证码阻断切课）
    SWITCH_FAILED: 'SWITCH_FAILED', // 切换失败
    COURSE_COMPLETE: 'COURSE_COMPLETE' // 课程全部完成
  };
  const VS_LABEL = {
    NO_PLAYER: '无播放器', PLAYING: '播放中', USER_PAUSED: '用户暂停',
    PLATFORM_PAUSED: '平台暂停', VIDEO_ENDED: '视频结束', SWITCHING: '切换中',
    CAPTCHA: '验证码弹窗', WAIT_MANUAL: '等待人工验证', SWITCH_FAILED: '切换失败',
    COURSE_COMPLETE: '课程全部完成'
  };

  /* ============================== 状态 ============================== */
  const state = {
    settings: { ...DEFAULT_SETTINGS },
    masterPause: false,       // 面板「暂停/恢复自动化」
    videoState: VS.NO_PLAYER,
    video: null,              // 当前绑定的 video 元素
    boundVideo: null,         // 已绑定事件的 video 元素（用于比较是否变化）
    courseTitle: '',          // 当前课程标题（维护值）
    userPaused: false,        // 最近一次暂停是否用户发起
    lastUserInteractAt: 0,    // 页面级用户交互时间
    lastVideoClickAt: 0,      // 视频元素点击时间
    windowBlurAt: 0,          // 窗口最近一次失焦时间
    lastSafeResumeAt: 0,      // 最近一次安全恢复播放时间（节流）
    captchaActive: false,
    captchaShownAt: 0,
    captchaPauseBlock: false, // 验证码暂停切课生效中
    pendingSwitch: false,     // 有未完成的切课请求（ended 后等待验证码/自动）
    switchInFlight: false,
    switchAttempts: 0,
    endedHandledKey: '',      // 已完成（成功或终态失败）切课的课程 key，去重
    lastTime: 0,              // 轮询用的 currentTime
    lastTimeAt: 0,
    pollTimer: null,
    videoObserverTimer: null,
    diagObserver: null,
    diagListeners: [],
    diagSession: null,        // 本次验证码诊断会话
    liveSeq: 0,
    // —— 提醒与浮窗 ——
    flashTimer: null,         // 标题闪烁定时器
    originalTitle: '',        // 闪烁前的原标题（用于恢复）
    lastNotifyAt: 0,          // 最近一次系统通知时间（冷却）
    panelLogs: [],            // 浮窗日志环形缓冲（内存）
    panel: null,              // 浮窗 host 元素（Shadow DOM）
    panelCollapsed: false
  };

  /* ============================== 工具 ============================== */
  function now() { return Date.now(); }
  function ts() {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function visibleEl(el) {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  }
  function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // 视频元素 → 事件处理函数的映射（WeakMap，不在页面元素上留任何扩展属性）
  const handlersMap = new WeakMap();

  /* ============================== 日志 ============================== */
  function pushLog(level, cat, msg, tag) {
    const entry = { t: now(), ts: ts(), level, cat, msg: String(msg), tag: tag || '' };
    try {
      chrome.storage.local.get(LOG_KEY, (res) => {
        const arr = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
        arr.push(entry);
        if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
        chrome.storage.local.set({ [LOG_KEY]: arr });
      });
    } catch (e) { /* storage 不可用时静默 */ }
    // eslint-disable-next-line no-console
    console.log(PREFIX, entry.ts, level, cat, tag, msg);
    // 浮窗日志环形缓冲（内存，仅最近若干条）
    state.panelLogs.push(entry);
    if (state.panelLogs.length > PANEL_LOG_LIMIT) state.panelLogs.splice(0, state.panelLogs.length - PANEL_LOG_LIMIT);
    updatePanel();
  }
  const logInfo = (cat, msg, tag) => pushLog('info', cat, msg, tag);
  const logWarn = (cat, msg, tag) => pushLog('warn', cat, msg, tag);
  const logErr = (cat, msg, tag) => pushLog('error', cat, msg, tag);
  const logDiag = (cat, msg, tag) => pushLog('diag', cat, msg, tag);

  /* ============================== 设置 ============================== */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (res) => {
        const s = res[SETTINGS_KEY];
        if (s && typeof s === 'object') state.settings = { ...DEFAULT_SETTINGS, ...s };
        resolve();
      });
    });
  }
  function saveSettings(patch) {
    state.settings = { ...state.settings, ...patch };
    chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SETTINGS_KEY]) {
      const s = changes[SETTINGS_KEY].newValue;
      if (s && typeof s === 'object') {
        const prevAuto = state.settings.autoSwitch;
        state.settings = { ...DEFAULT_SETTINGS, ...s };
        logInfo('设置', `设置已更新：自动切换=${state.settings.autoSwitch} 结束检测=${state.settings.videoEnd} 验证码暂停=${state.settings.captchaPause} 诊断=${state.settings.diagnosis} 标题闪烁=${state.settings.titleFlash} 系统通知=${state.settings.sysNotify} 浮窗=${state.settings.floatingPanel}`);
        // 浮窗开关即时生效（关闭→隐藏；开启→创建/显示）
        if (state.settings.floatingPanel) {
          if (!state.panel) buildPanel(); else state.panel.style.display = '';
        } else if (state.panel) {
          state.panel.style.display = 'none';
        }
        // 关闭→开启自动切换时，补做之前挂起的切课
        if (!prevAuto && state.settings.autoSwitch && state.pendingSwitch && !state.captchaActive && !state.switchInFlight && !state.masterPause) {
          logInfo('切课', '自动切换已开启，补做挂起的切课');
          void doSwitch();
        }
      }
    }
  });

  /* ============================== 实时快照（供 popup） ============================== */
  function writeLive(extra) {
    const v = state.video;
    const dur = v && isFinite(v.duration) ? v.duration : 0;
    const cur = v && isFinite(v.currentTime) ? v.currentTime : 0;
    const live = {
      seq: ++state.liveSeq,
      videoState: state.videoState,
      videoStateLabel: VS_LABEL[state.videoState] || state.videoState,
      masterPause: state.masterPause,
      courseTitle: state.courseTitle,
      hasVideo: !!state.video,
      playing: !!(v && !v.paused && !v.ended),
      currentTime: Math.round(cur * 10) / 10,
      duration: Math.round(dur * 10) / 10,
      progressPct: dur > 0 ? Math.min(100, Math.round((cur / dur) * 1000) / 10) : 0,
      captchaActive: state.captchaActive,
      captchaPauseBlock: state.captchaPauseBlock,
      pendingSwitch: state.pendingSwitch,
      switchInFlight: state.switchInFlight,
      ...(extra || {})
    };
    try { chrome.storage.local.set({ [LIVE_KEY]: live }); } catch (e) { /* 忽略 */ }
  }
  const writeLiveThrottled = debounce(() => writeLive(), 500);

  /* ============================== 课程定位 ============================== */
  function courseListItems() {
    // 已验证结构：课程列表 <li><h3 class="suspension"><span>课程名</span></h3>…（detail-C78Rx8MT.js）
    const list = Array.from(document.querySelectorAll('li'))
      .filter((li) => li.querySelector('h3.suspension span') && visibleEl(li));
    if (list.length) return list;
    // 通用兜底：任意含标题文本的 li 列表
    return Array.from(document.querySelectorAll('li'))
      .filter((li) => {
        const t = norm(li.textContent);
        return t.length > 1 && t.length < 60 && visibleEl(li);
      });
  }
  function liTitle(li) {
    const s = li.querySelector('h3.suspension span');
    return norm(s ? s.textContent : (li.querySelector('h3') ? li.querySelector('h3').textContent : li.textContent));
  }
  function getCourseTitle() {
    if (state.courseTitle) return state.courseTitle;
    const items = courseListItems();
    if (items.length) {
      state.courseTitle = liTitle(items[0]);
      logInfo('课程', `初始化课程标题（取列表首项）：${state.courseTitle}`);
    } else if (document.title && norm(document.title)) {
      state.courseTitle = norm(document.title).slice(0, 60);
    }
    return state.courseTitle;
  }
  function findActiveLiIndex() {
    const items = courseListItems();
    const cur = norm(state.courseTitle);
    if (!cur || !items.length) return -1;
    // 1) 标题精确/包含匹配
    for (let i = 0; i < items.length; i++) {
      const t = norm(liTitle(items[i]));
      if (t && (t === cur || t.includes(cur) || cur.includes(t))) return i;
    }
    // 2) 状态文本匹配「学习中」的课程（平台自动续播的常见情形）
    for (let i = 0; i < items.length; i++) {
      if (/学习中/.test(items[i].textContent)) return i;
    }
    return -1;
  }
  function courseKey() {
    const v = state.video;
    const src = (v && (v.currentSrc || v.src)) || location.href;
    return `${norm(state.courseTitle)}||${src}`;
  }

  /* ============================== 视频监测 ============================== */
  function findVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    // 优先可见且面积最大者（页面可能有列表预览视频，取主播放器）
    const vis = vids.filter(visibleEl);
    const pool = vis.length ? vis : vids;
    pool.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    return pool[0] || null;
  }

  function classifyPause() {
    if (captchaPresent()) {
      logWarn('播放器', 'pause：验证码弹窗存在 → 平台暂停', '已验证');
      return VS.PLATFORM_PAUSED;
    }
    if (document.visibilityState === 'hidden') {
      logInfo('播放器', 'pause：标签页隐藏（平台 visibilitychange 暂停）→ 平台暂停', '已验证');
      return VS.PLATFORM_PAUSED;
    }
    if (!document.hasFocus() || now() - state.windowBlurAt < BLUR_MS) {
      // 页面失去鼠标焦点（窗口 blur / 被遮挡）期间暂停 → 平台/浏览器行为，非用户主动
      logInfo('播放器', 'pause：页面失焦期间 → 平台暂停（不干预）', '已验证');
      return VS.PLATFORM_PAUSED;
    }
    if (now() - state.lastVideoClickAt < VIDEO_CLICK_MS || now() - state.lastUserInteractAt < USER_INT_MS) {
      logInfo('播放器', 'pause：紧随用户交互 → 用户暂停', '观察');
      return VS.USER_PAUSED;
    }
    logInfo('播放器', 'pause：无明显用户交互 → 平台暂停（推测）', '推测');
    return VS.PLATFORM_PAUSED;
  }

  /**
   * 安全恢复播放（一次）：
   * - 仅用于「非用户主动」的暂停场景（失焦恢复 / 页面重新可见 / 人工验证完成）；
   * - 用户主动暂停、验证码未完成、自动化已暂停、视频已结束 → 一律不干预；
   * - 节流 RESUME_THROTTLE_MS，避免与油猴脚本/平台自身恢复逻辑双重触发。
   */
  function attemptSafeResume(reason, opts) {
    const o = opts || {};
    if (state.masterPause) { logInfo('播放器', `${reason}：自动化已暂停，不恢复`); return; }
    const v = state.video;
    if (!v || !document.contains(v)) return;
    if (v.ended) { handleEnded(); return; }
    if (state.captchaActive) { logInfo('播放器', `${reason}：验证码弹窗未完成，不恢复`); return; }
    if (state.userPaused) { logInfo('播放器', `${reason}：用户主动暂停，不干预`); return; }
    if (!v.paused) { setVideoState(VS.PLAYING); return; }
    if (now() - state.lastSafeResumeAt < RESUME_THROTTLE_MS) {
      logInfo('播放器', `${reason}：距上次安全恢复过近，跳过（节流）`);
      return;
    }
    // 失焦/可见性恢复路径：要求页面确实可见；失焦路径额外要求已重新获得焦点
    if (!o.allowBackground && document.visibilityState !== 'visible') return;
    if (!o.allowBackground && reason === '窗口焦点恢复' && !document.hasFocus()) return;

    state.lastSafeResumeAt = now();
    logInfo('播放器', `${reason}：非用户暂停，安全恢复播放（一次）`);
    v.play().then(() => {
      state.userPaused = false;
      setVideoState(VS.PLAYING);
    }).catch((e) => logWarn('播放器', `${reason}：恢复播放被浏览器拦截：${e && e.message ? e.message : e}`, '观察'));
  }

  function setVideoState(s, extra) {
    if (state.videoState === s) { writeLiveThrottled(); return; }
    state.videoState = s;
    logInfo('状态', `播放器状态 → ${VS_LABEL[s] || s}`);
    writeLiveThrottled();
  }

  function handleEnded() {
    const key = courseKey();
    if (state.endedHandledKey === key) {
      logInfo('切课', `ended 去重：本课程已完成切换流程（key=${key.slice(0, 40)}…）`);
      return;
    }
    // 幂等：同一轮 ended 已在处理中（等待验证码/等待切课），避免轮询重复触发与刷屏
    if (state.pendingSwitch && (state.videoState === VS.VIDEO_ENDED || state.videoState === VS.WAIT_MANUAL || state.videoState === VS.SWITCHING)) {
      return;
    }
    setVideoState(VS.VIDEO_ENDED);
    logInfo('切课', `视频播放结束（事件/兜底）key=${key.slice(0, 60)}…`);
    state.pendingSwitch = true;

    if (state.masterPause) { logWarn('切课', '自动化已暂停，不切课'); return; }
    if (!state.settings.autoSwitch) { logWarn('切课', '自动切换已关闭，不切课'); return; }
    if (state.settings.captchaPause && captchaPresent()) {
      setVideoState(VS.WAIT_MANUAL);
      logWarn('切课', '验证码弹窗存在，挂起切课，等待人工验证完成后复核');
      return;
    }
    if (state.switchInFlight) { logInfo('切课', '切换进行中，跳过本次触发'); return; }
    void doSwitch();
  }

  function bindVideo(video) {
    if (!video) return;
    if (state.boundVideo === video) return;
    const old = state.boundVideo;
    if (old) {
      const h = handlersMap.get(old);
      if (h) {
        ['play', 'pause', 'ended', 'timeupdate', 'waiting', 'playing', 'emptied', 'loadedmetadata', 'durationchange', 'seeking', 'seeked', 'click'].forEach((ev) => {
          old.removeEventListener(ev, h[ev]);
        });
        handlersMap.delete(old);
      }
    }
    state.video = video;
    state.boundVideo = video;

    const onPlay = () => {
      state.userPaused = false;
      if (!state.masterPause) setVideoState(VS.PLAYING);
    };
    const onPause = () => {
      if (video.ended) { handleEnded(); return; }
      const s = classifyPause();
      state.userPaused = (s === VS.USER_PAUSED);
      setVideoState(s);
    };
    const onEnded = () => handleEnded();
    const onTimeupdate = () => {
      if (!state.masterPause && !video.paused && !video.ended) setVideoState(VS.PLAYING);
    };
    const onWaiting = () => { /* 缓冲中，不改变主状态，仅记录 */ };
    const onPlaying = () => { state.userPaused = false; if (!state.masterPause) setVideoState(VS.PLAYING); };
    const onEmptied = () => { /* 播放器重挂载前 */ };
    const onClick = () => { state.lastVideoClickAt = now(); };

    const handlers = { play: onPlay, pause: onPause, ended: onEnded, timeupdate: onTimeupdate, waiting: onWaiting, playing: onPlaying, emptied: onEmptied, loadedmetadata: () => {}, durationchange: () => {}, seeking: () => {}, seeked: () => {}, click: onClick };
    handlersMap.set(video, handlers);
    Object.keys(handlers).forEach((ev) => video.addEventListener(ev, handlers[ev]));

    if (!state.courseTitle) getCourseTitle();
    logInfo('播放器', `已绑定视频元素 ${video.tagName.toLowerCase()} src=${(video.currentSrc || video.src || '').slice(0, 80)}`);
    setVideoState(video.paused ? (video.ended ? VS.VIDEO_ENDED : classifyPause()) : VS.PLAYING);
  }

  /* ---------- SPA 重发现：监听 DOM 变化，视频元素被替换/新增时自动重绑 ---------- */
  const onDomChanged = debounce(() => {
    // 验证码出现/消失
    const cap = captchaPresent();
    if (cap && !state.captchaActive) onCaptchaShown();
    else if (!cap && state.captchaActive) onCaptchaHidden();

    // 播放器重发现
    const cur = state.boundVideo;
    if (cur && !document.contains(cur)) {
      logInfo('播放器', '原视频元素已从 DOM 移除（SPA 切换/重挂载），重新发现播放器');
      state.video = null; state.boundVideo = null;
      const v = findVideo();
      if (v) {
        bindVideo(v);
        // 新课程源已变化 → 切换成功确认；若有挂起切课则顺延处理
        if (state.switchInFlight) { state.switchInFlight = false; onSwitchVerified(); }
        if (state.pendingSwitch && !captchaPresent() && !state.masterPause && state.settings.autoSwitch) {
          logInfo('切课', '检测到播放器重挂载（课程已切换），清空挂起切课');
          state.pendingSwitch = false;
        }
      } else {
        setVideoState(VS.NO_PLAYER);
      }
    } else if (!cur) {
      const v = findVideo();
      if (v) { bindVideo(v); logInfo('播放器', 'SPA 动态加载出视频元素，自动重绑'); }
    }
    writeLiveThrottled();
  }, 400);

  let domObserver = null;
  function ensureDomObserver() {
    if (domObserver) return;
    domObserver = new MutationObserver(() => onDomChanged());
    domObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  /* ============================== 轮询兜底 ============================== */
  function poll() {
    // 1) 验证码状态复核
    const cap = captchaPresent();
    if (cap && !state.captchaActive) onCaptchaShown();
    else if (!cap && state.captchaActive) onCaptchaHidden();

    // 2) 视频存在性
    if (!state.video || !document.contains(state.video)) {
      const v = findVideo();
      if (v && v !== state.boundVideo) bindVideo(v);
      else if (!v && state.videoState !== VS.NO_PLAYER) setVideoState(VS.NO_PLAYER);
    }

    const v = state.video;
    if (!v) return;

    // 3) 结束兜底：ended 事件丢失时
    if (v.ended || (isFinite(v.duration) && v.duration > 0 && !v.paused && v.currentTime >= v.duration - 0.8)) {
      handleEnded();
      return;
    }

    // 4) 状态对账（漏事件）
    if (v.paused && !v.ended && state.videoState === VS.PLAYING) {
      const s = classifyPause();
      state.userPaused = (s === VS.USER_PAUSED);
      setVideoState(s);
    } else if (!v.paused && !v.ended && state.videoState !== VS.PLAYING && !state.switchInFlight) {
      state.userPaused = false;
      setVideoState(VS.PLAYING);
    }

    // 5) 停滞检测：非暂停但 currentTime 长时间不变（平台层等待/卡缓冲）
    if (!v.paused && !v.ended) {
      if (Math.abs(v.currentTime - state.lastTime) < 0.05) {
        if (now() - state.lastTimeAt > STALL_MS) {
          logWarn('播放器', `进度停滞 ${Math.round(STALL_MS / 1000)}s 未前进（currentTime=${v.currentTime.toFixed(1)}），疑似平台层等待/异常，不做任何自动操作`, '推测');
          state.lastTimeAt = now(); // 防止刷屏
          setVideoState(VS.PLATFORM_PAUSED);
        }
      } else {
        state.lastTime = v.currentTime;
        state.lastTimeAt = now();
      }
    }
    writeLiveThrottled();
  }

  /* ============================== 验证码监测与诊断 ============================== */
  function captchaPresent() {
    const el = document.querySelector(CAPTCHA_SEL);
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  }

  function onCaptchaShown() {
    state.captchaActive = true;
    state.captchaShownAt = now();
    state.captchaPauseBlock = state.settings.captchaPause;
    setVideoState(state.pendingSwitch ? VS.WAIT_MANUAL : VS.CAPTCHA);
    logWarn('验证码', '打卡验证码弹窗出现 → 暂停自动切换，等待人工完成（不自动滑动、不绕过后端）');
    if (state.settings.diagnosis) startDiagnosis();
    if (state.settings.titleFlash) startTitleFlash();
    if (state.settings.sysNotify) sendCaptchaNotify();
    writeLive();
  }

  function onCaptchaHidden() {
    state.captchaActive = false;
    state.captchaPauseBlock = false;
    stopTitleFlash();
    stopDiagnosis();
    logInfo('验证码', '验证码弹窗已关闭，复核页面状态');
    postCaptchaRecheck();
    writeLive();
  }

  function postCaptchaRecheck() {
    const v = state.video;
    if (v && document.contains(v)) {
      if (v.ended) {
        logInfo('验证码', '人工验证完成后视频已结束 → 触发切课复核');
        handleEnded();
        return;
      }
      if (v.paused && !state.userPaused) {
        // 安全恢复自动学习：仅验证码流程后、且非用户暂停时恢复播放（有限次数，不反复抢播）
        attemptSafeResume('人工验证完成', { allowBackground: true });
      } else if (!v.paused) {
        logInfo('验证码', '平台已自行恢复播放（onSuccess 回调）', '已验证');
        setVideoState(VS.PLAYING);
      } else {
        logInfo('验证码', '用户保持暂停，不干预');
      }
    }
    // 若有挂起的切课（ended 期间弹窗），现在补做
    if (state.pendingSwitch && !state.switchInFlight && !state.masterPause && state.settings.autoSwitch) {
      if (v && !v.ended && !v.paused) {
        // 视频还在播：说明本轮 ended 已被平台重置，挂起作废
        logInfo('切课', '挂起切课作废：视频仍在播放');
        state.pendingSwitch = false;
      } else {
        logInfo('切课', '补做挂起的切课');
        void doSwitch();
      }
    }
  }

  /* ---------- 验证码提醒（标题闪烁 + 系统通知） ---------- */
  function startTitleFlash() {
    if (state.flashTimer) return;
    state.originalTitle = document.title;
    const alertText = '⚠ 打卡验证码待人工完成';
    let on = false;
    state.flashTimer = setInterval(() => {
      document.title = on ? alertText : state.originalTitle;
      on = !on;
    }, FLASH_MS);
    logInfo('验证码', '标题闪烁提醒已开启（弹窗关闭后自动恢复原标题）');
  }
  function stopTitleFlash() {
    if (state.flashTimer) { clearInterval(state.flashTimer); state.flashTimer = null; }
    if (state.originalTitle) { document.title = state.originalTitle; state.originalTitle = ''; }
  }
  function sendCaptchaNotify() {
    if (now() - state.lastNotifyAt < NOTIFY_COOLDOWN_MS) return;
    state.lastNotifyAt = now();
    try {
      chrome.runtime.sendMessage({
        type: 'HNYX_NOTIFY',
        title: '河南医学习助手',
        message: '打卡验证码已弹出：请完成滑动拼图验证（插件已暂停自动流程，完成后自动恢复）'
      });
      logInfo('验证码', '已发送系统通知提醒');
    } catch (e) { logWarn('验证码', '系统通知发送失败（SW 不可达）：' + e.message, '观察'); }
  }

  /* ---------- 页面浮窗控制面板（Shadow DOM 隔离，不污染页面样式） ---------- */
  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .hnp { font: 12px/1.5 "Microsoft YaHei", sans-serif; color: #e6eaf2; user-select: none; }
    .hnp-hd { display: flex; align-items: center; gap: 6px; padding: 7px 10px;
              background: #1f2733; border: 1px solid #39424f; border-radius: 8px 8px 0 0; cursor: move; }
    .hnp-dot { width: 8px; height: 8px; border-radius: 50%; background: #7ee787; flex: none; }
    .hnp-dot.paused { background: #f59a5c; }
    .hnp-dot.captcha { background: #f0597b; }
    .hnp-name { font-weight: 600; font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hnp-cfg { font-size: 10px; color: #9aa7b8; }
    .hnp-toggle { cursor: pointer; border: none; background: none; color: #9aa7b8; font-size: 12px; padding: 0 2px; }
    .hnp-btn { border: 1px solid #39424f; background: #2a3441; color: #dbe4f0; border-radius: 4px;
               font-size: 11px; padding: 2px 7px; cursor: pointer; }
    .hnp-btn:hover { background: #35404f; }
    .hnp-btn.warn { border-color: #8a5a33; color: #ffd9a8; }
    .hnp-btn.primary { border-color: #3a7d5a; color: #b8f0d2; }
    .hnp-body { background: #151b24; border: 1px solid #39424f; border-top: none;
                border-radius: 0 0 8px 8px; padding: 8px 10px; max-height: 420px; overflow: auto; }
    .hnp-row { display: flex; gap: 6px; align-items: baseline; margin-bottom: 4px; }
    .hnp-k { color: #9aa7b8; flex: none; width: 52px; }
    .hnp-v { color: #e6eaf2; word-break: break-all; }
    .hnp-prog { height: 6px; background: #232c38; border-radius: 3px; overflow: hidden; flex: 1; align-self: center; }
    .hnp-prog i { display: block; height: 100%; background: #4f8cff; }
    .hnp-log { background: #0c1016; border: 1px solid #232c38; border-radius: 4px; padding: 4px 6px;
               height: 96px; overflow: auto; font: 11px/1.5 Consolas, monospace; }
    .hnp-log .warn { color: #ffd9a8; } .hnp-log .error { color: #ff9a9a; } .hnp-log .diag { color: #b8a2ff; }
    .hnp-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .hnp-collapsed .hnp-body { display: none; }
  `;

  function buildPanel() {
    if (state.panel) { state.panel.style.display = state.settings.floatingPanel ? '' : 'none'; return; }
    const host = document.createElement('div');
    host.id = '__hnyxFloatingPanel';
    host.style.cssText = 'position:fixed; top:70px; right:20px; z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    root.appendChild(style);
    const wrap = document.createElement('div');
    wrap.className = 'hnp' + (state.panelCollapsed ? ' hnp-collapsed' : '');
    wrap.innerHTML = `
      <div class="hnp-hd">
        <span class="hnp-dot" id="dot"></span>
        <span class="hnp-name">河南医学习助手</span>
        <span class="hnp-cfg" id="cfg"></span>
        <button class="hnp-toggle" id="toggle">${state.panelCollapsed ? '▔' : '▁'}</button>
      </div>
      <div class="hnp-body">
        <div class="hnp-row"><span class="hnp-k">课程</span><span class="hnp-v" id="course">—</span></div>
        <div class="hnp-row"><span class="hnp-k">播放器</span><span class="hnp-v" id="vstate">无播放器</span></div>
        <div class="hnp-row"><span class="hnp-k">进度</span><span class="hnp-prog"><i id="progFill"></i></span><span class="hnp-v" id="progText">0%</span></div>
        <div class="hnp-row"><span class="hnp-k">验证码</span><span class="hnp-v" id="captcha">未出现</span></div>
        <div class="hnp-log" id="log">--</div>
        <div class="hnp-actions">
          <button class="hnp-btn" id="bRescan">重新扫描</button>
          <button class="hnp-btn warn" id="bPause">暂停自动化</button>
          <button class="hnp-btn primary" id="bResume">恢复自动化</button>
          <button class="hnp-btn" id="bClear">清空日志</button>
        </div>
      </div>`;
    root.appendChild(wrap);

    const $p = (id) => wrap.querySelector('#' + id);
    $p('toggle').addEventListener('click', (e) => { e.stopPropagation(); togglePanelCollapse(); });
    $p('bRescan').addEventListener('click', (e) => { e.stopPropagation(); rescan(); });
    $p('bPause').addEventListener('click', (e) => { e.stopPropagation(); panelPause(); });
    $p('bResume').addEventListener('click', (e) => { e.stopPropagation(); panelResume(); });
    $p('bClear').addEventListener('click', (e) => { e.stopPropagation(); panelClearLogs(); });

    // 头部拖拽（仅影响面板自身位置，不影响页面）
    const hd = wrap.querySelector('.hnp-hd');
    let drag = null;
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('.hnp-toggle')) return;
      drag = { x: e.clientX, y: e.clientY, l: host.offsetLeft, t: host.offsetTop };
      try { hd.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });
    hd.addEventListener('pointermove', (e) => {
      if (!drag) return;
      host.style.left = Math.max(0, drag.l + (e.clientX - drag.x)) + 'px';
      host.style.top = Math.max(0, drag.t + (e.clientY - drag.y)) + 'px';
      host.style.right = 'auto';
    });
    const endDrag = () => { drag = null; };
    hd.addEventListener('pointerup', endDrag);
    hd.addEventListener('pointercancel', endDrag);

    (document.body || document.documentElement).appendChild(host);
    state.panel = host;
    updatePanel();
    logInfo('浮窗', '页面浮窗面板已创建（Shadow DOM 隔离样式，可拖动、可收起；不干扰页面与油猴脚本）');
  }

  function togglePanelCollapse() {
    state.panelCollapsed = !state.panelCollapsed;
    if (!state.panel) return;
    const wrap = state.panel.shadowRoot.querySelector('.hnp');
    wrap.classList.toggle('hnp-collapsed', state.panelCollapsed);
    const tg = wrap.querySelector('#toggle');
    tg.textContent = state.panelCollapsed ? '▔' : '▁';
  }

  function panelPause() { state.masterPause = true; logWarn('控制', '浮窗：已暂停全部自动化（不切课、不恢复播放）'); writeLive(); }
  function panelResume() { state.masterPause = false; logInfo('控制', '浮窗：已恢复自动化'); postCaptchaRecheck(); writeLive(); }
  function panelClearLogs() {
    try { chrome.storage.local.set({ [LOG_KEY]: [] }); } catch (e) { /* 忽略 */ }
    state.panelLogs = [];
    logInfo('控制', '浮窗：清空日志');
  }

  function updatePanel() {
    const host = state.panel;
    if (!host) return;
    let wrap;
    try { wrap = host.shadowRoot && host.shadowRoot.querySelector('.hnp'); } catch (e) { return; }
    if (!wrap) return;
    const $p = (id) => wrap.querySelector('#' + id);
    if (!$p('course')) return;
    const v = state.video;
    const dur = v && isFinite(v.duration) ? v.duration : 0;
    const cur = v && isFinite(v.currentTime) ? v.currentTime : 0;
    $p('course').textContent = state.courseTitle || '—';
    const st = $p('vstate');
    st.textContent = VS_LABEL[state.videoState] || state.videoState;
    st.style.color = state.videoState === VS.PLAYING ? '#7ee787'
      : (state.videoState === VS.USER_PAUSED ? '#f5c76a' : '#f0a8a8');
    const pct = dur > 0 ? Math.min(100, Math.round((cur / dur) * 1000) / 10) : 0;
    $p('progFill').style.width = pct + '%';
    $p('progText').textContent = `${Math.round(cur)}s / ${Math.round(dur)}s (${pct}%)`;
    const cap = $p('captcha');
    if (state.captchaActive) {
      cap.textContent = state.videoState === VS.WAIT_MANUAL ? '弹窗中 · 等待人工完成' : '弹窗中';
      cap.style.color = '#f0597b';
    } else {
      cap.textContent = '未出现';
      cap.style.color = '';
    }
    $p('cfg').textContent = state.masterPause ? '已暂停' : (state.pendingSwitch ? '切课挂起' : '运行中');
    $p('dot').className = 'hnp-dot' + (state.masterPause ? ' paused' : (state.captchaActive ? ' captcha' : ''));
    const log = $p('log');
    log.innerHTML = '';
    state.panelLogs.slice(-8).forEach((e) => {
      const line = document.createElement('div');
      line.className = e.level || 'info';
      line.textContent = `${e.ts} [${e.level}] ${e.msg}`;
      log.appendChild(line);
    });
    log.scrollTop = log.scrollHeight;
  }

  /* ---------- 诊断模块（纯被动观察） ---------- */
  function diagSnapshot() {
    const wrap = document.querySelector(CAPTCHA_SEL);
    if (!wrap) return null;
    const q = (s) => wrap.querySelector(s);
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const csOf = (el, props) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const o = {};
      props.forEach((p) => { o[p] = cs[p]; });
      return o;
    };
    const canvases = Array.from(wrap.querySelectorAll('canvas'));
    const snap = {
      ts: ts(),
      wrapHtml: wrap.outerHTML.slice(0, 1600),
      wrapRect: rectOf(wrap),
      wrapStyle: csOf(wrap, ['display', 'position', 'width', 'height', 'zIndex']),
      canvasArea: rectOf(q('.canvasArea')),
      sliderContainer: {
        rect: rectOf(q('.sliderContainer')),
        className: q('.sliderContainer') ? q('.sliderContainer').className : null,
        style: csOf(q('.sliderContainer'), ['width', 'height', 'background', 'border'])
      },
      slider: { rect: rectOf(q('.slider')), left: q('.slider') ? q('.slider').style.left : null, style: csOf(q('.slider'), ['width', 'height', 'position', 'cursor']) },
      sliderMask: { rect: rectOf(q('.sliderMask')), width: q('.sliderMask') ? q('.sliderMask').style.width : null, style: csOf(q('.sliderMask'), ['background', 'height']) },
      sliderText: { text: q('.sliderText') ? norm(q('.sliderText').textContent) : null },
      refreshIcon: rectOf(q('.refreshIcon')),
      loadingContainer: { rect: rectOf(q('.loadingContainer')), display: q('.loadingContainer') ? getComputedStyle(q('.loadingContainer')).display : null },
      canvases: canvases.map((c) => ({
        width: c.width, height: c.height,
        rect: rectOf(c),
        styleLeft: c.style.left,
        className: c.className,
        style: csOf(c, ['position', 'top', 'left', 'cursor'])
      })),
      resources: performance.getEntriesByType('resource')
        .filter((e) => /sliderImages|api\//.test(e.name))
        .slice(-20)
        .map((e) => e.name.slice(0, 140))
    };
    // Canvas 像素分析（只读；跨域时 getImageData 抛 SecurityError，这本身是结论）
    snap.canvases = snap.canvases.map((c, idx) => {
      const el = canvases[idx];
      let analysis = { readable: null, note: '' };
      try {
        const ctx = el.getContext('2d');
        if (!ctx) { analysis.note = '无法获取 2d 上下文'; }
        else {
          const img = ctx.getImageData(0, 0, el.width, el.height);
          const d = img.data;
          const step = Math.max(1, Math.floor(d.length / 4 / 4000));
          let nonTransparent = 0, sumL = 0, sumL2 = 0, n = 0;
          for (let i = 0; i < d.length; i += 4 * step) {
            const a = d[i + 3];
            if (a > 0) nonTransparent++;
            const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            sumL += l; sumL2 += l * l; n++;
          }
          const mean = n ? sumL / n : 0;
          const variance = n ? Math.max(0, sumL2 / n - mean * mean) : 0;
          analysis = {
            readable: true,
            pixels: el.width * el.height,
            sampled: n,
            nonTransparentRatio: n ? Math.round((nonTransparent / n) * 1000) / 10 : 0,
            meanLuma: Math.round(mean * 10) / 10,
            lumaStddev: Math.round(Math.sqrt(variance) * 10) / 10
          };
        }
      } catch (e) {
        analysis = { readable: false, note: String(e && e.name ? e.name : e) + '（canvas 被跨域污染或不可读）' };
      }
      return { ...c, pixels: analysis };
    });
    return snap;
  }

  function startDiagnosis() {
    const wrap = document.querySelector(CAPTCHA_SEL);
    if (!wrap) return;
    state.diagSession = { startAt: now(), startTs: ts(), transitions: [], events: 0, snapshot: null };
    logDiag('验证码', '开始被动诊断：结构/坐标/CSS/Canvas/事件观察', '诊断');

    try {
      const snap = diagSnapshot();
      state.diagSession.snapshot = snap;
      logDiag('验证码', 'DOM 快照：' + JSON.stringify(snap).slice(0, 2200), '【已验证】');
    } catch (e) { logErr('验证码', '快照失败：' + e.message); }

    // 状态类变化观察（sliderContainer: active/success/fail）
    try {
      const ob = new MutationObserver((muts) => {
        muts.forEach((m) => {
          if (m.type === 'attributes') {
            const el = m.target;
            if (el.classList && el.classList.contains('sliderContainer')) {
              const cls = el.className;
              state.diagSession.transitions.push({ t: ts(), attr: m.attributeName, className: cls });
              logDiag('验证码', `状态变化：${m.attributeName} → ${cls}`, '【观察】');
            } else if (m.attributeName === 'style' && el.classList) {
              const key = el.className || '?';
              logDiag('验证码', `样式变化（${key}）：${el.getAttribute('style')}`, '【观察】');
            }
          }
        });
      });
      ob.observe(wrap, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
      state.diagObserver = ob;
    } catch (e) { logErr('验证码', '状态观察器失败：' + e.message); }

    // 被动事件观察（不 preventDefault / 不 stopPropagation，不干预页面）
    const evNames = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend'];
    const onEv = (ev) => {
      if (!state.captchaActive) return;
      const target = ev.target;
      if (!(target instanceof Element) || !wrap.contains(target)) return;
      if (state.diagSession.events >= 120) return; // 防刷屏
      state.diagSession.events++;
      const rect = wrap.getBoundingClientRect();
      const x = Math.round(ev.clientX - rect.left), y = Math.round(ev.clientY - rect.top);
      logDiag('验证码', `事件 ${ev.type} 目标=${target.className || target.tagName} @(${x},${y})`, '【观察】');
    };
    evNames.forEach((n) => {
      const h = (e) => onEv(e);
      window.addEventListener(n, h, { capture: true, passive: true });
      state.diagListeners.push([n, h]);
    });
  }

  function stopDiagnosis() {
    if (state.diagObserver) { try { state.diagObserver.disconnect(); } catch (e) {} state.diagObserver = null; }
    state.diagListeners.forEach(([n, h]) => window.removeEventListener(n, h, { capture: true }));
    state.diagListeners = [];
    if (state.diagSession) {
      const s = state.diagSession;
      logDiag('验证码', `诊断结束：事件 ${s.events} 条，状态迁移 ${s.transitions.length} 次（${s.transitions.map((t) => t.className).join(' → ') || '无'}）`, '诊断');
      try {
        chrome.storage.local.get(DIAG_KEY, (res) => {
          const prev = res[DIAG_KEY] ? [res[DIAG_KEY]] : [];
          prev.unshift({ at: now(), atTs: s.startTs, transitions: s.transitions.slice(-30), events: s.events });
          chrome.storage.local.set({ [DIAG_KEY]: prev.slice(0, 5) });
        });
      } catch (e) { /* 忽略 */ }
      state.diagSession = null;
    }
  }

  /* ============================== 自动切课 ============================== */
  function findNextTarget() {
    // 1) 课程列表定位（已验证结构）
    const items = courseListItems();
    if (items.length > 1) {
      const idx = findActiveLiIndex();
      if (idx >= 0) {
        if (idx < items.length - 1) {
          logInfo('切课', `课程列表定位：第 ${idx + 1}/${items.length} 项（${liTitle(items[idx]).slice(0, 30)}）→ 下一项`);
          return { el: items[idx + 1], kind: 'list-item', title: liTitle(items[idx + 1]) };
        }
        logInfo('切课', `当前为最后一项（第 ${idx + 1}/${items.length}），无下一节 → 课程全部完成`);
        return { el: null, kind: 'last', title: '' };
      }
    }
    // 2) 通用「下一节」按钮兜底
    const nextBtn = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
      .filter((el) => {
        if (!visibleEl(el)) return false;
        const t = norm(el.textContent);
        if (!t || t.length > 20) return false;
        return /^(下一节|下一课|下一集|下节课|下一条|下一章|next)/i.test(t);
      })
      .sort((a, b) => (a.textContent.length - b.textContent.length))[0];
    if (nextBtn) {
      logInfo('切课', '通用按钮兜底：' + norm(nextBtn.textContent).slice(0, 20));
      return { el: nextBtn, kind: 'next-button', title: '' };
    }
    // 3) 通用 class/id 兜底
    const attrBtn = Array.from(document.querySelectorAll('[class*="next" i], [id*="next" i]'))
      .filter((el) => visibleEl(el) && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.onclick || el.getAttribute('role') === 'button'))
      .sort((a, b) => a.tagName.length - b.tagName.length)[0];
    if (attrBtn) {
      logInfo('切课', '属性定位兜底：<' + attrBtn.tagName.toLowerCase() + ' class=' + (attrBtn.className || '').toString().slice(0, 40) + '>');
      return { el: attrBtn, kind: 'attr-next', title: '' };
    }
    logInfo('切课', '未找到下一节入口');
    return { el: null, kind: 'none', title: '' };
  }

  function onSwitchVerified() {
    state.switchInFlight = false;
    state.switchAttempts = 0;
    state.pendingSwitch = false;
    state.endedHandledKey = courseKey();
    logInfo('切课', `切换成功并已校验，新课程：${state.courseTitle.slice(0, 40)}`, '已验证');
    setVideoState(VS.PLAYING);
  }

  function verifySwitch(beforeSrc, beforeVideo, beforeTitle) {
    return new Promise((resolve) => {
      const start = now();
      const timer = setInterval(() => {
        const v = state.video || findVideo();
        const okSrc = v && v.currentSrc && v.currentSrc !== beforeSrc;
        const okReplace = v && v !== beforeVideo && beforeVideo && !document.contains(beforeVideo);
        const okTitle = !!beforeTitle && state.courseTitle !== beforeTitle;
        if (okSrc || okReplace || okTitle) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (now() - start > SWITCH_VERIFY_MS) {
          clearInterval(timer);
          resolve(false);
        }
      }, SWITCH_VERIFY_INTERVAL);
    });
  }

  async function doSwitch() {
    if (state.switchInFlight) return;
    state.switchInFlight = true;
    state.switchAttempts = 0;
    setVideoState(VS.SWITCHING);
    const beforeTitle = state.courseTitle;
    const beforeVideo = state.video;
    const beforeSrc = (beforeVideo && (beforeVideo.currentSrc || beforeVideo.src)) || '';

    while (state.switchAttempts < SWITCH_RETRIES) {
      state.switchAttempts++;
      if (captchaPresent()) {
        logWarn('切课', `第 ${state.switchAttempts} 次尝试前发现验证码弹窗，中止并等待人工验证`);
        setVideoState(VS.WAIT_MANUAL);
        state.switchInFlight = false;
        return;
      }
      const target = findNextTarget();
      if (!target || !target.el) {
        if (target && target.kind === 'last') {
          logInfo('切课', '已是最后一节 → 课程全部完成');
          state.pendingSwitch = false;
          state.endedHandledKey = courseKey();
          setVideoState(VS.COURSE_COMPLETE);
          state.switchInFlight = false;
          return;
        }
        logWarn('切课', `第 ${state.switchAttempts} 次尝试：未找到下一节入口`);
        if (state.switchAttempts >= SWITCH_RETRIES) break;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // 点击前先定位当前课程，点击后校验「课程标题/播放源」真实变化
      const clickedTitle = target.title || '';
      try { target.el.click(); } catch (e) { logErr('切课', '点击异常：' + e.message); }

      logInfo('切课', `第 ${state.switchAttempts} 次点击：${target.kind} ${clickedTitle.slice(0, 30)}`);
      const ok = await verifySwitch(beforeSrc, beforeVideo, beforeTitle);
      if (ok) {
        if (clickedTitle && clickedTitle !== state.courseTitle) {
          state.courseTitle = clickedTitle;
          logInfo('切课', `课程标题已更新：${clickedTitle.slice(0, 40)}`, '已验证');
        }
        onSwitchVerified();
        return;
      }
      logWarn('切课', `第 ${state.switchAttempts} 次切换校验未通过（课程标题/播放源未变化）`);
      if (state.switchAttempts >= SWITCH_RETRIES) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // 有限重试后仍失败：不再无限点击
    state.pendingSwitch = false;
    state.endedHandledKey = courseKey();
    state.switchInFlight = false;
    setVideoState(VS.SWITCH_FAILED);
    logErr('切课', `切换失败：重试 ${SWITCH_RETRIES} 次未生效，已停止自动点击（可手动点击或点击面板「重新扫描」）`);
  }

  /* ============================== 消息（popup） ============================== */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !msg.type || !msg.type.startsWith('HNYX_')) return;
    switch (msg.type) {
      case 'HNYX_GET_SNAPSHOT':
        writeLive({ _snapshot: true });
        sendResponse({ ok: true, live: buildSnapshot() });
        break;
      case 'HNYX_SETTINGS':
        if (msg.patch) saveSettings(msg.patch);
        sendResponse({ ok: true, settings: state.settings });
        break;
      case 'HNYX_RESCAN':
        rescan();
        sendResponse({ ok: true });
        break;
      case 'HNYX_PAUSE_ALL':
        state.masterPause = true;
        logWarn('控制', '面板：已暂停全部自动化（不切课、不恢复播放）');
        writeLive();
        sendResponse({ ok: true });
        break;
      case 'HNYX_RESUME_ALL':
        state.masterPause = false;
        logInfo('控制', '面板：已恢复自动化');
        // 恢复后对账一次：若视频处于待切课/平台暂停态，按规则推进
        postCaptchaRecheck();
        writeLive();
        sendResponse({ ok: true });
        break;
      case 'HNYX_CLEAR_LOGS':
        try { chrome.storage.local.set({ [LOG_KEY]: [] }); } catch (e) {}
        sendResponse({ ok: true });
        break;
      default:
        break;
    }
    return true;
  });

  function buildSnapshot() {
    const v = state.video;
    return {
      videoState: state.videoState,
      videoStateLabel: VS_LABEL[state.videoState] || state.videoState,
      masterPause: state.masterPause,
      courseTitle: state.courseTitle,
      hasVideo: !!v,
      playing: !!(v && !v.paused && !v.ended),
      currentTime: v && isFinite(v.currentTime) ? Math.round(v.currentTime * 10) / 10 : 0,
      duration: v && isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
      progressPct: v && isFinite(v.duration) && v.duration > 0 ? Math.min(100, Math.round((v.currentTime / v.duration) * 1000) / 10) : 0,
      captchaActive: state.captchaActive,
      captchaPauseBlock: state.captchaPauseBlock,
      pendingSwitch: state.pendingSwitch,
      switchAttempts: state.switchAttempts,
      settings: { ...state.settings },
      engineVersion: '1.1.0'
    };
  }

  function rescan() {
    logInfo('控制', '面板：重新扫描页面');
    const v = findVideo();
    if (v) bindVideo(v); else setVideoState(VS.NO_PLAYER);
    if (!state.courseTitle) getCourseTitle();
    if (captchaPresent() && !state.captchaActive) onCaptchaShown();
    writeLive();
  }

  /* ============================== 页面级用户交互与失焦/可见性监测 ============================== */
  // 用户交互时间戳（仅用于 pause 归因，被动监听）
  ['mousedown', 'touchstart', 'keydown'].forEach((ev) => {
    window.addEventListener(ev, () => { state.lastUserInteractAt = now(); }, { capture: true, passive: true });
  });

  // 页面失去鼠标焦点（窗口 blur/被遮挡）可能触发平台暂停：记录时间供 pause 归因；
  // 焦点恢复 / 页面重新可见时，做一次「非用户暂停」的安全恢复（被动监听，不劫持、不阻止平台行为）
  window.addEventListener('blur', () => { state.windowBlurAt = now(); }, { passive: true });
  window.addEventListener('focus', () => attemptSafeResume('窗口焦点恢复'), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') attemptSafeResume('页面重新可见');
  }, { passive: true });

  /* ============================== 启动 ============================== */
  async function boot() {
    await loadSettings();
    logInfo('系统', `content script 启动（引擎 v1.1.0），设置：${JSON.stringify(state.settings)}`);
    const v = findVideo();
    if (v) bindVideo(v); else logInfo('系统', '当前页面未发现视频元素（NO_PLAYER），将随 SPA 变化自动重发现');
    getCourseTitle();
    ensureDomObserver();
    if (state.settings.floatingPanel) buildPanel();
    setInterval(() => updatePanel(), 2000); // 浮窗进度轻量刷新
    state.pollTimer = setInterval(poll, POLL_MS);
    writeLive();
    logInfo('系统', '监测已启动：事件监听 + 5s 轮询兜底；验证码弹窗将暂停自动切换（标题闪烁/系统通知/浮窗提示已启用）');
  }
  boot();
})();
