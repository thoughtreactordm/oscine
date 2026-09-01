# Oscine™ Trademark Policy

This document summarises the brand rights that sit alongside the MIT-licensed source code. It is a
plain-language summary, not legal advice.

## The code is free to use

The Oscine source code is released under the MIT License. You can fork it, modify it, ship it in a
commercial product, or build on it — with or without payment, for any purpose. Those rights are
granted by the LICENSE file and nothing in this document takes them away.

## The brand is not

"Oscine" is a trademark of Thought Reactor (™, claimed through use; unregistered). The name, logo,
icon, wordmark, and the visual identity of Oscine are owned by Thought Reactor, all rights
reserved, and are **not** covered by the MIT License.

This mirrors the model used by projects like Mozilla Firefox and Chromium: the code is open, the
brand is not.

## What this means for forks

If you fork or redistribute this code in a way that makes it a distinct product, you must:

- **Remove the Oscine name** from the application title, package name, installer, window chrome,
  documentation, and any other user-facing surface.
- **Remove or replace the brand assets** listed below with your own originals.
- **Not imply affiliation or endorsement** by Thought Reactor.

You do not need permission from Thought Reactor to ship your fork; you just need to rename and
rebrand it first.

## Nominative references are fine

Truthful, factual references to Oscine are always permitted:

- "a fork of Oscine"
- "compatible with Oscine"
- "based on the Oscine source code"
- "originally derived from Oscine"

These are factual statements, not brand use, and do not require permission.

## Reserved brand assets

The following files in this repository are brand assets and are reserved — they are **not** covered
by the MIT License:

```
build/oscine-logo.svg          # master vector source for the app mark
build/oscine-logo-base.svg     # base form of the mark (no colour fill)
build/icon.svg                 # SVG app icon
build/icon.png                 # PNG app icon (master raster)
build/icon.ico                 # Windows .ico bundle
build/icons/16x16.png
build/icons/24x24.png
build/icons/32x32.png
build/icons/48x48.png
build/icons/64x64.png
build/icons/128x128.png
build/icons/256x256.png
build/icons/512x512.png
src/renderer/shell/AppLogo.vue # Vue component that renders the Oscine mark in the title bar
```

The icon set under `build/icons/` is generated from `build/oscine-logo.svg` by
`scripts/make-icons.mjs`. The script and the SVG source are both reserved; the generated PNGs are
as well.

`src/renderer/panels/AppTitleBar.vue` references `AppLogo.vue` and displays the application name.
A fork should replace or remove both.

## Moving the assets

The icons under `build/` are read directly by the packaging tool (electron-builder) from those
paths and are not safe to move without updating the build configuration. They are enumerated above
rather than moved into a dedicated directory.

## Contact

For questions about brand use, contact Thought Reactor.
