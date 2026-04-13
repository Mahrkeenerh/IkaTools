// Museum partner scraping — adds a "Save Partners" button to the museum treaties view.
// Walks all pagination pages, collects partner player IDs + names, and overwrites
// museumPartners_{world} so stale (broken) deals are automatically removed.
(() => {
  const TAG = "[MuseumPartners]";
  const worldName = IkUtils.getUrlWorldName() || "unknown";
  const KEY_PARTNERS = "museumPartners_" + worldName;

  // Parse partner rows from a DOM tree — works with both live document
  // and DOMParser-parsed full-page HTML (fetched pagination pages).
  function parsePartners(root) {
    const partners = [];
    // Try #tab_museumTreaties first (live DOM), fall back to any .table01
    // with .avatarName rows (full-page fetch where the id may differ)
    const scope = root.querySelector("#tab_museumTreaties") || root;
    for (const row of scope.querySelectorAll("table.table01 tr")) {
      const nameEl = row.querySelector(".avatarName");
      if (!nameEl) continue;
      const link = row.querySelector("a.writeMsg");
      if (!link) continue;
      const m = link.href.match(/receiverId=(\d+)/);
      if (!m) continue;
      partners.push({ id: m[1], name: nameEl.textContent.trim() });
    }
    return partners;
  }

  // Get hrefs for pagination pages we haven't loaded yet (skip current page = <span>)
  function getOtherPageUrls(root) {
    const urls = [];
    const scope = root.querySelector("#tab_museumTreaties") || root;
    for (const a of scope.querySelectorAll(".paginator a.page_link")) {
      if (a.href) urls.push(a.href);
    }
    return urls;
  }

  // Fetch a treaties page via AJAX and parse partners from the changeView HTML.
  // The game's AJAX response embeds the view HTML as an escaped string inside a
  // JSON payload: ["changeView",["museumTreaties","...HTML..."]]. We extract that
  // fragment and parse it with DOMParser.
  async function fetchPagePartners(url) {
    const ajaxUrl = url + (url.includes("?") ? "&" : "?") + "ajax=1";
    const resp = await fetch(ajaxUrl, {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    const text = await resp.text();
    // Extract the HTML fragment from the changeView JSON array
    const marker = '"changeView"';
    const idx = text.indexOf(marker);
    if (idx === -1) return [];
    // Find the opening bracket of the array value: ["museumTreaties","<html>"]
    const arrStart = text.indexOf("[", idx + marker.length);
    if (arrStart === -1) return [];
    // Parse the JSON array to get the HTML string
    let depth = 0;
    let arrEnd = -1;
    for (let i = arrStart; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]") { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
    }
    if (arrEnd === -1) return [];
    try {
      const arr = JSON.parse(text.substring(arrStart, arrEnd));
      const html = arr[1]; // the HTML fragment string
      const doc = new DOMParser().parseFromString(html, "text/html");
      return parsePartners(doc);
    } catch (e) {
      return [];
    }
  }

  async function collectAllPartners(btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      // Current page
      let all = parsePartners(document);

      // Remaining pages
      const pageUrls = getOtherPageUrls(document);
      for (const url of pageUrls) {
        const page = await fetchPagePartners(url);
        all = all.concat(page);
      }

      // Deduplicate by ID
      const seen = new Set();
      const unique = [];
      for (const p of all) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          unique.push(p);
        }
      }

      // Overwrite — removes stale entries from broken deals
      await chrome.storage.local.set({ [KEY_PARTNERS]: unique });

      btn.textContent = `Saved ${unique.length} partners`;
      setTimeout(() => {
        btn.textContent = "Save Partners";
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      console.error(TAG, "collect failed:", err);
      btn.textContent = "Error!";
      setTimeout(() => {
        btn.textContent = "Save Partners";
        btn.disabled = false;
      }, 2000);
    }
  }

  function injectButton() {
    const tab = document.getElementById("tab_museumTreaties");
    if (!tab) return;
    if (tab.querySelector("#ik-save-partners-btn")) return;

    const btn = document.createElement("button");
    btn.id = "ik-save-partners-btn";
    btn.textContent = "Save Partners";
    Object.assign(btn.style, {
      display: "block",
      margin: "6px auto",
      padding: "4px 12px",
      border: "1px solid #8b7355",
      borderRadius: "4px",
      background: "linear-gradient(to bottom, #f5e6c8, #d4b88c)",
      color: "#4a3520",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: "bold",
    });
    btn.addEventListener("mouseenter", () => { btn.style.background = "linear-gradient(to bottom, #ffe8b0, #e0c898)"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "linear-gradient(to bottom, #f5e6c8, #d4b88c)"; });
    btn.addEventListener("click", () => collectAllPartners(btn));

    // Insert after the paginator (bottom of the partner list)
    const paginator = tab.querySelector(".paginator");
    if (paginator) paginator.after(btn);
    else {
      const content = tab.querySelector(".content");
      if (content) content.appendChild(btn);
      else tab.appendChild(btn);
    }

    // Resize the popup body to fit the new content (game auto-sizes popups
    // so no scrollbar is needed — we match that by updating the inline height)
    const bd = tab.closest(".bd.mainContentScroll");
    const mc = bd && bd.querySelector(".mainContent");
    if (bd && mc) {
      bd.style.height = mc.scrollHeight + "px";
    }
  }

  // Watch for museum treaties tab appearing/reloading (AJAX navigation)
  let debounce = null;
  const obs = new MutationObserver(() => {
    if (!document.getElementById("tab_museumTreaties")) return;
    if (document.querySelector("#ik-save-partners-btn")) return;
    clearTimeout(debounce);
    debounce = setTimeout(injectButton, 200);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Check on load
  if (document.getElementById("tab_museumTreaties")) injectButton();
})();
