# TVB — TV Browser for TizenBrew

A [TizenBrew](https://github.com/reisxd/TizenBrew) module that makes browsing the web on Samsung (Tizen) smart TVs
comfortable with the remote control.

> **Status: early version (v0.1.3).** Home page with bookmarks, remote-friendly navigation, a virtual cursor,
> basic video controls and a phone remote. Popup blocking and more video features are planned.

## Features

- **Home page** with clock, web search (Google) or address bar, and your bookmarks, in a "glass" style
- **Highlight navigation:** the arrow keys move between links, buttons, fields and videos; OK opens them
- **Virtual cursor** for the parts of a page that highlight navigation can't reach
- **Bookmarks:** add any page with one key, without leaving it; rename, reorder and delete them from the home page
- **Video:** full screen with one key, play / pause and 10-second jumps with the media keys
- **Loading bar** while a page loads, and a white background for pages that don't set one
- **Phone remote:** control TVB from your phone's browser (arrows, OK, keys) and type into text fields
  with the phone keyboard
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

## Phone remote

Press **GUIDE** on the TV: the guide shows an address (for example `http://192.168.1.50:8096`) and a password.
Open the address in your phone's browser (same Wi-Fi network), enter the password and use the phone as a remote.
When a text field is open on the TV, a text box appears on the phone: type and press **Invia** (send).

- The password has 8 characters and changes every time TVB starts.
- After several wrong passwords the page pauses for a minute.
- The phone can only send keys and text: it cannot see bookmarks or pages.
- The home network connection is not encrypted: do not type passwords of other websites from the phone.
- Websites with a strict security policy (for example Wikipedia) do not accept commands from the phone:
  use the TV remote there.

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
   tvbrew-mods/tvb@v0.1.3
   ```
4. Go back to the TizenBrew home screen and launch **TV Browser**.

Specifying the version prevents an old cached copy from being loaded.

After updating TVB, restart the TV once if bookmarks or the phone remote don't work: an older version's
service may still be running (from v0.1.3 on, a new version replaces the old one by itself).

## Bookmarks and privacy

Bookmarks are stored only on your TV: in a small file managed by TVB inside TizenBrew's storage
(`/home/owner/share/tvbBookmarks.json`), with a copy in the storage of the TVB home page.
The bookmark service listens only on the TV itself (127.0.0.1). The phone remote listens on your home network
(port 8096) and requires the password shown on the TV. Nothing is collected or sent anywhere.

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
