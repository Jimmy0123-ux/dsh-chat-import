/* global window, document, fetch */
// lib/client.js — dsh-chat-import 的 Browser 侧 bundle（手写 CJS factory，供 dsh web
// 客户端 ModuleLoader 注入）。REQ-41：侧边栏底部「导入会话」按钮 → 滑出面板。
// Stage 1：被动会话发现（POST /api-import/sessions，11 来源下拉）。
// Stage 2：按工作区文件夹（project）分组浏览 + 单选/多选导入（POST /api-import/import，
// 复用 host 工具层同一套导入编排——幂等/增量/force/预算语义与 import_* 工具一致）。
// 纯前端：不 import 任何 DSH host 模块，只消费注入的 slots 服务与 react。
// 结构对齐竞品 dsh-plugin-session-import（ModuleLoader.load + module.exports
// {name,inject,apply} + ctx.slots.register）。
window.__ModuleLoader__.load({
  id: "dsh-chat-import",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useState, useEffect } = React;

    // 来源下拉（'' = 全部来源；与 lib/discovery.mjs 的 FORMATS 对应，claude-code →
    // claude）。chatgpt 无默认数据根，仅显式 path 可发现。
    const SOURCES = [
      "", "claude-code", "codex", "chatgpt", "cursor", "gemini", "reasonix",
      "opencode", "zcode", "grokbuild", "openclaw", "pi", "hermes",
    ];
    // discovery format 短名 → 客户端来源 id（构建 /api-import/import 的 items）。
    const FORMAT_SOURCE = {
      claude: "claude-code", codex: "codex", chatgpt: "chatgpt", cursor: "cursor",
      gemini: "gemini", reasonix: "reasonix", opencode: "opencode", zcode: "zcode",
      grokbuild: "grokbuild", openclaw: "openclaw", pi: "pi", hermes: "hermes",
    };

    // 滑入动画（一次性注入，幂等防重复）
    if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-import-slide]")) {
      const tag = document.createElement("style");
      tag.dataset.dshImportSlide = "1";
      tag.textContent = "@keyframes dsh-import-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }";
      document.head.appendChild(tag);
    }

    // 明暗主题自适应（对齐竞品：body 的 data-ds-dark-theme 属性判定）
    const isDark = () => typeof document !== "undefined" && document.body && document.body.hasAttribute("data-ds-dark-theme");
    const themeColors = () => (isDark()
      ? { bg: "#1b1f27", border: "#2a3040", field: "#14181f", text: "#e4e8ee", dim: "#9aa3b2", dimmer: "#7a8394", accent: "#4f8cff", hover: "#1f2530" }
      : { bg: "#ffffff", border: "#d8dee6", field: "#f5f6f8", text: "#1f2328", dim: "#57606a", dimmer: "#6e7781", accent: "#0969da", hover: "#eef1f5" });

    const makeStyles = (C) => ({
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9998, display: "flex", justifyContent: "flex-end" },
      panel: {
        position: "fixed", top: 0, right: 0, bottom: 0, width: "460px", maxWidth: "94vw",
        background: C.bg, borderLeft: "1px solid " + C.border, color: C.text,
        font: "13px/1.6 system-ui, sans-serif", zIndex: 9999, display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,.35)",
        animation: "dsh-import-slide-in .18s ease-out",
      },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid " + C.border },
      title: { fontSize: "14px", fontWeight: 600 },
      close: { background: "transparent", border: "none", color: C.dim, fontSize: "16px", cursor: "pointer", padding: "2px 6px", borderRadius: "4px" },
      row: { display: "flex", gap: "8px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid " + C.border },
      label: { color: C.dim, flex: "none" },
      select: {
        flex: "1", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "6px 8px", fontSize: "13px", outline: "none",
      },
      // 工具栏：全选 / 清空 / 刷新 + 已选计数
      toolbar: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      toolBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "4px 10px", fontSize: "12px", cursor: "pointer",
      },
      count: { marginLeft: "auto", color: C.dimmer, fontSize: "12px", flex: "none" },
      // 导入操作条：多选导入主按钮 + 结果摘要
      importBar: { display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      primaryBtn: {
        flex: "1", background: C.accent, color: "#ffffff", border: "none", borderRadius: "6px",
        padding: "7px 10px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer",
      },
      result: { padding: "7px 12px", fontSize: "12px", color: C.dim, borderBottom: "1px solid " + C.border, background: C.field },
      list: { flex: "1", overflowY: "auto", padding: "8px" },
      // 工作区文件夹分组头
      group: {
        display: "flex", alignItems: "center", gap: "6px", padding: "8px 10px 4px",
        fontSize: "12px", fontWeight: 600, color: C.dim, position: "sticky", top: 0,
        background: C.bg, zIndex: 1,
      },
      groupCount: { marginLeft: "auto", fontSize: "11px", fontWeight: 400, color: C.dimmer },
      item: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 10px", borderRadius: "6px", marginBottom: "2px" },
      checkbox: { marginTop: "3px", flex: "none", accentColor: C.accent, cursor: "pointer" },
      itemMain: { flex: "1", minWidth: "0" },
      itemTitle: { fontSize: "12.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      itemMeta: { color: C.dimmer, fontSize: "11px", marginTop: "2px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      fmt: { fontSize: "10px", padding: "0 6px", borderRadius: "8px", border: "1px solid " + C.border, color: C.dim, flex: "none" },
      badge: { marginLeft: "auto", fontSize: "10px", padding: "1px 6px", borderRadius: "8px", border: "1px solid " + C.border, color: C.dim, flex: "none" },
      importBtn: {
        flex: "none", background: C.accent, color: "#ffffff", border: "none", borderRadius: "6px",
        padding: "3px 10px", fontSize: "11.5px", cursor: "pointer", marginTop: "2px",
      },
      importedTag: { flex: "none", fontSize: "11px", color: "#1a7f37", marginTop: "2px", whiteSpace: "nowrap" },
      status: { padding: "40px 16px", textAlign: "center", color: C.dimmer },
      error: { padding: "16px", textAlign: "center", color: "#cf222e" },
    });

    function fmtTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    const statusLabel = (st) => (st === "imported" ? "已导入" : st === "partial" ? "部分" : "未导入");
    const statusColor = (st, colors) => (st === "imported" ? "#1a7f37" : st === "partial" ? "#9a6700" : colors.dimmer);

    // 会话条目唯一键（format + sourcePath + sessionId；\u0000 不在路径中出现）
    const itemKey = (s) => s.format + "\u0000" + s.sourcePath + "\u0000" + s.sessionId;
    // 条目 → /api-import/import 的 items 项（client 来源 id + sourcePath + sessionId）
    const toItem = (s) => ({ source: FORMAT_SOURCE[s.format] || s.format, sourcePath: s.sourcePath, sessionId: s.sessionId });

    // 批量结果摘要（single/batch 混合计数）
    function fmtImportResult(results) {
      const c = { imported: 0, already: 0, appended: 0, skipped: 0, failed: 0 };
      for (const r of results || []) {
        if (r.status === "failed") { c.failed++; continue; }
        if (r.mode === "batch") {
          c.imported += r.imported || 0;
          c.already += r.alreadyImported || 0;
          c.appended += r.appended || 0;
          c.skipped += r.skipped || 0;
          c.failed += r.failed || 0;
        } else if (r.status === "imported") c.imported++;
        else if (r.status === "already-imported") c.already++;
        else if (r.status === "appended") c.appended++;
        else c.skipped++;
      }
      const bits = [];
      if (c.imported) bits.push("新增 " + c.imported);
      if (c.appended) bits.push("续写 " + c.appended);
      if (c.already) bits.push("已存在 " + c.already);
      if (c.skipped) bits.push("跳过 " + c.skipped);
      if (c.failed) bits.push("失败 " + c.failed);
      return "导入完成：" + (bits.length ? bits.join("，") : "无变化");
    }

    /** 发现 + 导入面板：来源过滤 + 按工作区文件夹分组 + 单选/多选导入 */
    function DiscoveryPanel({ onClose, source, onSourceChange }) {
      const colors = themeColors();
      const style = makeStyles(colors);
      const [sessions, setSessions] = useState(null); // null = 加载中；[] = 空
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(new Map()); // key → 会话条目
      const [importing, setImporting] = useState(false);
      const [result, setResult] = useState(null);
      const [reload, setReload] = useState(0);

      useEffect(() => {
        let cancelled = false;
        setSessions(null);
        setError(null);
        setResult(null);
        setSelected(new Map());
        fetch("/api-import/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, query: "" }),
        })
          .then((resp) => resp.json())
          .then((data) => {
            if (cancelled) return;
            if (data && data.ok === true) setSessions(Array.isArray(data.sessions) ? data.sessions : []);
            else setError((data && data.error) || "会话列表加载失败");
          })
          .catch((err) => { if (!cancelled) setError(String((err && err.message) || err)); });
        return () => { cancelled = true; };
      }, [source, reload]);

      // 执行导入（单选/多选共用）：POST /api-import/import → 摘要 → 重取列表刷新状态
      const doImport = async (items) => {
        if (!items || items.length === 0 || importing) return;
        setImporting(true);
        setResult(null);
        try {
          const resp = await fetch("/api-import/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
          });
          const data = await resp.json();
          if (data && data.ok === true) {
            setResult(fmtImportResult(data.results));
            setSelected(new Map());
            setReload((n) => n + 1);
          } else {
            setResult((data && data.error) || "导入失败");
          }
        } catch (err) {
          setResult("导入失败：" + String((err && err.message) || err));
        } finally {
          setImporting(false);
        }
      };

      const toggle = (s) => {
        const key = itemKey(s);
        setSelected((prev) => {
          const next = new Map(prev);
          if (next.has(key)) next.delete(key);
          else next.set(key, s);
          return next;
        });
      };

      const toggleAll = () => {
        if (!sessions || sessions.length === 0) return;
        const allKeys = sessions.map(itemKey);
        const allSelected = allKeys.every((k) => selected.has(k));
        setSelected(allSelected ? new Map() : new Map(allKeys.map((k, i) => [k, sessions[i]])));
      };

      // 按工作区文件夹（project）分组；未分组钉到最后
      const groups = [];
      if (sessions && sessions.length > 0) {
        const byProject = new Map();
        for (const s of sessions) {
          const key = s.project || "(未分组)";
          if (!byProject.has(key)) byProject.set(key, []);
          byProject.get(key).push(s);
        }
        const names = [...byProject.keys()].sort((a, b) => {
          if (a === "(未分组)") return 1;
          if (b === "(未分组)") return -1;
          return a.localeCompare(b);
        });
        for (const name of names) groups.push({ name, list: byProject.get(name) });
      }

      const allSelected = sessions && sessions.length > 0 && sessions.every((s) => selected.has(itemKey(s)));

      const renderGroup = (group) => {
        const rows = group.list.map((s) => {
          const key = itemKey(s);
          const checked = selected.has(key);
          const ts = s.lastActiveAt || s.createdAt;
          const badgeColor = statusColor(s.importStatus, colors);
          const imported = s.importStatus === "imported";
          return React.createElement("div", {
            key,
            style: style.item,
            onMouseEnter: (e) => { e.currentTarget.style.background = colors.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
          },
            React.createElement("input", {
              type: "checkbox", style: style.checkbox, checked,
              onChange: () => toggle(s), disabled: importing, title: "多选导入",
            }),
            React.createElement("div", { style: style.itemMain },
              React.createElement("div", { style: style.itemTitle }, s.title || "(无标题)"),
              React.createElement("div", { style: style.itemMeta },
                React.createElement("span", { style: style.fmt }, s.format),
                React.createElement("span", null, (typeof s.messageCount === "number" ? s.messageCount : "—") + " 条"),
                React.createElement("span", null, fmtTime(ts) || "时间未知"),
                React.createElement("span", { style: { ...style.badge, color: badgeColor, borderColor: badgeColor } }, statusLabel(s.importStatus)))),
            imported
              ? React.createElement("span", { style: style.importedTag }, "已导入")
              : React.createElement("button", {
                style: style.importBtn, disabled: importing,
                onClick: () => doImport([toItem(s)]),
                title: "导入该会话（已导入则幂等跳过/续写）",
              }, "导入"));
        });
        return React.createElement(React.Fragment, { key: group.name },
          React.createElement("div", { style: style.group },
            React.createElement("span", { style: { flex: "none" } }, "▸"),
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, group.name),
            React.createElement("span", { style: style.groupCount }, group.list.length + " 个会话")),
          rows);
      };

      return React.createElement("div", { style: style.overlay, onClick: onClose },
        React.createElement("div", { style: style.panel, onClick: (e) => e.stopPropagation() },
          React.createElement("div", { style: style.header },
            React.createElement("span", { style: style.title }, "导入会话"),
            React.createElement("button", { style: style.close, onClick: onClose, title: "关闭" }, "✕")),
          React.createElement("div", { style: style.row },
            React.createElement("span", { style: style.label }, "来源"),
            React.createElement("select", { style: style.select, value: source, onChange: (e) => onSourceChange(e.target.value) },
              SOURCES.map((s) => React.createElement("option", { key: s, value: s }, s ? s : "全部来源")))),
          React.createElement("div", { style: style.toolbar },
            React.createElement("button", { style: style.toolBtn, onClick: toggleAll, disabled: !sessions || sessions.length === 0 || importing }, allSelected ? "取消全选" : "全选"),
            React.createElement("button", { style: style.toolBtn, onClick: () => setSelected(new Map()), disabled: selected.size === 0 || importing }, "清空"),
            React.createElement("button", { style: style.toolBtn, onClick: () => setReload((n) => n + 1), disabled: importing }, "刷新"),
            React.createElement("span", { style: style.count }, "已选 " + selected.size)),
          React.createElement("div", { style: style.importBar },
            React.createElement("button", {
              style: { ...style.primaryBtn, opacity: selected.size === 0 || importing ? 0.55 : 1 },
              disabled: selected.size === 0 || importing,
              onClick: () => doImport([...selected.values()].map(toItem)),
            }, importing ? "导入中…" : "导入所选 (" + selected.size + ")")),
          result && React.createElement("div", { style: style.result }, result),
          sessions === null && !error && React.createElement("div", { style: style.status }, "加载中…"),
          error && React.createElement("div", { style: style.error }, error),
          sessions !== null && !error && sessions.length === 0 && React.createElement("div", { style: style.status }, "没有找到会话"),
          sessions !== null && !error && sessions.length > 0
            && groups.map(renderGroup)));
    }

    /** 侧边栏底部入口按钮：图标 + 「导入会话」 */
    function ImportButton() {
      const colors = themeColors();
      const [open, setOpen] = useState(false);
      const [source, setSource] = useState(SOURCES[0]);
      const btnStyle = {
        display: "flex", alignItems: "center", gap: "6px", width: "100%",
        background: "transparent", border: "none", color: colors.dim,
        cursor: "pointer", padding: "6px 10px", borderRadius: "6px", fontSize: "12.5px",
        textAlign: "left",
      };
      return React.createElement(React.Fragment, null,
        React.createElement("button", { style: btnStyle, title: "从其他工具导入会话（发现 + 单选/多选导入）", onClick: () => setOpen(true) },
          React.createElement("span", { style: { fontSize: "14px" } }, "⇩"),
          "导入会话"),
        open && React.createElement(DiscoveryPanel, { onClose: () => setOpen(false), source, onSourceChange: setSource }));
    }

    const name = "import-claude";
    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(() =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "chat-import", order: 0 },
          ImportButton,
        ));
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});
