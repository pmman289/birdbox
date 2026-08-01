(() => {
  let preference = "";
  try { preference = localStorage.getItem("birdbox-theme") ?? ""; } catch {}
  const theme = preference === "dark" || preference === "light"
    ? preference
    : (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
