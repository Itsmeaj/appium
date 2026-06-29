# Architecture & Dependencies

This document is deliberately transparent about what runs in the open and what
relies on a native runtime. If you are evaluating the driver for an open-source
or supply-chain-sensitive context, read this first.

## The short version

The driver speaks the standard Appium/WebDriver protocol and drives Linux GUI
apps through **AT-SPI2**, the open freedesktop accessibility stack. Element
finding, page source, clicks, typing, and screenshots all map onto AT-SPI and —
on Wayland — XDG desktop portals.

One performance-critical piece, **accessibility-tree extraction**, is provided
by a native runtime component (`libstdspalinux.so`). This is a documented,
install-once **prerequisite**, the same way XCUITest requires Apple's XCTest.

## Why a native runtime at all

Accessibility-tree extraction is the hot path: every `findElement`,
`getPageSource`, and window scan walks the AT-SPI tree and serializes it. On
large application trees (hundreds to thousands of nodes) this must be fast.

A native, in-process AT-SPI client does this walk with minimal IPC. Doing the
same walk from JavaScript over D-Bus would issue a separate round-trip per node
per property — orders of magnitude more overhead on big trees — which is not an
acceptable trade for an interactive automation driver. The native runtime exists
to protect execution speed, which is a hard requirement for real test suites.

The data it returns is **not proprietary**: it is the standard AT-SPI tree
(roles, names, states, extents, interfaces) that any AT-SPI client — Accerciser,
`pyatspi`, GNOME's own tooling — can read. The runtime is an optimized reader of
open data, not a closed data source.

## What is open vs native, by capability

| Capability | X11 backend | Wayland backend |
|---|---|---|
| Accessibility tree (find / page source) | native runtime | native runtime |
| Pointer / mouse input | native runtime | **open** — XDG portal `RemoteDesktop` |
| Keyboard input | native runtime | **open** — XDG portal + evdev maps (JS) |
| Screenshots | native runtime | **open** — portal / `gnome-screenshot` / `grim` |
| Clipboard | native runtime | **open** — `wl-clipboard`, native fallback |
| Window enumeration / rect | native runtime | **open** — derived in JS from AT-SPI XML |
| App launch / running / kill | native runtime (+ JS `pgrep`/`spawn` fallback) | native runtime (+ JS fallback) |
| Display size | native runtime | **open** — portal logical size, native fallback |

On Wayland, everything except accessibility-tree extraction already runs in the
open (pure JavaScript over `dbus-next`, XDG portals, and standard CLI tools).

## Native runtime prerequisite

- Path: `/usr/local/lib/libstdspalinux.so`
- Loaded at runtime by the thin `@stdspa/stdspalinux_temp` N-API shim via
  `dlopen`/`dlsym`.
- Distributed as a separate redistributable binary, provisioned by the unified
  `.deb`/`.rpm` packages or installed manually.
- The driver itself is licensed Apache-2.0; the runtime is shipped under its own
  redistribution terms.

If the runtime is missing, the X11 backend fails fast with an actionable,
distro-aware message pointing at the matching package.

## Roadmap: toward a fully self-contained build

The native runtime is an optimization boundary, not a lock-in. The intended
path to a fully open, buildable-from-source driver — **without regressing
speed** — is:

1. **Native open AT-SPI reader.** Replace the closed runtime's tree-walk with an
   open-source native (N-API / C / Rust) AT-SPI2 client. Because it would use the
   same underlying `libatspi`/AT-SPI registry the closed runtime uses, it can
   match current performance. This is the high-leverage item.
2. **AT-SPI `Collection` interface for bulk queries.** AT-SPI exposes a
   `Collection` interface (already present in element `interfaces=` metadata)
   that returns matching nodes in a single call, avoiding per-node round-trips —
   the key to keeping an open reader fast.
3. **Open X11 input.** Replace native X11 input with XTEST (small open binding)
   to bring X11 to parity with the already-open Wayland input path.

A pure-JavaScript-over-D-Bus reader is explicitly **not** on the roadmap: it
cannot meet the performance bar on large trees.

## AT-SPI tree shape (reference)

Elements are serialized to XML whose attributes map 1:1 to standard AT-SPI
properties:

```xml
<menu name="File" pid="14683" childCount="10" toolkit="gtk__3.24.43"
  interfaces="[Accessible,Collection,Component,Selection]"
  states="[ENABLED,SELECTABLE,SENSITIVE,SHOWING,VISIBLE]" rect="[223,178,39,28]">
```

| XML attribute | AT-SPI2 source |
|---|---|
| tag (e.g. `menu`, `push-button`) | `getRoleName()` |
| `name` | `Accessible.name` |
| `pid` | owning `Application` |
| `childCount` | `Accessible.childCount` |
| `toolkit` | `Application.toolkitName` + version |
| `interfaces` | `Accessible.getInterfaces()` |
| `states` | `Accessible.getState()` |
| `rect` | `Component.getExtents(DESKTOP_COORDS)` |
| `text` | `Text.getText()` |

A rect of `[-2147483648,...]` is `INT_MIN` from `getExtents()` for unrealized
(off-screen) components — standard AT-SPI behavior, not a driver artifact.
