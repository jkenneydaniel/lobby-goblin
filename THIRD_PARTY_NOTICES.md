# Third-party notices

Lobby Goblin is unofficial and is not affiliated with or endorsed by Wube
Software or Facepunch Studios. Game names and trademarks belong to their
respective owners.

- [Factorio](https://factorio.com/) is proprietary software from Wube Software.
  No game executables, artwork, mods, saves or verbatim game example configuration
  files are included in this source release. Users obtain the headless server
  separately through the game container image and need matching game clients.
- [factoriotools/factorio-docker](https://github.com/factoriotools/factorio-docker)
  supplies the existing supported external game image and legacy compatibility
  test input. Its Docker wrapper is MIT licensed; this does not relicense the
  Factorio game. It is referenced, not vendored here. Our optional image is built
  independently from Debian and the official Wube headless download; its startup
  and RCON tools are maintained in `panel/applications/factorio/images/`.
- [Rust](https://rust.facepunch.com/) is proprietary software from Facepunch
  Studios. The Rust module downloads its dedicated server separately through a
  reviewed [Didstopia image](https://github.com/Didstopia/rust-server). Neither
  the game binaries nor that image wrapper are included in this source release;
  their terms and licenses apply separately.
- [Node.js](https://nodejs.org/) and the Debian base image are external runtime
  dependencies. Their licenses and component notices remain in their images.
- [ws](https://github.com/websockets/ws) is the MIT-licensed Rust WebRCON client.
  Its license is included with the installed dependency in the panel image.
- [ssh2](https://github.com/mscdex/ssh2) is the MIT-licensed SSH client used for
  administrator-requested host installation. Its license and dependency notices
  are included with the installed packages in the panel image.

The compact world preset in `panel/world-defaults.json` contains the panel's
exposed configuration keys and numeric/boolean standard values. It is generated
from the project's field definitions, rather than redistributing the full game
example files. Omitted low-level tuning is supplied by the installed game.

A selected set of Tabler Icons v3.49.0 outline icons is bundled in
`panel/public/icons.js` under the MIT license.
Copyright (c) 2020 Paweł Kuna. The complete notice is preserved in
`panel/public/LICENSE-tabler.md`. Icons come from the official
[Tabler Icons repository](https://github.com/tabler/tabler-icons).
