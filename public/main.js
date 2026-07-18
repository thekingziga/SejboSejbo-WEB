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
