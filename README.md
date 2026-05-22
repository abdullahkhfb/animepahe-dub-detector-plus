<div align="center">
  <img src="icon/animepahe-dub-detector.svg" width="128" alt="AnimePahe DUB Detector Icon">
  <h1>animepahe DUB Detector</h1>
</div>

Tags dubbed episodes with DUB badges on animepahe — per episode, automatically.

## Features

- Detects English-dubbed episodes on anime pages, play pages, and the home page.
- Native clear-cache button built into the status pill and extension menu for instant data resets.
- Two-stage validation: queries the episode links API, then falls back to parsing the play page HTML.
- Results cached for 12 hours (configurable) to avoid repeated requests.
- Batch processing (3 episodes at a time) to reduce load.
- Status pill in bottom-right corner shows progress, then disappears.

## Installation

1. Install a userscript manager.  
   **Recommended: [ScriptCat](https://scriptcat.org/)** (fast, modern, with cloud backup, open-source ).
2. Open the [raw script](https://update.greasyfork.org/scripts/577043/AnimePahe-DUB-Detector.user.js) your manager will prompt to install.
3. Click Install.

Visible results:

- **Anime page**: Pink `DUB` badge on dubbed episode cards (top-right).
- **Play page**: `DUB` badge next to the episode number.
- **Home page**: Pink badge with a microphone icon like `🎙️ 4/12` on anime covers (top-right), showing dubbed/total episodes.
- **Cache Control**: A dedicated `Clear Cache` button appears on the status pill during active scans, alongside an extension menu fallback command.

## Configuration

Edit these variables at the top of the script if needed:

- `CACHE_TTL` – cache lifetime in milliseconds (default: 12 hours).
- `BATCH_SIZE` – concurrent checks per batch (default: 3).

## Known Issues

- Rate limiting (HTTP 429). The script batches requests and caches results; if limited, wait a few minutes.
- Home page uses a MutationObserver with 500ms debounce for newly loaded content.

## License

<a href="LICENSE">
  <img src="https://upload.wikimedia.org/wikipedia/commons/9/93/GPLv3_Logo.svg" width="80" alt="GPLv3 Logo">
</a>
