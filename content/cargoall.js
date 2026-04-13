// Quick-action buttons for army / transporter forms:
// 1. "0" / "max" for the extra cargo ships CappedValue input (#extraTransporter)
// 2. "0 all" / "max all" for every army unit slider (registeredSliders)
//
// Implementation note: onclick handlers are set via setAttribute so the
// browser parses them into page-context handlers. That lets us touch
// `missionController` directly without a bridge round-trip.
(() => {
  const TRANSPORT_ID = "ikExtraTransporterQuick";
  const ARMY_ALL_ID = "ikArmyAllQuick";

  const SET_TRANSPORT_ZERO_JS =
    "var ti=window.missionController&&missionController.transporterInput;" +
    "if(ti){ti.textInput.val(0);ti.testValue();}return false;";

  const SET_TRANSPORT_ALL_JS =
    "var ti=window.missionController&&missionController.transporterInput;" +
    "if(ti){ti.textInput.val(ti.max);ti.testValue();}return false;";

  const SET_ARMY_ZERO_JS =
    "var mc=window.missionController;" +
    "if(mc&&mc.registeredSliders){" +
    "mc.registeredSliders.forEach(function(s){s.setActualValue(0);});" +
    "}return false;";

  const SET_ARMY_MAX_JS =
    "var mc=window.missionController;" +
    "if(mc&&mc.registeredSliders){" +
    "mc.registeredSliders.forEach(function(s){s.setActualValue(s.maxValue);});" +
    "}return false;";

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

  function injectTransporterButtons() {
    if (!document.getElementById("plunderForm")) return;
    const input = document.getElementById("extraTransporter");
    if (!input) return;
    const plusminus = document.getElementById("plusminus");
    if (!plusminus) return;
    if (document.getElementById(TRANSPORT_ID)) return;

    const wrap = document.createElement("div");
    wrap.id = TRANSPORT_ID;
    wrap.style.cssText =
      "position:absolute;left:0;top:42px;width:80px;" +
      "text-align:center;white-space:nowrap;";
    wrap.appendChild(makeButton("0", "Zrušit dodatečné lodě", SET_TRANSPORT_ZERO_JS));
    wrap.appendChild(makeButton("max", "Poslat všechny volné lodě", SET_TRANSPORT_ALL_JS));

    plusminus.appendChild(wrap);
  }

  function injectArmyAllButtons() {
    const form = document.getElementById("plunderForm")
      || document.getElementById("armyDeploymentForm");
    if (!form) return;
    const unitList = form.querySelector("ul.assignUnits");
    if (!unitList) return;
    if (document.getElementById(ARMY_ALL_ID)) return;

    const wrap = document.createElement("div");
    wrap.id = ARMY_ALL_ID;
    wrap.style.cssText =
      "text-align:center;padding:4px 0;";
    wrap.appendChild(makeButton("0 all", "Zrušit všechny jednotky", SET_ARMY_ZERO_JS));
    wrap.appendChild(makeButton("max all", "Poslat všechny jednotky", SET_ARMY_MAX_JS));

    unitList.after(wrap);
  }

  function inject() {
    injectTransporterButtons();
    injectArmyAllButtons();
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
