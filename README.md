# TVB — TV Browser for TizenBrew

A [TizenBrew](https://github.com/reisxd/TizenBrew) module that adds remote-control-friendly
browsing features to Samsung (Tizen) smart TVs.

> **Status: testing phase.** The current module only checks how TizenBrew injects the script
> into web pages. It is not a usable browser yet.

## Goals

1. Address bar, bookmarks and history usable with the remote
2. Virtual cursor moved with the arrow keys (OK = click, scrolling at the edges)
3. Blocking of popups, overlays and banners
4. "Open the player": opens the video player's iframe as the main page
5. "Extract video": finds the page's video streams (mp4, m3u8) and plays them in a
   full-screen, remote-controlled player

Known limitations: no support for DRM-protected content (Widevine).

## Requirements

- Samsung TV with Tizen 3.0 or later (developed on a 2019 model running Tizen 5.0)
- [TizenBrew](https://github.com/reisxd/TizenBrew) installed and working

## Installing in TizenBrew

1. Open TizenBrew on the TV.
2. Go to the **module manager** and choose **add GitHub module**.
3. Type the module name, including the version:
   ```
   tvbrew-mods/tvb@v0.0.1
   ```
4. Go back to the TizenBrew home screen and launch **TV Browser (test)**.

Specifying the version (`@v0.0.1`) prevents an old cached copy from being loaded.

## Uninstalling

In the TizenBrew module manager, select the module and remove it.
The module does not change anything on the TV outside TizenBrew.

## Safety

The module is designed to be harmless:

- it runs only inside TizenBrew and does not touch the TV's settings or system;
- it does not intercept system keys (Home, Back/Exit, Volume, Power);
- every error is caught and shown on screen without freezing the page;
- it does not collect or send any data.

## Notes

Personal, experimental project with no warranty. Issues and pull requests are disabled.
