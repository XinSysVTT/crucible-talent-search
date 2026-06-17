/**
 * @file region-labels.mjs
 * Draws semi-transparent region labels inside the Crucible Talent Tree PIXI canvas —
 * one per ability sextant — so players can orient themselves at a glance.
 *
 * Implementation notes
 * --------------------
 * The tree background's child order after draw() completes:
 *   0  backdrop       (tiling slate texture)
 *   1  coreGradient
 *   2  overlay        ← sextant colour polygons
 *   3  originTattoo
 *   4–9  spokes (×6)
 *   10 coreMolten
 *   11 core
 *   12 edges          (Graphics)
 *   13 connections    (Graphics)
 *   14–19 ability score texts (×6, added via #drawAbilityScores)
 *   20 nodes container
 *   21 darken overlay
 *
 * We insert our label container at index 3 (after the sextant overlay but
 * before every decoration and node) so labels are "underneath" everything.
 */

/**
 * Ability order must match CrucibleTalentTree.#SEXTANT_ABILITIES.
 * Each sextant's visual centre angle = 60 * i + 30  (degrees).
 */
const SEXTANT_ABILITIES = ["dexterity", "toughness", "strength", "wisdom", "presence", "intellect"];

/** Sentinel to prevent double-injection on the singleton tree. */
const INJECTED = Symbol("crucibleRegionLabels");

/**
 * Radial distance (PIXI world units) for each name label's anchor point.
 * Tier nodes sit at radii 400–1260; 900 falls midway between tier 2 and tier 3.
 */
const LABEL_RADIUS = 900;

/** Live reference to the injected PIXI container, for setting onChange callbacks. */
let _container = null;

/* -------------------------------------------- */
/*  Settings registration                        */
/* -------------------------------------------- */

/**
 * Register module settings for region labels.
 * Must be called from the `init` hook (before keybindings lock).
 */
export function registerRegionLabelSettings() {

  game.settings.register("crucible-talent-search", "showRegionLabels", {
    name: "TALENT_SEARCH.SETTINGS.showRegionLabels.name",
    hint: "TALENT_SEARCH.SETTINGS.showRegionLabels.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: visible => {
      if ( _container?.parent ) _container.visible = visible;
    }
  });

  game.settings.register("crucible-talent-search", "regionLabelsOpacity", {
    name: "TALENT_SEARCH.SETTINGS.regionLabelsOpacity.name",
    hint: "TALENT_SEARCH.SETTINGS.regionLabelsOpacity.hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 2, max: 25, step: 1 },
    default: 8,
    onChange: pct => {
      if ( !_container?.parent ) return;
      const base = pct / 100;
      for ( const child of _container.children ) {
        // Each text stores its base alpha ratio so we can preserve
        // the relative difference between the name and subtitle.
        child.alpha = (child._baseAlpha ?? 1.0) * base;
      }
    }
  });

  game.settings.register("crucible-talent-search", "regionLabelsSize", {
    name: "TALENT_SEARCH.SETTINGS.regionLabelsSize.name",
    hint: "TALENT_SEARCH.SETTINGS.regionLabelsSize.hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 1, max: 200, step: 10 },
    default: 100,
    onChange: pct => {
      if ( !_container?.parent ) return;
      const scale = pct / 100;
      for ( const child of _container.children ) {
        // Each text stores its base font size so we can scale it cleanly.
        if ( child.style ) child.style.fontSize = Math.round((child._baseFontSize ?? 160) * scale);
      }
    }
  });

  game.settings.register("crucible-talent-search", "regionLabelsRadius", {
    name: "TALENT_SEARCH.SETTINGS.regionLabelsRadius.name",
    hint: "TALENT_SEARCH.SETTINGS.regionLabelsRadius.hint ",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1500, step: 10 },
    default: 900,
    onChange: radius => {
      if ( !_container?.parent ) return;
      for ( const child of _container.children ) {
        const a = child._angleRad ?? 0;
        if ( child._isSubtitle ) {
          child.position.set(
            Math.cos(a) * (radius + 140),
            Math.sin(a) * (radius + 140)
          );
        } else {
          child.position.set(Math.cos(a) * radius, Math.sin(a) * radius);
        }
      }
    }
  });
}

/* -------------------------------------------- */
/*  Internal helpers                             */
/* -------------------------------------------- */

/**
 * Convert a Foundry Color object to a CSS hex string for PIXI.TextStyle.fill.
 * @param {Color} color
 * @returns {string}
 */
function colorToCss(color) {
  if ( typeof color?.css === "string" ) return color.css;
  return `#${Number(color).toString(16).padStart(6, "0")}`;
}

/* -------------------------------------------- */

/**
 * Build the PIXI container that holds all six region labels.
 * @param {number} baseOpacity  0-to-1 opacity to apply to name labels.
 * @param {number} radius       Radial distance from centre for name labels.
 * @returns {PIXI.Container}
 */
function buildLabelContainer(baseOpacity, radius) {
  // Use PreciseText when available for sharper sub-pixel rendering.
  const PreciseText = foundry.canvas?.containers?.PreciseText ?? PIXI.Text;
  const container   = new PIXI.Container();
  container.name    = "crucible-region-labels";

  for ( const [i, abilityId] of SEXTANT_ABILITIES.entries() ) {
    const ability  = SYSTEM.ABILITIES[abilityId];
    const fill     = colorToCss(ability.color);
    const angleRad = Math.toRadians(60 * i + 30);
    const cx       = Math.cos(angleRad) * radius;
    const cy       = Math.sin(angleRad) * radius;

    /* ---- Main ability name (large watermark) ---- */
    const nameStyle = new PIXI.TextStyle({
      fontFamily   : "AwerySmallcaps, serif",
      fontSize     : 160,
      fill,
      align        : "center",
      letterSpacing: 14,
    });
    const nameLabel = game.i18n.localize(ability.label).toUpperCase();
    const nameText  = new PreciseText(nameLabel, nameStyle);
    nameText.anchor.set(0.5, 0.5);
    nameText.position.set(cx, cy);
    nameText._baseAlpha    = 1.0;
    nameText._baseFontSize = 160;
    nameText._angleRad     = angleRad;
    nameText._isSubtitle   = false;
    nameText.alpha         = baseOpacity;
    container.addChild(nameText);

    /* ---- Subtitle (smaller, offset outward along the sextant axis) ---- */
    const descKey = `TALENT_SEARCH.REGION.${abilityId}`;
    const descStr = game.i18n.localize(descKey);
    if ( descStr !== descKey ) {
      const subStyle = new PIXI.TextStyle({
        fontFamily   : "AwerySmallcaps, serif",
        fontSize     : 72,
        fill,
        align        : "center",
        letterSpacing: 8,
      });
      const subText = new PreciseText(descStr, subStyle);
      subText.anchor.set(0.5, 0.5);
      subText._baseAlpha    = 0.7;
      subText._baseFontSize = 72;
      subText._angleRad     = angleRad;
      subText._isSubtitle   = true;
      // Place the subtitle further from centre along the radial direction
      // so it floats just below the name regardless of which sextant it's in.
      subText.position.set(
        cx + Math.cos(angleRad) * 140,
        cy + Math.sin(angleRad) * 140
      );
      subText.alpha = baseOpacity * 0.7;
      container.addChild(subText);
    }
  }

  return container;
}

/* -------------------------------------------- */
/*  Public API                                   */
/* -------------------------------------------- */

/**
 * Inject region labels into the talent tree.  Idempotent — safe to call on
 * every controls render because the tree is lazily drawn only once.
 *
 * @param {CrucibleTalentTree} tree   Pass game.system.tree
 */
export function injectRegionLabels(tree) {
  if ( !tree?.background ) return;

  // Tree already has labels: just sync their visibility to the current setting.
  if ( tree[INJECTED] ) {
    if ( _container?.parent ) {
      _container.visible = game.settings.get("crucible-talent-search", "showRegionLabels");
    }
    return;
  }

  // Feature is disabled: do nothing (we don't set INJECTED so we'll retry if
  // the user enables the setting and reopens the tree).
  if ( !game.settings.get("crucible-talent-search", "showRegionLabels") ) return;

  tree[INJECTED] = true;
  const pct      = game.settings.get("crucible-talent-search", "regionLabelsOpacity");
  const sizePct  = game.settings.get("crucible-talent-search", "regionLabelsSize");
  const radius   = game.settings.get("crucible-talent-search", "regionLabelsRadius");
  _container     = buildLabelContainer(pct / 100, radius);

  // Apply saved font size if it differs from the default.
  if ( sizePct !== 100 ) {
    const scale = sizePct / 100;
    for ( const child of _container.children ) {
      if ( child.style ) child.style.fontSize = Math.round((child._baseFontSize ?? 160) * scale);
    }
  }

  // Index 3 = after overlay (sextant polygons, index 2) and before originTattoo (3).
  // This places our labels behind all decorative sprites, edges and node icons.
  tree.background.addChildAt(_container, 3);
}
