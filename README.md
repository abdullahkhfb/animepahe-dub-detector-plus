# animepahe DUB Detector Plus

A small add-on for [animepahe](https://animepahe.pw) that puts a **DUB** or **SUB ONLY** label on every episode, so you never have to click in just to find out.

**Version 2.0.0** · Free and open source, licensed under **GPL v3** (see [LICENSE](LICENSE)).

## What it does

- Adds a **DUB** badge to episodes that have an English dub, and a **SUB ONLY** badge to the ones that don't.
- Works on the homepage, on an anime's episode list, and on the video player page.
- Everything is checked automatically — you don't have to click anything.
- Remembers what it's already checked, so it doesn't keep re-checking the same episodes every time you visit.

## Screenshots

![DUB and SUB ONLY badges shown on animepahe](screenshots/screenshot-badges.png)

![The Settings panel](screenshots/screenshot-settings.png)

## How to install

1. Install a userscript manager in your browser. Both [ScriptCat](https://scriptcat.org/) and [Violentmonkey](https://violentmonkey.github.io/) are free and open source, and work in Chrome, Firefox, and Edge.
2. Open the script's [Greasyfork page](https://greasyfork.org/en/scripts/585305-animepahe-dub-detector-plus).
3. Click **Install this script**, then confirm the install screen shown by your userscript manager.
4. Visit animepahe.pw or animepahe.org. That's it, the badges just show up.

## Settings

Click your userscript manager's icon in your browser toolbar, then choose **"⚙️ Open DUB Detector Settings"** to open the settings panel right on the page. From there you can:

- Turn the whole thing on or off
- Turn SUB ONLY badges on or off
- Turn homepage checking on or off (it's on by default)
- Clear the saved results if you ever want a fresh check
- Open **Advanced Settings** for extra options like how often things are re-checked — most people never need to touch these

## A quick note on how it works

The script only looks at animepahe's own pages to figure out which episodes are dubbed — it doesn't send your data anywhere else, and it doesn't need an account or sign-in of any kind.

## License

This project is free software, licensed under the **GNU General Public License v3.0**. You're free to use it, share it, and change it, as long as anything you share back stays under the same license. See [LICENSE](LICENSE) for the full text.
