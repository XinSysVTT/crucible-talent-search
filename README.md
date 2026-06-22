# Crucible Talent Search

A Foundry VTT module for the **Crucible** system that adds a powerful searchable talent browser to the Talent Tree interface.

## Features

- 🔎 Search talents by name
- 🎯 Filter talents by ability score
- 📊 Filter talents by tier
- 🚀 Jump directly to a talent node from search results
- ✅ Visual indicators for owned talents
- 💡 Talent tooltips and highlighting support
- 🌍 Localization support (English and Polish)
- 🎨 Integrated UI that matches the Crucible Talent Tree

<img width="355" height="631" alt="Talent browser" src="https://github.com/user-attachments/assets/487995cc-fa49-404e-958a-7a14f34bbd20" />

### Also addtional feature (clearly marked attributes in talent tree) 
<img width="984" height="806" alt="full talent tree" src="https://github.com/user-attachments/assets/27925681-4781-46a2-8db2-be1283b4e233" />


## Requirements

- Foundry VTT v14.361 or newer
- Crucible System v0.9.4 or newer

## Installation

### Manifest URL

```text
https://github.com/XinSysVTT/crucible-talent-search/releases/latest/download/module.json
```

1. Open Foundry VTT.
2. Navigate to **Add-on Modules**.
3. Click **Install Module**.
4. Paste the manifest URL above.
5. Install and enable the module.

## Usage

1. Open a Crucible Talent Tree.
2. Click the Talent Search button in the talent controls.
3. Enter a search term.
4. Optionally filter by:
   - Ability Score
   - Tier
5. Click the crosshair icon beside a result to navigate directly to that talent.

## Search Interface

The panel includes:

- Search input with live filtering
- Ability filter dropdown
- Tier filter dropdown
- Result counter
- Scrollable talent list
- Quick navigation buttons
- Owned talent indicators

## Supported Languages

- English
- Polish

## Project Structure

```text
crucible-talent-search/
├── crucible-talent-search.mjs
├── module.json
├── lang/
│   ├── en.json
│   └── pl.json
├── scripts/
│   ├── talent-search.mjs
│   └── region-labels.mjs
├── styles/
│   └── talent-search.css
└── templates/
    └── talent-search.hbs
```

## Version

Current version: **1.1.7**

## Author

**XinSysVtt**

## License

Do what you want :) 
