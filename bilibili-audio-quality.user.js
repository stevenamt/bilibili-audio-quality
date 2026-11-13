// ==UserScript==
// @name         B站网页版音质选择
// @namespace    https://github.com/stevenamt/bilibili-audio-quality
// @version      2.0.3
// @description  在 B 站网页播放器的「清晰度」菜单里附带音质档位（自动 / 最高可用 / 标准 / 较高 / 极高 / 杜比全景声 / Hi-Res 无损）。选档后重载页面，播放位置自动恢复。
// @author       stevenamt
// @license      MIT
// @homepageURL  https://github.com/stevenamt/bilibili-audio-quality
// @supportURL   https://github.com/stevenamt/bilibili-audio-quality/issues
// @updateURL    https://stevenamt.github.io/bilibili-audio-quality/bilibili-audio-quality.user.js
// @downloadURL  https://stevenamt.github.io/bilibili-audio-quality/bilibili-audio-quality.user.js
// @match        https://www.bilibili.com/video/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理
 * ----
 * B 站把 playurl 的 dash 对象交给 dashjs。
 * dash.audio 里每一路音频，dashjs 都当成一个可选档。
 * 播放器手里本来就有全部档位，只是界面不给你选。
 *
 * 脚本在播放器读到响应之前，只留目标那一路。
 * 三处来源都改：dash.audio 数组、dash.flac、dash.dolby。
 * 播放器没得挑，就只能播它。
 *
 * 换档要重新取流，所以每次选档都重载页面。
 * 重载前把播放位置存进 sessionStorage，回来再 seek 回去。
 *
 * 界面
 * ----
 * 音质选项并进原生「清晰度」菜单，同一条 li 结构。
 * 位置、样式、hover、全屏重定位、点外部关闭全由播放器负责。
 * 菜单里只多一行「音质 · 极高 ▸」，点进去切成音质视图再选档。
 *
 * 结构
 * -----
 * 配置 → 工具 → 取流（改响应）→ 菜单（只画 UI）
 * → 换档与进度 → 交互
 * 取流层不碰 DOM，菜单层不碰响应，
 * 两边只通过 window.biliAQ 交换"现在有哪些档、用了哪一档"。
 */

(function () {
  'use strict';

  // 防重入。同一页面只跑一份
  if (window.biliAQ && window.biliAQ.__core) return;

  // 快照
  // list: 全部档位
  var AQ = { list: [] };

  // ---------------------------------------------------------------- 配置

  // 目标档存放的键
  // 0 = 自动；-1 = 最高可用；正数 = 音轨 id
  var KEY = 'aq_level';

  // 换档前的播放位置
  var SEEK_KEY = 'aq_seek';

  // 位置记录 2 分钟内有效
  var SEEK_TTL = 120000;

  // id 到平台文案。表里没有就显示 #id
  var NAMES = {
    30216: '标准',
    30232: '较高',
    30280: '极高',
    30250: '杜比全景声',
    30251: 'Hi-Res 无损'
  };

  // 最近一次 playurl 给的完整档位表
  // 裁剪之前记下来，单档模式菜单还要用它
  var ALL = [];

  // 菜单选择器与标记
  var MENU = '.bpx-player-ctrl-quality-menu';
  var MARK = 'data-aq';      // 我们加的 li
  var VIEW = 'data-aq-view'; // quality（入口行）/ audio（音质视图）
  var SIG = 'data-aq-sig';   // 上次渲染的快照，用于幂等短路
  var STYLE_ID = 'aq-style';

  // 分组标题 / 返回行共用：字号行高跟原生一致，只把颜色压暗
  var HEAD_STYLE = 'list-style:none;cursor:pointer;padding:6px 12px;' +
    'font-size:11px;line-height:18px;color:rgba(255,255,255,.55);' +
    'border-top:1px solid rgba(255,255,255,.09)';

  // ---------------------------------------------------------------- 工具

  // id 转名字
  // id: 音轨 id，-1 是最高可用，0 是自动
  function name(id) {
    if (id === -1) return '最高可用';
    return NAMES[id] || (id ? '#' + id : '自动');
  }

  // 字节转 kbps，取整
  // bw: 带宽字节数
  function kbps(bw) {
    return Math.round((bw || 0) / 1000);
  }

  // 浏览器能不能解这个编码
  // codec: 形如 mp4a.40.2 / flac / ec-3
  function canPlay(codec) {
    try {
      if (!codec || !window.MediaSource) return true;
      return MediaSource.isTypeSupported('audio/mp4; codecs="' + codec + '"');
    } catch (e) { return true; }
  }

  // 读目标档
  function selected() {
    try {
      var n = parseInt(localStorage.getItem(KEY), 10);
      return isNaN(n) ? 0 : n;
    } catch (e) { return 0; }
  }

  // 写目标档
  // id: 同 KEY 的取值
  function save(id) {
    try { localStorage.setItem(KEY, String(id)); } catch (e) {}
  }

  // ---------------------------------------------------------------- 取流

  // 找 dash。三个位置都试
  // json: playurl 的整个响应
  // 投稿页在 data.dash，番剧在 result.dash
  // 有的接口嵌在 result.video_info.dash
  function findDash(json) {
    if (!json || typeof json !== 'object') return null;
    return (json.data && json.data.dash)
      || (json.result && json.result.dash)
      || (json.result && json.result.video_info && json.result.video_info.dash)
      || null;
  }

  // 处理一份 playurl 响应
  // json: 整个响应，原地改，返回同一个对象
  function handle(json) {
    try {
      var dash = findDash(json);
      if (!dash) return json;

      // 先收完整档位表。后面的裁剪会把它改小
      // seen: 已收的 id，防止同一档出现两次
      var seen = {};
      var full = [];

      // 手上一路音轨，塞进完整表
      // a: 原始对象；defId / defCodec: 缺字段时的兜底
      function keep(a, defId, defCodec) {
        if (!a || !a.baseUrl) return;
        var id = a.id || defId;
        if (!id || seen[id]) return;
        seen[id] = 1;
        full.push({ id: id, bw: a.bandwidth || 0, codec: a.codecs || defCodec, raw: a });
      }

      (dash.audio || []).forEach(function (a) { keep(a, 0, ''); });
      if (dash.flac && dash.flac.audio) keep(dash.flac.audio, 30251, 'flac');
      if (dash.dolby && Array.isArray(dash.dolby.audio)) {
        dash.dolby.audio.forEach(function (a) { keep(a, 30250, 'ec-3'); });
      }

      if (!full.length) return json;

      // 按带宽从低到高排，最高可用就是最后一个
      full.sort(function (x, y) { return x.bw - y.bw; });
      ALL = full.map(function (x) {
        return { id: x.id, bw: x.bw, codec: x.codec };
      });

      var target = selected();

      // 最高可用：往下找第一档能解的
      if (target === -1) {
        for (var i = full.length - 1; i >= 0; i--) {
          if (canPlay(full[i].codec)) { target = full[i].id; break; }
        }
      }

      // 自动：原样交给播放器
      if (!(target > 0)) return json;

      // 具体档：只留一路，播放器没得挑
      var hit = null;
      full.forEach(function (x) { if (+x.id === target) hit = x; });
      if (!hit) return json;

      dash.audio = [hit.raw];
      dash.dolby = { type: 0, audio: null };
      dash.flac = { display: false, audio: null };
    } catch (e) {}
    return json;
  }

  // 判断是不是 playurl 接口
  // url: 请求地址
  function isPlayurl(url) {
    return typeof url === 'string' && url.indexOf('playurl') > -1;
  }

  // 1) 首屏内联数据
  // document-start 抢在页面脚本前
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

  // 3) XHR。切画质走这条
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
          Object.defineProperty(xhr, 'responseText', {
            get: function () { return text; },
            configurable: true
          });
          // responseType 是 json 时调用方要对象
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

  // 刷新快照。给菜单和外界看
  function refresh() {
    AQ.list = ALL.map(function (x) {
      return { id: x.id, kbps: kbps(x.bw), codec: x.codec, ok: canPlay(x.codec) };
    });
  }

  // 菜单数据：自动 / 最高可用 / 实际下发的每一档
  function rows() {
    var cur = selected();
    var out = [
      { id: 0, text: '自动', on: cur === 0 },
      { id: -1, text: '最高可用', on: cur === -1 }
    ];

    AQ.list.forEach(function (a) {
      var rate = a.kbps ? ' · ' + a.kbps + ' kbps' : '';
      out.push({
        id: a.id,
        text: name(a.id) + rate + (a.ok ? '' : '（无法解码）'),
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

  // 收起态：只多一行入口，显示选中的档
  function entryRows() {
    var label = AQ.list.length ? name(selected()) : '读取中';
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

  // 幂等：菜单开关、换档、切清晰度后都会重跑；内容一样就直接返回
  function inject() {
    var ul = menuEl();
    if (!ul) return;
    ensureStyle();

    refresh();

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

  // 换档
  // id: 0 自动 / -1 最高 / 正数音轨 id
  // 每次换档都要重新取流，直接重载
  function apply(id) {
    if (isNaN(id) || id === selected()) return;
    save(id);
    savePlayback();
    location.reload();
  }

  // 重载后视频会回到起点
  // 把时间点临时存进 sessionStorage，回来再 seek
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

  // 菜单是常驻节点，但取流完成前只有画质项；盯住 DOM，一变就补一次，空闲时不消耗
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

  // ---------------------------------------------------------------- 对外

  window.biliAQ = {
    __core: true,

    // 全部档位
    list: function () { refresh(); return AQ.list.slice(); },

    // 换档，会重载
    // id: 0 自动 / -1 最高 / 正数音轨 id
    set: apply,

    // 目标档
    target: selected,

    // 目标档文案
    label: function () { return name(selected()); }
  };
})();
