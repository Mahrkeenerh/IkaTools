// Adds "0" / "max" buttons for the extra cargo ships input on the
// plunder/raid page. The game only ships per-unit setMin/setMax on the
// army sliders — the #extraTransporter (CappedValue) input has only
// step +/- arrows.
//
// Implementation note: the onclick handler is set via setAttribute so
// the browser parses it into a page-context handler. That lets us touch
// `missionController.transporterInput` directly without a bridge round-trip.
(() => {
  const INJECTED_ID = "ikExtraTransporterQuick";

  const SET_ZERO_JS =
    "var ti=window.missionController&&missionController.transporterInput;" +
    "if(ti){ti.textInput.val(0);ti.testValue();}return false;";

  const SET_ALL_JS =
    "var ti=window.missionController&&missionController.transporterInput;" +
    "if(ti){ti.textInput.val(ti.max);ti.testValue();}return false;";

  function makeButton(label, title, onclickJs) {
    const a = document.createElement("a");
    a.href = "javascript:void(0)";
    a.textContent = label;
    a.title = title;
    a.style.cssText =
      "display:inline-block;min-width:18px;padding:1px 6px;margin:0 2px;" +
      "font-size:11px;line-height:14px;text-align:center;color:#542c0f;" +
      "background:#f2e0b6;border:1px solid #87581b;border-radius:3px;" +
      "text-decoration:none;font-weight:bold;cursor:pointer;";
    a.setAttribute("onclick", onclickJs);
    return a;
  }

  function inject() {
    if (!document.getElementById("plunderForm")) return;
    const input = document.getElementById("extraTransporter");
    if (!input) return;
    const plusminus = document.getElementById("plusminus");
    if (!plusminus) return;
    if (document.getElementById(INJECTED_ID)) return;

    const wrap = document.createElement("div");
    wrap.id = INJECTED_ID;
    wrap.style.cssText =
      "position:absolute;left:0;top:42px;width:80px;" +
      "text-align:center;white-space:nowrap;";
    wrap.appendChild(makeButton("0", "Zrušit dodatečné lodě", SET_ZERO_JS));
    wrap.appendChild(makeButton("max", "Poslat všechny volné lodě", SET_ALL_JS));

    plusminus.appendChild(wrap);
  }

  inject();

  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      inject();
    }, 300);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
