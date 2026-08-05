/**
 * Shared renderers and behaviour for the six mockups.
 *
 * Classic script, not a module - see the note in mock-data.js. Reads FOREMAN and ROWS,
 * which mock-data.js declares at top level in the same global lexical scope.
 *
 * Everything the six options have in COMMON lives here: the ledger, the count strip, the
 * health readout, the live-repositories summary, and the field leaves. The options differ
 * in how the configuration is arranged, so only that part is written per page. This is the
 * same reason the real app has `settings-console.tsx` - six hand-copied ledgers would
 * disagree with each other by the third edit, and then the mockups would be arguing about
 * markup drift rather than about layout.
 *
 * Wrapped in an IIFE so that `Mock` is the ONLY thing this file adds to the page. Classic
 * scripts share one global lexical scope, so a bare top-level `const esc` here collides
 * with a page that declares its own - and the collision is an uncaught SyntaxError that
 * kills the whole inline script, which renders as a blank panel rather than as an error
 * anyone would notice. That happened once already.
 */

(function () {
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** The count strip. Every tile is the filter that selects it, exactly as in the app. */
function stripHtml() {
  return `<div class="sc-strip">${FOREMAN.tallies
    .map(
      (t) =>
        `<button class="sc-stat sc-stat-${t.tone}" type="button" data-tally="${t.id}"><b>${t.count}</b><span>${esc(t.label)}</span></button>`,
    )
    .join("")}</div>`;
}

function rowHtml(r) {
  return `<button class="sc-row sc-row-open" type="button">
    <span class="sc-ref">${esc(r.session)}</span>
    <span class="sc-ask"><span class="sc-ask-purpose">${esc(r.purpose)}</span><span class="sc-ask-raw">${esc(r.ask)}</span></span>
    <span class="sc-verdict sc-verdict-${r.outcome}">${esc(r.outcome)}</span>
    <span class="sc-decided"><span class="sc-decided-who">${esc(r.who)}</span><span class="sc-decided-why">${esc(r.why)}</span></span>
    <span class="sc-when">${esc(r.when)}</span>
  </button>`;
}

/**
 * The ledger. `rows` trims the list for a mockup that needs a shorter stage; `foot`
 * drops the caption where the layout already says it.
 *
 * No Cheap-tier column, in any mockup: that column exists only under the SHADOW posture
 * and this snapshot is On, so rendering it would show a permanently empty track.
 */
function ledgerHtml({ rows = ROWS.length, foot = true, strip = true } = {}) {
  return `<div class="sc-ledger">
    ${strip ? stripHtml() : ""}
    <div class="sc-table sc-table-foreman">
      <div class="sc-head"><h3>Decisions</h3></div>
      <div class="sc-row sc-row-head" aria-hidden="true">
        <span>Session</span><span>Asked</span><span>Outcome</span><span>Decided by</span><span class="sc-when">When</span>
      </div>
      <div class="sc-scroll">${ROWS.slice(0, rows).map(rowHtml).join("")}</div>
    </div>
    ${
      foot
        ? `<p class="settings-hint sc-foot">The last 100 decisions across every session, newest first. Episodes are kept for 30 days.</p>`
        : ""
    }
  </div>`;
}

/** The live figures card. Its own heading, because it is a different population to the strip. */
function healthHtml() {
  return `<section class="sc-card"><div class="sc-card-head"><h3 class="sc-card-title">Right now</h3></div>
    <div class="sc-card-body">${FOREMAN.health
      .map(
        (h) =>
          `<p class="sc-health-row"><span>${esc(h.label)}</span><span class="sc-health-value">${esc(h.value)}</span></p>`,
      )
      .join("")}</div></section>`;
}

/**
 * Live repositories, as the panel actually renders it: a COUNT and a link out.
 *
 * There is no editor here and no mockup may add one. The repo allowlist is edited in the
 * Trust category, which is why this returns a sentence rather than a field.
 */
function liveReposHtml() {
  return `<p class="settings-hint trust-summary">${esc(FOREMAN.liveRepos.summary)}
    <button type="button" class="settings-link">${esc(FOREMAN.liveRepos.link)}</button>.</p>`;
}

/**
 * A model select, with the provider-correct option list and the resolved default first.
 *
 * Carries `name` rather than `id`: several pages inject their own `id` by rewriting the
 * opening tag, and an id emitted here would be a duplicate attribute on those. `name`
 * satisfies the same "this field should be identifiable" check and cannot collide.
 */
function selectHtml(field) {
  const opts = [field.fallback, ...field.options].filter(Boolean);
  return `<select class="field-input sc-input" name="${esc(field.id ?? field.label)}" aria-label="${esc(field.label)}">${opts
    .map((o) => `<option${o === field.value ? " selected" : ""}>${esc(o)}</option>`)
    .join("")}</select>`;
}

/** The posture line. Always rendered, in every state - a switch cannot tell four apart. */
function stateHtml() {
  return `<p class="sc-state sc-state-${FOREMAN.posture.tone}"><span class="sc-dot sc-dot-${FOREMAN.posture.tone}"></span>${esc(FOREMAN.posture.line)}</p>`;
}

/** The cheap-tier segmented control, as the app draws it. */
function tierSegHtml() {
  return `<fieldset class="sc-field sc-seg"><legend class="sc-field-label">Cheap tier</legend>
    <div class="sc-seg-row">${FOREMAN.cheapTier.options
      .map(
        (o) =>
          `<label class="sc-seg-opt${o.id === FOREMAN.cheapTier.value ? " is-on" : ""}" title="${esc(o.label)}">
            <input type="radio" name="tier" ${o.id === FOREMAN.cheapTier.value ? "checked" : ""} /><span>${esc(o.short)}</span></label>`,
      )
      .join("")}</div>
    <p class="settings-hint">${esc(FOREMAN.cheapTier.options.find((o) => o.id === FOREMAN.cheapTier.value).label)}.</p>
  </fieldset>`;
}

/* ---------------------------------------------------------------- behaviour ---- */

/**
 * Tabs. Real ones: arrow keys move, Home/End jump, and the panels are wired through
 * aria-controls so the mockup is honest about what it would cost to build.
 */
function wireTabs(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return;
  const show = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.classList.toggle("is-on", on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = root.querySelector("#" + t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => show(t));
    t.addEventListener("keydown", (e) => {
      const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(e.key in map)) return;
      e.preventDefault();
      const next = tabs[(map[e.key] + tabs.length) % tabs.length];
      show(next);
      next.focus();
    });
  });
  show(tabs.find((t) => t.classList.contains("is-on")) ?? tabs[0]);
}

/**
 * The digest accordion. One open at a time, which is the real constraint: the editors are
 * tall, and two open in a column pushes the row you opened first off the top.
 */
function wireAccordion(root) {
  const rows = [...root.querySelectorAll("[data-expands]")];
  for (const row of rows) {
    row.addEventListener("click", () => {
      const panel = root.querySelector("#" + row.dataset.expands);
      const open = row.classList.contains("is-open");
      for (const other of rows) {
        other.classList.remove("is-open");
        other.setAttribute("aria-expanded", "false");
        const p = root.querySelector("#" + other.dataset.expands);
        if (p) p.hidden = true;
      }
      if (!open) {
        row.classList.add("is-open");
        row.setAttribute("aria-expanded", "true");
        if (panel) panel.hidden = false;
      }
    });
  }
}

/** A disclosure: one button, one region, aria-expanded kept truthful. */
function wireToggle(root, btnSel, targetSel, { onOpen, onClose } = {}) {
  const btn = root.querySelector(btnSel);
  const target = root.querySelector(targetSel);
  if (!btn || !target) return;
  const set = (open) => {
    target.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) onOpen?.(target);
    else onClose?.(target);
  };
  btn.addEventListener("click", () => set(target.hidden));
  for (const close of root.querySelectorAll("[data-closes]")) {
    close.addEventListener("click", () => set(false));
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !target.hidden) set(false);
  });
}

/** Count-strip tiles behave like the real filter: click to select, click again to clear. */
function wireStrip(root) {
  const tiles = [...root.querySelectorAll("[data-tally]")];
  for (const tile of tiles) {
    tile.addEventListener("click", () => {
      const on = tile.classList.contains("is-active");
      tiles.forEach((t) => {
        t.classList.remove("is-active");
        t.setAttribute("aria-pressed", "false");
      });
      if (!on) {
        tile.classList.add("is-active");
        tile.setAttribute("aria-pressed", "true");
      }
    });
  }
}

/** Segmented controls that are buttons rather than radios (the posture bar, the presets). */
function wireSegments(root) {
  for (const group of root.querySelectorAll("[data-segment]")) {
    const btns = [...group.querySelectorAll("button")];
    for (const b of btns) {
      b.addEventListener("click", () => {
        btns.forEach((x) => {
          x.classList.remove("is-on");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("is-on");
        b.setAttribute("aria-pressed", "true");
        group.dispatchEvent(new CustomEvent("segment", { detail: b.dataset.value }));
      });
    }
  }
}

window.Mock = {
  esc,
  ledgerHtml,
  stripHtml,
  healthHtml,
  liveReposHtml,
  selectHtml,
  stateHtml,
  tierSegHtml,
  wireTabs,
  wireAccordion,
  wireToggle,
  wireStrip,
  wireSegments,
  /** Mount every ledger placeholder and wire the behaviours a page happens to use. */
  boot(root = document) {
    for (const slot of root.querySelectorAll("[data-ledger]")) {
      const opts = slot.dataset.ledger ? JSON.parse(slot.dataset.ledger) : {};
      slot.innerHTML = ledgerHtml(opts);
    }
    for (const slot of root.querySelectorAll("[data-health]")) slot.innerHTML = healthHtml();
    for (const slot of root.querySelectorAll("[data-live-repos]")) slot.innerHTML = liveReposHtml();
    wireTabs(root);
    wireAccordion(root);
    wireStrip(root);
    wireSegments(root);
  },
};
})();
