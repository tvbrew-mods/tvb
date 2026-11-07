# TVB — TV Browser for TizenBrew

A [TizenBrew](https://github.com/reisxd/TizenBrew) module that makes browsing the web on Samsung (Tizen) smart TVs
comfortable with the remote control.

> **Status: early version (v0.1.0).** Home page with bookmarks, remote-friendly navigation and a virtual cursor.
> Popup blocking and video features are planned.

## Features

- **Home page** with clock, web search (Google) or address bar, and your bookmarks
- **Highlight navigation:** the arrow keys move between links, buttons and fields; OK opens them
- **Virtual cursor** for the parts of a page that highlight navigation can't reach
- **Bookmarks:** add any page with one key; rename, reorder and delete them from the home page
- **Key guide** always one key away
- Keys pressed while an embedded frame (for example a video player or a cookie banner) has the focus still work

## Remote keys

| Key | On websites | On the home page |
|---|---|---|
| Arrows | highlight links, buttons and fields (the page scrolls when there is nothing else) | move between bookmarks, search and guide |
| OK | open / press the highlighted element | open the selected item |
| TOOLS (or 8) | turn the virtual cursor on / off | |
| B (green) | add the page to the bookmarks | |
| C (yellow) | back to the home page | |
| D (blue) | | edit the bookmark: rename, move, delete |
| RETURN | back (or close the guide / leave a frame) | |
| INFO (or 9) | key guide | key guide |
| EXIT | exit the app | exit the app |

## Planned

1. Blocking of popups, overlays and banners
2. "Open the player": open an embedded video player as the main page
3. "Extract video": find the page's video streams and play them in a full-screen, remote-controlled player

Known limitations: no support for DRM-protected content (Widevine).

## Requirements

- Samsung TV with Tizen 3.0 or later (developed on a 2019 model running Tizen 5.0)
- [TizenBrew](https://github.com/reisxd/TizenBrew) installed and working

New to TizenBrew? Follow the step-by-step [TV setup guide](docs/TV-SETUP.md).

## Installing in TizenBrew

1. Open TizenBrew on the TV.
2. Go to the **module manager** and choose **add GitHub module**.
3. Type the module name, including the version:
   ```
   tvbrew-mods/tvb@v0.1.0
   ```
4. Go back to the TizenBrew home screen and launch **TV Browser**.

Specifying the version prevents an old cached copy from being loaded.

If the module does not start, your TV may not support the TOOLS and INFO keys: remove it and add
`tvbrew-mods/tvb@v0.1.0-safe` instead (same features, use 8 and 9 instead of TOOLS and INFO).

## Bookmarks and privacy

Bookmarks are stored only on your TV, in the storage of the TVB home page. Nothing is collected or sent anywhere.

## Uninstalling

In the TizenBrew module manager, select the module and remove it.
The module does not change anything on the TV outside TizenBrew.

## Safety

The module is designed to be harmless:

- it runs only inside TizenBrew and does not touch the TV's settings or system;
- it never intercepts system keys (Home, EXIT, volume, channels, power);
- every error is caught without freezing the page;
- links that would open new windows open in the same page instead.

## Notes

Personal, experimental project with no warranty. Issues and pull requests are disabled.
