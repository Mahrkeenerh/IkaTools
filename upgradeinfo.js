// Show missing resource amounts on building upgrade panels
(() => {
  const TAG = "[IkTools:UpgradeInfo]";
  const RESOURCE_IDS = {
    wood: "js_GlobalMenu_wood",
    wine: "js_GlobalMenu_wine",
    marble: "js_GlobalMenu_marble",
    crystal: "js_GlobalMenu_crystal",
    sulfur: "js_GlobalMenu_sulfur",
  };

  const parseNum = (text) => IkUtils.parseNum(text);

  function formatNum(n) {
    return n.toLocaleString("en").replace(/,/g, " ");
  }

  function getCurrentResource(type) {
    const el = document.getElementById(RESOURCE_IDS[type]);
    return el ? parseNum(el.textContent) : 0;
  }

  function injectMissing() {
    const lists = document.querySelectorAll("ul.resources");
    for (const ul of lists) {
      for (const li of ul.children) {
        if (!li.classList.contains("red") || !li.classList.contains("bold")) continue;
        if (li.querySelector(".ik-missing")) continue;
        const type = Object.keys(RESOURCE_IDS).find((t) => li.classList.contains(t));
        if (!type) continue;
        const cost = parseNum(li.textContent);
        const current = getCurrentResource(type);
        const missing = cost - current;
        if (missing <= 0) continue;
        li.style.height = "auto";
        li.style.paddingBottom = "0";
        li.style.marginBottom = "0";
        const span = document.createElement("span");
        span.className = "ik-missing";
        span.style.cssText = "display:block; font-size:0.85em; opacity:0.8; line-height:1.2;";
        span.textContent = `(-${formatNum(missing)})`;
        li.appendChild(span);
        console.log(TAG, `Injected missing for ${type}: -${formatNum(missing)}`);
      }
    }
  }

  // Initial run
  injectMissing();

  // Debounced MutationObserver, same pattern as barbarian ship calc
  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      injectMissing();
    }, 300);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
