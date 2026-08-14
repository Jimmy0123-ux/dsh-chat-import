/* global window, document, fetch */
// lib/client.js — dsh-chat-import 的 Browser 侧 bundle（手写 CJS factory，供 dsh web
// 客户端 ModuleLoader 注入）。REQ-41：侧边栏底部「导入会话」按钮 → 滑出面板。
// Stage 1：被动会话发现（POST /api-import/sessions，11 来源下拉）。
// Stage 2：按工作区文件夹（project）分组浏览 + 单选/多选导入（POST /api-import/import，
// 复用 host 工具层同一套导入编排——幂等/增量/force/预算语义与 import_* 工具一致）。
// Stage 3：搜索（query 服务端过滤标题/项目/路径）+ 分页（offset/limit，跨页多选保留）。
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
    // 分页大小：sessions 路由按 offset/limit 切片（total 为过滤后总数）
    const PAGE_SIZE = 50;

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
      // 搜索行：输入 + 搜索/清除（query 服务端过滤标题/项目/路径）
      searchRow: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      searchInput: {
        flex: "1", minWidth: "0", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "5px 8px", fontSize: "12.5px", outline: "none",
      },
      searchBtn: {
        flex: "none", background: C.accent, color: "#ffffff", border: "none", borderRadius: "6px",
        padding: "5px 12px", fontSize: "12.5px", cursor: "pointer",
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
      list: { flex: "1", minHeight: "0", overflowY: "auto", padding: "8px" },
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
      // 分页条：上一页 / 页码 / 下一页
      pageBar: { display: "flex", gap: "8px", alignItems: "center", justifyContent: "center", padding: "8px 12px", borderTop: "1px solid " + C.border },
      pageBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "4px 12px", fontSize: "12px", cursor: "pointer",
      },
      pageInfo: { color: C.dimmer, fontSize: "12px" },
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

    // 健壮 JSON 读取：先取文本再解析，空/非 JSON 响应返回 null——避免 resp.json()
    // 对空响应抛 "Failed to execute 'json'…Unexpected end of JSON input" 原始异常
    // （面板应给出可读错误，而不是把浏览器异常直接亮给用户）。
    const readJson = async (resp) => {
      try {
        return JSON.parse(await resp.text());
      } catch {
        return null;
      }
    };

    /** 发现 + 导入面板：来源过滤 + 按工作区文件夹分组 + 单选/多选导入 */
    function DiscoveryPanel({ onClose }) {
      const colors = themeColors();
      const style = makeStyles(colors);
      const [source, setSource] = useState(SOURCES[0]);
      const [sessions, setSessions] = useState(null); // null = 加载中；[] = 空
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(new Map()); // key → 会话条目
      const [importing, setImporting] = useState(false);
      const [result, setResult] = useState(null);
      const [reload, setReload] = useState(0);
      const [queryInput, setQueryInput] = useState(""); // 搜索框输入（未提交）
      const [query, setQuery] = useState(""); // 已提交的搜索词（请求用）
      const [page, setPage] = useState(0); // 当前页（0 基）
      const [total, setTotal] = useState(0); // 过滤后总数（服务端返回）
      const [collapsed, setCollapsed] = useState(new Set()); // 已折叠的工作区分组名

      useEffect(() => {
        let cancelled = false;
        setSessions(null);
        setError(null);
        setResult(null);
        fetch("/api-import/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, query, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
        })
          .then((resp) => readJson(resp))
          .then((data) => {
            if (cancelled) return;
            if (data && data.ok === true) {
              const list = Array.isArray(data.sessions) ? data.sessions : [];
              setSessions(list);
              setTotal(typeof data.total === "number" ? data.total : list.length);
            } else if (data && data.error) {
              setError(data.error);
            } else {
              setError("导入面板服务响应异常（路由可能未注册，请重启 dsh 后重试）");
            }
          })
          .catch((err) => { if (!cancelled) setError("导入面板请求失败：" + String((err && err.message) || err)); });
        return () => { cancelled = true; };
      }, [source, query, page, reload]);

      // 来源/搜索词变化 → 清空跨页选择（换页/刷新保留选择，支持跨页多选）
      useEffect(() => { setSelected(new Map()); }, [source, query]);

      // Esc 关闭面板（全屏 overlay 打开时会挡住页面其它操作，必须可键盘退出）
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);

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
          const data = await readJson(resp);
          if (data && data.ok === true) {
            setResult(fmtImportResult(data.results));
            setSelected(new Map());
            setReload((n) => n + 1);
          } else if (data && data.error) {
            setResult(data.error);
          } else {
            setResult("导入失败：服务响应异常（路由可能未注册，请重启 dsh 后重试）");
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

      // 搜索：提交词 + 回到第一页；来源/搜索词变化由上方 effect 清空跨页选择
      const applySearch = () => {
        setQuery(queryInput.trim());
        setPage(0);
        setReload((n) => n + 1);
      };
      const clearSearch = () => {
        setQueryInput("");
        setQuery("");
        setPage(0);
        setReload((n) => n + 1);
      };
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
        const isCollapsed = collapsed.has(group.name);
        const toggleGroup = () => {
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(group.name)) next.delete(group.name);
            else next.add(group.name);
            return next;
          });
        };
        const rows = isCollapsed ? [] : group.list.map((s) => {
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
          React.createElement("div", {
            style: style.group, onClick: toggleGroup, title: isCollapsed ? "展开该工作区分组" : "折叠该工作区分组",
          },
            React.createElement("span", { style: { flex: "none" } }, isCollapsed ? "▸" : "▾"),
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
            React.createElement("select", {
              style: style.select, value: source,
              onChange: (e) => { setSource(e.target.value); setPage(0); setQuery(""); setQueryInput(""); },
            },
              SOURCES.map((s) => React.createElement("option", { key: s, value: s }, s ? s : "全部来源")))),
          React.createElement("div", { style: style.searchRow },
            React.createElement("input", {
              style: style.searchInput, value: queryInput, placeholder: "搜索标题 / 工作区 / 路径…",
              onChange: (e) => setQueryInput(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") applySearch(); },
            }),
            React.createElement("button", { style: style.searchBtn, onClick: applySearch }, "搜索"),
            React.createElement("button", { style: style.toolBtn, onClick: clearSearch, disabled: (!queryInput && !query) || importing }, "清除")),
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
          sessions !== null && !error && sessions.length === 0 && React.createElement("div", { style: style.status }, query ? "没有匹配的会话" : "没有找到会话"),
          sessions !== null && !error && sessions.length > 0
            && React.createElement("div", { style: style.list }, groups.map(renderGroup)),
          totalPages > 1 && React.createElement("div", { style: style.pageBar },
            React.createElement("button", { style: style.pageBtn, disabled: page === 0 || importing, onClick: () => setPage((p) => Math.max(0, p - 1)) }, "上一页"),
            React.createElement("span", { style: style.pageInfo }, "第 " + (page + 1) + " / " + totalPages + " 页 · 共 " + total + " 个"),
            React.createElement("button", { style: style.pageBtn, disabled: page >= totalPages - 1 || importing, onClick: () => setPage((p) => Math.min(totalPages - 1, p + 1)) }, "下一页"))));
    }

    /** 插件 logo（assets/import.svg 内联，跟随 currentColor 适配明暗主题） */
    function LogoIcon({ size }) {
      const s = size || 16;
      return React.createElement("svg", {
        width: s, height: s, viewBox: "0 0 1024 1024", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", style: { flex: "none" },
        "aria-hidden": true,
      },
        React.createElement("path", {
          d: "M905.309091 628.363636c-27.927273 0-46.545455 18.618182-46.545455 46.545455v223.418182H165.236364V125.672727h200.145454c27.927273 0 46.545455-18.618182 46.545455-46.545454s-18.618182-46.545455-46.545455-46.545455H118.690909c-27.927273 0-46.545455 18.618182-46.545454 46.545455v865.745454c0 27.927273 18.618182 46.545455 46.545454 46.545455h786.618182c27.927273 0 46.545455-18.618182 46.545454-46.545455v-269.963636c0-27.927273-18.618182-46.545455-46.545454-46.545455z",
          fill: "currentColor" }),
        React.createElement("path", {
          d: "M556.218182 558.545455h349.090909v-93.09091h-269.963636l293.236363-269.963636-65.163636-65.163636-307.2 283.927272V116.363636h-93.090909V558.545455h4.654545z",
          fill: "currentColor" }));
    }

    /** 触发按钮：fixed 浮动（脱离 footer.action 行布局），视觉对齐侧边栏「设置」按钮。
     * footerActions 是 256px flex 行；官方 cordis 徽标条目 `flex:0 0 auto; width:256px`
     * 不可收缩、占满整行，会把同槽其它条目挤出容器并被侧边栏 overflow:hidden 裁剪、
     * 主内容列遮挡（实测）。用 fixed + 高 z-index 把按钮锚到侧边栏底部上方，任何
     * footer occupant（cordis / 未来其它插件）都无法挡住；样式对齐设置按钮（透明底、
     * 12px 圆角、16px 图标 + 文字、悬停浅底），图标用插件 logo；rail（wide=false）
     * 态只显图标。
     */
    function ImportButton({ wide }) {
      const [open, setOpen] = useState(false);
      const rail = wide === false;
      // 视觉逐项对齐侧边栏「设置」按钮（实测基准）：全宽 264×34、行高 22px、
      // 内边距 6px 2px 6px 10px、gap 8px、圆角 12px、16×16 图标；颜色/悬停用
      // 侧边栏同一 CSS 变量（--dsw-alias-label-primary / interactive-bg-hover），
      // 明暗主题下与设置按钮完全一致。rail（wide=false）态只显图标、不撑全宽。
      const triggerStyle = {
        position: "fixed", left: "8px", bottom: "132px", zIndex: 10000,
        width: rail ? "auto" : "264px", height: rail ? "auto" : "34px",
        boxSizing: "border-box",
        display: "flex", alignItems: "center", gap: "8px",
        background: "transparent", border: "none",
        color: "var(--dsw-alias-label-primary)",
        borderRadius: "12px", padding: rail ? "6px" : "6px 2px 6px 10px",
        fontSize: "14px", lineHeight: "22px", fontWeight: 400,
        cursor: "pointer",
      };
      const hoverBg = "var(--dsw-alias-interactive-bg-hover)";
      return React.createElement(React.Fragment, null,
        !open && React.createElement("button", {
          style: triggerStyle, title: "从其他工具导入会话（发现 + 单选/多选导入）",
          "aria-label": "导入会话",
          onClick: () => setOpen(true),
          onMouseEnter: (e) => { e.currentTarget.style.background = hoverBg; },
          onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        },
          React.createElement(LogoIcon, { size: 16 }),
          !rail && "导入会话"),
        open && React.createElement(DiscoveryPanel, { onClose: () => setOpen(false) }));
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
