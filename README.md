<div align="center">
  <img src="icon/animepahe-dub-detector.svg" width="128" alt="AnimePahe DUB Detector Icon">
  <h1>animepahe DUB Detector</h1>
  <p>Tags dubbed episodes with DUB badges on animepahe — per episode, automatically.</p>
</div>

> [!IMPORTANT]
> **Project Temporarily Archived & Undergoing Improvements**  
> This repository is currently archived, and the GreasyFork script has been **deleted until further notice**. The script is actively being reworked and improved behind the scenes to provide better performance and reliability. The installation steps below are preserved for when the updated version officially launches.

---

## Features

### 🌟 User Experience
- **Cross-Page Detection:** Identifies English-dubbed episodes across anime info pages, individual play pages, and the main home page.
- **Live UI Feedback:** Features a floating status pill in the bottom-right corner displaying real-time ETA and percentage tracking during scans.
- **Quick Reset:** Includes a native `Clear Dub Detector Cache` command directly inside your userscript manager's menu for instant data resets.

### ⚙️ Under the Hood
- **Optimized Scanning:** Uses a concurrent multi-probe binary search to map out dubbed episode boundaries with minimal API requests.
- **Anti-Rate Limit Throttler:** Built-in queue management automatically delays and retries requests to prevent temporary Cloudflare blocks.
- **Smart Caching:** Results are cached locally for 24 hours with automatic garbage collection for stale entries to minimize network overhead.

---

## Visual Indicators

- **Anime Page:** Pink `DUB` badge placed on the top-right of dubbed episode cards.
- **Play Page:** A seamless `DUB` badge integrated directly next to the active episode title.
- **Home Page:** A pink badge featuring a microphone icon (e.g., `🎙️ 4/12`) on anime covers, displaying the exact ratio of dubbed to total episodes.

---

## Installation

> [!WARNING]
> *Note: Script links are currently inactive due to active ongoing improvements.*

1. Install a userscript manager.  
   **Recommended: [ScriptCat](https://scriptcat.org/)** (Fast, modern, open-source, with built-in cloud backup).
2. Open the [raw script](https://update.greasyfork.org/scripts/577043/animepahe-DUB-Detector.user.js) (Disabled).
3. Click **Install** when prompted by your manager.

---

## Configuration

You can tweak these constants at the very top of the script source code to fine-tune performance:

| Constant | Default Value | Description |
| :--- | :--- | :--- |
| `CACHE_TTL` | `24 * 60 * 60 * 1000` | How long scanned results are stored locally (24 hours). |
| `PARALLEL_PROBES` | `8` | The number of concurrent network checks executed during binary search. |

---

## Known Issues

- **Home Page Delays:** The home page implementation relies on a `MutationObserver` paired with a debounce function to detect newly infinite-scrolled content. This may cause a slight, brief delay before badges appear when scrolling rapidly.

---

## License

<a href="LICENSE">
  <img src="https://upload.wikimedia.org/wikipedia/commons/9/93/GPLv3_Logo.svg" width="80" alt="GPLv3 Logo">
</a>
