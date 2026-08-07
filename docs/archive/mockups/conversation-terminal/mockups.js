const toast = document.querySelector("[data-toast]");
let toastTimer = 0;

// Match a live session: open at the newest output, with scrollback above it.
document.querySelectorAll(".pty-scroll, .output-pane, .event-pane, .ledger-main").forEach((log) => {
  log.scrollTop = log.scrollHeight;
});

function announce(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => announce(button.dataset.action));
});

document.querySelectorAll("[data-composer]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const field = form.querySelector("input, textarea");
    const value = field?.value.trim();
    if (!value) {
      announce("Type an instruction first");
      field?.focus();
      return;
    }

    announce(`Queued to Codex: ${value}`);
    field.value = "";
    field.focus();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  const pages = {
    "1": "01-native-pty.html",
    "2": "02-duplex-console.html",
    "3": "03-operator-log.html",
  };
  const next = pages[event.key];
  if (next) window.location.href = next;
});
