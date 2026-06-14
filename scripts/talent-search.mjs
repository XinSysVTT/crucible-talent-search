const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * A search and browse panel for talents in the Crucible Talent Tree.
 */
export default class CrucibleTalentSearch extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "crucible-talent-search",
    window: { frame: false, positioned: false },
    classes: ["crucible"],
    actions: {
      closeSearch: CrucibleTalentSearch.#onCloseSearch,
      navigateToTalent: CrucibleTalentSearch.#onNavigateToTalent
    }
  };

  static PARTS = {
    search: {
      root: true,
      template: "modules/crucible-talent-search/templates/talent-search.hbs"
    }
  };

  /** @type {(() => void)|null} Module-level handler for closing the search panel only. */
  static #closeHandler = null;

  /** @type {(() => boolean)|null} Module-level handler for Escape / full UI dismiss. */
  static #dismissUiHandler = null;

  /**
   * Register a handler invoked when the user closes the panel (× button).
   * @param {() => void} handler
   */
  static registerCloseHandler(handler) {
    CrucibleTalentSearch.#closeHandler = handler;
  }

  /**
   * Register a handler invoked when the user presses Escape.
   * @param {() => boolean} handler
   */
  static registerDismissUiHandler(handler) {
    CrucibleTalentSearch.#dismissUiHandler = handler;
  }

  /**
   * Request panel close through the module handler when registered.
   */
  static requestClose() {
    CrucibleTalentSearch.#closeHandler?.();
  }

  /**
   * Request full talent UI dismiss (search + controls + tree).
   * @returns {boolean}
   */
  static requestDismissUi() {
    return CrucibleTalentSearch.#dismissUiHandler?.() ?? false;
  }

  /* -------------------------------------------- */
  /*  Private State                                */
  /* -------------------------------------------- */

  #query = "";
  #abilityFilter = "";
  #tierFilter = -1;

  /** Cancellable handle for the debounced search re-render. */
  #debouncedRender = null;

  /** True while close is in progress; blocks further renders from re-opening the panel. */
  #closing = false;

  /** True after destroyPanel(); this instance must never render again. */
  #destroyed = false;

  /** The node whose underglow we turned on, so we can turn it off on leave. */
  #hoveredIcon = null;

  /** The node whose underglow we turned on after a click-navigate. */
  #highlightedIcon = null;

  /** The talent icon (wheel spoke) that was highlighted by the last click-navigate. */
  #highlightedTalentIcon = null;

  /** The floating talent-info tooltip div rendered next to the search panel. */
  #tooltipEl = null;

  /** Saved panel position so it survives re-renders. */
  #dragLeft = null;
  #dragBottom = null;

  /** Incremented each time a navigate is triggered; lets in-flight navigations detect they've been superseded. */
  #navigateSeq = 0;

  /* -------------------------------------------- */
  /*  Accessors                                    */
  /* -------------------------------------------- */

  get tree() {
    return game.system.tree;
  }

  get #TalentNode() {
    return crucible.api.talents.CrucibleTalentNode;
  }

  /* -------------------------------------------- */
  /*  Rendering                                    */
  /* -------------------------------------------- */

  /** @override */
  _canRender(options) {
    if ( this.#closing || this.#destroyed ) return false;
  }

  /* -------------------------------------------- */

  /** @override */
  async render(options = {}, _options = {}) {
    if ( this.#closing || this.#destroyed ) return this;
    return super.render(options, _options);
  }

  /* -------------------------------------------- */

  /**
   * Immediately remove the panel from the DOM and unregister the ApplicationV2
   * instance. Does not use ApplicationV2.close() so we are not blocked behind
   * any in-flight render() on the shared semaphore.
   */
  destroyPanel() {
    if ( this.#destroyed ) return;
    this.#destroyed = true;
    this.#closing = true;
    this.#abortPendingRenders();
    this.#clearClickHighlight();
    this.#hideTooltip();
    this.#removeDomNodes();
    foundry.applications.instances.delete("crucible-talent-search");
  }

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const { actor } = this.tree;
    const query = this.#query.toLowerCase().trim();
    const allTalents = this.#gatherTalents(actor);

    const abilities = Object.entries(SYSTEM.ABILITIES).map(([id, cfg]) => ({
      id,
      label: cfg.label,
      selected: this.#abilityFilter === id
    }));

    const tierOptions = [-1, 0, 1, 2, 3, 4].map(value => ({
      value,
      label: value < 0 ? game.i18n.localize("TALENT_SEARCH.AllTiers") : game.i18n.format("TALENT_SEARCH.TierN", { n: value }),
      selected: this.#tierFilter === value
    }));

    const filtered = allTalents.filter(t => {
      if ( query ) {
        const match = t.name.toLowerCase().includes(query)
          || t.nodeType.toLowerCase().includes(query)
          || (t.action && t.action.toLowerCase().includes(query))
          || `tier ${t.tier}`.includes(query);
        if ( !match ) return false;
      }
      if ( this.#abilityFilter && !t.abilities.includes(this.#abilityFilter) ) return false;
      if ( this.#tierFilter >= 0 && t.tier !== this.#tierFilter ) return false;
      return true;
    });

    filtered.sort((a, b) => {
      if ( a.owned !== b.owned ) return a.owned ? -1 : 1;
      if ( a.accessible !== b.accessible ) return a.accessible ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      query: this.#query,
      abilities,
      tierOptions,
      talents: filtered,
      totalCount: allTalents.length,
      filteredCount: filtered.length,
      allShown: filtered.length === allTalents.length
    };
  }

  /* -------------------------------------------- */

  #gatherTalents(actor) {
    const results = [];
    const seen = new Set();
    const { tree } = this;

    // Build ability id ↔ label lookup once, outside the loops.
    // node.abilities can be keyed by short id ("wis") or full label ("Wisdom");
    // we normalise everything to the short ids that SYSTEM.ABILITIES uses so
    // the ability filter dropdown always matches.
    const systemAbilityIds = new Set(Object.keys(SYSTEM.ABILITIES ?? {}));
    const abilityLabelToId = {};
    for ( const [id, cfg] of Object.entries(SYSTEM.ABILITIES ?? {}) ) {
      abilityLabelToId[(cfg.label ?? id).toLowerCase()] = id;
      abilityLabelToId[id.toLowerCase()] = id;
      if ( cfg.nodeId ) abilityLabelToId[cfg.nodeId.toLowerCase()] = id;
    }

    for ( const node of this.#TalentNode.nodes.values() ) {
      if ( node.tier < 0 ) continue;
      const state = tree.state.get(node);

      for ( const talent of node.talents ) {
        if ( seen.has(talent.id) ) continue;
        seen.add(talent.id);

        const owned = actor.talentIds.has(talent.id);
        const accessible = !!(state?.accessible || state?.purchased);
        const banned = !!state?.banned;

        // Normalise node.abilities to the ids used by SYSTEM.ABILITIES.
        // Crucible stores abilities as a Set; Object.keys(Set) is always [].
		
		const NODE_TYPE_LABEL_KEYS = {
  origin: "TALENT_SEARCH.NODE_TYPES.origin", attack: "TALENT_SEARCH.NODE_TYPES.attack",
  melee: "TALENT_SEARCH.NODE_TYPES.melee", ranged: "TALENT_SEARCH.NODE_TYPES.ranged",
  magic: "TALENT_SEARCH.NODE_TYPES.magic", defense: "TALENT_SEARCH.NODE_TYPES.defense",
  heal: "TALENT_SEARCH.NODE_TYPES.heal", spell: "TALENT_SEARCH.NODE_TYPES.spell",
  move: "TALENT_SEARCH.NODE_TYPES.move", utility: "TALENT_SEARCH.NODE_TYPES.utility",
  skill: "TALENT_SEARCH.NODE_TYPES.skill", signature: "TALENT_SEARCH.NODE_TYPES.signature",
  training: "TALENT_SEARCH.NODE_TYPES.training"
};
        const rawAbilities = this.#collectAbilityKeys(node.abilities);
        const abilities = rawAbilities.map(k => {
          const lk = k.toLowerCase();
          return abilityLabelToId[lk] ?? (systemAbilityIds.has(lk) ? lk : k);
        });

        results.push({
          id: talent.id,
          uuid: talent.uuid,
          name: talent.name,
          img: talent.img || "icons/svg/mystery-man.svg",
          tier: node.tier ?? 0,
          nodeId: node.id,
          nodeType: game.i18n.localize(NODE_TYPE_LABEL_KEYS[node.type] ?? node.type),
          abilities,
          owned,
          accessible,
          banned,
          action: talent.system?.activation?.type ?? talent.system?.action ?? "",
          cssClass: owned ? "owned" : accessible ? "accessible" : banned ? "banned" : ""
        });
      }
    }

    return results;
  }

  /* -------------------------------------------- */

  /**
   * Extract ability keys from the various shapes Crucible may use on a node.
   * @param {Iterable<string>|Record<string, unknown>|null|undefined} abilities
   * @returns {string[]}
   */
  #collectAbilityKeys(abilities) {
    if ( !abilities ) return [];
    if ( Array.isArray(abilities) ) return abilities;
    if ( abilities instanceof Set ) return [...abilities];
    if ( typeof abilities[Symbol.iterator] === "function" ) return [...abilities];
    return Object.keys(abilities);
  }

  /* -------------------------------------------- */

  _insertElement(element) {
    if ( this.#closing || this.#destroyed ) return;
    const existing = document.getElementById(element.id);
    if ( existing ) {
      existing.replaceWith(element);
      return;
    }
    const controls = document.getElementById("crucible-talent-controls");
    if ( controls ) controls.insertAdjacentElement("beforebegin", element);
    else document.body.appendChild(element);
  }

  /* -------------------------------------------- */

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;

    // Restore saved drag position after re-render
    if ( this.#dragLeft !== null ) el.style.left   = this.#dragLeft;
    if ( this.#dragBottom !== null ) el.style.bottom = this.#dragBottom;

    // After every render the DOM is replaced, so any stored reference to a
    // ".navigated" entry element is now stale. If the highlighted node is no
    // longer represented by a live DOM element we clear the CSS-only part of
    // the highlight state so the next click doesn't need to fight a ghost entry.
    if ( this.#highlightedIcon ) {
      const nodeId = this.#highlightedIcon.node?.id;
      const liveEntry = nodeId ? el.querySelector(`[data-node-id="${nodeId}"]`) : null;
      if ( liveEntry ) {
        // Re-apply the "navigated" class that was lost when the DOM was rebuilt.
        liveEntry.classList.add("navigated");
      }
      // If the node isn't in the current results at all the CSS class is simply absent —
      // the canvas highlight remains until the user clicks elsewhere, which is fine.
    }

    if ( this.#hoveredIcon ) {
      this.#glowOff(this.#hoveredIcon.node?.id);
    }
    this.#hideTooltip();

    // Live text search.
    // Capture the value synchronously then debounce only the render call.
    // If the entire callback is debounced, event.target is gone (re-rendered)
    // by the time the callback fires, so only the first character is ever stored.
    const input = el.querySelector(".talent-search-input");
    if ( input ) {
      this.#debouncedRender ??= foundry.utils.debounce(() => {
        if ( !this.#closing && !this.#destroyed && this.rendered ) this.render();
      }, 180);
      input.addEventListener("input", event => {
        this.#query = event.target.value;
        this.#debouncedRender();
      });
      // Always restore focus after every render so typing isn't interrupted
      // when the DOM is fully replaced on re-render (not just on initial open).
      setTimeout(() => {
        if ( this.#closing || this.#destroyed ) return;
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }, 0);
    }

    // Ability score filter
    el.querySelector(".talent-filter-ability")?.addEventListener("change", event => {
      this.#abilityFilter = event.target.value;
      this.render();
    });

    // Tier filter
    el.querySelector(".talent-filter-tier")?.addEventListener("change", event => {
      this.#tierFilter = Number.parseInt(event.target.value, 10);
      this.render();
    });

    // Direct close handler — do not rely on ApplicationV2 data-action alone.
    const closeBtn = el.querySelector(".close-btn");
    if ( closeBtn ) {
      closeBtn.addEventListener("click", event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        CrucibleTalentSearch.requestClose();
      }, { capture: true });
    }

    // Hover: glow canvas node + show our own tooltip next to the search panel
    for ( const entry of el.querySelectorAll(".talent-search-entry[data-node-id]") ) {
      entry.addEventListener("pointerenter", this.#onEntryHover.bind(this));
      entry.addEventListener("pointerleave", this.#onEntryLeave.bind(this));
    }

    el.querySelector(".search-results")?.addEventListener("scroll", () => {
      this.#hideTooltip();
      if ( this.#hoveredIcon ) {
        this.#glowOff(this.#hoveredIcon.node?.id);
    }}, { passive: true });

    // Make the panel draggable by its header
    const header = el.querySelector(".search-header");
    if ( header ) {
      header.style.cursor = "grab";
      header.addEventListener("pointerdown", (e) => {
        if ( e.target.closest(".close-btn") ) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = el.getBoundingClientRect();
        const startLeft   = rect.left;
        const startBottom = window.innerHeight - rect.bottom;
        header.style.cursor = "grabbing";
        const onMove = (e) => {
          const left   = Math.max(0, startLeft   + (e.clientX - startX));
          const bottom = Math.max(0, startBottom - (e.clientY - startY));
          this.#dragLeft   = `${left}px`;
          this.#dragBottom = `${bottom}px`;
          el.style.left   = this.#dragLeft;
          el.style.bottom = this.#dragBottom;
        };
        const onUp = () => {
          header.style.cursor = "grab";
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    }
  }

  /* -------------------------------------------- */
  /*  Custom tooltip                               */
  /* -------------------------------------------- */

  /**
   * Show a talent info tooltip to the RIGHT of the .search-panel element,
   * vertically aligned to the hovered list entry.
   * We build the tooltip ourselves from the item document so it always
   * appears next to our panel, never at the canvas sprite position.
   * @param {HTMLElement} entryEl  The hovered .talent-search-entry <li>
   * @param {string}      uuid
   */
  async #showTooltip(entryEl, uuid) {
    this.#hideTooltip();

    // Resolve the item document from its UUID
    let item;
    try { item = await fromUuid(uuid); } catch(e) { return; }
    if ( !item ) return;

    // Build tooltip HTML — reuse Foundry's enrichHTML for the description
    const description = item.system?.description?.value ?? item.system?.description ?? "";
    const enriched = description
      ? await TextEditor.enrichHTML(description, { async: true, secrets: false })
      : "";

    const tip = document.createElement("div");
    tip.id = "crucible-talent-search-tooltip";
    tip.classList.add("crucible", "crucible-talent-search-tooltip");
    tip.innerHTML = `
      <div class="tooltip-header">
        <img src="${item.img || "icons/svg/mystery-man.svg"}" alt="${item.name}" />
        <h3>${item.name}</h3>
      </div>
      ${enriched ? `<div class="tooltip-body">${enriched}</div>` : ""}
    `;

    document.body.appendChild(tip);
    this.#tooltipEl = tip;

    // Position: to the right of .search-panel, vertically centred on the entry
    const panelRect = this.element.querySelector(".search-panel").getBoundingClientRect();
    const entryRect = entryEl.getBoundingClientRect();

    // Temporarily make visible (off-screen) to measure height
    tip.style.visibility = "hidden";
    tip.style.left = "0px";
    tip.style.top = "0px";

    // Use rAF so the browser has painted and we can measure
    requestAnimationFrame(() => {
      const tipH = tip.offsetHeight;
      const tipW = tip.offsetWidth;

      const left = panelRect.right + 8;  // 8px gap to the right of the panel
      // Centre on the hovered entry, clamped to viewport
      let top = entryRect.top + (entryRect.height / 2) - (tipH / 2);
      top = Math.max(8, Math.min(top, window.innerHeight - tipH - 8));

      // If tooltip would overflow the right edge, flip to left of panel
      const finalLeft = (left + tipW + 8 > window.innerWidth)
        ? panelRect.left - tipW - 8
        : left;

      tip.style.left = `${finalLeft}px`;
      tip.style.top  = `${top}px`;
      tip.style.visibility = "visible";
    });
  }

  /* -------------------------------------------- */

  /** Remove the custom tooltip if it exists. */
  #hideTooltip() {
    this.#tooltipEl?.remove();
    this.#tooltipEl = null;
  }

  /* -------------------------------------------- */
  /*  Canvas node glow helpers                     */
  /* -------------------------------------------- */

  /**
   * Get the live PIXI TalentTreeNode icon for a data node id, if the tree
   * is currently rendered.
   * @param {string} nodeId
   * @returns {CrucibleTalentTreeNode|null}
   */
  #getIcon(nodeId) {
    const node = this.#TalentNode.nodes.get(nodeId);
    return node?.icon ?? null;
  }

  /* -------------------------------------------- */

  /**
   * Light up the underglow on a PIXI node icon.
   * Does NOT activate the canvas HUD — that would render a panel at the
   * canvas-space position of the node, not next to our search panel.
   * @param {string} nodeId
   */
  #glowOn(nodeId) {
    const icon = this.#getIcon(nodeId);
    if ( !icon ) return;
    this.#hoveredIcon = icon;

    // Scale up slightly — same as _onPointerOver
    const s = (icon.config.size + 8) / icon.config.size;
    icon.scale.set(s, s);

    // Show underglow using the node's own colour
    if ( icon.node.id !== "origin" ) {
      icon.underglow.tint    = icon.node.color;
      icon.underglow.visible = true;
    }
    // NOTE: intentionally NOT calling this.tree.hud.activate(icon) here —
    // the HUD renders at the canvas node position, which is the wrong place.
  }

  /* -------------------------------------------- */

  /**
   * Restore a previously-glowed icon to its resting state, unless it's the
   * currently click-highlighted node.
   * @param {string} nodeId
   */
  #glowOff(nodeId) {
    const icon = this.#hoveredIcon;
    if ( !icon ) return;
    this.#hoveredIcon = null;

    // Don't remove glow if this is the click-highlighted node
    if ( icon === this.#highlightedIcon ) return;

    icon.scale.set(1.0, 1.0);
    icon.underglow.visible = !!icon.config.underglowColor;
  }

  /* -------------------------------------------- */

  /**
   * Apply a persistent click-highlight to a specific talent icon in the wheel,
   * plus a subtle underglow on the containing node. Clears any previous highlight.
   * @param {string} nodeId
   * @param {CrucibleTalentTreeTalent|null} [talentIcon=null]
   */
  #setClickHighlight(nodeId, talentIcon = null) {
    this.#clearClickHighlight();

    const icon = this.#getIcon(nodeId);
    if ( !icon || icon.node.id === "origin" ) return;
    this.#highlightedIcon = icon;

    // Subtle node underglow – enough to find it on the canvas, not overwhelming
    if ( icon.underglow ) {
      icon.underglow.tint    = icon.node.color ?? 0xffffff;
      icon.underglow.visible = true;
      icon.underglow.alpha   = 0.85;
    }

    // Primary highlight: the individual talent spoke in the choice wheel
    if ( talentIcon ) {
      this.#highlightedTalentIcon = talentIcon;
      talentIcon.scale.set(1.2, 1.2);

      const color = icon.node.color ?? 0xffffff;
      if ( talentIcon.underglow ) {
        talentIcon.underglow.tint    = color;
        talentIcon.underglow.visible = true;
        talentIcon.underglow.alpha   = 1.0;
      }
      // Boost frame brightness so the talent pops against surrounding icons
      if ( talentIcon.frame ) talentIcon.frame.tint = 0xffffff;
    }

    // Pulsing CSS class on the matching search-panel entry
    const el = this.element?.querySelector(`[data-node-id="${nodeId}"]`);
    el?.classList.add("navigated");
  }

  /* -------------------------------------------- */

  /**
   * Remove the click highlight from the previously highlighted node and talent icon.
   */
  #clearClickHighlight() {
    // Restore the talent icon in the wheel
    const talentIcon = this.#highlightedTalentIcon;
    if ( talentIcon ) {
      this.#highlightedTalentIcon = null;
      talentIcon.scale.set(1.0, 1.0);
      if ( talentIcon.underglow ) {
        talentIcon.underglow.alpha   = talentIcon.config?.underglowAlpha ?? 0.75;
        talentIcon.underglow.visible = !!talentIcon.config?.underglowColor;
      }
      if ( talentIcon.frame && talentIcon.config?.frameTint !== undefined ) {
        talentIcon.frame.tint = talentIcon.config.frameTint;
      }
    }

    // Restore the node underglow
    const icon = this.#highlightedIcon;
    if ( !icon ) return;
    this.#highlightedIcon = null;

    if ( icon !== this.#hoveredIcon && icon.underglow ) {
      icon.underglow.alpha   = icon.config?.underglowAlpha ?? 0.5;
      icon.underglow.visible = !!icon.config?.underglowColor;
    }

    this.element?.querySelector(".talent-search-entry.navigated")
      ?.classList.remove("navigated");
  }

  /* -------------------------------------------- */
  /*  Event handlers                               */
  /* -------------------------------------------- */

  #onEntryHover(event) {
    const el = event.currentTarget;
    const { nodeId, uuid } = el.dataset;

    // Glow the canvas node (underglow + scale only, no HUD popup on canvas)
    if ( nodeId ) this.#glowOn(nodeId);

    // Show our own tooltip to the right of the search panel
    if ( uuid ) this.#showTooltip(el, uuid);
  }

  /* -------------------------------------------- */

  #onEntryLeave(event) {
    const { nodeId } = event.currentTarget.dataset;
    if ( nodeId ) this.#glowOff(nodeId);
    this.#hideTooltip();
  }

  /* -------------------------------------------- */

  /** Cancel any debounced search re-render that could run after close starts. */
  #abortPendingRenders() {
    if ( this.#debouncedRender ) {
      this.#debouncedRender.cancel?.();
      this.#debouncedRender = null;
    }
  }

  /* -------------------------------------------- */

  /** Remove every DOM node this panel may have created. */
  #removeDomNodes() {
    this.element?.remove();
    document.getElementById("crucible-talent-search")?.remove();
    document.querySelectorAll("#crucible-talent-search-tooltip, .crucible-talent-search-tooltip")
      .forEach(node => node.remove());
  }

  /* -------------------------------------------- */

  /**
   * Close button handler (data-action fallback).
   * @this {CrucibleTalentSearch}
   */
  static #onCloseSearch() {
    CrucibleTalentSearch.requestClose();
  }

  /* -------------------------------------------- */

  /**
   * Pan to the talent's node and highlight it.
   * @this {CrucibleTalentSearch}
   * @param {PointerEvent} event
   * @param {HTMLElement}  target
   */
  static async #onNavigateToTalent(event, target) {
    event.stopPropagation();

    const entry    = target.closest("[data-node-id]");
    const nodeId   = entry?.dataset.nodeId;
    const talentId = entry?.dataset.talentId;
    if ( !nodeId ) return;

    const node = this.#TalentNode.nodes.get(nodeId);
    if ( !node ) return;

    const tree = this.tree;

    // Increment sequence — any previous in-flight navigation will see its
    // captured seq no longer matches and bail out early, preventing races
    // when the user clicks a second talent before the first finishes awaiting.
    const seq = ++this.#navigateSeq;
    const stale = () => seq !== this.#navigateSeq;

    // Clear any previous click-highlight immediately so stale talent icons
    // from the previous node don't persist into the new navigation.
    this.#clearClickHighlight();

    // 1. Pan the canvas to the node
    tree.pan({ x: node.point.x, y: node.point.y, scale: 0.6 });

    const nodeIcon = node.icon;
    if ( !nodeIcon ) return;

    // 2. Let the pan animation settle before touching the tree state.
    await new Promise(r => setTimeout(r, 200));
    if ( stale() ) return;

    // Always do a full deactivate → activate cycle so the wheel is torn down
    // and rebuilt cleanly, even if tree.active appears falsy (e.g. same node
    // re-clicked, or Crucible clears active mid-pan).
    try {
      tree.deactivateNode({ click: false, nativeEvent: { type: "pointerout" } });
    } catch(e) {
      // Fallback: directly deactivate the wheel if deactivateNode threw
      try { tree.wheel?.deactivate(); } catch(_) {}
    }

    // wheel.activate() is async and NOT awaited by tree.activateNode(). When a
    // talent has been learned, #drawTalents() does multiple `await loadTexture()`
    // calls. If deactivate() fires during one of those yields, the loop resumes
    // afterward and keeps calling talents.addChild() on the now-cleared container —
    // leaving ghost icons on top of the next node's wheel.
    //
    // We poll until wheel.node is null AND wheel.talents.children is empty,
    // which confirms the previous async draw has fully unwound before we activate.
    const drainDeadline = Date.now() + 1000;
    while ( Date.now() < drainDeadline ) {
      if ( stale() ) return;
      const w = tree.wheel;
      if ( !w || (w.node === null && (w.talents?.children?.length ?? 0) === 0) ) break;
      await new Promise(r => setTimeout(r, 25));
    }
    if ( stale() ) return;

    // Activate the target node (also handles re-opening the same node if it
    // was the already-active one and the user clicks it again).
    tree.activateNode(nodeIcon);

    // 3. Compute the expected number of talent icons the wheel will contain.
    //    The wheel's #getNodeTalents() includes:
    //      a) node.talents (compendium items configured for the node), plus
    //      b) any extra owned talents in actor.system.talentNodes[nodeId] whose
    //         actor-item IDs don't correspond to a talent already in the base set.
    //
    //    IMPORTANT: node.talents uses compendium item IDs, while talentNodes stores
    //    actor-owned item IDs — these are different ID spaces and cannot be compared
    //    directly with Set.has(). We must resolve each owned ID to an actor item and
    //    then check whether that item's compendium source ID is in the base set.
    //    Failing to do this made expectedCount too large (ownedExtraIds always
    //    non-empty), causing the poll loop to time out and the wrong/stale wheel
    //    icons to remain on screen.
    const baseTalentIds = new Set([...node.talents].map(t => t.id));
    const actor = tree.actor;
    let ownedExtraCount = 0;
    for ( const actorItemId of (actor?.system?.talentNodes?.[nodeId] ?? []) ) {
      const item = actor.items.get(actorItemId);
      if ( !item ) continue;  // item missing from actor — wheel skips it too
      // The item's source ID (flags.core.sourceId or getFlag) matches the compendium ID
      const sourceId = item.getFlag?.("core", "sourceId") ?? item.flags?.core?.sourceId ?? "";
      // Extract just the item ID portion from the UUID (e.g. "Compendium.foo.bar.Item.XXXX" → "XXXX")
      const compendiumId = sourceId.split(".").pop() ?? "";
      if ( !baseTalentIds.has(item.id) && !baseTalentIds.has(compendiumId) ) {
        ownedExtraCount++;
      }
    }
    const expectedCount = baseTalentIds.size + ownedExtraCount;

    // 4. Poll until the wheel belongs to the correct node AND has the full
    //    expected complement of fully-drawn talent icons.
    let talentIcon = null;
    if ( talentId ) {
      const deadline = Date.now() + 2500;
      while ( Date.now() < deadline ) {
        if ( stale() ) return;
        await new Promise(r => setTimeout(r, 25));

        const wheel = tree.wheel;
        if ( !wheel ) continue;

        // wheel.node being wrong means the wheel is still mid-teardown or
        // mid-rebuild for a different node — keep waiting.
        // wheel.node is the CrucibleTalentTreeNode PIXI icon, not the data node.
        if ( wheel.node !== nodeIcon ) continue;

        const children = wheel.talents?.children ?? [];

        // Require the full expected count before we trust the children array.
        // A count below expectedCount means #drawTalents() is still mid-loop.
        if ( children.length < expectedCount ) continue;

        // All icon textures must also be resolved (not EMPTY placeholder).
        const allReady = children.every(t => t.icon?.texture && t.icon.texture !== PIXI.Texture.EMPTY);
        if ( !allReady ) continue;

        // Wheel is complete — locate our specific talent icon.
        talentIcon = children.find(t => t.talent?.id === talentId) ?? null;
        if ( talentIcon ) break;
      }
    }

    if ( stale() ) return;

    // 4. Show the talent HUD only if the tree has fully committed to this node.
    //    Checking tree.active prevents activating the HUD against a stale/previous
    //    node's state (which is what caused old talents to appear when navigating
    //    quickly between nodes).
    if ( talentIcon ) {
      const activeIcon = tree.active?.icon ?? tree.active;
      if ( activeIcon === nodeIcon ) {
        tree.hud.activate(talentIcon);
      }
    }

    // 5. Highlight: talent icon (primary) if found, else just the node (secondary).
    //    Always call so the node glows even when talentIcon is null.
    this.#setClickHighlight(nodeId, talentIcon ?? null);
  }
}
