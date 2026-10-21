// ==UserScript==
// @name         奶蛙快跑 · 辅助面板 (无敌 / 磁铁 / 护盾 / 滑板)
// @name:en      Naiwa Run Helper
// @namespace    https://naiwa-kuaipao.pages.dev/
// @version      2.0.0
// @description  奶蛙快跑（three.js 跑酷 v6.8.4）前端辅助面板：永久无敌、金币磁铁、满护盾、滞空滑板、金币双倍、一键切「屌炸天」难度、实时里程金币、真实结算入账。Alt+X 显示/隐藏面板。
// @description:en  Client-side helper for Naiwa Run v6.8.4: permanent invincibility, coin magnet, max shields, hoverboard, 2x coins, one-click "diao" difficulty, live run stats, real settlement. Alt+X toggles the panel.
// @author       iu6888
// @license      MIT
// @match        https://xn--yus23mh00b62f.vip/*
// @match        https://naiwa-kuaipao.pages.dev/*
// @run-at       document-start
// @grant        none
// @noframes
// @downloadURL  https://raw.githubusercontent.com/iu6888/naiwakuaipao-helper/main/naiwa-helper.user.js
// @updateURL    https://raw.githubusercontent.com/iu6888/naiwakuaipao-helper/main/naiwa-helper.user.js
// ==/UserScript==

/*
 * ── 站点变化（v6.8.4，2026-10 实测）──────────────────────────────────────────
 * 1. 主域名迁到 https://xn--yus23mh00b62f.vip （即「奶蛙快跑.vip」）。
 *    pages.dev 只剩跳板/提示页，@match 两处都留着。
 * 2. 入口变成登录门：/ 与 /login 下发同一个登录页，未登录访问 /game?mode=solo
 *    会被 302 打回 /login。所以脚本只在已登录、真正进入 /game 的页面里工作。
 * 3. 引擎不再单独请求 engine.js，改为内联分发（局部变量混淆，但【全局对象和
 *    属性名保留】—— 这是 version.json 里作者自己写明的策略）。因此
 *    window.RunnerCore / window.gameDebug / Game 的属性名全部照旧可用。
 * 4. 新增服务端权威结算：
 *      POST /api/v1/runs/start          → { runId, ticket }
 *      POST /api/v1/runs/{runId}/finish → { ticket, distance, coins, jumps, slides, roofDistance, time }
 *      GET  /api/v1/wardrobe            → 服务端衣橱（会覆盖本地存档）
 *      POST /api/v1/wardrobe/buy        → 服务端原子扣币 + 授予皮肤
 *    → 直接改 game.coins 会在 finish 被 422「超出服务器合理范围」拒绝，
 *      随后的 wardrobe pull 又把本地存档抹回服务端值。
 *    → 但【真实跑出来的数据】服务端照收：实测 diao 难度 + 磁铁 37 秒
 *      跑 2828 米 / 3702 金币，finish 返回 200 progressSynced:true，金币正常入账。
 *    结论：正确姿势是「让游戏自己跑、自己结算」，而不是伪造钱包。
 *
 * ── 仍然有效的原理 ───────────────────────────────────────────────────────────
 * 每帧状态机里只有两个地方决定"受伤/被抓"：
 *
 *   step() 碰撞判定：
 *       if (!safe && this.invincible <= 0) { o.hit = true; this.hit(); if (this.status === "over") break; }
 *   hit() 受伤判定：
 *       if (this.invincible > 0 || this.hoverboard > 0) return;   // 直接短路
 *       if (this.shield > 0) { this.shield--; this.invincible = 1.2; return }
 *       if (this.hurt > 0) this.status = "over"                   // 第一次撞 hurt=7s，7 秒内再撞 = 被抓
 *
 *   每帧衰减：
 *       for (const k of ["slide","hurt","invincible","magnet","hoverboard","multiplierTimer","comboTimer"])
 *         this[k] = Math.max(0, this[k] - dt);
 *
 *   → Math.max(0, Infinity - dt) === Infinity，写入 Infinity 之后【永不衰减】。
 *   → reset() 每次开局会把 invincible / magnet / shield 抹零，所以必须 Hook reset()。
 *
 *   金币吸附（v6.8.4 半径比旧版更大）：
 *       const pull = o.type === "coin" && this.magnet > 0;
 *       if (o < (pull ? 9 : 1.2) && n >= -(pull ? 6 : 1) && Math.abs(this.y + .85 - t.y) < (pull ? 6 : 1.5))
 *
 * ── 已失效、本版不再提供的能力 ───────────────────────────────────────────────
 *   · 直接写 localStorage 改金币 / 解锁全部服装
 *     → wardrobe pull 会用服务端数据覆盖；canWearOwned() 只认服务端下发的
 *       wardrobeOwned 集合，本地 ownedOutfits 里有也不让穿。
 *   · 伪造一局超高金币
 *     → finish 返回 422，progressSynced:false。
 *   想真正拿到金币和皮肤：开无敌 + 磁铁，选「屌炸天」（金币 ×3），
 *   让游戏跑够时间自然结算，再用游戏内商城买（服务端原子扣币、授予）。
 */

(function () {
  "use strict";

  /* ══════════════════════════ 配置 ══════════════════════════ */

  const STATE = {
    invincible: true,  // 永久无敌（永不掉血、永不被抓）
    magnet: true,      // 永久金币磁铁
    shield: true,      // 满护盾
    hoverboard: false, // 滞空滑板（撞什么都不会被抓，会改变一点手感）
    multiplier: false, // 金币 ×2
    panel: true,       // 是否显示面板
  };

  const PROFILE_KEY = "sunny-run-v4-profile";
  const TOKEN_KEY = "naiwa-online-token";
  const POLL_MS = 120;
  const READY_TIMEOUT = 120000;
  const LIVE_MS = 400;
  const KEEPALIVE_MS = 250;

  // 兜底默认值；生效值优先从 RunnerCore.CONFIG 动态读
  const FALLBACK = { maxShields: 3, magnetSeconds: 12, hoverboardSeconds: 30, multiplierSeconds: 10 };

  /* ══════════════════════════ 小工具 ══════════════════════════ */

  const $game = () => (window.gameDebug && window.gameDebug.game) || null;
  const $view = () => {
    try { return window.gameDebug ? window.gameDebug.snapshot().view : null; } catch (e) { return null; }
  };
  const $cfg = () => (window.RunnerCore && window.RunnerCore.CONFIG) || {};

  const cfgNum = (key, fallback) => {
    const v = Number($cfg()[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };

  const fmt = (n) => {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
    if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + "万";
    return String(n);
  };

  const sessionToken = () => {
    try {
      return localStorage.getItem(TOKEN_KEY) ||
        ((document.cookie.match(/(?:^|;\s*)naiwa_token=([A-Za-z0-9_-]+)/) || [])[1] || "");
    } catch (e) { return ""; }
  };

  /* ══════════════════════════ 核心补丁 ══════════════════════════ */

  function applyTo(g) {
    if (!g) return;

    if (STATE.invincible) {
      g.invincible = Infinity; // 关键：Infinity 不会被 Math.max(0, x - dt) 衰减
      g.hurt = 0;              // 清掉"追兵"计时，避免 7 秒内二次撞击判定
    }

    if (STATE.magnet) {
      // 刻意不用 Infinity：HUD 会渲染 Math.ceil(magnet) + "s"，
      // Infinity 会显示成 "Infinitys"。吸附只看 magnet > 0，续杯成游戏自身时长即可。
      // 留 0.6 秒余量再补，避免每帧写值导致 HUD 抖动。
      const want = FALLBACK.magnetSeconds;
      if (!(Number(g.magnet) >= want - 0.6)) g.magnet = want;
    }

    if (STATE.shield) {
      const max = cfgNum("maxShields", FALLBACK.maxShields);
      if (!(Number(g.shield) >= max)) g.shield = max;
    }

    if (STATE.hoverboard) {
      const want = cfgNum("hoverboardSeconds", FALLBACK.hoverboardSeconds);
      if (!(Number(g.hoverboard) >= want - 0.6)) g.hoverboard = want;
    }

    if (STATE.multiplier) {
      const want = cfgNum("multiplierSeconds", FALLBACK.multiplierSeconds);
      if (!(Number(g.multiplierTimer) >= want - 0.6)) g.multiplierTimer = want;
    }
  }

  const apply = () => applyTo($game());

  const PATCH_FLAG = "__naiwaHelperV2";

  function patch(Game) {
    if (!Game || !Game.prototype) return false;
    if (Game.prototype[PATCH_FLAG]) return true;
    Game.prototype[PATCH_FLAG] = true;

    const _reset = Game.prototype.reset;
    const _hit = Game.prototype.hit;

    // 每次 start() → game.reset() 之后自动重新上状态。
    // 构造器里的第一次 reset 也走这里，此时 gameDebug 还没就绪，所以直接作用到 this。
    Game.prototype.reset = function (seed, difficulty) {
      const r = _reset.call(this, seed, difficulty);
      try { applyTo(this); } catch (e) { /* ignore */ }
      return r;
    };

    // 兜底：即使碰撞判定漏过来，任何命中也不生效
    Game.prototype.hit = function () {
      if (STATE.invincible) {
        this.invincible = Infinity;
        this.hurt = 0;
        return;
      }
      if (STATE.hoverboard && (Number(this.hoverboard) || 0) > 0) {
        return; // 滑板本身就会短路 hit()，这里只是保证不推进 hurt
      }
      return _hit.apply(this, arguments);
    };

    return true;
  }

  /* ══════════════════════════ 开关（立即可见） ══════════════════════════ */

  function toggle(key, on) {
    STATE[key] = on;
    const g = $game();
    if (!g) return;

    if (key === "invincible") {
      if (on) { g.invincible = Infinity; g.hurt = 0; } else { g.invincible = 0; }
    } else if (key === "magnet") {
      g.magnet = on ? FALLBACK.magnetSeconds : 0;
    } else if (key === "shield") {
      g.shield = on ? cfgNum("maxShields", FALLBACK.maxShields) : 0;
    } else if (key === "hoverboard") {
      g.hoverboard = on ? cfgNum("hoverboardSeconds", FALLBACK.hoverboardSeconds) : 0;
    } else if (key === "multiplier") {
      g.multiplierTimer = on ? cfgNum("multiplierSeconds", FALLBACK.multiplierSeconds) : 0;
    }
  }

  /* ══════════════════════════ 操作 ══════════════════════════ */

  // 切到「屌炸天」：金币 ×3，且每 30000 米额外 +2000 金币
  function setDiao() {
    window.selectedDifficulty = "diao";
    try { localStorage.setItem("naiwa-difficulty", "diao"); } catch (e) { /* ignore */ }
    document.querySelectorAll("[data-difficulty]").forEach((el) => {
      el.setAttribute("aria-pressed", String(el.dataset.difficulty === "diao"));
    });
    const g = $game();
    if (g && g.status === "running") toast("已切到「屌炸天」，下一局生效");
    else toast("已切到「屌炸天」· 金币 ×3");
    syncUI();
  }

  // 走游戏自己的结算：home() → bankRun() → POST /api/v1/runs/{id}/finish
  function settleNow() {
    const g = $game();
    if (!g) return toast("游戏还没加载完");
    const view = $view();
    if (!["running", "paused", "over"].includes(view)) {
      return toast("当前不在跑局中，先点「开始奔跑」");
    }
    if (view === "running" && g.time < 1.2) {
      return toast("刚起跑，等跑出 1 秒再结算，否则会被跳过");
    }
    const dist = Math.floor(Number(g.distance) || 0);
    const coins = Math.floor(Number(g.coins) || 0);
    window.gameDebug.home();
    toast("已结算 · " + fmt(dist) + " 米 / " + fmt(coins) + " 金币");
    setTimeout(syncUI, 800);
  }

  function resetSave() {
    try {
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem("naiwa-difficulty");
      localStorage.removeItem("naiwa-selected-map");
    } catch (e) { /* ignore */ }
    toast("已清空本机存档，正在刷新…");
    setTimeout(() => location.reload(), 700);
  }

  /* ══════════════════════════ 面板 UI（Shadow DOM 隔离） ══════════════════════════ */

  let ui = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .card {
      width: 250px; background: rgba(22, 26, 32, .94); color: #e8edf4;
      border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.45); overflow: hidden;
      backdrop-filter: blur(10px); font-size: 12.5px; line-height: 1.45;
    }
    .hd {
      display: flex; align-items: center; gap: 6px; padding: 9px 10px;
      background: linear-gradient(135deg, #2b3542 0%, #1b2028 100%);
      border-bottom: 1px solid rgba(255,255,255,.1); cursor: default;
    }
    .hd b { font-size: 13px; letter-spacing: .3px; color: #9fe870; }
    .hd .tag { flex: 1; font-size: 10px; color: #7d8894; font-weight: 500; }
    .hd button {
      all: unset; cursor: pointer; width: 22px; height: 22px; line-height: 22px;
      text-align: center; border-radius: 6px; color: #aab4c0; font-size: 14px;
    }
    .hd button:hover { background: rgba(255,255,255,.12); color: #fff; }
    .bd { padding: 8px 10px 10px; }
    .bd.collapsed { display: none; }
    .sec { margin: 8px 0 4px; font-size: 11px; color: #7d8894; letter-spacing: .6px; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; }
    .sw {
      position: relative; width: 36px; height: 20px; border-radius: 10px;
      background: #39424e; transition: background .16s; cursor: pointer; flex: none;
    }
    .sw::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
      border-radius: 50%; background: #fff; transition: transform .16s;
    }
    .sw.on { background: #2fa84f; }
    .sw.on::after { transform: translateX(16px); }
    .btn {
      all: unset; box-sizing: border-box;
      display: block; width: 100%; text-align: center; cursor: pointer;
      padding: 7px 8px; margin-top: 5px; border-radius: 8px; font-size: 12.5px;
      background: #2c3542; color: #dbe3ec;
      border: 1px solid rgba(255,255,255,.08); transition: filter .12s;
    }
    .btn:hover { filter: brightness(1.25); }
    .btn.ok { background: #235c37; color: #d6ffe3; }
    .btn.gold { background: #5a4a1e; color: #ffe9b0; }
    .btn.warn { background: #5c2a2a; color: #ffd9d9; }
    .stat {
      display: flex; gap: 6px; margin: 6px 0 2px; padding: 7px 6px;
      background: rgba(255,255,255,.05); border-radius: 8px;
    }
    .stat div { flex: 1; text-align: center; min-width: 0; }
    .stat b { display: block; font-size: 13px; color: #cfe9b0; font-variant-numeric: tabular-nums; }
    .stat small { display: block; font-size: 10px; color: #7d8894; margin-top: 1px; }
    .ft { margin-top: 9px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.08);
          font-size: 10.5px; color: #7d8894; line-height: 1.65; }
    .ft .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; }
    .ft .dot.on { background: #43c463; }
    .ft .dot.off { background: #6b7480; }
    .toast {
      position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
      background: rgba(20,24,30,.95); color: #eaf2ff; padding: 8px 14px;
      border-radius: 9px; border: 1px solid rgba(255,255,255,.16);
      font-size: 12.5px; white-space: nowrap; opacity: 0; pointer-events: none;
      transition: opacity .2s; box-shadow: 0 8px 24px rgba(0,0,0,.45);
      max-width: 92vw; overflow: hidden; text-overflow: ellipsis;
    }
    .toast.show { opacity: 1; }
  `;

  function buildUI() {
    if (ui) return ui;

    const host = document.createElement("div");
    host.id = "naiwa-helper-host";
    host.style.cssText = "position:fixed;z-index:2147483647;top:14px;right:14px;";
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = [
      '<div class="hd">',
      '  <b>奶蛙辅助</b><span class="tag">v2.0 · 6.8.4</span>',
      '  <button class="fold" title="折叠">–</button>',
      '</div>',
      '<div class="bd">',
      '  <div class="stat">',
      '    <div><b id="s-dist">0</b><small>本局米数</small></div>',
      '    <div><b id="s-coin">0</b><small>本局金币</small></div>',
      '    <div><b id="s-time">0s</b><small>时长</small></div>',
      '  </div>',
      '  <div class="sec">跑局内</div>',
      '  <div class="row"><span>永久无敌</span><i class="sw" data-sw="invincible"></i></div>',
      '  <div class="row"><span>金币磁铁</span><i class="sw" data-sw="magnet"></i></div>',
      '  <div class="row"><span>满护盾</span><i class="sw" data-sw="shield"></i></div>',
      '  <div class="row"><span>滞空滑板</span><i class="sw" data-sw="hoverboard"></i></div>',
      '  <div class="row"><span>金币 ×2（倍率）</span><i class="sw" data-sw="multiplier"></i></div>',
      '  <div class="sec">刷金币（服务端会校验）</div>',
      '  <button class="btn gold" data-act="diao">切到「屌炸天」· 金币 ×3</button>',
      '  <button class="btn ok" data-act="settle">结算本局（真实入账）</button>',
      '  <div class="sec">维护</div>',
      '  <button class="btn warn" data-act="reset">清空本机存档</button>',
      '  <div class="ft">',
      '    <div><span class="dot off" id="d-login"></span><span id="t-login">未登录</span></div>',
      '    <div><span class="dot off" id="d-sync"></span><span id="t-sync">本局未同步</span></div>',
      '    <div style="margin-top:5px">Alt + X 显示 / 隐藏</div>',
      '  </div>',
      '</div>',
    ].join("\n");

    const toastEl = document.createElement("div");
    toastEl.className = "toast";

    root.append(style, card, toastEl);
    (document.body || document.documentElement).appendChild(host);

    ui = {
      host, root, card, toastEl, switches: {},
      dist: root.getElementById("s-dist"),
      coin: root.getElementById("s-coin"),
      time: root.getElementById("s-time"),
      dotLogin: root.getElementById("d-login"),
      txtLogin: root.getElementById("t-login"),
      dotSync: root.getElementById("d-sync"),
      txtSync: root.getElementById("t-sync"),
    };

    // 开关
    root.querySelectorAll(".sw").forEach((el) => {
      const key = el.dataset.sw;
      ui.switches[key] = el;
      el.addEventListener("click", () => {
        const next = !el.classList.contains("on");
        el.classList.toggle("on", next);
        toggle(key, next);
        syncUI();
      });
    });

    // 按钮
    root.querySelector('[data-act="diao"]').addEventListener("click", setDiao);
    root.querySelector('[data-act="settle"]').addEventListener("click", settleNow);
    root.querySelector('[data-act="reset"]').addEventListener("click", resetSave);

    // 折叠
    const bd = root.querySelector(".bd");
    const fold = root.querySelector(".fold");
    fold.addEventListener("click", () => {
      const hidden = bd.classList.toggle("collapsed");
      fold.textContent = hidden ? "+" : "–";
    });

    // 不要让面板上的按键传给游戏
    root.addEventListener("keydown", (e) => e.stopPropagation(), true);
    root.addEventListener("pointerdown", (e) => e.stopPropagation(), true);

    syncUI();
    return ui;
  }

  function setDot(el, on) {
    if (!el) return;
    el.classList.toggle("on", !!on);
    el.classList.toggle("off", !on);
  }

  function syncUI() {
    if (!ui) return;

    ui.switches.invincible.classList.toggle("on", STATE.invincible);
    ui.switches.magnet.classList.toggle("on", STATE.magnet);
    ui.switches.shield.classList.toggle("on", STATE.shield);
    ui.switches.hoverboard.classList.toggle("on", STATE.hoverboard);
    ui.switches.multiplier.classList.toggle("on", STATE.multiplier);

    // 登录态
    const tok = sessionToken();
    setDot(ui.dotLogin, tok);
    ui.txtLogin.textContent = tok ? "已登录 · 云端结算" : "未登录（去登录页）";

    // 结算态
    let st = "";
    try {
      if (window.NaiwaRunProgress && typeof window.NaiwaRunProgress.status === "function") {
        st = window.NaiwaRunProgress.status();
      }
    } catch (e) { st = ""; }

    const MAP = {
      synced: ["已同步到云端", true],
      saving: ["正在同步…", true],
      ready: ["云端已就绪", true],
      starting: ["正在开局…", true],
      local: ["本局仅本地", false],
      idle: ["本局未同步", false],
    };
    const hit = MAP[st] || ["本局未同步", false];
    setDot(ui.dotSync, hit[1]);
    ui.txtSync.textContent = hit[0];
  }

  function syncLive() {
    if (!ui) return;
    const g = $game();
    if (!g) return;
    ui.dist.textContent = fmt(g.distance);
    ui.coin.textContent = fmt(g.coins);
    ui.time.textContent = Math.floor(Number(g.time) || 0) + "s";
  }

  let toastTimer = 0;
  function toast(text) {
    if (!ui) return;
    ui.toastEl.textContent = text;
    ui.toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toastEl.classList.remove("show"), 2800);
  }

  function togglePanel() {
    STATE.panel = !STATE.panel;
    if (STATE.panel) buildUI();
    if (ui) ui.host.style.display = STATE.panel ? "" : "none";
  }

  /* ══════════════════════════ 启动 ══════════════════════════ */

  document.addEventListener(
    "keydown",
    (e) => {
      // Alt+X 切换面板；游戏本身只占用 方向键 / 空格 / P / Esc
      if (e.altKey && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        togglePanel();
      }
    },
    true
  );

  function boot() {
    let waited = 0;
    let protoPatched = false;
    let started = false;

    const timer = setInterval(() => {
      waited += POLL_MS;
      const RC = window.RunnerCore;

      // 阶段一：engine.js 一跑出 RunnerCore，立刻接管 Game.prototype，
      // 这样 s11 里 new Game() 的第一次 reset 就已被覆盖。
      if (!protoPatched && RC && RC.Game) {
        protoPatched = patch(RC.Game);
        if (protoPatched) console.log("%c[奶蛙辅助] Game.prototype 已接管", "color:#0a0;font-weight:bold");
      }

      // 阶段二：主逻辑把 gameDebug 挂上 window 后，才能拿实例、建面板
      if (protoPatched && window.gameDebug && !started) {
        started = true;
        clearInterval(timer);

        apply();
        setInterval(apply, KEEPALIVE_MS);
        setInterval(syncUI, 1200);
        setInterval(syncLive, LIVE_MS);

        console.log("%c[奶蛙辅助] 已注入 v2.0（无敌 / 磁铁 / 护盾 / 滑板）", "color:#0a0;font-weight:bold");
        if (STATE.panel) buildUI();
        syncUI();
        setTimeout(syncUI, 1500); // 等登录后的 wardrobe pull 落地再刷一次状态
        return;
      }

      if (waited >= READY_TIMEOUT) {
        clearInterval(timer);
        console.warn("[奶蛙辅助] 等待 RunnerCore / gameDebug 超时。若页面停在 /login，请先登录再进游戏。");
        if (STATE.panel && !ui) buildUI();
      }
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
