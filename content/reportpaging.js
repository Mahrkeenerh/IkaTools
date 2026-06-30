// Add ±100 jump links to advisor report paginators (game only steps ±10)
(() => {
  // Newer (lower offset) jumps go on the left, older (higher offset) on the right.
  const JUMPS = [100];

  function withOffset(href, offset) {
    const u = new URL(href, location.href);
    u.searchParams.set("offset", String(Math.max(0, offset)));
    return u.href;
  }

  function makeLink(href, label, title) {
    const a = document.createElement("a");
    a.className = "paginator_link ik-jump";
    a.href = href;
    a.title = title;
    a.textContent = label;
    // Inline onclick runs in page context, where ajaxHandlerCall lives (same as native links).
    a.setAttribute("onclick", "ajaxHandlerCall(this.href);return false;");
    a.style.cssText = "cursor:pointer; font-weight:bold; padding:0 4px; vertical-align:middle;";
    return a;
  }

  function enhance(td) {
    if (td.dataset.ikJump) return;

    const anchors = [...td.querySelectorAll("a.paginator_link")].filter((a) =>
      /[?&]offset=/.test(a.href)
    );
    if (!anchors.length) return; // single page — nothing to jump to

    // Current page start offset, from the bold "A-B" range (A is 1-based → offset A-1).
    let pageStart = null;
    const bold = td.querySelector(".paginator_link.bold");
    const m = bold && bold.textContent.match(/(\d+)\s*-\s*\d+/);
    if (m) {
      pageStart = parseInt(m[1], 10) - 1;
    } else {
      // Fallback: native prev = start-10, next = start+10 → min anchor offset + 10.
      const offs = anchors.map((a) =>
        parseInt(new URL(a.href, location.href).searchParams.get("offset"), 10)
      );
      pageStart = Math.min(...offs) + 10;
    }
    if (!Number.isFinite(pageStart)) return;

    const baseHref = anchors[0].href;
    const prevAnchor = anchors[0]; // leftmost = newer side
    const nextAnchor = anchors[anchors.length - 1]; // rightmost = older side

    // Newer jumps (offset decreases). Only when not already at the top.
    if (pageStart > 0) {
      for (const j of JUMPS) {
        const link = makeLink(withOffset(baseHref, pageStart - j), "«" + j, "Jump " + j + " newer");
        td.insertBefore(link, prevAnchor);
      }
    }

    // Older jumps (offset increases). Game clamps at the real end.
    let after = nextAnchor;
    for (const j of [...JUMPS].reverse()) {
      const link = makeLink(withOffset(baseHref, pageStart + j), j + "»", "Jump " + j + " older");
      after.after(link);
      after = link;
    }

    td.dataset.ikJump = "1";
  }

  function run() {
    for (const td of document.querySelectorAll("td.paginator")) enhance(td);
  }

  run();

  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 300);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
