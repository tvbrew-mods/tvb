# TV setup guide

How to prepare a Samsung (Tizen) TV to run TVB.

**Already have TizenBrew installed and working?** Skip to [step 4](#4-set-host-pc-ip-to-127001).

## Contents

1. [Check the Tizen version](#1-check-the-tizen-version)
2. [Enable Developer Mode](#2-enable-developer-mode)
3. [Install TizenBrew from your PC](#3-install-tizenbrew-from-your-pc)
4. [Set Host PC IP to 127.0.0.1](#4-set-host-pc-ip-to-127001)
5. [Check that TizenBrew works](#5-check-that-tizenbrew-works)
6. [Install TVB](#6-install-tvb)
7. [Safety and how to undo everything](#safety-and-how-to-undo-everything)

## 1. Check the Tizen version

Go to **Settings › Support › About This TV** and note the Tizen (or firmware) version.

- TizenBrew requires **Tizen 3.0 or later** (TVs from 2017 onwards).
- On **Tizen 7 or later** the installer asks you to sign in with a Samsung account to create a certificate.
  On older versions no account is needed.

## 2. Enable Developer Mode

You need your PC's local IP address. On Windows, open a terminal, run `ipconfig` and look for
"IPv4 Address" (for example `192.168.1.20`). The TV and the PC must be on the **same network**.

1. On the TV, open **Apps**.
2. Type `12345` with the remote. The "Developer mode" window opens.
3. Switch **Developer mode** to **On**.
4. In **Host PC IP**, enter your PC's IP address.
5. Press **OK**, then **restart the TV**: hold the power button on the remote until the logo appears again.

## 3. Install TizenBrew from your PC

1. Download **TizenBrew Installer Desktop** for your OS **only** from the official page:
   <https://github.com/reisxd/TizenBrewInstaller/releases/latest>
2. Run it.
   - Windows may show a SmartScreen warning ("unrecognized app") because the program is not signed.
     Continue only if you downloaded it from the page above.
   - If the Windows firewall asks for network access, allow it for private networks.
3. Click **Install TizenBrew** and wait until it finishes.

## 4. Set Host PC IP to 127.0.0.1

TizenBrew launches itself in debug mode to inject scripts into websites, and it only does so when the
Host PC IP is `127.0.0.1`. Without this setting, website mods like TVB do not work.

1. On the TV, open **Apps** and type `12345` again.
2. Leave **Developer mode** **On** and set **Host PC IP** to `127.0.0.1`.
3. Press **OK** and **restart the TV**.

## 5. Check that TizenBrew works

- Open **TizenBrew** from your apps. Its home screen with the module manager should appear.
- If you see an error like "Failed to connect to the debugger", check step 4 and restart the TV again.

## 6. Install TVB

1. In TizenBrew, open the **module manager** and choose **add GitHub module**.
2. Type the module name, including the version:
   ```
   tvbrew-mods/tvb@v0.0.1
   ```
3. Go back to the TizenBrew home screen and launch **TV Browser (test)**.

Specifying the version prevents an old cached copy from being loaded.

> More detailed instructions for the finished app will be added here.

## Safety and how to undo everything

- **Developer Mode** is an official Samsung feature and does not modify the system.
  Turn it off from the same window (**Apps** › `12345` › **Off**).
- **TizenBrew** can be uninstalled like any other app.
- **TVB** can be removed from the TizenBrew module manager.
- No firmware changes, no rooting, no system modifications are involved.
- To exit TVB at any time, use the **Home** or **Back/Exit** key: TVB never blocks them.
