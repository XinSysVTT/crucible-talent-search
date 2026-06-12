import CrucibleTalentSearch from "./scripts/talent-search.mjs";
import { registerRegionLabelSettings, injectRegionLabels } from "./scripts/region-labels.mjs";

/**
 * @module crucible-talent-search
 */

/* -------------------------------------------- */
/*  Module-scoped state                          */
/* -------------------------------------------- */

/** @type {CrucibleTalentSearch|null} */
let searchPanel = null;

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

function getSearchButton(controlsEl) {
  return controlsEl?.querySelector(".talent-search-toggle") ?? null;
}

/**
 * Sync the controls-bar toggle button to the given open/closed state.
 * @param {boolean} open
 */
function syncButtonState(open) {
  const controlsEl = document.getElementById("crucible-talent-controls");
  const btn = getSearchButton(controlsEl);
  if ( !btn ) return;
  btn.classList.toggle("active", open);
  btn.setAttribute("aria-pressed", String(open));
}

/* -------------------------------------------- */

/**
 * Remove any search-panel DOM nodes, including orphans.
 */
function purgeSearchDom() {
  document.getElementById("crucible-talent-search")?.remove();
  document.querySelectorAll("#crucible-talent-search-tooltip, .crucible-talent-search-tooltip")
    .forEach(node => node.remove());
}

/* -------------------------------------------- */

/**
 * Is the search panel currently visible in the DOM?
 * @returns {boolean}
 */
function isSearchOpen() {
  return !!document.getElementById("crucible-talent-search");
}

/* -------------------------------------------- */

/**
 * Is the Crucible talent tree currently active?
 * @returns {boolean}
 */
function isTalentTreeOpen() {
  const tree = game.system?.tree;
  return !!(tree?.actor && tree.canvas && !tree.canvas.hidden);
}

/* -------------------------------------------- */

/**
 * Close the search panel synchronously.
 */
function closePanel() {
  syncButtonState(false);

  const panel = searchPanel;
  searchPanel = null;

  panel?.destroyPanel();
  purgeSearchDom();
  foundry.applications.instances.delete("crucible-talent-search");
}

/* -------------------------------------------- */

/** Guard against Escape firing both the module keybinding and a bubbling keydown. */
let dismissLocked = false;

/**
 * Fully dismiss the talent tree UI (search + controls) with no animation delay.
 * @returns {boolean}
 */
function dismissTalentUi() {
  if ( dismissLocked ) return true;

  const hadSearch = isSearchOpen();
  const hadTree = isTalentTreeOpen();
  if ( !hadSearch && !hadTree ) return false;

  dismissLocked = true;
  closePanel();
  hideControlsDom();

  const done = () => { dismissLocked = false; };
  if ( hadTree ) void game.system.tree.close().finally(done);
  else done();

  return true;
}

/* -------------------------------------------- */

/**
 * Hide the talent-tree controls bar immediately.
 * @param {HTMLElement} controlsRoot
 */
function hideControlsDom(controlsRoot) {
  const el = controlsRoot ?? document.getElementById("crucible-talent-controls");
  if ( !el ) return;
  el.style.setProperty("display", "none");
  el.classList.add("is-hidden");
}

/* -------------------------------------------- */

/**
 * Toggle the search panel open or closed.
 * @param {HTMLButtonElement} btn
 */
async function toggleSearch(btn) {
  if ( isSearchOpen() ) {
    closePanel();
    return;
  }

  closePanel();

  searchPanel = new CrucibleTalentSearch();
  await searchPanel.render({ force: true });
  syncButtonState(true);
}

/* -------------------------------------------- */

/**
 * Wire instant-hide handlers onto the talent-tree controls bar.
 * @param {HTMLElement} html
 */
function wireControlsCloseHooks(html) {
  const closeTreeBtn = html.querySelector('[data-action="closeTree"]');
  if ( closeTreeBtn && !closeTreeBtn.dataset.talentSearchCloseHook ) {
    closeTreeBtn.dataset.talentSearchCloseHook = "true";
    closeTreeBtn.addEventListener("click", () => {
      closePanel();
      hideControlsDom(html);
    }, { capture: true });
  }
}

/* -------------------------------------------- */
/*  Hook: inject Search button on controls render */
/* -------------------------------------------- */

function onRenderTalentControls(app, html) {
  // Inject region labels when the talent tree controls bar renders (normal play).
  if ( app.id === "crucible-talent-controls" ) {
    injectRegionLabels(game.system?.tree);
    wireControlsCloseHooks(html);

    if ( getSearchButton(html) ) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("talent-search-toggle", "frame-brown");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", game.i18n.localize("TALENT_SEARCH.ButtonLabel"));
    btn.innerHTML = `<i class="fa-solid fa-magnifying-glass" inert></i>`
      + `<label>${game.i18n.localize("TALENT_SEARCH.ButtonLabel")}</label>`;

    btn.addEventListener("click", () => toggleSearch(btn));

    if ( isSearchOpen() ) {
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
    }

    const controlsDiv = html.querySelector(".controls");
    if ( controlsDiv ) controlsDiv.prepend(btn);
    else html.append(btn);
    return;
  }

  // Inject region labels + search button when the hero creation sheet is on the talents step.
  if ( app.id === "crucible-hero-creation" ) {
    // The header re-renders on every tab change, so we must re-inject each time.
    // Only show the button when the talents step is active.
    if ( app.element.dataset.step !== "talents" ) return;

    // Inject region labels — deferred one frame so activateTalentTree() has
    // finished embedding the PIXI canvas before we add children to tree.background.
    requestAnimationFrame(() => injectRegionLabels(game.system?.tree));

    // Add a search button into .fullscreen-buttons alongside Restart / Close,
    // matching the existing plain button style. Guard against double-injection.
    const buttonsBar = app.element.querySelector(".fullscreen-buttons");
    if ( !buttonsBar || buttonsBar.querySelector(".talent-search-toggle") ) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("talent-search-toggle", "fullscreen-button", "plain");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", game.i18n.localize("TALENT_SEARCH.ButtonLabel"));
    btn.innerHTML = `<i class="fa-solid fa-magnifying-glass" inert></i>`
      + game.i18n.localize("TALENT_SEARCH.ButtonLabel");

    btn.addEventListener("click", () => toggleSearch(btn));

    if ( isSearchOpen() ) {
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
    }

    // Insert before the first existing button so it sits at the top of the column.
    buttonsBar.prepend(btn);
    return;
  }
}

/* -------------------------------------------- */
/*  Hook: close panel BEFORE the tree closes     */
/* -------------------------------------------- */

/**
 * @param {ApplicationV2} app
 */
function onPreCloseTalentControls(app) {
  if ( app.id !== "crucible-talent-controls" ) return;
  closePanel();
  hideControlsDom(app.element);
}

/* -------------------------------------------- */
/*  Hook: sync button if panel closed internally */
/* -------------------------------------------- */

/**
 * @param {ApplicationV2} app
 */
function onCloseSearchPanel(app) {
  if ( app.id !== "crucible-talent-search" ) return;
  closePanel();
}

/* -------------------------------------------- */
/*  Hook registration                            */
/* -------------------------------------------- */

CrucibleTalentSearch.registerCloseHandler(closePanel);
CrucibleTalentSearch.registerDismissUiHandler(dismissTalentUi);

/**
 * Intercept Escape before Foundry's core dismiss handler, which otherwise
 * leaves the bottom controls HUD visible while it slowly closes other apps.
 */
function registerEscapeKeybinding() {
  game.keybindings.register("crucible-talent-search", "dismissTalentUi", {
    name: "Dismiss Crucible talent UI",
    uneditable: [{ key: "Escape" }],
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
    onDown: () => dismissTalentUi()
  });
}

Hooks.once("init", () => {
  registerRegionLabelSettings();
  registerEscapeKeybinding();
});
Hooks.on("renderApplicationV2",    onRenderTalentControls);
Hooks.on("preCloseApplicationV2",  onPreCloseTalentControls);
Hooks.on("closeApplicationV2",     onCloseSearchPanel);
