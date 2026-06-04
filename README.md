<div align="center">
  <img src="icon/animepahe-dub-detector.svg" width="128" alt="AnimePahe DUB Detector Icon">
  <h1>animepahe DUB Detector</h1>
</div>

Tags dubbed episodes with DUB badges on animepahe — per episode, automatically.

> [!NOTE]
> **Rate Limiting Resolved**

## Features

- Detects English-dubbed episodes across anime pages, play pages, and the home page.
- **Optimized Scanning:** Uses a concurrent multi-probe binary search to map out dubbed episode boundaries with minimal API requests.
- **Anti-Rate Limit Throttler:** Built-in queue management automatically delays and retries requests to prevent temporary Cloudflare blocks.
- **Smart Caching:** Results are cached for 24 hours with automatic garbage collection for stale entries to keep local data fresh.
- **Live UI Feedback:** Floating status pill in the bottom-right corner displays real-time ETA percentage tracking.
- **Quick Reset:** Native `Clear Dub Detector Cache` command available directly in your userscript manager's menu for instant data resets.

## Installation

1. Install a userscript manager.  
   **Recommended: [ScriptCat](https://scriptcat.org/)** (fast, modern, with cloud backup, open-source).
2. Open the [raw script](https://update.greasyfork.org/scripts/577043/animepahe-DUB-Detector.user.js); your manager will prompt to install it.
3. Click Install.

### Visual Indicators:

- **Anime page**: Pink `DUB` badge on dubbed episode cards (top-right).
- **Play page**: `DUB` badge seamlessly integrated next to the episode title.
- **Home page**: Pink badge with a microphone icon (e.g., `🎙️ 4/12`) on anime covers (top-right), showing the ratio of dubbed to total episodes.

## Configuration

You can tweak these constants at the top of the script to adjust performance:

- `CACHE_TTL` – How long results are stored in milliseconds (default: 24 hours / `24 * 60 * 60 * 1000`).
- `PARALLEL_PROBES` – The number of concurrent checks executed during the binary search phase (default: 8).

## Known Issues

- The home page relies on a MutationObserver with a debounce function to detect newly loaded content, which may cause a slight delay before badges appear when scrolling.

## License

<a href="LICENSE">
  <img src="https://upload.wikimedia.org/wikipedia/commons/9/93/GPLv3_Logo.svg" width="80" alt="GPLv3 Logo">
</a>
