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

const DEVICE_ID_KEY = "sejbosejbo_device_id";

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    // A locally generated id until the server issues a signed one below.
    // Kept as the fallback so voting still works if that request fails -
    // the server accepts unsigned ids unless enforcement is switched on.
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Upgrades a locally generated id to a server-signed one, once. Signed
 * ids start with "v1_"; anything else is from before this existed. Done
 * in the background because nothing on the page needs to wait for it -
 * the next vote picks up whichever id is stored at the time. */
(() => {
  const current = localStorage.getItem(DEVICE_ID_KEY);
  if (current && current.startsWith("v1_")) return;
  fetch("/api/v1/device", { method: "POST" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data && typeof data.device_id === "string") {
        localStorage.setItem(DEVICE_ID_KEY, data.device_id);
      }
    })
    .catch(() => {
      /* keep the local id - voting still works without a signed one */
    });
})();

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

// --- confirm-before-submit ---------------------------------------------------

// These were inline onsubmit="return confirm(...)" attributes, which a
// nonce-based Content-Security-Policy blocks outright. Delegated from the
// document so it also covers admin tables rendered after load.
document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-confirm]");
  if (!form) return;
  if (!window.confirm(form.getAttribute("data-confirm"))) event.preventDefault();
});

// --- email subscription ------------------------------------------------------

// Submitted over fetch so the page doesn't navigate away from the support
// page for what is a one-line result. Falls back to nothing if the
// request fails outright - the status line says so either way.
const SUBSCRIBE_SEEN_KEY = "sejbosejbo_subscribe_prompted";

// There can be two of these on a page: the one on /support and the
// first-visit popup. Both behave identically, so this wires up every
// match rather than the first.
document.querySelectorAll("[data-subscribe-form]").forEach((form) => {
  const status = form.querySelector("[data-subscribe-status]");
  const button = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = window.SEJBOSEJBO_COPY?.loading || "...";

    try {
      const response = await fetch("/api/v1/subscribe" + window.location.search, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.querySelector("input[name=email]").value })
      });
      const data = await response.json().catch(() => ({}));
      status.textContent = data.message || data.error || "";
      if (response.ok) {
        form.reset();
        // Someone who has just signed up must never be asked again, on
        // this page or any later visit.
        try {
          localStorage.setItem(SUBSCRIBE_SEEN_KEY, "1");
        } catch {
          /* private mode - the prompt may reappear, which is survivable */
        }
      }
    } catch {
      status.textContent = window.SEJBOSEJBO_COPY?.loadingFailed || "";
    } finally {
      button.disabled = false;
    }
  });
});

// --- first-visit email prompt ------------------------------------------------

// Shown once per device, ever. Dismissing it, subscribing from it, or
// subscribing from the support page all set the same flag, so there is no
// combination of actions that shows it twice.
(() => {
  const pop = document.querySelector("[data-subscribe-pop]");
  if (!pop) return;

  let alreadyPrompted = true;
  try {
    alreadyPrompted = localStorage.getItem(SUBSCRIBE_SEEN_KEY) === "1";
  } catch {
    // No localStorage means no way to remember a dismissal, and a prompt
    // that reappears on every page is worse than one that never appears.
    return;
  }
  if (alreadyPrompted) return;

  // Not on /support, where the same form is already on the page in full.
  // Asked as "is there a subscribe form outside the popup" rather than
  // by matching a path, so it stays right if the form moves elsewhere.
  const formElsewhere = Array.from(document.querySelectorAll("[data-subscribe-form]"))
    .some((form) => !pop.contains(form));
  if (formElsewhere) return;

  function dismiss() {
    pop.hidden = true;
    try {
      localStorage.setItem(SUBSCRIBE_SEEN_KEY, "1");
    } catch {
      /* nothing to do - see above */
    }
  }

  pop.querySelectorAll("[data-subscribe-dismiss]").forEach((button) => {
    button.addEventListener("click", dismiss);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pop.hidden) dismiss();
  });

  // A beat after load, so it arrives as an interruption to a page the
  // visitor can already see rather than as the first thing they meet.
  setTimeout(() => {
    // Never stack on top of the mobile notice. A first visit on a phone
    // triggers both, and dismissing one only to be met by another is how
    // a visitor decides the site is not worth the trouble. Skipping
    // rather than queueing: the flag is untouched, so this simply asks on
    // a later visit instead.
    const gate = document.querySelector("[data-mobile-gate]");
    if (gate && !gate.hidden) return;
    pop.hidden = false;
  }, 2500);
})();

// --- theme toggle ------------------------------------------------------------

// Light is the default and what every first visit gets; dark is opt-in and
// remembered per device. The head of every page carries a tiny inline
// script that applies the stored choice before first paint - this half only
// handles the button, so a page still renders in the right theme with this
// file blocked or slow.
(() => {
  const KEY = "sejbosejbo_theme";
  const toggle = document.querySelector("[data-theme-toggle]");
  const icon = document.querySelector("[data-theme-icon]");
  if (!toggle || !icon) return;

  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function paint() {
    const dark = isDark();
    // Shows the destination, not the current state: a sun means "go light".
    icon.textContent = dark ? "☀️" : "\u{1F319}";
    toggle.setAttribute("aria-pressed", String(dark));
  }

  toggle.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    if (next === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode - the choice just won't survive the visit */
    }
    paint();
  });

  paint();
})();

// --- mobile notice -----------------------------------------------------------

// One-time note on phones that the site is built wide. Deliberately
// dismissible and shown once per device: most visitors arrive on a phone,
// and a gate they cannot get past would simply lose them. Decided in JS on
// viewport width rather than server-side on the user agent, which is wrong
// often enough to matter.
(() => {
  const gate = document.querySelector("[data-mobile-gate]");
  if (!gate) return;

  const KEY = "sejbosejbo_mobile_notice";
  const isSmall = window.matchMedia("(max-width: 720px)").matches;
  if (!isSmall) return;

  try {
    if (localStorage.getItem(KEY) === "1") return;
  } catch {
    // No storage means no way to remember a dismissal, and a notice on
    // every page load is worse than none.
    return;
  }

  function dismiss() {
    gate.hidden = true;
    document.body.classList.remove("mobile-gate-on");
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* nothing to do - see above */
    }
  }

  gate.querySelectorAll("[data-mobile-gate-dismiss]").forEach((el) => {
    el.addEventListener("click", dismiss);
  });

  // Tapping the backdrop is the gesture people try first.
  gate.addEventListener("click", (event) => {
    if (event.target === gate) dismiss();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !gate.hidden) dismiss();
  });

  gate.hidden = false;
  document.body.classList.add("mobile-gate-on");
})();

// --- the hidden page ---------------------------------------------------------

(() => {
  const page = document.querySelector(".sw");
  if (!page) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Counters climb from zero to their real value, then keep drifting up
  // forever, because a number that stops is a number you stop believing.
  document.querySelectorAll("[data-sw-count]").forEach((el) => {
    const target = Number(el.getAttribute("data-sw-count")) || 0;
    if (reduced) {
      el.textContent = target.toLocaleString("en-US");
      return;
    }
    const started = performance.now();
    const runFor = 1600;
    let current = target;

    function frame(now) {
      const progress = Math.min(1, (now - started) / runFor);
      // Ease out, so it slams up and then settles rather than crawling.
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(target * eased).toLocaleString("en-US");
      if (progress < 1) requestAnimationFrame(frame);
      else {
        setInterval(() => {
          current += Math.max(1, Math.floor(target * 0.0000004 * (1 + Math.random())));
          el.textContent = current.toLocaleString("en-US");
        }, 900);
      }
    }
    requestAnimationFrame(frame);
  });

  // The cap's valuation refuses to settle on a number.
  const capValue = document.querySelector("[data-sw-capvalue]");
  if (capValue && !reduced) {
    const symbols = ["∞", "???", "NaN", "yes", "€∞", "priceless", "ask again"];
    let i = 0;
    setInterval(() => {
      i = (i + 1) % symbols.length;
      capValue.textContent = symbols[i];
    }, 1700);
  }

  // Bowing is real and persisted, so the number means something.
  const worshipButton = document.querySelector("[data-sw-worship]");
  const worshipCount = document.querySelector("[data-sw-worship-count]");
  if (worshipButton && worshipCount) {
    const template = worshipCount.textContent;
    worshipButton.addEventListener("click", async () => {
      if (worshipButton.disabled) return;
      worshipButton.disabled = true;
      try {
        const response = await fetch("/api/v1/cap/worship", { method: "POST" });
        const data = await response.json().catch(() => ({}));
        if (response.ok && typeof data.count === "number") {
          // Rebuild from the template so the sentence stays translated.
          worshipCount.textContent = template.replace(/[\d,. ]+/, data.count.toLocaleString("en-US"));
          const cap = document.querySelector("[data-sw-cap]");
          if (cap && !reduced) {
            cap.style.filter = "brightness(2.4)";
            setTimeout(() => { cap.style.filter = ""; }, 180);
          }
        } else if (data.error) {
          worshipCount.textContent = data.error;
        }
      } catch {
        /* the cap is unmoved by network failure */
      } finally {
        worshipButton.disabled = false;
      }
    });
  }

  // Type the word and the page notices.
  let typed = "";
  document.addEventListener("keydown", (event) => {
    if (event.key.length !== 1) return;
    typed = (typed + event.key.toLowerCase()).slice(-5);
    if (typed === "sweat" && !reduced) {
      document.body.style.animation = "sw-tumble 1.2s linear";
      setTimeout(() => { document.body.style.animation = ""; }, 1200);
    }
  });
})();
