// dsh-balance — Client 半（手写，无构建依赖）。
// 格式：window.__ModuleLoader__.load({ id, factory }) 的 CJS factory，
// 与 esbuild 产物同构；platform 模块（react）经注入的 require 解析。
window.__ModuleLoader__.load({ id: "dsh-balance", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

var React = require("react");

var CSS = [
  ".dsh-balance-badge{display:inline-flex;gap:8px;font-size:12px;line-height:1;padding:2px 8px;border-radius:999px;white-space:nowrap;user-select:none;color:var(--ds-color-text-secondary,#8a8f98);}",
  ".dsh-balance-item.is-ok{color:var(--ds-color-success,#16a34a);}",
  ".dsh-balance-item.is-low{color:var(--ds-color-warning,#d97706);font-weight:600;}",
  ".dsh-balance-item.is-error{color:var(--ds-color-text-tertiary,#9aa0a8);}",
  ".dsh-balance-item.is-usage{color:var(--ds-color-text-secondary,#8a8f98);}",
  ".dsh-balance-panel{display:flex;flex-direction:column;gap:12px;max-width:480px;font-size:13px;}",
  ".dsh-balance-row{display:flex;align-items:center;gap:8px;}",
  ".dsh-balance-row input[type=number]{width:120px;}",
  ".dsh-balance-subtitle{font-weight:600;margin-top:4px;}",
  ".dsh-balance-provider{display:flex;align-items:center;gap:8px;}",
  ".dsh-balance-panel button{align-self:flex-start;padding:4px 14px;}",
  ".dsh-balance-saved{margin-left:8px;color:var(--ds-color-text-tertiary,#9aa0a8);}",
].join("\n");

function formatBalance(p) {
  var n = Number(p.balance);
  var s = isFinite(n) ? n.toFixed(2) : String(p.balance);
  return (p.symbol || "") + s;
}

function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function BalanceBadge(props) {
  var ctx = props.ctx;
  var sessionId = props.sessionId;
  var pair = React.useState(null);
  var state = pair[0];
  var setState = pair[1];
  var usagePair = React.useState(null);
  var usage = usagePair[0];
  var setUsage = usagePair[1];

  React.useEffect(function () {
    var alive = true;
    function refresh() {
      fetch("/dsh-balance/api/state")
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (alive && d) setState(d); })
        .catch(function () {});
      if (sessionId) {
        fetch("/dsh-balance/api/usage?sessionId=" + encodeURIComponent(sessionId))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (alive && d && d.ok) setUsage(d); })
          .catch(function () {});
      }
    }
    refresh();
    var timer = ctx.get("timer");
    var stop;
    if (timer) stop = timer.interval(refresh, 300000);
    return function () { alive = false; if (stop) stop(); };
  }, []);

  if (state === null) {
    return React.createElement("span", { className: "dsh-balance-badge" }, "余额加载中…");
  }
  if (state.enabled === false) {
    return null; // 总开关关闭 → 隐藏徽章
  }
  var providers = state.providers || [];
  if (providers.length === 0) {
    return React.createElement("span", { className: "dsh-balance-badge" }, "无启用的提供商");
  }
  var items = providers.map(function (p, i) {
    var cls = "dsh-balance-item " + (p.ok ? (p.low ? "is-low" : "is-ok") : "is-error");
    var text = p.ok
      ? (p.name || p.id) + " " + formatBalance(p) + (p.low ? " ⚠" : "")
      : (p.name || p.id) + " " + (p.error || "获取失败");
    return React.createElement("span", { key: p.id || String(i), className: cls }, text);
  });
  if (usage && usage.ok) {
    var total = usage.tokens.input + usage.tokens.output + usage.tokens.cache + usage.tokens.reasoning;
    var u = "本项 " + formatTokens(total) + " tok";
    if (usage.cost !== undefined) u += " · ¥" + usage.cost.toFixed(3);
    items.push(React.createElement("span", { key: "usage", className: "dsh-balance-item is-usage" }, u));
  }
  return React.createElement("span", { className: "dsh-balance-badge", title: "API 账户余额与当前项目用量" }, items);
}

function SettingsPanel(props) {
  var ctx = props.ctx;
  var configPair = React.useState(null);
  var config = configPair[0];
  var setConfig = configPair[1];
  var savedPair = React.useState("");
  var saved = savedPair[0];
  var setSaved = savedPair[1];

  React.useEffect(function () {
    fetch("/dsh-balance/api/config")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.config) setConfig(d.config); })
      .catch(function () {});
  }, []);

  if (config === null) {
    return React.createElement("div", { className: "dsh-balance-panel" }, "加载中…");
  }

  function update(patch) {
    setConfig(Object.assign({}, config, patch));
  }
  function updateProvider(index, patch) {
    var next = config.providers.slice();
    next[index] = Object.assign({}, next[index], patch);
    setConfig(Object.assign({}, config, { providers: next }));
  }
  function save() {
    setSaved("");
    fetch("/dsh-balance/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function () { setSaved("已保存"); })
      .catch(function () { setSaved("保存失败"); });
  }

  var rows = (config.providers || []).map(function (p, i) {
    return React.createElement("label", { key: p.id || String(i), className: "dsh-balance-provider" },
      React.createElement("input", {
        type: "checkbox",
        checked: p.enabled !== false,
        onChange: function (e) { updateProvider(i, { enabled: e.target.checked }); },
      }),
      React.createElement("span", null, p.name || p.id)
    );
  });

  return React.createElement("div", { className: "dsh-balance-panel" },
    React.createElement("label", { className: "dsh-balance-row" },
      React.createElement("input", {
        type: "checkbox",
        checked: config.enabled !== false,
        onChange: function (e) { update({ enabled: e.target.checked }); },
      }),
      React.createElement("span", null, "启用余额显示")
    ),
    React.createElement("label", { className: "dsh-balance-row" },
      React.createElement("span", null, "低余额阈值"),
      React.createElement("input", {
        type: "number",
        value: config.lowThreshold,
        onChange: function (e) { update({ lowThreshold: Number(e.target.value) }); },
      })
    ),
    React.createElement("label", { className: "dsh-balance-row" },
      React.createElement("span", null, "刷新间隔 (ms)"),
      React.createElement("input", {
        type: "number",
        value: config.refreshMs,
        onChange: function (e) { update({ refreshMs: Number(e.target.value) }); },
      })
    ),
    React.createElement("div", null,
      React.createElement("div", { className: "dsh-balance-subtitle" }, "提供商"),
      rows
    ),
    React.createElement("div", null,
      React.createElement("button", { onClick: save }, "保存"),
      saved ? React.createElement("span", { className: "dsh-balance-saved" }, saved) : null
    )
  );
}

function apply(ctx) {
  var slots = ctx.get("slots");
  if (slots === undefined) return;

  // 注入样式（teardown 时移除）
  var style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  ctx.effect(function () {
    return function () { style.remove(); };
  }, "dsh-balance styles");

  // Composer 下方余额徽章
  slots.inject("conversation.composer.dock", function () {
    return slots.register(
      { name: "conversation.composer.dock", id: "dsh-balance", order: 60 },
      function (props) { return React.createElement(BalanceBadge, { ctx: ctx, sessionId: props && props.sessionId }); }
    );
  });

  // 设置面板（独立页）
  slots.inject("settings.section", function () {
    return slots.register(
      { name: "settings.section", id: "dsh-balance", order: 100, label: "余额监控" },
      function (props) { return React.createElement(SettingsPanel, { ctx: ctx, close: props && props.close }); }
    );
  });
}

module.exports = { apply: apply };
return module.exports;
} });
