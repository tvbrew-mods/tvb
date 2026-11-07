# TVB — TV Browser for TizenBrew

A [TizenBrew](https://github.com/reisxd/TizenBrew) module that makes browsing the web on Samsung (Tizen) smart TVs
comfortable with the remote control.

> **Status: early version (v0.1.1).** Home page with bookmarks, remote-friendly navigation, a virtual cursor
> and basic video controls. Popup blocking and more video features are planned.

## Features

- **Home page** with clock, web search (Google) or address bar, and your bookmarks, in a "glass" style
- **Highlight navigation:** the arrow keys move between links, buttons, fields and videos; OK opens them
- **Virtual cursor** for the parts of a page that highlight navigation can't reach
- **Bookmarks:** add any page with one key, without leaving it; rename, reorder and delete them from the home page
- **Video:** full screen with one key, play / pause and 10-second jumps with the media keys
- **Loading bar** while a page loads, and a white background for pages that don't set one
- **Key guide** always one key away
- Keys pressed while an embedded frame (for example a video player or a cookie banner) has the focus still work

## Remote keys

| Key | On websites | On the home page |
|---|---|---|
| Arrows | highlight links, buttons, fields and videos (the page scrolls when there is nothing else) | move between bookmarks, search and guide |
| OK | open / press the highlighted element (play / pause on a video) | open the selected item |
| TOOLS | turn the virtual cursor on / off | |
| A (red) | video full screen (RETURN to leave) | |
| B (green) | add the page to the bookmarks | |
| C (yellow) | back to the home page | |
| D (blue) | | edit the bookmark: rename, move, delete |
| ▶ / ⏸ | play / pause the video | |
| ◀◀ / ▶▶ | jump back / forward 10 seconds in the video | |
| RETURN | back (or close the guide, leave full screen or a frame) | close dialogs |
| GUIDE | key guide | key guide |
| INFO | technical information (debug) | technical information (debug) |
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
   tvbrew-mods/tvb@v0.1.2
   ```
4. Go back to the TizenBrew home screen and launch **TV Browser**.

Specifying the version prevents an old cached copy from being loaded.

If the module does not start, your TV may not support the GUIDE key: remove it and add
`tvbrew-mods/tvb@v0.1.2-safe` instead (same features; open the key guide from the **Guide** button on the home page).

## Bookmarks and privacy

Bookmarks are stored only on your TV: in a small file managed by TVB inside TizenBrew's storage
(`/home/owner/share/tvbBookmarks.json`), with a copy in the storage of the TVB home page.
The bookmark service listens only on the TV itself (127.0.0.1). Nothing is collected or sent anywhere.

## Uninstalling

In the TizenBrew module manager, select the module and remove it.
The module does not change anything on the TV outside TizenBrew (apart from the bookmarks file above).

## Safety

The module is designed to be harmless:

- it runs only inside TizenBrew and does not touch the TV's settings or system;
- it never intercepts system keys (Home, EXIT, volume, channels, power);
- every error is caught without freezing the page;
- links that would open new windows open in the same page instead.

## Notes

Personal, experimental project with no warranty. Issues and pull requests are disabled.
