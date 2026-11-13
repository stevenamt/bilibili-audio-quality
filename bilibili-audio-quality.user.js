// ==UserScript==
// @name         B站网页版音质选择
// @namespace    https://github.com/stevenamt/bilibili-audio-quality
// @version      2.0.2
// @description  在 B 站网页播放器的「清晰度」菜单里附带音质档位（自动 / 最高可用 / 标准 / 较高 / 极高 / 杜比全景声 / Hi-Res 无损）。AAC 之间不刷新页面直接换。
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
 * B 站把 playurl 的 dash 对象直接交给 dashjs。
 * dash.audio 里每一路音频，dashjs 都当成一个 representation。
 * 播放器手里本来就有全部档位，
 * 只是界面不给你选，默认播排序第一的那一路。
 *
 * 换档因此有两条路：
 *   AAC 之间：dashjs 的 setQualityFor('audio', 索引) 原地换。
 *   不重建 MSE，位置、缓冲、画质都不动。
 *   FLAC / 杜比：编码不同，必须换 SourceBuffer，
 *   热切会卡死十几秒，改用重载页面 + 首屏只留目标档。
 *
 * 界面
 * ----
 * 音质选项并进原生「清晰度」菜单，同一条 li 结构。
 * 位置、样式、hover、全屏重定位、点外部关闭全由播放器负责。
 * 菜单里只多一行「音质 · 极高 ▸」，点进去切成音质视图再选档。
 *
 * 结构
 * -----
 * 配置 → 工具 → 取流（改响应）→ 引擎（切档）→ 菜单（只画 UI）
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
  // applied: 上一次切到的档
  var AQ = { list: [], applied: 0 };

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

  // 音轨 id 到编码。拦截响应时记下来
  var CODECS = {};

  // 最近一次 playurl 给的完整档位表
  // 裁剪之前记下来，FLAC 单档模式菜单还要用它
  var ALL = [];

  // dashjs 的 MediaPlayer 实例。截到才有得切
  var MP = null;

  // 页面会建两个实例，第一个是空壳
  // 每次用之前挑一个有档位表的
  var MPS = [];

  // window.dashjs 本体。只为了让页面的 getter 还能读到
  var DJ = null;

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

  // 把 FLAC 和杜比并进 dash.audio
  // dash: playurl 里的 dash 对象
  // 原字段保留，只往 audio 数组里追加
  // dashjs 每多一个对象，就多一路可选档
  function merge(dash) {
    // 待并入的音轨
    var extra = [];

    // 无损是单个对象
    var flac = dash.flac && dash.flac.audio;
    if (flac && flac.baseUrl) extra.push(flac);

    // 杜比是数组
    var dolby = dash.dolby && dash.dolby.audio;
    if (Array.isArray(dolby)) {
      dolby.forEach(function (a) { if (a && a.baseUrl) extra.push(a); });
    }

    if (!extra.length) return;

    dash.audio = dash.audio || [];

    // 已有的 id，避免重复追加
    var have = {};
    dash.audio.forEach(function (a) { have[a.id] = 1; });

    extra.forEach(function (a) {
      if (have[a.id]) return;
      dash.audio.push(a);
    });
  }

  // 处理一份 playurl 响应
  // json: 整个响应，原地改，返回同一个对象
  function handle(json) {
    try {
      var dash = findDash(json);
      if (!dash) return json;

      // 记编码，给 canPlay / hot 用
      (dash.audio || []).forEach(function (a) { if (a.id) CODECS[a.id] = a.codecs || ''; });
      if (dash.flac && dash.flac.audio && dash.flac.audio.id) {
        CODECS[dash.flac.audio.id] = 'flac';
      }
      if (dash.dolby && Array.isArray(dash.dolby.audio)) {
        dash.dolby.audio.forEach(function (a) { if (a.id) CODECS[a.id] = a.codecs || 'ec-3'; });
      }

      // 先记完整档位表。后面的裁剪会把它改小
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
        full.push({ id: id, bw: a.bandwidth || 0, codec: a.codecs || defCodec });
      }

      (dash.audio || []).forEach(function (a) { keep(a, 0, ''); });
      if (dash.flac && dash.flac.audio) keep(dash.flac.audio, 30251, 'flac');
      if (dash.dolby && Array.isArray(dash.dolby.audio)) {
        dash.dolby.audio.forEach(function (a) { keep(a, 30250, 'ec-3'); });
      }

      if (full.length) {
        ALL = full.sort(function (x, y) { return x.bw - y.bw; });
      }

      // 目标是 FLAC / 杜比：直接裁成单路
      // 最高可用时先解析成具体档，才知道要不要裁
      var target = selected();
      if (target === -1) {
        target = ALL.length ? ALL[ALL.length - 1].id : -1;
      }
      if (target > 0 && !hot(target)) {
        var all = [];
        (dash.audio || []).forEach(function (a) { if (a && a.baseUrl) all.push(a); });
        if (dash.flac && dash.flac.audio && dash.flac.audio.baseUrl) all.push(dash.flac.audio);
        if (dash.dolby && Array.isArray(dash.dolby.audio)) {
          dash.dolby.audio.forEach(function (a) { if (a && a.baseUrl) all.push(a); });
        }

        var hit = null;
        all.forEach(function (a) { if (a.id === target) hit = a; });

        if (hit) {
          dash.audio = [hit];
          dash.dolby = { type: 0, audio: null };
          dash.flac = { display: false, audio: null };
          return json;
        }
      }

      merge(dash);
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

  // ---------------------------------------------------------------- 引擎

  // 截 dashjs 实例
  // 页面把 dashjs 赋值到 window 时才能拿到
  // 轮询会错过第一次构造，必须用 setter
  function arm(v) {
    if (!v || typeof v !== 'object') return;
    try {
      var F = v.MediaPlayer;
      if (typeof F !== 'function' || F.__aqWrapped) return;

      // 包一层工厂，create() 的返回值就是实例
      var wrapped = function () {
        var inst = F.apply(this, arguments);
        try {
          var rawCreate = inst.create;
          inst.create = function () {
            var p = rawCreate.apply(this, arguments);
            bind(p);
            return p;
          };
        } catch (e) {}
        return inst;
      };

      for (var k in F) {
        try { wrapped[k] = F[k]; } catch (e) {}
      }
      wrapped.__aqWrapped = true;
      v.MediaPlayer = wrapped;
    } catch (e) {}
  }

  try {
    Object.defineProperty(window, 'dashjs', {
      configurable: true,
      get: function () { return DJ; },
      set: function (v) { DJ = v; arm(v); }
    });
  } catch (e) {}

  // 挑一个真正带档位表的实例
  // B 站先建空壳、再建真正的那个，顺序不保证
  function pick() {
    if (MP) {
      try { if ((MP.getBitrateInfoListFor('audio') || []).length) return MP; } catch (e) {}
    }
    for (var i = MPS.length - 1; i >= 0; i--) {
      try {
        if ((MPS[i].getBitrateInfoListFor('audio') || []).length) {
          MP = MPS[i];
          return MP;
        }
      } catch (e) {}
    }
    return MP;
  }

  // 档位表。每次现读，不缓存
  // 返回 [{id, bw, idx}]，顺序就是 dashjs 的顺序
  function tracks() {
    var p = pick();
    if (!p) return [];
    try {
      var l = p.getBitrateInfoListFor('audio') || [];
      return l.map(function (x, i) {
        return { id: +x.id, bw: x.bitrate || 0, idx: i };
      });
    } catch (e) { return []; }
  }

  // 现在实际在跑的档
  function nowId() {
    var p = pick();
    if (!p) return 0;
    try {
      var l = p.getBitrateInfoListFor('audio') || [];
      var q = p.getQualityFor('audio');
      return l[q] ? +l[q].id : 0;
    } catch (e) { return 0; }
  }

  // 目标档能不能热切
  // 只有 AAC 之间是同一个 SourceBuffer，能原地换
  // FLAC / 杜比要换编码，dashjs 必然重建 MSE，中断十几秒
  function hot(id) {
    var c = CODECS[id] || '';
    return !c || /mp4a|aac/i.test(c);
  }

  // 把目标档落到播放器
  // id: 0 自动 / -1 最高 / 正数音轨 id
  // boot: true 表示首屏调用，此时不许重载，否则死循环
  function apply(id, boot) {
    if (isNaN(id)) return;

    var p = pick();
    var l = [];
    try { l = p ? (p.getBitrateInfoListFor('audio') || []) : []; } catch (e) {}

    // 自动：不碰播放器
    if (id === 0) {
      // 上次是 FLAC 的话手上只有单档，重载才能拿回全部
      if (!boot && l.length <= 1) { savePlayback(); location.reload(); return; }
      // 交回 ABR 自己挑
      try { if (p) p.setAutoSwitchQualityFor('audio', true); } catch (e) {}
      AQ.applied = 0;
      return;
    }

    // 非 AAC 档：换编码必须重建 MSE，走重载让首屏直接取
    if (id > 0 && !hot(id)) {
      if (!boot) { savePlayback(); location.reload(); }
      return;
    }

    if (!l.length) return;

    var want = -1;
    if (id === -1) {
      want = l.length - 1;
    } else {
      for (var i = 0; i < l.length; i++) {
        if (+l[i].id === id) want = i;
      }
    }

    // 实际要落的档。-1 时就是列表最后一个
    var wantId = want >= 0 ? +l[want].id : id;

    // 最高可用可能落在 FLAC 上，同样不能热切
    if (!hot(wantId)) {
      if (!boot) { savePlayback(); location.reload(); }
      return;
    }

    // 列表里没有目标档：当前 manifest 不全，重载才能拿到
    if (want < 0) {
      if (!boot) { savePlayback(); location.reload(); }
      return;
    }

    try {
      p.setQualityFor('audio', want);
      AQ.applied = +l[want].id;
    } catch (e) {}
  }

  // 实例就绪
  // p: dashjs 的 MediaPlayer
  function bind(p) {
    MP = p;
    MPS.push(p);

    // 等档位表出来再落目标
    // 播放器构造完到 manifest 解析完有一小段空窗
    var tries = 0;
    var timer = setInterval(function () {
      var l = [];
      try { l = p.getBitrateInfoListFor('audio') || []; } catch (e) {}

      if (l.length) {
        clearInterval(timer);
        apply(selected(), true);
        refresh();
      } else if (++tries > 60) {
        clearInterval(timer);
      }
    }, 250);
  }

  // 刷新快照。给菜单和外界看
  function refresh() {
    var live = tracks().map(function (t) {
      var codec = CODECS[t.id] || '';
      return { id: t.id, kbps: kbps(t.bw), codec: codec, ok: canPlay(codec) };
    });

    // FLAC / 杜比模式下 dashjs 手上只有一路
    // 用 playurl 记下的完整表，菜单才切得回去
    if (ALL.length > live.length) {
      AQ.list = ALL.map(function (x) {
        return { id: x.id, kbps: kbps(x.bw), codec: x.codec, ok: canPlay(x.codec) };
      });
      return;
    }

    AQ.list = live;
  }

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

  // 收起态：只多一行入口，显示当前实际在用的档
  function entryRows() {
    var n = nowId();
    var t = selected();
    var label = n > 0 ? name(n) : (t === -1 ? '最高可用' : '自动');
    if (!AQ.list.length) label = '读取中';
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

  // 换档只能重载时，视频会回到起点
  // 把时间点临时存进 sessionStorage，重载后 seek 回去
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
      save(parseInt(mark, 10));
      apply(parseInt(mark, 10), false);
      inject();
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

    // 换档。AAC 之间热切，FLAC / 杜比走重载
    // id: 0 自动 / -1 最高 / 正数音轨 id
    set: function (id) {
      if (isNaN(id)) return;
      save(id);
      apply(id, false);
      refresh();
    },

    // 实际在跑的档
    now: nowId,

    // 目标档
    target: selected,

    // 目标档文案
    label: function () { return name(selected()); }
  };
})();
