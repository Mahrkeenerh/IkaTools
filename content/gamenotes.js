// In-game notes toolbar button with floating panel + hide game notes option
(() => {
  if (!/^s\d+/.test(location.hostname)) return;
  const NOTES_KEY = "ikNotes";

  let notes = [];
  let activeNoteId = null;
  let saveTimer = null;
  let panelVisible = false;

  // --- Storage ---
  async function loadNotes() {
    const data = await chrome.storage.local.get(NOTES_KEY);
    notes = data[NOTES_KEY] || [];
  }

  function saveNotes() {
    chrome.storage.local.set({ [NOTES_KEY]: notes });
  }

  // --- DOM helpers ---
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k === "className") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    if (children) {
      if (typeof children === "string") e.textContent = children;
      else if (Array.isArray(children)) children.forEach((c) => c && e.appendChild(c));
    }
    return e;
  }

  // --- Floating panel ---
  function createPanel() {
    const panel = el("div", { id: "ik-notes-panel", style: {
      display: "none", position: "fixed", top: "36px", left: "50%",
      transform: "translateX(-50%)", width: "480px", maxHeight: "420px",
      background: "#141824", border: "1px solid #2a3040", borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.5)", zIndex: "99999",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: "13px", color: "#c8cdd8", overflow: "hidden",
    }});

    // Header
    const header = el("div", { style: {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 12px", borderBottom: "1px solid #2a3040", background: "#1a1f2e",
    }}, [
      el("span", { style: { fontWeight: "600", color: "#e0e4ec", fontSize: "13px" }}, "Notes"),
      el("div", { style: { display: "flex", gap: "6px" }}, [
        el("button", {
          id: "ik-notes-add",
          style: { padding: "2px 8px", border: "1px solid #2a3040", borderRadius: "3px",
            background: "transparent", color: "#8890a0", cursor: "pointer", fontSize: "14px" },
          title: "New note",
        }, "+"),
        el("button", {
          id: "ik-notes-close",
          style: { padding: "2px 8px", border: "1px solid #2a3040", borderRadius: "3px",
            background: "transparent", color: "#8890a0", cursor: "pointer", fontSize: "14px" },
        }, "\u00D7"),
      ]),
    ]);
    panel.appendChild(header);

    // Body: sidebar + editor
    const body = el("div", { style: {
      display: "flex", height: "340px",
    }});

    // Sidebar
    const sidebar = el("div", { id: "ik-notes-sidebar", style: {
      width: "160px", minWidth: "160px", borderRight: "1px solid #2a3040",
      overflowY: "auto",
    }});
    body.appendChild(sidebar);

    // Editor area
    const editor = el("div", { id: "ik-notes-editor", style: {
      flex: "1", display: "flex", flexDirection: "column", padding: "8px",
    }});

    const titleInput = el("input", { id: "ik-notes-title", type: "text", placeholder: "Note title", style: {
      padding: "4px 6px", border: "1px solid transparent", borderRadius: "3px",
      background: "transparent", color: "#e0e4ec", fontSize: "14px", fontWeight: "600",
      fontFamily: "inherit", marginBottom: "6px", outline: "none",
    }});
    titleInput.addEventListener("focus", () => {
      titleInput.style.borderColor = "#3a4a6a";
      titleInput.style.background = "#0d1018";
    });
    titleInput.addEventListener("blur", () => {
      titleInput.style.borderColor = "transparent";
      titleInput.style.background = "transparent";
    });
    editor.appendChild(titleInput);

    const textarea = el("textarea", { id: "ik-notes-content", placeholder: "Write your note here...", style: {
      flex: "1", padding: "8px", border: "1px solid #2a3040", borderRadius: "4px",
      background: "#0d1018", color: "#c8cdd8", fontSize: "12px", fontFamily: "inherit",
      resize: "none", outline: "none",
    }});
    textarea.addEventListener("focus", () => { textarea.style.borderColor = "#3a4a6a"; });
    textarea.addEventListener("blur", () => { textarea.style.borderColor = "#2a3040"; });
    editor.appendChild(textarea);

    // Delete button row
    const actions = el("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: "6px" }}, [
      el("button", { id: "ik-notes-delete", style: {
        padding: "3px 10px", border: "none", borderRadius: "4px",
        background: "#6b2020", color: "#daa", fontSize: "12px", cursor: "pointer",
      }}, "Delete"),
    ]);
    editor.appendChild(actions);

    // Empty state
    const empty = el("div", { id: "ik-notes-empty", style: {
      flex: "1", display: "flex", alignItems: "center", justifyContent: "center",
      color: "#556", fontSize: "12px",
    }}, "No notes yet. Click + to create one.");
    editor.appendChild(empty);

    body.appendChild(editor);
    panel.appendChild(body);

    return panel;
  }

  function renderSidebar() {
    const sidebar = document.getElementById("ik-notes-sidebar");
    if (!sidebar) return;
    sidebar.innerHTML = "";
    for (const note of notes) {
      const item = el("div", {
        className: "ik-note-item" + (note.id === activeNoteId ? " active" : ""),
        style: {
          padding: "8px 10px", cursor: "pointer", fontSize: "12px", color: "#c8cdd8",
          borderBottom: "1px solid #1e2535", whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
          background: note.id === activeNoteId ? "#2a3550" : "",
        },
        onclick: () => selectNote(note.id),
        onmouseenter: function() { if (note.id !== activeNoteId) this.style.background = "rgba(42,74,106,0.3)"; },
        onmouseleave: function() { if (note.id !== activeNoteId) this.style.background = ""; },
      }, note.title || "Untitled");
      sidebar.appendChild(item);
    }
  }

  function selectNote(id) {
    activeNoteId = id;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    const title = document.getElementById("ik-notes-title");
    const content = document.getElementById("ik-notes-content");
    const editorArea = document.getElementById("ik-notes-editor");
    const empty = document.getElementById("ik-notes-empty");
    if (title) title.value = note.title;
    if (content) content.value = note.content;
    if (editorArea) { editorArea.style.display = "flex"; }
    if (empty) empty.style.display = "none";
    // Show delete, hide empty
    const del = document.getElementById("ik-notes-delete");
    if (del) del.style.display = "";
    renderSidebar();
  }

  function showEmpty() {
    activeNoteId = null;
    const title = document.getElementById("ik-notes-title");
    const content = document.getElementById("ik-notes-content");
    const empty = document.getElementById("ik-notes-empty");
    const del = document.getElementById("ik-notes-delete");
    if (title) title.value = "";
    if (content) content.value = "";
    if (empty) empty.style.display = "flex";
    if (del) del.style.display = "none";
    renderSidebar();
  }

  function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const note = notes.find((n) => n.id === activeNoteId);
      if (!note) return;
      const title = document.getElementById("ik-notes-title");
      const content = document.getElementById("ik-notes-content");
      if (title) note.title = title.value;
      if (content) note.content = content.value;
      note.updated = new Date().toISOString();
      saveNotes();
      renderSidebar();
    }, 500);
  }

  function bindPanelEvents() {
    const addBtn = document.getElementById("ik-notes-add");
    const closeBtn = document.getElementById("ik-notes-close");
    const deleteBtn = document.getElementById("ik-notes-delete");
    const title = document.getElementById("ik-notes-title");
    const content = document.getElementById("ik-notes-content");

    addBtn.addEventListener("click", () => {
      const note = { id: Date.now(), title: "Untitled", content: "", updated: new Date().toISOString() };
      notes.unshift(note);
      saveNotes();
      selectNote(note.id);
      title.focus();
      title.select();
    });

    closeBtn.addEventListener("click", () => togglePanel(false));

    deleteBtn.addEventListener("click", () => {
      if (!activeNoteId) return;
      if (!confirm("Delete this note? This cannot be undone.")) return;
      const idx = notes.findIndex((n) => n.id === activeNoteId);
      notes.splice(idx, 1);
      saveNotes();
      if (notes.length > 0) {
        selectNote(notes[Math.min(idx, notes.length - 1)].id);
      } else {
        showEmpty();
      }
    });

    title.addEventListener("input", debouncedSave);
    content.addEventListener("input", debouncedSave);
  }

  function togglePanel(show) {
    const panel = document.getElementById("ik-notes-panel");
    if (!panel) return;
    panelVisible = show !== undefined ? show : !panelVisible;
    panel.style.display = panelVisible ? "block" : "none";
    if (panelVisible) {
      // Reload in case popup edited notes
      loadNotes().then(() => {
        renderSidebar();
        if (notes.length > 0) {
          selectNote(activeNoteId && notes.find((n) => n.id === activeNoteId) ? activeNoteId : notes[0].id);
        } else {
          showEmpty();
        }
      });
    }
  }

  // --- Toolbar injection ---
  function injectNotesToolbar() {
    const toolbar = document.querySelector("#GF_toolbar ul");
    if (!toolbar || document.getElementById("ik-notes-toggle")) return;

    const li = document.createElement("li");
    li.id = "ik-notes-toggle";

    const link = document.createElement("a");
    link.textContent = "\uD83D\uDDD2 Notes";
    link.title = "Open notes panel";
    link.style.cssText = "cursor:pointer;user-select:none;color:#572E11;";

    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
      link.style.color = panelVisible ? "#5ca0f2" : "#572E11";
    });

    li.appendChild(link);
    li.dataset.ikOrder = "1";
    toolbar.appendChild(li);
    IkUtils.reorderToolbarItems(toolbar);

    // Create and append the floating panel
    const panel = createPanel();
    document.body.appendChild(panel);
    bindPanelEvents();

    // Close panel on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panelVisible) {
        togglePanel(false);
        link.style.color = "#572E11";
      }
    });
  }

  // --- Hide game notes ---
  function applyHideGameNotes(hide) {
    const gameNotes = document.querySelector("#GF_toolbar li.notes");
    if (gameNotes) {
      gameNotes.style.display = hide ? "none" : "";
    }
  }

  // --- Init ---
  chrome.storage.local.get("hideGameNotes", (data) => {
    applyHideGameNotes(!!data.hideGameNotes);
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.hideGameNotes) {
      applyHideGameNotes(!!changes.hideGameNotes.newValue);
    }
    // Sync notes if edited from popup while panel is open
    if (changes[NOTES_KEY] && panelVisible) {
      notes = changes[NOTES_KEY].newValue || [];
      renderSidebar();
      if (activeNoteId && notes.find((n) => n.id === activeNoteId)) {
        selectNote(activeNoteId);
      } else if (notes.length > 0) {
        selectNote(notes[0].id);
      } else {
        showEmpty();
      }
    }
  });

  loadNotes().then(() => {
    injectNotesToolbar();
  });
})();
