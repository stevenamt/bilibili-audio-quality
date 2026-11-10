// ==UserScript==
// @name         B站网页版音质选择
// @name:zh-CN   B站网页版音质选择
// @namespace    https://github.com/stevenamt/bilibili-audio-quality
// @version      1.6.0
// @description  在 B 站网页播放器的「清晰度」菜单里附带音质档位（自动 / 最高可用 / 标准 / 较高 / 极高 / 杜比全景声 / Hi-Res 无损）。
// @author       stevenamt
// @license      MIT
// @homepageURL  https://github.com/stevenamt/bilibili-audio-quality
// @supportURL   https://github.com/stevenamt/bilibili-audio-quality/issues
// @updateURL    https://stevenamt.github.io/bilibili-audio-quality/bilibili-audio-quality.user.js
// @downloadURL  https://stevenamt.github.io/bilibili-audio-quality/bilibili-audio-quality.user.js
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理
 * -----
 * B 站网页播放器没有独立的音质选项：x/player/playurl 的响应里 dash.audio 同时带多路音频，
 * 选哪一路由播放器自己决定，服务端也没有“指定音质”的参数。
 * 所以这里只做一件事：在播放器读到响应之前把 dash.audio 过滤成只剩目标那一路。
 * 三条路径都要拦：首屏内联的 window.__playinfo__、fetch、XMLHttpRequest。
 *
 * 界面
 * -----
 * 音质选项并进原生「清晰度」菜单（同一条 li 结构），不自绘按钮和浮层：
 * 位置、样式、hover、全屏重定位、点外部关闭全由播放器负责。
 * 菜单里只多一行「音质 · 极高 ▸」，点进去切成音质视图再选档——
 * 直接平铺会把菜单撑到比播放器还高，小窗口下顶部的画质项会被裁掉。
 *
 * 结构
 * -----
 * 配置 → 状态 → 工具 → 取流（改响应）→ 菜单（只画 UI）→ 换档（存进度、重载）→ 交互入口
 * 取流层不碰 DOM，菜单层不碰响应；两边只通过 AQ 这个快照交换“现在有哪些档、用了哪一档”。
 *
 * 已知限制
 * --------
 * - 档位名用平台官方文案（标准 / 较高 / 极高），后面跟的数字才是接口下发的实测码率。
 * - 无损 / 杜比取决于片源和账号权限，平台不下发就没有（脚本不伪造档位）。
 * - 判断某档能不能播只看浏览器解码能力：Chrome/Linux 解不了 E-AC-3，杜比档会标「无法解码」。
 */

(function () {
  'use strict';

  // 既是防重入标记，也是取流层给菜单层的快照
  if (window.__biliAQ) return;
  var AQ = window.__biliAQ = { all: [], applied: 0 };

  // ---------------------------------------------------------------- 配置

  var LEVEL_KEY = 'aq_level';  // 0 = 自动（不拦取流）；-1 = 最高可用；其余为音轨 id
  var SEEK_KEY = 'aq_seek';    // 换档前的播放位置
  var SEEK_TTL = 120000;       // 位置记录 2 分钟内有效

  // [音轨 id, 档位简称, 全称]。顺序即高低；id 大小和音质无关（30251 无损的 id 比 30280 小）
  // 名字用平台官方那套（标准 / 较高 / 极高），不写标称码率：实测 30216 只有 44 kbps，
  // 写「64K」会和同一行显示的实测值当场打架。
  var TIERS = [
    [30216, '标准', '标准'],
    [30232, '较高', '较高'],
    [30280, '极高', '极高'],
    [30250, '杜比', '杜比全景声'],
    [30251, '无损', 'Hi-Res 无损']
  ];
  var ORDER = TIERS.map(function (t) { return t[0]; });
  var VIP_FROM = ORDER.indexOf(30250); // 从这里开始是大会员档

  var NAMES = {};
  TIERS.forEach(function (t) { NAMES[t[0]] = t; });

  // 菜单选择器与标记
  var MENU = '.bpx-player-ctrl-quality-menu';
  var MARK = 'data-aq';      // 我们加的 li
  var VIEW = 'data-aq-view'; // quality（入口行）/ audio（音质视图）
  var SIG = 'data-aq-sig';   // 上次渲染的快照，用于幂等短路
  var STYLE_ID = 'aq-style';

  // 分组标题 / 返回行共用：字号行高跟原生一致，只把颜色压暗、加一条分隔线
  var HEAD_STYLE = 'list-style:none;cursor:pointer;padding:6px 12px;' +
    'font-size:11px;line-height:18px;color:rgba(255,255,255,.55);' +
    'border-top:1px solid rgba(255,255,255,.09)';

  // ---------------------------------------------------------------- 工具

  function name(id, full) {
    var t = NAMES[id];
    if (t) return full ? t[2] : t[1];
    if (id === -1) return '最高可用'; // 不是音轨 id，不能落到 '#' 兜底
    return id ? '#' + id : '自动';
  }

  function kbps(stream) {
    return Math.round(((stream && stream.bandwidth) || 0) / 1000);
  }

  // 浏览器能不能解这个音频编码。MediaSource 缺失时按可播处理，别误杀
  function canPlay(codec) {
    try {
      if (!codec || !window.MediaSource) return true;
      return MediaSource.isTypeSupported('audio/mp4; codecs="' + codec + '"');
    } catch (e) { return true; }
  }

  function selected() {
    try {
      var n = parseInt(localStorage.getItem(LEVEL_KEY), 10);
      return isNaN(n) ? 0 : n;
    } catch (e) { return 0; }
  }

  function save(id) {
    try { localStorage.setItem(LEVEL_KEY, String(id)); } catch (e) {}
  }

  // ---------------------------------------------------------------- 取流

  // 把普通 / 无损 / 杜比三处音频合成一张表，按档位高低排序
  function collect(dash) {
    var list = [];

    function add(a, defId, defCodec) {
      if (!a) return;
      list.push({ id: a.id || defId, kbps: kbps(a), codec: a.codecs || defCodec, raw: a });
    }

    (dash.audio || []).forEach(function (a) { add(a, a.id, ''); });

    var flac = dash.flac && dash.flac.audio; // 无损是单个对象
    if (flac && flac.baseUrl) add(flac, 30251, 'flac');

    var dolby = dash.dolby && dash.dolby.audio; // 杜比是数组
    if (Array.isArray(dolby)) dolby.forEach(function (a) { add(a, 30250, 'ec-3'); });

    return list.sort(function (x, y) { return ORDER.indexOf(x.id) - ORDER.indexOf(y.id); });
  }

  // 挑一路：目标档在就精确命中；不在就退到不高于它的最高普通档；-1 取能播的最高档
  function choose(list, target) {
    var playable = list.filter(function (x) { return canPlay(x.codec); });
    if (!playable.length) return list[list.length - 1];
    if (target === -1) return playable[playable.length - 1];

    // 精确命中优先。少了这一步，选「无损」会被下面的 VIP_FROM 挡掉、退成极高档
    for (var i = 0; i < playable.length; i++) {
      if (playable[i].id === target) return playable[i];
    }

    // 目标档没下发：退到不高于它的最高普通档；比最低档还低（或目标 id 不在表里）就取最低档
    var want = ORDER.indexOf(target);
    if (want > -1) {
      for (var j = playable.length - 1; j >= 0; j--) {
        var idx = ORDER.indexOf(playable[j].id);
        if (idx > -1 && idx <= want && idx < VIP_FROM) return playable[j];
      }
    }
    return playable[0];
  }

  // 改响应：只留目标那一路，并把无损 / 杜比字段清空，免得播放器绕过去
  function handle(json) {
    try {
      var dash = json && json.data && json.data.dash;
      if (!dash) return json;

      var list = collect(dash);
      if (!list.length) return json;

      var target = selected();
      var applied = 0;

      if (target) {
        var hit = choose(list, target);
        if (hit) {
          dash.audio = [hit.raw]; // 只留一路，播放器没得挑
          dash.dolby = { type: 0, audio: null };
          dash.flac = { display: false, audio: null };
          applied = hit.id;
        }
      }

      AQ.all = list.map(function (x) {
        return { id: x.id, kbps: x.kbps, codec: x.codec, ok: canPlay(x.codec) };
      });
      AQ.applied = applied;
    } catch (e) {}
    return json;
  }

  function isPlayurl(url) {
    return typeof url === 'string' && url.indexOf('playurl') > -1;
  }

  // 1) 首屏内联数据
  var inline;
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      get: function () { return inline; },
      set: function (v) { inline = handle(v); }
    });
  } catch (e) {}

  // 2) fetch
  var rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url);
      var pending = rawFetch.apply(this, arguments);
      if (!isPlayurl(url)) return pending;

      return pending.then(function (res) {
        return res.clone().json().then(function (json) {
          return new Response(JSON.stringify(handle(json)), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
          });
        }).catch(function () { return res; });
      });
    };
  }

  // 3) XMLHttpRequest：send 之前注册 readystatechange，早于播放器读取
  var rawOpen = XMLHttpRequest.prototype.open;
  var rawSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aqUrl = url;
    return rawOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (isPlayurl(xhr.__aqUrl)) {
      var patched = false;
      xhr.addEventListener('readystatechange', function () {
        if (patched || xhr.readyState !== 4) return;
        patched = true;
        try {
          var text = JSON.stringify(handle(JSON.parse(xhr.responseText)));
          Object.defineProperty(xhr, 'responseText', { get: function () { return text; }, configurable: true });
          // responseType 是 json 时调用方要的是对象，塞字符串会让它读 undefined
          Object.defineProperty(xhr, 'response', {
            configurable: true,
            get: function () {
              if (xhr.responseType === 'json') {
                try { return JSON.parse(text); } catch (e) { return null; }
              }
              return text;
            }
          });
        } catch (e) {}
      });
    }
    return rawSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------- 菜单

  function menuEl() {
    return document.querySelector(MENU);
  }

  // 音质视图下隐藏原生画质项：平铺会超出播放器高度，顶部几项被容器裁掉
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = MENU + '[' + VIEW + '="audio"]>li:not([' + MARK + ']){display:none}';
    (document.head || document.documentElement).appendChild(style);
  }

  // 实际在跑的那一路：分片 URL 形如 xxx-1-30280.m4s，取最近出现的一条。
  // 选「自动」或「最高可用」时，播放器实际挑的可能不是你以为的那档，入口行要如实显示
  function runningId() {
    try {
      var entries = performance.getEntriesByType('resource');
      for (var i = entries.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
        var m = /-(\d{5})\.m4s/.exec(entries[i].name);
        if (m && ORDER.indexOf(+m[1]) > -1) return +m[1];
      }
    } catch (e) {}
    return 0;
  }

  // 菜单数据：自动 / 最高可用 / 实际下发的每一档
  function rows() {
    var cur = selected();
    var out = [
      { id: 0, text: '自动', on: cur === 0 },
      { id: -1, text: '最高可用', on: cur === -1 }
    ];

    AQ.all.forEach(function (a) {
      var rate = a.kbps ? ' · ' + a.kbps + ' kbps' : '';
      out.push({
        id: a.id,
        text: name(a.id, true) + rate + (a.ok ? '' : '（无法解码）'),
        on: cur === a.id,
        off: !a.ok
      });
    });

    return out;
  }

  function item(text, mark, cls, style) {
    var li = document.createElement('li');
    li.className = 'bpx-player-ctrl-quality-menu-item' + (cls ? ' ' + cls : '');
    li.setAttribute(MARK, String(mark));
    if (style) li.style.cssText = style;

    var span = document.createElement('span');
    span.className = 'bpx-player-ctrl-quality-text';
    span.textContent = text;
    li.appendChild(span);
    return li;
  }

  // 收起态：只多一行入口，显示当前实际在用的档
  function entryRows() {
    var id = runningId() || AQ.applied || selected();
    var label = id > 0 ? name(id, true) : (selected() === -1 ? '最高可用' : '自动');
    if (!AQ.all.length) label = '读取中';
    return [item('音质 · ' + label + ' ▸', 'head', '', HEAD_STYLE)];
  }

  // 音质视图：一行返回 + 各下发档位
  function audioRows(list) {
    var out = [item('◂ 清晰度', 'back', '', HEAD_STYLE)];

    list.forEach(function (r) {
      var li = item(r.text, r.id, r.on ? 'bpx-state-active' : '',
        r.off ? 'opacity:.4;cursor:not-allowed' : '');
      if (r.off) li.setAttribute('data-off', '');
      out.push(li);
    });

    return out;
  }

  // 幂等：菜单开关、换档、切清晰度后都会重跑；内容和上次一样就直接返回
  function inject() {
    var ul = menuEl();
    if (!ul) return;
    ensureStyle();

    var view = ul.getAttribute(VIEW) || 'quality';
    var list = rows();
    var sig = view + ':' + list.map(function (r) {
      return r.id + (r.on ? '*' : '') + (r.off ? 'x' : '');
    }).join('|');

    if (ul.getAttribute(SIG) === sig && ul.querySelector('[' + MARK + ']')) return;

    [].slice.call(ul.querySelectorAll('[' + MARK + ']')).forEach(function (n) {
      n.parentNode.removeChild(n);
    });

    (view === 'audio' ? audioRows(list) : entryRows()).forEach(function (li) {
      ul.appendChild(li);
    });

    ul.setAttribute(SIG, sig);
  }

  // ------------------------------------------------------------ 换档与进度

  // 换档只能重载页面，视频会回到起点。把时间点临时存进 sessionStorage，重载后 seek 回去
  function savePlayback() {
    try {
      var v = document.querySelector('video');
      if (!v || !(v.currentTime > 0.5)) return;
      sessionStorage.setItem(SEEK_KEY, v.currentTime + ',' + Date.now());
    } catch (e) {}
  }

  function restorePlayback() {
    var t = 0;
    try {
      var parts = (sessionStorage.getItem(SEEK_KEY) || '').split(',');
      var at = +parts[1];
      if (at && Date.now() - at <= SEEK_TTL) t = +parts[0] || 0;
    } catch (e) { return; }
    if (!(t > 0)) return;

    // document-start 时还没有 video，等播放器就绪后再 seek
    var tries = 0;
    var timer = setInterval(function () {
      var v = document.querySelector('video');
      if (v && v.readyState >= 1) {
        clearInterval(timer);
        try { v.currentTime = t; sessionStorage.removeItem(SEEK_KEY); } catch (e) {}
      } else if (++tries > 40) {
        clearInterval(timer);
      }
    }, 250);
  }

  function apply(id) {
    if (isNaN(id)) return;
    save(id);
    savePlayback();
    location.reload();
  }

  // ---------------------------------------------------------------- 交互

  // 播放器对菜单有事件委托，条目点下去会顺带触发画质切换，所以在捕获阶段拦掉
  document.addEventListener('click', function (e) {
    var li = e.target && e.target.closest && e.target.closest('[' + MARK + ']');
    if (!li) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var mark = li.getAttribute(MARK);
    var ul = menuEl();
    if (!ul) return;

    if (mark === 'head') {
      ul.setAttribute(VIEW, 'audio');
      inject();
    } else if (mark === 'back') {
      ul.setAttribute(VIEW, 'quality');
      inject();
    } else if (!li.hasAttribute('data-off')) {
      apply(parseInt(mark, 10));
    }
  }, true);

  // 菜单是常驻节点，但取流完成前只有画质项；盯住 DOM，一变就补一次，空闲时不消耗。
  // document-start 时 documentElement 可能还是 null，observe 会抛错并把后面注册一起带崩
  var watching = false;
  function watch() {
    if (watching || !document.documentElement) return;
    watching = true;
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { queued = false; inject(); }, 120);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // 切清晰度 / 换 P 之后会重新取流，菜单里的档位要跟着变
  document.addEventListener('loadedmetadata', function () { setTimeout(inject, 500); }, true);
  document.addEventListener('fullscreenchange', function () { setTimeout(inject, 300); });

  restorePlayback();
  watch();

  document.addEventListener('DOMContentLoaded', function () {
    watch();
    inject();
  });

  if (document.readyState !== 'loading') {
    watch();
    inject();
  }
})();
