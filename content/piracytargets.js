// Pirate loot targets — capture the piracy highscore leaderboard.
//
// On the highscore view (view=highscore) with the type dropdown set to
// "piracy", each place cell carries a per-row tooltip of the form
// "(COEF * theft protection) = resources on evaluation day". COEF is the booty
// multiplier applied to your haul when you raid that player — the actual loot
// indicator. It is banded, not 1:1 with rank (e.g. top 10 each get a distinct
// 2.75…1.0, ranks 11–20 share 0.875, 31–50 share 0.5). The .score column is
// just the player's cumulative piracy points, which the user doesn't care about.
//
// This script injects a "Save loot targets" button on that view. Clicking it
// scrapes every visible row and writes them (full replace) to
// pirateTargets_{world}, keyed by avatarId:
//   { name, allyTag, rank, coef, score, ts }
// where `coef` is the loot coefficient (the indicator); `rank`/`score` are secondary.
//
// Display is handled elsewhere (islandinfo / minimap / islandfilter / mapfilter),
// gated by the global `pirateTargetsEnabled` toggle. This script only captures.
(() => {
  const TAG = "[PirateTargets]";
  const worldName = IkUtils.getUrlWorldName() || "unknown";
  const KEY = "pirateTargets_" + worldName;
  const BTN_ID = "ik-pirate-save";

  // True only when the highscore view is showing the piracy ranking.
  function isPiracyView() {
    if (!document.getElementById("highscore")) return false;
    const sel = document.getElementById("js_highscoreType");
    return !!sel && sel.value === "piracy";
  }

  // Scrape every leaderboard row into { [avatarId]: {name, allyTag, rank, coef, score, ts} }.
  function scrapeRows() {
    const out = {};
    const now = Date.now();
    const rows = document.querySelectorAll("#highscore table tr");
    for (const row of rows) {
      const placeCell = row.querySelector("td.place");
      const link = row.querySelector("td.name a[href*='avatarId=']");
      if (!placeCell || !link) continue; // header / spacer rows
      const idMatch = link.getAttribute("href").match(/avatarId=(\d+)/);
      if (!idMatch) continue;
      const avatarId = idMatch[1];
      // parseInt stops at the first non-digit, so the nested tooltip div text
      // ("1 (2.75 * …)") still yields just the rank.
      const rank = parseInt(placeCell.textContent, 10) || 0;
      // Loot coefficient — the booty multiplier from the place-cell tooltip
      // "(COEF * theft protection) = …". This is the actual loot indicator.
      const tip = placeCell.querySelector(".tooltip");
      const coefMatch = tip ? tip.textContent.match(/\(\s*([\d.,]+)\s*\*/) : null;
      const coef = coefMatch ? parseFloat(coefMatch[1].replace(",", ".")) : 0;
      const name = (link.getAttribute("title") || link.textContent || "").trim();
      const allyCell = row.querySelector("td.allytag a");
      const allyTag = allyCell ? allyCell.textContent.trim() : "";
      const scoreCell = row.querySelector("td.score");
      // Piracy points (secondary). Prefer the title attr (full number); strip
      // non-digits — the game renders thousands with spaces ("1 586 516").
      const scoreRaw = scoreCell ? (scoreCell.getAttribute("title") || scoreCell.textContent || "") : "";
      const score = parseInt(scoreRaw.replace(/\D/g, ""), 10) || 0;
      out[avatarId] = { name, allyTag, rank, coef, score, ts: now };
    }
    return out;
  }

  async function save(btn) {
    const targets = scrapeRows();
    const count = Object.keys(targets).length;
    if (!count) {
      flash(btn, "No rows found", "#E04444");
      return;
    }
    await chrome.storage.local.set({ [KEY]: targets });
    flash(btn, `✓ Saved ${count} loot targets`, "#5ab87a");
  }

  // Briefly show a status message on the button, then restore its label.
  function flash(btn, msg, color) {
    btn.textContent = msg;
    btn.style.borderColor = color;
    btn.style.color = color;
    clearTimeout(btn._ikFlash);
    btn._ikFlash = setTimeout(() => {
      btn.textContent = labelText();
      btn.style.borderColor = "#a86b2a";
      btn.style.color = "#ffcf8a";
    }, 2500);
  }

  function labelText() {
    return "🏴 Save loot targets";
  }

  function ensureButton() {
    if (!isPiracyView()) {
      const stale = document.getElementById(BTN_ID);
      if (stale) stale.remove();
      return;
    }
    if (document.getElementById(BTN_ID)) return;
    const table = document.querySelector("#highscore table");
    if (!table) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = labelText();
    btn.title = "Save all visible piracy-leaderboard players as loot targets (highlights them on the map until cleared / toggled off)";
    btn.style.cssText =
      "display:block;margin:6px auto;padding:4px 12px;background:#2a1d10;color:#ffcf8a;" +
      "border:1px solid #a86b2a;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;";
    btn.addEventListener("click", () => save(btn));
    table.parentNode.insertBefore(btn, table);
  }

  // The highscore view arrives/updates via AJAX into the page; watch for it and
  // (re)inject the button. Also re-evaluates when the type dropdown switches
  // between score/piracy/etc.
  const obs = new MutationObserver(() => ensureButton());
  obs.observe(document.body, { childList: true, subtree: true });
  ensureButton();
})();
