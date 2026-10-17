# Dash2Dock Motion for GNOME 51

A dock for GNOME Shell with pointer-tracking icon magnification and a
translucent glass slab.

This repository is an **unofficial, community-maintained port that keeps
[Dash2Dock Motion](https://github.com/Unmade760/dash2dock-motion) working on
GNOME Shell 51**. The original project, by Unmade760, targets GNOME Shell 50.
It is itself a modified copy of
[Dash to Dock](https://github.com/micheleg/dash-to-dock), which supplies the
dock core, extended with a magnification engine that scales icons under the
cursor and reflows their neighbours around them.

All of the design, the magnification engine and the glass slab are the original
author's work; see [Credits](#credits) and [What is different from the
original](#what-is-different-from-the-original).

![Dash2Dock Motion](docs/showcase.gif)

> **Status:** tested on GNOME Shell 51 (CachyOS). `metadata.json` lists shell
> version 51 only. This port has not been tested on GNOME Shell 50 or older, and
> some of the changes below are specific to 51, so on older shells use the
> [original project](https://github.com/Unmade760/dash2dock-motion) instead.

## Features

- Icon magnification driven directly by the pointer, with a configurable peak
  scale and influence width.
- Icons, running indicators and notification badges are rendered oversampled
  and scaled down, so they stay sharp at any magnification.
- A configurable gap between the dock and the screen edge, which can also be
  negative to push the dock past the edge.
- A list of applications that never appear in the dock just because they are
  running, for launchers and other windows you would not switch back to.
- A translucent slab with an optional rim border. The backdrop blur is left to
  [Blur my Shell](https://github.com/aunetx/blur-my-shell) rather than
  reimplemented here.
- Everything Dash to Dock already provides: autohide, intellihide, multi
  monitor support, window previews, running indicators and app spread.

## What is different from the original

The changes in this port are about GNOME Shell 51 compatibility and a few
robustness fixes found while doing that work.

**GNOME Shell 51 API changes**

- St widgets no longer accept the `vertical` property. Every use was replaced
  with `orientation: Clutter.Orientation.VERTICAL` or `HORIZONTAL`, and
  `set_vertical()` with `set_orientation()`.
- The shell's `ui/pointerWatcher.js` module was removed. `dependencies/shell/ui.js`
  now provides a small replacement with the same `addWatch()` and
  `_removeWatch()` interface, built on the compositor's cursor tracker.
- `PopupMenu.open()` and `close()` take an options object instead of an
  animation constant. The calls in `appIcons.js` and `windowPreview.js` were
  updated.
- `metadata.json` declares support for shell version 51.

**Magnification and slab**

- The slab and the optional Blur my Shell backdrop are stretched from the
  magnified icon strip, so the backdrop follows the icons instead of
  overhanging them. The backdrop's scale and position are derived from its own
  allocation rather than assumed to match the slab.
- Pointer and icon positions are measured in the dash's own coordinate frame,
  frame timing uses a monotonic clock, and the slab padding is measured once
  per hover.
- The containers the icons overflow into have both kinds of clipping turned off
  while magnifying, and restored afterwards.

**Multi monitor and startup**

- The dock manager now checks that there is one dock per monitor (or just the
  preferred one when multi monitor is off) at startup, after login finishes,
  and whenever the monitors change. If a dock is missing, it rebuilds the
  docks. Previously a dock could be left on the laptop screen only until the
  extension was toggled by hand when the external monitor appeared late. A
  failing dock no longer stops the other docks from being created, and the
  check gives up after three attempts so it cannot loop.
- A dock rebuild while the shell is still starting no longer overwrites the
  saved overview setting, which could leave the overview disabled.

**Diagnostics**

- `touch /tmp/d2dm-debug` before hovering the dock makes the magnifier log its
  geometry to the shell journal (see [Troubleshooting](#troubleshooting)).

Everything else is as in the original.

## Requirements

GNOME Shell 51.

Blur my Shell is optional. If you want the dock blurred, install it and enable
its dash blur.

## Installation

### From source

```sh
git clone https://github.com/YOUR-USERNAME/dash2dock-motion.git
cd dash2dock-motion
dest=~/.local/share/gnome-shell/extensions/dash2dock-motion@unmade.space
mkdir -p "$dest"
cp -r ./* "$dest"/
glib-compile-schemas "$dest/schemas"
```

This assumes the extension files (`metadata.json`, `extension.js` and so on) are
in the repository root. If your checkout also contains the original project's
`Makefile`, `make install` does the same job.

GNOME Shell 51 has no extension hot-reload, so log out and back in, then:

```sh
gnome-extensions enable dash2dock-motion@unmade.space
```

Run only one dock at a time. Disable Dash to Dock, any other dock extension and
the built-in `dock@gnome-shell-extensions.gcampax.github.com` before enabling
this one, or they will fight over the dash.

## Configuration

```sh
gnome-extensions prefs dash2dock-motion@unmade.space
```

The Dash2Dock Motion page holds the settings below. The remaining pages are
Dash to Dock's own.

| Key | Range | Default | Effect |
| --- | --- | --- | --- |
| `magnify-max-scale` | 1.0 to 3.0 | 1.45 | Scale of the icon under the cursor. 1.0 disables magnification |
| `magnify-effect-width` | 160 to 560 px | 445 | Width of the influence zone along the dock |
| `magnify-rise` | 0.0 to 1.0 | 0.0 | How far magnified icons lift off the slab |
| `edge-distance` | -16 to 8 px | -5 | Gap from the screen edge. Negative pushes the dock past it |
| `glass-outline` | boolean | true | Rim border around the slab |
| `show-icon-highlight` | boolean | false | Translucent box behind hovered and focused icons |
| `running-apps-exclusions` | list of app ids | `['vicinae.desktop']` | Apps kept out of the dock when they open. Favourites are unaffected |

## How the magnification works

A raised-cosine (Hann) window maps cursor position to icon scale, which gives
zero slope at both edges of the influence zone and at the peak, so icons do not
snap as the pointer crosses a boundary. Icons are anchored on the dock's screen
edge and grow outwards past the slab.

Positions come from a cumulative layout walk. Each slot is widened by its own
magnification and the results are accumulated, anchored so that the point under
the cursor stays under the cursor. Neighbouring icons flow outwards as a
consequence rather than being positioned individually.

Scale is a direct function of pointer position, recomputed every frame. Two
quantities are integrated over time instead of being read straight off the
pointer. One is a scalar envelope, a critically damped spring that scales the
whole effect as the pointer enters and leaves the dock. The other is the cursor
itself: the pointer is sampled once a frame, and the beat between a mouse's
report rate and the frame clock is enough to make the anchor twitch, so the
sampled position goes through a 45 ms low pass first. It settles exactly on the
pointer when you stop moving.

Nothing is re-laid-out per frame: only `pivot_point`, `set_scale` and
`translation_x/y` are touched. The one exception is that the dash re-runs the
magnifier after its own allocation, because Clutter advances timelines before
it relayouts, and an icon animating in resizes the strip on every frame of that
animation.

## Troubleshooting

**The dock is missing on one monitor after login.** The extension should
notice and rebuild the docks by itself. To see whether it did:

```sh
journalctl -b -o cat /usr/bin/gnome-shell | grep dash2dock-motion
```

A line like `rebuilding docks (startup-complete+4s): 1 dock(s) for 2 expected`
means it caught the problem. A line starting `couldn't create the dock for
monitor` followed by an error is worth including in a bug report.

**Magnification or the slab looks wrong.** Create the flag file, hover the dock
for a few seconds, then collect the log:

```sh
touch /tmp/d2dm-debug
journalctl -f -o cat /usr/bin/gnome-shell | grep d2dm
```

Include a few of the `[d2dm v4]` lines and a screenshot in your report. Delete
`/tmp/d2dm-debug` to turn the logging off.

## Bug reporting

Please open an issue at
https://github.com/YOUR-USERNAME/dash2dock-motion/issues.

Bugs in the dock itself, meaning autohide, intellihide, struts, theming or the
preferences pages other than Dash2Dock Motion, most likely belong upstream at
[micheleg/dash-to-dock](https://github.com/micheleg/dash-to-dock/issues).
Please check there first, and mention that you are running this fork if you
report here.

## Relationship to upstream

This is a modified copy of the original
[Dash2Dock Motion](https://github.com/Unmade760/dash2dock-motion), which is
itself a modified copy of Dash to Dock v105, not a fork intended to replace
either. The schema id and UUID are unchanged from the original, so this cannot
be installed side by side with it, and it should replace the original rather
than run alongside it.

`magnifier.js` and `glass.js` are original to Dash2Dock Motion and hold the
magnification engine and the slab's style layer. The files modified by the
original author relative to Dash to Dock are:

- `appIcons.js`: oversampled icon textures, the `animateLaunch()` bounce, and
  an `updateIconGeometry()` that derives the minimize target from the
  allocation chain so per-frame transforms cannot displace it.
- `appIconIndicators.js`: oversampled running dots and notification badge.
- `dash.js`: `refreshIconResolution()`, the `items-allocated` signal the
  magnifier hangs off, and the running-app exclusion filter.
- `docking.js`: magnifier and glass wiring, the edge distance setting, and a
  padded slide-container clip so magnified icons are not cut off.
- `prefs.js`: the Dash2Dock Motion preferences page.
- `utils.js`: `getIconOversample()`.
- `stylesheet.css`, `schemas/*.gschema.xml`, `metadata.json`, `imports.js` and
  `extension.js`: the corresponding additions.

This GNOME 51 port further modifies `magnifier.js`, `docking.js`, `dash.js`,
`appIcons.js`, `windowPreview.js`, `dependencies/shell/ui.js` and
`metadata.json`, along with the other files that built St widgets with the
removed `vertical` property.

## Credits

- **Dash2Dock Motion** by [Unmade760](https://github.com/Unmade760). The
  magnification engine, the glass slab and the design of the extension are
  theirs; this repository exists only to keep that work running on GNOME 51.
- [Dash to Dock](https://github.com/micheleg/dash-to-dock) by Michele Gaio
  (micheleg) and contributors. The dock core, covering docking, autohide,
  intellihide, struts, theming, app icons and preferences, is v105.
- [Dash2Dock Animated](https://github.com/icedman/dash2dock-lite) by icedman,
  studied by the original author while working out the launch bounce and the
  per-frame animation approach. No code from it is included.
- GNOME Shell 51 port by YOUR-NAME.

Not affiliated with or endorsed by any of the projects above.

## License

GPL-2.0-or-later, matching upstream, which is distributed under the terms of
the GNU General Public License, version 2 or later. The modifications in this
repository are released under the same terms. The full licence text is in
[COPYING](COPYING), and the attribution required when redistributing is in
[NOTICE](NOTICE).
