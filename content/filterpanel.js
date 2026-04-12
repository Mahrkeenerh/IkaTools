// Filter panel UI for island dimming controls
// Reads/writes mapFilters in chrome.storage.local
// Dispatches "ik-filter-change" CustomEvent on window
(() => {
  const STORAGE_KEY = "mapFilters";
  const CUSTOM_CODE_KEY = "mapCustomPredicateCode"; // source for the power-user JS predicate
  const CUSTOM_ENABLED_KEY = "mapCustomPredicateEnabled";
  const PRESETS_KEY = "customJsPresets";
  const DEFAULT_CONFIG = { enabled: true, globalOp: "and", groups: [] };

  let panelEl = null;
  let bodyEl = null;
  let statusEl = null;
  let config = null;
  let collapsed = false;
  let saveTimer = null;
  let panelPosition = "left"; // opposite of minimap
  let queryIndex = null; // derived rich-data blob, or null if no full scan
  let savedPresets = []; // [{id, name, code}] loaded from storage

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
    emitPresetChange();
  }

  function emitPresetChange() {
    const active = [];
    if (config && config.enabled && config.groups) {
      for (const group of config.groups) {
        if (group.enabled === false) continue;
        for (const f of (group.filters || [])) {
          if (f.type === "customJs" && !active.some((p) => p.id === f.value)) {
            const preset = savedPresets.find((p) => p.id === f.value);
            if (preset) active.push({ id: preset.id, code: preset.code });
          }
        }
      }
    }
    window.dispatchEvent(new CustomEvent("ik-preset-change", { detail: { presets: active } }));
  }

  function removePresetFromConfig(presetId) {
    if (!config || !config.groups) return;
    let changed = false;
    for (const group of config.groups) {
      const before = group.filters.length;
      group.filters = group.filters.filter((f) => !(f.type === "customJs" && f.value === presetId));
      if (group.filters.length !== before) changed = true;
    }
    if (changed) update();
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
    btnToggleActive: {
      background: "rgba(90,184,122,0.35)", color: "#5ab87a",
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
    applyStyle(btn, { ...S.btn, ...(active ? S.btnToggleActive : {}) });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowActive = onClick();
      btn.textContent = nowActive ? labelA : labelB;
      applyStyle(btn, { ...S.btn, ...(nowActive ? S.btnToggleActive : {}) });
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

  // Find option metadata for an active filter (matches by type, plus value
  // for non-parameterized filters where value is part of the identity).
  function findOption(filter) {
    if (filter.type === "customJs") {
      const preset = savedPresets.find((p) => p.id === filter.value);
      return preset
        ? { type: "customJs", value: filter.value, label: preset.name, color: "#AA88FF", parameterized: false }
        : { type: "customJs", value: filter.value, label: "Unknown preset", color: "#666", parameterized: false };
    }
    return globalThis.MapFilter.FILTER_OPTIONS.find((o) => {
      if (o.type !== filter.type) return false;
      if (o.parameterized) return true;
      return o.value === filter.value;
    });
  }

  // --- Build filter chip (used for fixed enum/boolean filters) ---
  function buildChip(filter, onRemove) {
    const opt = findOption(filter);
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

  // --- Build rule row (used for parameterized filters: text/number/allyTag) ---
  function buildRuleRow(filter, onRemove) {
    const opt = findOption(filter);
    const label = opt ? opt.label : filter.type;
    const color = opt ? opt.color : "#888";

    const row = document.createElement("div");
    applyStyle(row, {
      display: "flex", alignItems: "center", gap: "4px",
      margin: "3px 0", padding: "3px 6px",
      background: color + "1a",
      border: "1px solid " + color + "55",
      borderRadius: "4px",
      fontSize: "11px", fontFamily: "sans-serif", color: "#d0d8e0",
    });

    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    applyStyle(labelEl, { flexShrink: "0", color: "#a0a8b8" });
    row.appendChild(labelEl);

    let inputEl;
    if (opt && opt.paramKind === "allyTag") {
      // Dropdown of known alliance tags from the query index
      inputEl = document.createElement("select");
      applyStyle(inputEl, {
        flex: "1", minWidth: "60px", background: "#1a2a40", color: "#c0c8d8",
        border: "1px solid rgba(60,90,130,0.5)", borderRadius: "3px",
        fontSize: "11px", padding: "1px 3px",
      });
      const placeholder = document.createElement("option");
      placeholder.value = ""; placeholder.textContent = "-- pick --";
      inputEl.appendChild(placeholder);
      const tags = (queryIndex && queryIndex.allyTags) || [];
      const counts = (queryIndex && queryIndex.allyCityCounts) || {};
      for (const tag of tags) {
        const o = document.createElement("option");
        o.value = tag;
        o.textContent = counts[tag] ? `${tag} (${counts[tag]})` : tag;
        inputEl.appendChild(o);
      }
      inputEl.value = filter.value || "";
    } else {
      inputEl = document.createElement("input");
      inputEl.type = (opt && opt.paramKind === "number") ? "number" : "text";
      inputEl.placeholder = (opt && opt.paramPlaceholder) || "";
      inputEl.value = filter.value != null ? String(filter.value) : "";
      applyStyle(inputEl, {
        flex: "1", minWidth: "50px", background: "#1a2a40", color: "#c0c8d8",
        border: "1px solid rgba(60,90,130,0.5)", borderRadius: "3px",
        fontSize: "11px", padding: "1px 4px",
      });
    }

    inputEl.addEventListener("input", () => {
      filter.value = inputEl.type === "number" ? Number(inputEl.value) : inputEl.value;
      update();
    });
    inputEl.addEventListener("change", () => {
      filter.value = inputEl.type === "number" ? Number(inputEl.value) : inputEl.value;
      update();
    });
    inputEl.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(inputEl);

    const x = document.createElement("span");
    x.textContent = "\u00D7";
    applyStyle(x, { cursor: "pointer", fontSize: "13px", lineHeight: "1", color: "#aa6666", flexShrink: "0", padding: "0 2px" });
    x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    row.appendChild(x);

    return row;
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
    const haveRich = !!queryIndex;
    let lastGroup = "";
    for (const opt of options) {
      // Hide rich predicates entirely when no query index exists.
      if (opt.requiresRich && !haveRich) continue;
      if (opt.group !== lastGroup) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = opt.group;
        select.appendChild(optgroup);
        lastGroup = opt.group;
      }
      // Dedupe fixed filters; allow multiple parameterized rows of the same type
      if (!opt.parameterized) {
        const exists = group.filters.some((f) => f.type === opt.type && f.value === opt.value);
        if (exists) continue;
      }
      const o = document.createElement("option");
      o.value = JSON.stringify({ type: opt.type, value: opt.value });
      o.textContent = opt.label;
      // Append to last optgroup
      select.lastChild.appendChild(o);
    }

    // Add saved JS presets to the dropdown
    if (savedPresets.length > 0) {
      const presetGroup = document.createElement("optgroup");
      presetGroup.label = "Custom JS Presets";
      for (const preset of savedPresets) {
        const exists = group.filters.some((f) => f.type === "customJs" && f.value === preset.id);
        if (exists) continue;
        const o = document.createElement("option");
        o.value = JSON.stringify({ type: "customJs", value: preset.id });
        o.textContent = preset.name;
        presetGroup.appendChild(o);
      }
      if (presetGroup.children.length > 0) select.appendChild(presetGroup);
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

    // Group enable/disable toggle
    const groupEnabled = group.enabled !== false;
    const groupToggle = document.createElement("button");
    groupToggle.textContent = groupEnabled ? "ON" : "OFF";
    applyStyle(groupToggle, {
      ...S.btn,
      ...(groupEnabled ? S.btnToggleActive : {}),
      fontSize: "10px", padding: "2px 6px",
    });
    groupToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      group.enabled = group.enabled === false ? true : false;
      const on = group.enabled !== false;
      groupToggle.textContent = on ? "ON" : "OFF";
      applyStyle(groupToggle, {
        ...S.btn,
        ...(on ? S.btnToggleActive : {}),
        fontSize: "10px", padding: "2px 6px",
      });
      // Dim group content when disabled
      if (chipsRow) chipsRow.style.opacity = on ? "" : "0.4";
      if (rulesContainer) rulesContainer.style.opacity = on ? "" : "0.4";
      update();
    });
    header.appendChild(groupToggle);

    const title = document.createElement("span");
    title.textContent = group.name || "Group " + (groupIdx + 1);
    title.title = "Click to rename";
    applyStyle(title, { color: "#8890a0", fontSize: "11px", fontFamily: "sans-serif", flex: "1", cursor: "text" });
    title.addEventListener("click", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.value = group.name || "";
      input.placeholder = "Group " + (groupIdx + 1);
      applyStyle(input, {
        flex: "1", background: "#1a2a40", color: "#c0c8d8",
        border: "1px solid rgba(60,90,130,0.5)", borderRadius: "3px",
        fontSize: "11px", fontFamily: "sans-serif", padding: "0 4px",
        outline: "none", width: "100%",
      });
      const commit = () => {
        const val = input.value.trim();
        group.name = val || undefined;
        title.textContent = val || "Group " + (groupIdx + 1);
        input.replaceWith(title);
        save();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") { ke.preventDefault(); input.blur(); }
        if (ke.key === "Escape") { ke.preventDefault(); input.value = group.name || ""; input.blur(); }
      });
      title.replaceWith(input);
      input.focus();
      input.select();
    });
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

    // Chips (fixed filters) and rule rows (parameterized filters) — split rendering
    const chipsRow = document.createElement("div");
    applyStyle(chipsRow, { display: "flex", flexWrap: "wrap", alignItems: "center" });

    const rulesContainer = document.createElement("div");
    applyStyle(rulesContainer, { display: "flex", flexDirection: "column" });

    for (let i = 0; i < group.filters.length; i++) {
      const fi = i;
      const f = group.filters[i];
      const opt = findOption(f);
      const remove = () => {
        group.filters.splice(fi, 1);
        update();
        renderBody();
      };
      if (opt && opt.parameterized) {
        rulesContainer.appendChild(buildRuleRow(f, remove));
      } else {
        chipsRow.appendChild(buildChip(f, remove));
      }
    }

    chipsRow.appendChild(buildAddSelect(group, (filter) => {
      group.filters.push(filter);
      update();
      renderBody();
    }));

    if (!groupEnabled) {
      chipsRow.style.opacity = "0.4";
      rulesContainer.style.opacity = "0.4";
    }
    div.appendChild(chipsRow);
    if (rulesContainer.children.length > 0) div.appendChild(rulesContainer);
    return div;
  }

  function formatAge(ts) {
    if (!ts) return "never";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }

  function renderStatus() {
    if (!statusEl) return;
    statusEl.innerHTML = "";
    const lines = [];
    if (queryIndex) {
      const islandCount = Object.keys(queryIndex.islandsByCoord || {}).length;
      lines.push(`Rich data: ${islandCount} islands · scan ${formatAge(queryIndex.fullScanAt)}`);
      if (queryIndex.ct) {
        const flt = queryIndex.ct.allyFilter ? ` filter "${queryIndex.ct.allyFilter}"` : "";
        lines.push(`CT: ${queryIndex.ct.availableCount}/${queryIndex.ct.checkedCount} avail${flt}`);
      } else {
        lines.push("CT: not run");
      }
    } else {
      lines.push("Rich data: none — run a Full Scan to enable player/army/CT filters");
    }
    if (lastMatchCount != null) {
      lines.push(`${lastMatchCount} islands match`);
    }
    const fnActive = globalThis.MapFilter && MapFilter.getCustomPredicate && MapFilter.getCustomPredicate();
    const resActive = globalThis.MapFilter && MapFilter.hasCustomResults && MapFilter.hasCustomResults();
    if (fnActive || resActive) {
      lines.push("Custom JS predicate active");
    } else if (customCodeDraft.trim() && !customEnabled) {
      lines.push("Custom JS predicate paused");
    }
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      applyStyle(div, { color: "#7080a0", fontSize: "10px", fontFamily: "sans-serif", padding: "1px 0" });
      statusEl.appendChild(div);
    }
  }

  let lastMatchCount = null;
  function setMatchCount(n) {
    lastMatchCount = n;
    renderStatus();
  }

  // --- Custom JS predicate section (power-user) ---
  // Expandable block at the bottom of the panel body. User types a JS
  // expression body that must evaluate to a boolean; wrapped as
  // `new Function("i", <code>)` and installed via MapFilter.setCustomPredicate.
  // Persisted to chrome.storage.local so it survives page reloads and works
  // on both the world map and island views.
  let customCollapsed = true;
  let customCodeDraft = ""; // in-memory code buffer for the textarea
  let customError = null; // last compile/runtime error message
  let customEnabled = true; // toggle for the custom JS predicate

  // Compile user code via the page-context eval bridge (new Function() is
  // blocked in the content-script isolated world by the MV3 CSP).
  // On success, fire ik-custom-code-apply so minimap/islandfilter can
  // evaluate the compiled predicate against their current data.
  async function applyCustomCode(code) {
    customError = null;
    if (!globalThis.CustomEval) {
      customError = "CustomEval module not loaded";
      renderBody();
      return false;
    }
    if (!code || !code.trim()) {
      await CustomEval.compile("");
      if (globalThis.MapFilter) MapFilter.setCustomResults(null);
      chrome.storage.local.remove(CUSTOM_CODE_KEY);
      window.dispatchEvent(new CustomEvent("ik-custom-code-apply", { detail: { code: "" } }));
      return true;
    }
    const r = await CustomEval.compile(code);
    if (!r.ok) {
      customError = r.error || "Compile failed";
      if (globalThis.MapFilter) MapFilter.setCustomResults(null);
      renderBody();
      return false;
    }
    chrome.storage.local.set({ [CUSTOM_CODE_KEY]: code });
    if (!customEnabled) {
      // Code compiled OK but toggle is off — don't push results to consumers
      if (globalThis.MapFilter) MapFilter.setCustomResults(null);
      return true;
    }
    // Notify consumers (minimap, islandfilter) that they should evaluate the
    // new predicate against their current island/city data.
    window.dispatchEvent(new CustomEvent("ik-custom-code-apply", { detail: { code } }));
    return true;
  }

  function buildCustomSection() {
    const section = document.createElement("div");
    applyStyle(section, {
      marginTop: "6px", padding: "6px 8px",
      background: "rgba(20,35,55,0.6)", borderRadius: "4px",
      border: "1px solid rgba(60,90,130,0.3)",
    });

    // Header with toggle + active indicator
    const header = document.createElement("div");
    applyStyle(header, { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" });

    const caret = document.createElement("span");
    caret.textContent = customCollapsed ? "\u25B6" : "\u25BC";
    applyStyle(caret, { color: "#8890a0", fontSize: "10px" });
    header.appendChild(caret);

    const title = document.createElement("span");
    title.textContent = "Custom JS";
    applyStyle(title, { color: "#c0c8d8", fontSize: "11px", fontFamily: "sans-serif", flex: "1" });
    header.appendChild(title);

    const toggle = document.createElement("button");
    toggle.textContent = customEnabled ? "ON" : "OFF";
    applyStyle(toggle, {
      ...S.btn, fontSize: "10px", padding: "2px 6px",
      ...(customEnabled ? S.btnToggleActive : {}),
    });
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      customEnabled = !customEnabled;
      chrome.storage.local.set({ [CUSTOM_ENABLED_KEY]: customEnabled });
      toggle.textContent = customEnabled ? "ON" : "OFF";
      applyStyle(toggle, {
        ...S.btn, fontSize: "10px", padding: "2px 6px",
        ...(customEnabled ? S.btnToggleActive : {}),
      });
      if (customEnabled && customCodeDraft.trim()) {
        applyCustomCode(customCodeDraft);
      } else if (!customEnabled) {
        if (globalThis.MapFilter) MapFilter.setCustomResults(null);
        window.dispatchEvent(new CustomEvent("ik-custom-code-apply", { detail: { code: "", disabled: true } }));
      }
      renderBody();
    });
    header.appendChild(toggle);

    header.addEventListener("click", (e) => {
      e.stopPropagation();
      customCollapsed = !customCollapsed;
      renderBody();
    });
    section.appendChild(header);

    if (customCollapsed) return section;

    // Body
    const body = document.createElement("div");
    applyStyle(body, { marginTop: "6px" });

    const hint = document.createElement("div");
    hint.textContent = 'Return a boolean. Fields: _allyTags (Set), _ownerNamesText, _maxArmy, _players [{id, name, ally, allyId, state, cities, maxLevel, place, building, research, army, trader}], _ctAvailable, cities, tradegood, wonder, owner, x, y';
    applyStyle(hint, { color: "#667", fontSize: "9px", lineHeight: "1.4", marginBottom: "4px", fontFamily: "sans-serif" });
    body.appendChild(hint);

    const textarea = document.createElement("textarea");
    textarea.value = customCodeDraft;
    textarea.placeholder = 'i._maxArmy > 50000 && !i._allyTags.has("-DR-")';
    textarea.rows = 4;
    textarea.spellcheck = false;
    applyStyle(textarea, {
      width: "100%", padding: "4px 6px",
      background: "#0c1524", color: "#c0c8d8",
      border: "1px solid rgba(60,90,130,0.5)", borderRadius: "3px",
      fontFamily: "monospace", fontSize: "11px", lineHeight: "1.4",
      resize: "vertical", boxSizing: "border-box",
    });
    textarea.addEventListener("input", () => {
      customCodeDraft = textarea.value;
    });
    textarea.addEventListener("click", (e) => e.stopPropagation());
    textarea.addEventListener("keydown", (e) => {
      // Ctrl/Cmd+Enter to apply without reaching for the mouse
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        doApply();
      }
    });
    body.appendChild(textarea);

    const btnRow = document.createElement("div");
    applyStyle(btnRow, { display: "flex", gap: "4px", marginTop: "4px" });

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyStyle(applyBtn, { ...S.btn, flex: "1" });
    applyBtn.addEventListener("click", (e) => { e.stopPropagation(); doApply(); });
    btnRow.appendChild(applyBtn);

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    applyStyle(clearBtn, { ...S.btn });
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      customCodeDraft = "";
      applyCustomCode("");
      renderBody();
    });
    btnRow.appendChild(clearBtn);

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy coords";
    applyStyle(copyBtn, { ...S.btn });
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const coords = globalThis.MapFilter && MapFilter.getCustomResultCoords
        ? MapFilter.getCustomResultCoords() : [];
      if (coords.length === 0) {
        copyBtn.textContent = "No matches";
        setTimeout(() => { copyBtn.textContent = "Copy coords"; }, 1500);
        return;
      }
      const text = coords.map((c) => "[" + c.replace(":", ":") + "]").join("\n");
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied " + coords.length;
        setTimeout(() => { copyBtn.textContent = "Copy coords"; }, 1500);
      });
    });
    btnRow.appendChild(copyBtn);

    const savePresetBtn = document.createElement("button");
    savePresetBtn.textContent = "Save";
    applyStyle(savePresetBtn, { ...S.btn });
    savePresetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!customCodeDraft.trim()) return;
      const name = prompt("Preset name:");
      if (!name || !name.trim()) return;
      savedPresets.push({ id: uid(), name: name.trim(), code: customCodeDraft.trim() });
      chrome.storage.local.set({ [PRESETS_KEY]: savedPresets });
      renderBody();
    });
    btnRow.appendChild(savePresetBtn);

    body.appendChild(btnRow);

    if (customError) {
      const err = document.createElement("div");
      err.textContent = "Error: " + customError;
      applyStyle(err, { color: "#e66", fontSize: "10px", marginTop: "4px", fontFamily: "monospace", wordBreak: "break-word" });
      body.appendChild(err);
    }

    // Saved presets list
    if (savedPresets.length > 0) {
      const presetsDiv = document.createElement("div");
      applyStyle(presetsDiv, { marginTop: "6px", borderTop: "1px solid rgba(60,90,130,0.2)", paddingTop: "4px" });

      const presetsLabel = document.createElement("div");
      presetsLabel.textContent = "Saved presets (" + savedPresets.length + ")";
      applyStyle(presetsLabel, { color: "#8890a0", fontSize: "10px", marginBottom: "2px", fontFamily: "sans-serif" });
      presetsDiv.appendChild(presetsLabel);

      for (const preset of savedPresets) {
        const row = document.createElement("div");
        applyStyle(row, { display: "flex", alignItems: "center", gap: "4px", padding: "2px 0" });

        const nameEl = document.createElement("span");
        nameEl.textContent = preset.name;
        nameEl.title = preset.code;
        applyStyle(nameEl, { flex: "1", color: "#c0c8d8", fontSize: "10px", fontFamily: "sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        row.appendChild(nameEl);

        const loadBtn = document.createElement("button");
        loadBtn.textContent = "Load";
        applyStyle(loadBtn, { ...S.btn, fontSize: "9px", padding: "1px 4px" });
        loadBtn.addEventListener("click", ((p) => (e) => {
          e.stopPropagation();
          customCodeDraft = p.code;
          renderBody();
        })(preset));
        row.appendChild(loadBtn);

        const delBtn = document.createElement("button");
        delBtn.textContent = "\u00D7";
        applyStyle(delBtn, { ...S.btn, color: "#aa6666", fontSize: "12px", padding: "1px 4px" });
        delBtn.addEventListener("click", ((p) => (e) => {
          e.stopPropagation();
          savedPresets = savedPresets.filter((s) => s.id !== p.id);
          chrome.storage.local.set({ [PRESETS_KEY]: savedPresets });
          removePresetFromConfig(p.id);
          renderBody();
        })(preset));
        row.appendChild(delBtn);

        presetsDiv.appendChild(row);
      }
      body.appendChild(presetsDiv);
    }

    section.appendChild(body);
    return section;

    async function doApply() {
      const ok = await applyCustomCode(customCodeDraft);
      if (ok && customCodeDraft.trim()) customCollapsed = false;
      renderBody();
    }
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

    bodyEl.appendChild(buildCustomSection());

    renderStatus();
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
      ...(config.enabled ? S.btnToggleActive : {}),
      fontSize: "10px", padding: "2px 6px",
    });
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      config.enabled = !config.enabled;
      toggleBtn.textContent = config.enabled ? "ON" : "OFF";
      applyStyle(toggleBtn, {
        ...S.btn,
        ...(config.enabled ? S.btnToggleActive : {}),
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

    // Status footer — rich data freshness, CT counts, match count, custom predicate flag
    statusEl = document.createElement("div");
    applyStyle(statusEl, {
      padding: "4px 8px",
      borderTop: "1px solid rgba(60,90,130,0.3)",
      flexShrink: "0",
    });
    panelEl.appendChild(statusEl);

    renderBody();
    applyCollapse(collapseBtn);
    document.body.appendChild(panelEl);
  }

  function applyCollapse(collapseBtn) {
    if (bodyEl) bodyEl.style.display = collapsed ? "none" : "";
    if (statusEl) statusEl.style.display = collapsed ? "none" : "";
    if (collapseBtn) collapseBtn.textContent = collapsed ? "\u25B2" : "\u25BC";
  }

  // Load the rich-data query index for this world. Called on init and on
  // storage changes that touch queryIndex_{world}.
  async function loadQueryIndex() {
    const world = (globalThis.IkUtils && IkUtils.getUrlWorldName && IkUtils.getUrlWorldName()) || "unknown";
    const key = "queryIndex_" + world;
    const data = await chrome.storage.local.get(key);
    queryIndex = data[key] || null;
    if (panelEl) {
      renderBody();
    }
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
  // Filter panel is shown on both world map and island views — same predicates
  // apply to the minimap dim overlay and the per-city island dimming.
  function isSupportedView() {
    return document.body.id === "worldmap_iso" || document.body.id === "island";
  }

  async function init() {
    if (!isSupportedView()) return;
    if (!globalThis.MapFilter) return;

    const data = await chrome.storage.local.get([STORAGE_KEY, CUSTOM_CODE_KEY, CUSTOM_ENABLED_KEY, PRESETS_KEY, "minimapPosition", "minimapEnabled", "filterPanelCollapsed"]);
    if (!data.minimapEnabled) return;

    config = data[STORAGE_KEY] || { ...DEFAULT_CONFIG, groups: [] };
    collapsed = !!data.filterPanelCollapsed;
    savedPresets = data[PRESETS_KEY] || [];
    updatePosition(data.minimapPosition || "right");

    // Restore any saved custom JS predicate — draft + re-compile via bridge
    const savedCode = data[CUSTOM_CODE_KEY] || "";
    customEnabled = data[CUSTOM_ENABLED_KEY] !== false; // default true
    customCodeDraft = savedCode;
    if (savedCode) {
      customCollapsed = false;
      if (customEnabled) applyCustomCode(savedCode).catch(() => {});
    }

    createPanel();
    await loadQueryIndex();
    emit(); // notify minimap of current config
    emitPresetChange(); // notify minimap of active preset chips
  }

  // Expose hooks for the minimap to push match count + for the world data
  // updater (background commit) to refresh the panel without polling.
  globalThis.IkFilterPanel = {
    setMatchCount,
    refreshQueryIndex: loadQueryIndex,
  };

  // Refresh the status footer when a power-user predicate is toggled.
  window.addEventListener("ik-custom-predicate-change", () => renderStatus());

  function showOrHide() {
    if (isSupportedView()) {
      if (!panelEl) init();
      else if (panelEl) panelEl.style.display = "";
    } else {
      if (panelEl) panelEl.style.display = "none";
    }
  }

  // Watch for view changes (island view ↔ world map)
  const viewObs = new MutationObserver(() => showOrHide());
  viewObs.observe(document.body, { attributes: true, attributeFilter: ["id"] });

  // React to minimap position changes + queryIndex updates from background scans
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.minimapPosition) {
      updatePosition(changes.minimapPosition.newValue || "right");
    }
    if (changes.minimapEnabled) {
      if (changes.minimapEnabled.newValue) init();
      else if (panelEl) panelEl.style.display = "none";
    }
    // Refresh rich data when the background scan commits a new query index
    const world = (globalThis.IkUtils && IkUtils.getUrlWorldName && IkUtils.getUrlWorldName()) || "unknown";
    if (changes["queryIndex_" + world]) {
      loadQueryIndex();
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
