# Vortex Video for Windows

A small [Electron](https://www.electronjs.org/) app around https://vortex-video.pages.dev, so Vortex gets its own
window, taskbar icon and tray icon. Closing the window keeps it in the tray, so a friend's call still rings
(a Windows notification pops up and the taskbar button flashes). Quit from the tray icon.

Built by GitHub Actions (`.github/workflows/windows.yml`) and published on the
[Releases page](https://github.com/itbelikethatbruh/vortex-video/releases/latest) as `Vortex-Video-Setup.exe`.

- **Unsigned.** Windows SmartScreen shows "Windows protected your PC" the first time: click
  **More info → Run anyway**. Code-signing certificates cost money each year; the installer's SHA-256 is in the
  release notes and on VirusTotal.
- Screen sharing shares your main screen with system audio.

Run it locally: `npm install && npm start`. Build the installer on Windows: `npm run dist`.
