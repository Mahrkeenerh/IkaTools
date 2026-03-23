// Captcha detection, solving, and auto-submit logic
(() => {
  const MAX_AUTO_SUBMITS = 5;

  let autoSubmitCount = 0;
  let solving = false;
  let lastCaptchaSrc = null;

  function findCaptcha() {
    const img = document.querySelector("img.captchaImage");
    if (!img) return null;

    const input = document.querySelector("input#captcha");
    const submit = document.querySelector(
      "#pirateCaptureBox input.button[type='submit']"
    );

    return input ? { img, input, submit } : null;
  }

  async function getImageDataUrl(imgEl) {
    if (!imgEl.complete || !imgEl.naturalWidth) {
      await new Promise((r) =>
        imgEl.addEventListener("load", r, { once: true })
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgEl, 0, 0);
    return canvas.toDataURL("image/png");
  }

  async function solve(els) {
    if (solving) return;
    solving = true;

    try {
      const dataUrl = await getImageDataUrl(els.img);
      const response = await chrome.runtime.sendMessage({
        type: "solve-captcha",
        dataUrl,
      });

      if (response?.error) {
        console.error("[Ikariam Tools] Solver error:", response.error);
        solving = false;
        return;
      }

      if (!response?.answer) {
        solving = false;
        return;
      }

      // Fill the input
      els.input.value = response.answer;
      els.input.dispatchEvent(new Event("input", { bubbles: true }));
      els.input.dispatchEvent(new Event("change", { bubbles: true }));

      if (autoSubmitCount < MAX_AUTO_SUBMITS) {
        // Auto-submit mode
        autoSubmitCount++;
        els.input.style.outline = "2px solid #FF9800";
        console.log(
          `[Ikariam Tools] Auto-submit ${autoSubmitCount}/${MAX_AUTO_SUBMITS}: "${response.answer}"`
        );

        // Brief delay so the UI updates, then submit
        await new Promise((r) => setTimeout(r, 300));
        if (els.submit) els.submit.click();
      } else {
        // Manual mode — fill only, green highlight, wait for user
        els.input.style.outline = "2px solid #4CAF50";
        console.log(
          `[Ikariam Tools] Manual mode, filled: "${response.answer}"`
        );
      }
    } catch (err) {
      // Message channel closes when page updates after successful submit — ignore
      if (!err.message?.includes("message channel closed")) {
        console.error("[Ikariam Tools] Solve failed:", err);
      }
    }

    solving = false;
  }

  function check() {
    const els = findCaptcha();
    if (!els) {
      // Captcha gone — reset for next time
      if (lastCaptchaSrc !== null) {
        autoSubmitCount = 0;
        lastCaptchaSrc = null;
      }
      return;
    }

    const currentSrc = els.img.src;

    // New captcha image appeared (or refreshed after failed attempt)
    if (currentSrc !== lastCaptchaSrc) {
      lastCaptchaSrc = currentSrc;
      solve(els);
    }
  }

  // Watch for captcha appearing / changing
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });

  // Also check periodically in case mutations are missed
  setInterval(check, 1000);

  // Initial check
  check();
})();
