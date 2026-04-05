// Filter panel UI for island dimming controls
// Reads/writes mapFilters in chrome.storage.local
// Dispatches "ik-filter-change" CustomEvent on window
(() => {
  const STORAGE_KEY = "mapFilters";
  const DEFAULT_CONFIG = { enabled: true, globalOp: "and", groups: [] };

  let panelEl = null;
  let bodyEl = null;
  let config = null;
  let collapsed = false;
  let saveTimer = null;
  let panelPosition = "left"; // opposite of minimap

  function uid() {
    return Math.random().toString(36).slice(2, 7);
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORAGE_KEY]: config });
    }, 200);
  }

  function emit() {
    window.dispatchEvent(new CustomEvent("ik-filter-change", { detail: config }));
  }

  function update() {
    save();
    emit();
  }

  // --- Styling helpers ---
  const S = {
    btn: {
      padding: "3px 7px", border: "1px solid rgba(60,90,130,0.5)", borderRadius: "3px",
      background: "rgba(10,22,40,0.6)", color: "#8890a0", cursor: "pointer",
      fontSize: "11px", fontFamily: "sans-serif",
    },
    btnActive: {
      background: "rgba(42,74,106,0.8)", color: "#e0e8f0",
    },
    chip: {
      display: "inline-flex", alignItems: "center", gap: "4px",
      padding: "2px 8px", borderRadius: "12px", fontSize: "11px",
      fontFamily: "sans-serif", cursor: "default", margin: "2px",
    },
  };

  function applyStyle(el, style) {
    Object.assign(el.style, style);
  }

  function makeToggleBtn(labelA, labelB, active, onClick) {
    const btn = document.createElement("button");
    btn.textContent = active ? labelA : labelB;
    applyStyle(btn, { ...S.btn, ...(active ? S.btnActive : {}) });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowActive = onClick();
      btn.textContent = nowActive ? labelA : labelB;
      applyStyle(btn, { ...S.btn, ...(nowActive ? S.btnActive : {}) });
    });
    return btn;
  }

  function makeOpBtn(currentOp, onChange) {
    const btn = document.createElement("button");
    btn.textContent = currentOp.toUpperCase();
    applyStyle(btn, { ...S.btn, fontSize: "10px", padding: "2px 5px" });
    if (currentOp === "or") applyStyle(btn, S.btnActive);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const newOp = onChange();
      btn.textContent = newOp.toUpperCase();
      applyStyle(btn, { ...S.btn, fontSize: "10px", padding: "2px 5px" });
      if (newOp === "or") applyStyle(btn, S.btnActive);
    });
    return btn;
  }

  // --- Build filter chip ---
  function buildChip(filter, onRemove) {
    const opt = globalThis.MapFilter.FILTER_OPTIONS.find(
      (o) => o.type === filter.type && o.value === filter.value
    );
    const label = opt ? opt.label : `${filter.type}:${filter.value}`;
    const color = opt ? opt.color : "#888";

    const chip = document.createElement("span");
    applyStyle(chip, {
      ...S.chip,
      background: color + "33",
      border: "1px solid " + color + "66",
      color: "#d0d8e0",
    });

    const text = document.createElement("span");
    text.textContent = label;
    chip.appendChild(text);

    const x = document.createElement("span");
    x.textContent = "\u00D7";
    applyStyle(x, { cursor: "pointer", fontSize: "13px", lineHeight: "1", color: "#aa6666" });
    x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    chip.appendChild(x);

    return chip;
  }

  // --- Build add-filter dropdown ---
  function buildAddSelect(group, onAdd) {
    const wrap = document.createElement("span");
    applyStyle(wrap, { display: "inline-block", margin: "2px" });

    const btn = document.createElement("button");
    btn.textContent = "+ Add filter";
    applyStyle(btn, { ...S.btn, fontSize: "10px" });

    const select = document.createElement("select");
    applyStyle(select, {
      display: "none", fontSize: "11px", fontFamily: "sans-serif",
      background: "#1a2a40", color: "#c0c8d8", border: "1px solid rgba(60,90,130,0.5)",
      borderRadius: "3px", padding: "2px",
    });

    const placeholder = document.createElement("option");
    placeholder.textContent = "-- select --";
    placeholder.value = "";
    select.appendChild(placeholder);

    const options = globalThis.MapFilter.FILTER_OPTIONS;
    let lastGroup = "";
    for (const opt of options) {
      if (opt.group !== lastGroup) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = opt.group;
        select.appendChild(optgroup);
        lastGroup = opt.group;
      }
      // Skip if already in this group
      const exists = group.filters.some((f) => f.type === opt.type && f.value === opt.value);
      if (exists) continue;
      const o = document.createElement("option");
      o.value = JSON.stringify({ type: opt.type, value: opt.value });
      o.textContent = opt.label;
      // Append to last optgroup
      select.lastChild.appendChild(o);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.style.display = "none";
      select.style.display = "";
      select.focus();
    });

    select.addEventListener("change", () => {
      if (select.value) {
        onAdd(JSON.parse(select.value));
      }
      select.style.display = "none";
      btn.style.display = "";
    });

    select.addEventListener("blur", () => {
      select.style.display = "none";
      btn.style.display = "";
    });

    wrap.appendChild(btn);
    wrap.appendChild(select);
    return wrap;
  }

  // --- Build a group element ---
  function buildGroupEl(group, groupIdx) {
    const div = document.createElement("div");
    applyStyle(div, {
      padding: "6px 8px", margin: "4px 0",
      background: "rgba(20,35,55,0.6)", borderRadius: "4px",
      border: "1px solid rgba(60,90,130,0.3)",
    });

    // Header row
    const header = document.createElement("div");
    applyStyle(header, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" });

    const title = document.createElement("span");
    title.textContent = "Group " + (groupIdx + 1);
    applyStyle(title, { color: "#8890a0", fontSize: "11px", fontFamily: "sans-serif", flex: "1" });
    header.appendChild(title);

    const opBtn = makeOpBtn(group.op, () => {
      group.op = group.op === "and" ? "or" : "and";
      update();
      return group.op;
    });
    header.appendChild(opBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "\u00D7";
    applyStyle(delBtn, { ...S.btn, color: "#aa6666", fontSize: "13px", padding: "2px 6px" });
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      config.groups.splice(groupIdx, 1);
      update();
      renderBody();
    });
    header.appendChild(delBtn);
    div.appendChild(header);

    // Chips
    const chipsRow = document.createElement("div");
    applyStyle(chipsRow, { display: "flex", flexWrap: "wrap", alignItems: "center" });

    for (let i = 0; i < group.filters.length; i++) {
      const fi = i;
      chipsRow.appendChild(buildChip(group.filters[i], () => {
        group.filters.splice(fi, 1);
        update();
        renderBody();
      }));
    }

    chipsRow.appendChild(buildAddSelect(group, (filter) => {
      group.filters.push(filter);
      update();
      renderBody();
    }));

    div.appendChild(chipsRow);
    return div;
  }

  // --- Render panel body ---
  function renderBody() {
    if (!bodyEl) return;
    bodyEl.innerHTML = "";

    for (let i = 0; i < config.groups.length; i++) {
      bodyEl.appendChild(buildGroupEl(config.groups[i], i));
    }

    const addGroupBtn = document.createElement("button");
    addGroupBtn.textContent = "+ Add Group";
    applyStyle(addGroupBtn, { ...S.btn, marginTop: "4px", width: "100%" });
    addGroupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      config.groups.push({ id: uid(), op: "or", filters: [] });
      update();
      renderBody();
    });
    bodyEl.appendChild(addGroupBtn);
  }

  // --- Create the panel DOM ---
  function createPanel() {
    if (panelEl) panelEl.remove();

    panelEl = document.createElement("div");
    panelEl.id = "ik-filter-panel";
    applyStyle(panelEl, {
      position: "fixed",
      bottom: "12px",
      [panelPosition]: "12px",
      zIndex: "99998",
      background: "rgba(10, 22, 40, 0.92)",
      borderRadius: "8px",
      border: "1px solid rgba(60, 90, 130, 0.5)",
      boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      width: "280px",
      maxHeight: "70vh",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    });

    // Header bar
    const header = document.createElement("div");
    applyStyle(header, {
      display: "flex", alignItems: "center", gap: "6px",
      padding: "6px 8px",
      borderBottom: "1px solid rgba(60,90,130,0.3)",
      flexShrink: "0",
    });

    // Enable toggle
    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = config.enabled ? "ON" : "OFF";
    applyStyle(toggleBtn, {
      ...S.btn,
      ...(config.enabled ? S.btnActive : {}),
      fontSize: "10px", padding: "2px 6px",
    });
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      config.enabled = !config.enabled;
      toggleBtn.textContent = config.enabled ? "ON" : "OFF";
      applyStyle(toggleBtn, {
        ...S.btn,
        ...(config.enabled ? S.btnActive : {}),
        fontSize: "10px", padding: "2px 6px",
      });
      update();
    });
    header.appendChild(toggleBtn);

    const label = document.createElement("span");
    label.textContent = "Filters";
    applyStyle(label, { color: "#c0c8d8", fontSize: "12px", fontFamily: "sans-serif", flex: "1" });
    header.appendChild(label);

    // Global op toggle
    const globalOpBtn = makeOpBtn(config.globalOp, () => {
      config.globalOp = config.globalOp === "and" ? "or" : "and";
      update();
      return config.globalOp;
    });
    header.appendChild(globalOpBtn);

    // Collapse button
    const collapseBtn = document.createElement("button");
    collapseBtn.textContent = collapsed ? "\u25B2" : "\u25BC";
    applyStyle(collapseBtn, { ...S.btn, fontSize: "10px", padding: "2px 6px" });
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      chrome.storage.local.set({ filterPanelCollapsed: collapsed });
      applyCollapse(collapseBtn);
    });
    header.appendChild(collapseBtn);

    panelEl.appendChild(header);

    // Body (scrollable)
    bodyEl = document.createElement("div");
    applyStyle(bodyEl, {
      padding: "4px 8px 8px",
      overflowY: "auto",
      flex: "1",
    });
    panelEl.appendChild(bodyEl);

    renderBody();
    applyCollapse(collapseBtn);
    document.body.appendChild(panelEl);
  }

  function applyCollapse(collapseBtn) {
    if (bodyEl) bodyEl.style.display = collapsed ? "none" : "";
    if (collapseBtn) collapseBtn.textContent = collapsed ? "\u25B2" : "\u25BC";
  }

  function updatePosition(minimapPos) {
    panelPosition = minimapPos === "left" ? "right" : "left";
    if (panelEl) {
      panelEl.style.left = "";
      panelEl.style.right = "";
      panelEl.style[panelPosition] = "12px";
    }
  }

  // --- Initialization ---
  function isWorldMapView() {
    return document.body.id === "worldmap_iso";
  }

  async function init() {
    if (!isWorldMapView()) return;
    if (!globalThis.MapFilter) return;

    const data = await chrome.storage.local.get([STORAGE_KEY, "minimapPosition", "minimapEnabled", "filterPanelCollapsed"]);
    if (!data.minimapEnabled) return;

    config = data[STORAGE_KEY] || { ...DEFAULT_CONFIG, groups: [] };
    collapsed = !!data.filterPanelCollapsed;
    updatePosition(data.minimapPosition || "right");
    createPanel();
    emit(); // notify minimap of current config
  }

  function showOrHide() {
    if (isWorldMapView()) {
      if (!panelEl) init();
      else if (panelEl) panelEl.style.display = "";
    } else {
      if (panelEl) panelEl.style.display = "none";
    }
  }

  // Watch for view changes (island view ↔ world map)
  const viewObs = new MutationObserver(() => showOrHide());
  viewObs.observe(document.body, { attributes: true, attributeFilter: ["id"] });

  // React to minimap position changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.minimapPosition) {
      updatePosition(changes.minimapPosition.newValue || "right");
    }
    if (changes.minimapEnabled) {
      if (changes.minimapEnabled.newValue) init();
      else if (panelEl) panelEl.style.display = "none";
    }
  });

  // React to minimap position messages
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "minimap-position") {
      updatePosition(msg.position);
    }
    if (msg.type === "minimap-toggle") {
      if (msg.enabled) showOrHide();
      else if (panelEl) panelEl.style.display = "none";
    }
  });

  init();
})();
