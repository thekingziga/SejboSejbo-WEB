const logo = document.querySelector(".logo-button");
if (logo) {
  logo.addEventListener("click", () => {
    logo.classList.remove("bounce");
    window.requestAnimationFrame(() => logo.classList.add("bounce"));
  });
}

const randomButton = document.querySelector("[data-random-button]");
const randomResult = document.querySelector("[data-random-result]");
if (randomButton && randomResult) {
  randomButton.addEventListener("click", async () => {
    const copy = window.SEJBOSEJBO_COPY || {};
    randomResult.textContent = copy.loading || "Measuring Sejbosejbo...";
    try {
      const response = await fetch("/api/random-phrase");
      const data = await response.json();
      randomResult.textContent = data.phrase;
    } catch {
      randomResult.textContent = copy.loadingFailed || "Calibrating stupidity detector failed.";
    }
  });
}

// --- Paste an image straight into the upload form -------------------------

const imageInput = document.querySelector("[data-image-input]");
if (imageInput) {
  const preview = document.querySelector("[data-paste-preview]");
  const previewImg = preview?.querySelector("img");

  document.addEventListener("paste", (event) => {
    const items = [...(event.clipboardData?.items || [])];
    const item = items.find((entry) => entry.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;

    // Route the pasted file through the same input the form already submits,
    // so multipart upload code on the server needs no special case for it.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    imageInput.files = transfer.files;

    if (preview && previewImg) {
      previewImg.src = URL.createObjectURL(file);
      preview.hidden = false;
    }
  });

  imageInput.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    if (preview && previewImg && file) {
      previewImg.src = URL.createObjectURL(file);
      preview.hidden = false;
    }
  });
}

// --- Voting -----------------------------------------------------------------

function getDeviceId() {
  const key = "sejbosejbo_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

document.querySelectorAll("[data-vote-widget]").forEach((widget) => {
  const postId = widget.dataset.postId;
  const upButton = widget.querySelector('[data-vote="1"]');
  const downButton = widget.querySelector('[data-vote="-1"]');
  const upCount = widget.querySelector("[data-vote-up]");
  const downCount = widget.querySelector("[data-vote-down]");
  let voted = null; // 1, -1, or null - tracks this browser's current vote locally
  let busy = false;

  async function castVote(button, value) {
    if (busy) return;
    busy = true;
    upButton.disabled = true;
    downButton.disabled = true;
    // Withdraw if re-clicking the same direction, otherwise cast/switch.
    const nextValue = voted === value ? 0 : value;

    try {
      const response = await fetch(`/api/v1/posts/${postId}/vote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": getDeviceId()
        },
        body: JSON.stringify({ value: nextValue })
      });
      if (!response.ok) throw new Error("vote failed");
      const post = await response.json();
      voted = nextValue === 0 ? null : nextValue;
      upButton.classList.toggle("active", voted === 1);
      downButton.classList.toggle("active", voted === -1);
      if (upCount) upCount.textContent = post.upvotes;
      if (downCount) downCount.textContent = post.downvotes;
    } catch {
      const copy = window.SEJBOSEJBO_COPY || {};
      button.classList.add("vote-error");
      button.title = copy.voteFailed || "Vote failed. Try again.";
      setTimeout(() => button.classList.remove("vote-error"), 1200);
    } finally {
      busy = false;
      upButton.disabled = false;
      downButton.disabled = false;
    }
  }

  upButton?.addEventListener("click", (event) => {
    event.preventDefault();
    castVote(upButton, 1);
  });
  downButton?.addEventListener("click", (event) => {
    event.preventDefault();
    castVote(downButton, -1);
  });
});

// --- Reporting ---------------------------------------------------------------

document.querySelectorAll("[data-report-widget]").forEach((widget) => {
  const postId = widget.dataset.postId;
  const toggle = widget.querySelector("[data-report-toggle]");
  const form = widget.querySelector("[data-report-form]");
  const cancelButton = widget.querySelector("[data-report-cancel]");
  const status = widget.querySelector("[data-report-status]");
  if (!toggle || !form) return;

  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    toggle.hidden = !form.hidden;
  });

  cancelButton?.addEventListener("click", () => {
    form.hidden = true;
    toggle.hidden = false;
    status.textContent = "";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    status.textContent = "";

    const reason = form.elements.reason.value;
    const details = form.elements.details.value;

    try {
      const response = await fetch(`/api/v1/posts/${postId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, details })
      });
      if (!response.ok) throw new Error("report failed");
      const copy = window.SEJBOSEJBO_COPY || {};
      status.textContent = copy.reportSubmitted || "Report submitted. Thanks for flagging it.";
      form.reset();
      setTimeout(() => {
        form.hidden = true;
        toggle.hidden = false;
        status.textContent = "";
      }, 2000);
    } catch {
      const copy = window.SEJBOSEJBO_COPY || {};
      status.textContent = copy.reportFailed || "Report failed. Try again.";
    } finally {
      submitButton.disabled = false;
    }
  });
});

// --- Comments ----------------------------------------------------------------

(() => {
  const root = document.querySelector("[data-comments]");
  if (!root) return;
  const form = root.querySelector("[data-comment-form]");
  const list = root.querySelector("[data-comment-list]");
  const status = root.querySelector("[data-comment-status]");
  const counter = root.querySelector("[data-comment-count]");
  const postId = root.dataset.postId;
  if (!form || !list) return;

  function formatWhen(iso) {
    try {
      return new Intl.DateTimeFormat("en", {
        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      }).format(new Date(iso));
    } catch {
      return "";
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const copy = window.SEJBOSEJBO_COPY || {};
    const field = form.elements.body;
    const body = field.value.trim();
    status.textContent = "";
    status.className = "comment-status";

    if (!body) {
      status.textContent = copy.commentEmpty || "Write something first.";
      status.classList.add("bad");
      return;
    }

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      const response = await fetch(`/api/v1/posts/${postId}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Sent so a client can recognise its own comments later. The
          // server treats it as optional - comments stay anonymous.
          "X-Device-Id": getDeviceId()
        },
        body: JSON.stringify({ body })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "failed");

      root.querySelector("[data-comment-empty]")?.remove();
      const item = document.createElement("li");
      item.className = "comment";
      const p = document.createElement("p");
      // textContent, never innerHTML: this is untrusted input echoed
      // straight back into the page.
      p.textContent = data.body;
      const time = document.createElement("time");
      time.textContent = formatWhen(data.created_at);
      item.append(p, time);
      list.append(item);

      if (counter) counter.textContent = String(Number(counter.textContent || 0) + 1);
      field.value = "";
      status.textContent = copy.commentPosted || "Posted.";
      status.classList.add("ok");
    } catch (err) {
      status.textContent = err.message && err.message !== "failed"
        ? err.message
        : (copy.commentFailed || "Could not post that. Try again.");
      status.classList.add("bad");
    } finally {
      submit.disabled = false;
    }
  });
})();

// --- Voting on comments ------------------------------------------------------

// Same contract as post voting: re-clicking the active direction withdraws,
// the server recomputes and returns the authoritative counts.
document.querySelectorAll("[data-comment-vote-widget]").forEach((widget) => {
  const commentId = widget.dataset.commentId;
  const upButton = widget.querySelector('[data-cvote="1"]');
  const downButton = widget.querySelector('[data-cvote="-1"]');
  const upCount = widget.querySelector("[data-cvote-up]");
  const downCount = widget.querySelector("[data-cvote-down]");
  let voted = null;
  let busy = false;

  async function send(button, value) {
    if (busy) return;
    busy = true;
    upButton.disabled = true;
    downButton.disabled = true;
    const nextValue = voted === value ? 0 : value;

    try {
      const response = await fetch(`/api/v1/comments/${commentId}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": getDeviceId() },
        body: JSON.stringify({ value: nextValue })
      });
      if (!response.ok) throw new Error("vote failed");
      const comment = await response.json();
      voted = nextValue === 0 ? null : nextValue;
      upButton.classList.toggle("active", voted === 1);
      downButton.classList.toggle("active", voted === -1);
      if (upCount) upCount.textContent = comment.upvotes;
      if (downCount) downCount.textContent = comment.downvotes;
    } catch {
      const copy = window.SEJBOSEJBO_COPY || {};
      button.classList.add("vote-error");
      button.title = copy.voteFailed || "Vote failed. Try again.";
      setTimeout(() => button.classList.remove("vote-error"), 1200);
    } finally {
      busy = false;
      upButton.disabled = false;
      downButton.disabled = false;
    }
  }

  upButton?.addEventListener("click", () => send(upButton, 1));
  downButton?.addEventListener("click", () => send(downButton, -1));
});

// --- Reporting a comment -----------------------------------------------------

// A dropdown of the five reasons the API actually accepts, matching the
// post report widget. This used to be a window.prompt() the visitor typed
// into freehand, which could only ever produce one of five exact strings -
// anything else was rejected after the fact, and "spam!!" or "Spam " read
// as a bug rather than a validation rule.
document.querySelectorAll("[data-comment-report]").forEach((button) => {
  const commentId = button.dataset.commentReport;
  const form = document.querySelector(`[data-comment-report-form="${commentId}"]`);
  if (!form) return;

  const status = form.querySelector("[data-comment-report-status]");
  const copy = () => window.SEJBOSEJBO_COPY || {};

  button.addEventListener("click", () => {
    const opening = form.hidden;
    form.hidden = !opening;
    if (opening) form.querySelector("select")?.focus();
  });

  form.querySelector("[data-comment-report-cancel]")?.addEventListener("click", () => {
    form.hidden = true;
    if (status) status.textContent = "";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    const reason = form.querySelector("select[name=reason]").value;
    const details = form.querySelector("textarea[name=details]").value.trim();

    if (submit) submit.disabled = true;
    if (status) status.textContent = "";

    try {
      const response = await fetch(`/api/v1/comments/${commentId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(details ? { reason, details } : { reason })
      });
      if (!response.ok) throw new Error("failed");
      form.hidden = true;
      button.textContent = copy().commentReported || "reported";
      button.classList.add("done");
      button.disabled = true;
    } catch {
      if (status) status.textContent = copy().reportFailed || "Report failed. Try again.";
      if (submit) submit.disabled = false;
    }
  });
});

// --- Background music --------------------------------------------------------

// Browsers refuse unmuted autoplay until the visitor has interacted with
// the page - there is no way around that, so this tries to play, and if
// the promise rejects it arms a one-shot listener and starts on the first
// click/tap/key instead. The choice is remembered, so anyone who mutes
// once stays muted on every later visit.
(() => {
  const audio = document.querySelector("[data-music-audio]");
  const toggle = document.querySelector("[data-music-toggle]");
  const icon = document.querySelector("[data-music-icon]");
  if (!audio || !toggle || !icon) return;

  const KEY = "sejbosejbo_music";
  // Playback position, so the track picks up where it left off instead of
  // restarting on every page. This is a multi-page site - each navigation
  // destroys the <audio> element, so genuinely gapless playback is not
  // possible without turning the whole site into an SPA. Saving the
  // position is the honest approximation: a short gap while the next page
  // loads, then it resumes mid-track rather than from zero.
  const POS_KEY = "sejbosejbo_music_pos";
  const VOLUME = 0.3;
  let wantsMusic = localStorage.getItem(KEY) !== "off";

  function savePosition() {
    if (audio.currentTime > 0 && Number.isFinite(audio.currentTime)) {
      sessionStorage.setItem(POS_KEY, String(audio.currentTime));
    }
  }

  function restorePosition() {
    const saved = Number(sessionStorage.getItem(POS_KEY));
    if (!Number.isFinite(saved) || saved <= 0) return;
    const apply = () => {
      // duration is NaN until metadata lands; guard so we never seek past
      // the end and trigger an immediate loop back to 0.
      if (Number.isFinite(audio.duration) && saved < audio.duration) audio.currentTime = saved;
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener("loadedmetadata", apply, { once: true });
  }

  // pagehide covers normal navigation and mobile Safari's bfcache, which
  // "unload" does not reliably fire for.
  window.addEventListener("pagehide", savePosition);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") savePosition();
  });
  setInterval(savePosition, 5000);

  function paint() {
    icon.textContent = wantsMusic ? "\u{1F50A}" : "\u{1F507}";
    toggle.setAttribute("aria-pressed", String(wantsMusic));
  }

  // Only reveal the control once a track is known to exist - no point
  // offering a mute button for audio that 404s. Probes the mp3 because
  // it's the universal fallback: if that's present the element has
  // something playable regardless of which <source> the browser picks.
  const probeUrl = audio.querySelector('source[type="audio/mpeg"]')?.src
    || audio.querySelector("source")?.src;
  if (!probeUrl) return;

  fetch(probeUrl, { method: "HEAD" })
    .then((response) => {
      if (!response.ok) return;
      audio.volume = VOLUME;
      toggle.hidden = false;
      paint();
      if (wantsMusic) start();
    })
    .catch(() => {
      /* no track shipped - stay silent and keep the button hidden */
    });

  let armed = false;
  function armFirstInteraction() {
    if (armed) return;
    armed = true;
    const kick = () => {
      document.removeEventListener("pointerdown", kick);
      document.removeEventListener("keydown", kick);
      if (wantsMusic) audio.play().catch(() => {});
    };
    document.addEventListener("pointerdown", kick, { once: true });
    document.addEventListener("keydown", kick, { once: true });
  }

  function start() {
    audio.volume = VOLUME;
    restorePosition();
    audio.play().catch(armFirstInteraction);
  }

  toggle.addEventListener("click", () => {
    wantsMusic = !wantsMusic;
    localStorage.setItem(KEY, wantsMusic ? "on" : "off");
    paint();
    if (wantsMusic) start();
    else audio.pause();
  });
})();

// --- Admin connection tests --------------------------------------------------

// Both tests can be genuinely slow - a cold Ollama model load or an SMTP
// handshake to a far-away server - so the button reports busy state and
// stays disabled until the answer lands.
document.querySelectorAll("[data-test]").forEach((button) => {
  const kind = button.dataset.test;
  const output = document.querySelector(`[data-test-result="${kind}"]`);
  const idleLabel = button.textContent;
  const endpoint = kind === "ai" ? "/admin/ai/test" : "/admin/smtp/test";

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = button.dataset.busy || "...";
    output.textContent = "";
    output.className = "test-result";

    try {
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json();
      output.textContent = data.message || (data.ok ? "OK" : "Failed.");
      output.classList.add(data.ok ? "ok" : "bad");
    } catch {
      const copy = window.SEJBOSEJBO_COPY || {};
      output.textContent = copy.testFailedGeneric || "Test failed - the server didn't respond.";
      output.classList.add("bad");
    } finally {
      button.disabled = false;
      button.textContent = idleLabel;
    }
  });
});

// --- App platform badges (coming soon) --------------------------------------

document.querySelectorAll("[data-app-badge]").forEach((badge) => {
  badge.addEventListener("click", () => {
    const status = document.querySelector("[data-app-badge-status]");
    if (!status) return;
    const copy = window.SEJBOSEJBO_COPY || {};
    const template = copy.appComingSoonMessage || "{platform} app is coming soon. Hang tight.";
    status.textContent = template.replace("{platform}", badge.dataset.appBadge);
    badge.classList.remove("bounce");
    window.requestAnimationFrame(() => badge.classList.add("bounce"));
  });
});

// --- Support / tipping --------------------------------------------------------

// Each tier button asks the server for a Stripe Checkout session and then
// sends the browser there. The amount is never in this request - only a
// tier id - so nothing here can ask Stripe for a different price.
document.querySelectorAll("[data-tier]").forEach((button) => {
  button.addEventListener("click", async () => {
    const copy = window.SEJBOSEJBO_COPY || {};
    const row = document.querySelector("[data-tier-row]");
    const status = document.querySelector("[data-tier-status]");

    // Disable the whole row, not just the clicked button: a double click
    // would otherwise open two checkout sessions.
    row?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    if (status) status.textContent = copy.supportRedirecting || "Opening the payment page...";

    try {
      const response = await fetch("/api/v1/donations/stripe/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier_id: button.dataset.tier })
      });
      if (!response.ok) throw new Error("failed");
      const data = await response.json();
      if (!data.url) throw new Error("no url");
      window.location.href = data.url;
    } catch {
      if (status) status.textContent = copy.supportFailed || "Could not open the payment page. Try again in a moment.";
      row?.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  });
});
