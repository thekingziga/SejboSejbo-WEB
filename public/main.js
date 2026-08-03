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
