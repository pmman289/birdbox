(() => {
  try {
    const stored = localStorage.getItem("birdbox-theme");
    const theme = stored === "dark" || stored === "light"
      ? stored
      : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    // CSS color-scheme remains the fallback when storage or matchMedia is unavailable.
  }
})();
