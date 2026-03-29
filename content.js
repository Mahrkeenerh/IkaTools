// Captcha detection, solving, and auto-submit logic
(() => {
  const C = "[Captcha]";
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
      console.log(C, "Waiting for captcha image to load...");
      await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => clearTimeout(timer);
        const onLoad = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("Captcha image failed to load")); };
        imgEl.addEventListener("load", onLoad, { once: true });
        imgEl.addEventListener("error", onError, { once: true });
        timer = setTimeout(() => {
          imgEl.removeEventListener("load", onLoad);
          imgEl.removeEventListener("error", onError);
          reject(new Error("Captcha image load timed out"));
        }, 10000);
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgEl, 0, 0);
    console.log(C, "Image captured:", imgEl.naturalWidth + "x" + imgEl.naturalHeight);
    return canvas.toDataURL("image/png");
  }

  async function solve(els) {
    if (solving) {
      console.log(C, "Already solving, skipping");
      return;
    }
    solving = true;
    console.log(C, "Solving captcha... (auto-submit " + autoSubmitCount + "/" + MAX_AUTO_SUBMITS + ")");

    try {
      const dataUrl = await getImageDataUrl(els.img);
      console.log(C, "Sending to background solver...");
      const response = await chrome.runtime.sendMessage({
        type: "solve-captcha",
        dataUrl,
      });

      if (response?.error) {
        console.error(C, "Solver error:", response.error);
        return;
      }

      if (!response?.answer) {
        console.log(C, "No answer from solver, response:", response);
        return;
      }

      console.log(C, "Answer:", response.answer);

      // Fill the input
      els.input.value = response.answer;
      els.input.dispatchEvent(new Event("input", { bubbles: true }));
      els.input.dispatchEvent(new Event("change", { bubbles: true }));

      if (autoSubmitCount < MAX_AUTO_SUBMITS) {
        // Auto-submit mode
        autoSubmitCount++;
        els.input.style.outline = "2px solid #FF9800";
        console.log(C, "Auto-submit " + autoSubmitCount + "/" + MAX_AUTO_SUBMITS);

        // Brief delay so the UI updates, then submit
        await new Promise((r) => setTimeout(r, 300));
        if (els.submit) {
          console.log(C, "Clicking submit");
          els.submit.click();
        } else {
          console.log(C, "No submit button found!");
        }
      } else {
        // Manual mode — fill only, green highlight, wait for user
        els.input.style.outline = "2px solid #4CAF50";
        console.log(C, "Manual mode (limit reached), filled:", response.answer);
      }
    } catch (err) {
      // Message channel closes when page updates after successful submit — ignore
      if (!err.message?.includes("message channel closed")) {
        console.error(C, "Solve failed:", err);
      } else {
        console.log(C, "Channel closed (page updated, likely success)");
      }
    } finally {
      solving = false;
    }
  }

  function check() {
    const els = findCaptcha();
    if (!els) {
      // Captcha gone — reset for next time
      if (lastCaptchaSrc !== null) {
        console.log(C, "Captcha gone, resetting (was at " + autoSubmitCount + " auto-submits)");
        autoSubmitCount = 0;
        lastCaptchaSrc = null;
      }
      return;
    }

    const currentSrc = els.img.src;

    // New captcha image appeared (or refreshed after failed attempt)
    if (currentSrc !== lastCaptchaSrc) {
      console.log(C, "New captcha detected, src changed");
      lastCaptchaSrc = currentSrc;
      solve(els);
    }
  }

  // Watch for captcha appearing / changing
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(check, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial check
  console.log(C, "Captcha solver initialized");
  check();
})();
