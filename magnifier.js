// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Icon magnification driven by the pointer position.
//
// Icon scale is a direct function of the pointer position through a
// raised-cosine (Hann) window, recomputed every frame. Positions come from a
// cumulative layout walk: each slot is widened by its own magnification and
// the results are accumulated, anchored so the point under the cursor stays
// under the cursor. Icons are pinned to the dock's screen edge and grow
// outwards past the background.
//
// Two quantities are integrated over time instead of being read straight off
// the pointer. One is a scalar envelope in the range 0 to 1, a critically
// damped spring that multiplies the whole effect as the pointer enters and
// leaves the dock. The other is the cursor itself, low passed to keep input
// sampling noise out of the layout.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Glass from './glass.js';

// Defaults; the live values come from the magnify-* settings keys.
export const EFFECT_WIDTH = 320; // total span of the effect, px (logical)
export const MAX_SCALE = 2.0;   // scale of the icon directly under the cursor
// Schema maxima, used to size static clip paddings so they never need to
// react to settings changes (magnify-effect-width max, and perpendicular
// overflow = (magnify-max-scale max - 1) + magnify-rise max = 2 + 1).
export const MAX_EFFECT_WIDTH = 560;
export const MAX_PERP_OVERFLOW = 3;
const SPRING_OMEGA = 20.0;      // rad/s, critically damped enter/leave envelope
const MAX_FRAME_DT = 1 / 30;    // clamp spring integration steps
const SETTLE_ENVELOPE = 0.002;
const SETTLE_VELOCITY = 0.02;
// Low pass on the sampled pointer, seconds. Reading the pointer once a frame
// picks up the beat between the mouse's report rate and the frame clock, and
// the anchor turns that into the whole strip twitching. Steady state lag is
// speed times this, so about 11px at a normal sweep.
const CURSOR_TAU = 0.045;

const PIVOTS = {
    [St.Side.BOTTOM]: [0.5, 1],
    [St.Side.TOP]: [0.5, 0],
    [St.Side.LEFT]: [0, 0.5],
    [St.Side.RIGHT]: [1, 0.5],
};

export class DockMagnifier {
    /**
     * @param {DockDash} dash the dock's dash
     * @param {St.Widget} hoverBox the reactive, hover-tracked box wrapping it
     * @param {St.Side} position dock position on the monitor
     * @param {Gio.Settings} settings the dock's settings
     */
    constructor(dash, hoverBox, position, settings) {
        this._dash = dash;
        this._hoverBox = hoverBox;
        this._position = position;
        this._settings = settings;
        this._horizontal = position === St.Side.BOTTOM ||
                           position === St.Side.TOP;
        this._pivot = new Graphene.Point({
            x: PIVOTS[position][0],
            y: PIVOTS[position][1],
        });
        this._paused = false;     // menu open: freeze current transforms
        this._suspended = false;  // drag in progress: no magnification at all

        this._envelope = 0;
        this._velocity = 0;
        this._target = 0;

        this._timeline = null;
        this._signalIds = [];     // [object, id] pairs
        this._transformed = new Map();  // actor -> destroy-signal id
        this._risen = new Map();        // container -> destroy-signal id
        this._cursor = null;            // smoothed pointer, dock axis, in dash-local coordinates
        this._lastFrameUs = 0;
        this._bgRest = null;            // slab padding measured at rest
        this._debug = false;
        this._debugFrame = 0;
        this._debugPointer = null;      // [stageX, stageY] override for tests

        this._readSettings();
        this._connectSignals();
        this._unclipContainmentChain();
        this._syncTarget();
    }

    destroy() {
        this._stopTimeline();

        for (const [obj, id] of this._signalIds)
            obj.disconnect(id);
        this._signalIds = [];

        this._clearTransforms();
        this._reclipContainmentChain();

        this._dash = null;
        this._hoverBox = null;
        this._settings = null;
    }

    _readSettings() {
        if (this._settings) {
            this._maxScale = this._settings.get_double('magnify-max-scale');
            this._effectWidth = this._settings.get_int('magnify-effect-width');
            this._rise = this._settings.get_double('magnify-rise');
        } else {
            this._maxScale = MAX_SCALE;
            this._effectWidth = EFFECT_WIDTH;
            this._rise = 0;
        }
    }

    _connectSignals() {
        const connect = (obj, name, cb) => {
            this._signalIds.push([obj, obj.connect(name, cb)]);
        };
        connect(this._hoverBox, 'notify::hover', () => this._syncTarget());
        // The strip can be relaid out mid hover, when an app icon animates in.
        // Paused keeps the frozen transforms under an open menu.
        connect(this._dash, 'items-allocated', () => {
            if (!this._paused && this._envelope > 0)
                this.update();
        });
        // While a quicklist menu is open, freeze the current magnified state
        // (the icon stays magnified underneath its own menu).
        connect(this._dash, 'menu-opened', () => this._setPaused(true));
        connect(this._dash, 'menu-closed', () => this._setPaused(false));
        // While dragging an icon, drop magnification entirely: the drag
        // machinery owns positions and placeholders.
        connect(Main.overview, 'item-drag-begin',
            () => this._setSuspended(true));
        connect(Main.overview, 'item-drag-end',
            () => this._setSuspended(false));
        connect(Main.overview, 'item-drag-cancelled',
            () => this._setSuspended(false));
        if (this._settings) {
            const onSettings = () => {
                this._readSettings();
                if (this._envelope > 0)
                    this.update();
            };
            connect(this._settings, 'changed::magnify-max-scale', () => {
                onSettings();
                // Icon textures are oversampled to the magnification cap;
                // reload them at the new resolution.
                this._dash.refreshIconResolution();
            });
            connect(this._settings, 'changed::magnify-effect-width', onSettings);
            connect(this._settings, 'changed::magnify-rise', onSettings);
        }
    }

    /**
     * Magnified icons must be able to render outside the icon strip: every
     * St.BoxLayout in the containment chain is an StViewport, whose view clip
     * would guillotine them at the dash edge.
     */
    _clipChain() {
        return [
            this._dash._box,
            this._dash._boxContainer,
            this._dash._dashContainer,
            this._dash._scrollView,
            this._hoverBox,
        ].filter(a => a);
    }

    _unclipContainmentChain() {
        // Remember the original clip state so destroy() can restore it, and
        // drop both kinds of clip: the viewport's view clip and the generic
        // clip-to-allocation (a scroll view clips on the latter).
        this._savedClips = new Map();
        for (const actor of this._clipChain()) {
            this._savedClips.set(actor, {
                view: actor.clip_to_view,
                alloc: actor.clip_to_allocation,
            });
            if (actor.clip_to_view !== undefined)
                actor.clip_to_view = false;
            actor.clip_to_allocation = false;
        }
        this._savedOffscreenRedirect = this._dash.offscreen_redirect;
        this._dash.offscreen_redirect =
            Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY;
    }

    _reclipContainmentChain() {
        for (const [actor, saved] of this._savedClips ?? []) {
            if (saved.view !== undefined)
                actor.clip_to_view = saved.view;
            actor.clip_to_allocation = saved.alloc;
        }
        this._savedClips = null;
        this._dash.offscreen_redirect = this._savedOffscreenRedirect;
    }

    _setPaused(paused) {
        this._paused = paused;
        if (paused)
            this._stopTimeline();   // freeze transforms as they are
        else
            this._syncTarget();
    }

    _setSuspended(suspended) {
        this._suspended = suspended;
        if (suspended) {
            this._stopTimeline();
            this._envelope = 0;
            this._velocity = 0;
            this._clearTransforms();
        } else {
            this._syncTarget();
        }
    }

    _syncTarget() {
        if (this._paused || this._suspended)
            return;
        this._target = this._hoverBox.hover ? 1 : 0;
        if (this._target > 0 || this._envelope > 0)
            this._startTimeline();
    }

    _startTimeline() {
        if (this._timeline)
            return;
        // Opt-in diagnostics: `touch /tmp/d2dm-debug` before hovering the dock.
        this._debug = GLib.file_test('/tmp/d2dm-debug', GLib.FileTest.EXISTS);
        // Pick the pointer up where it is now, not where the last run left it.
        this._cursor = null;
        this._lastFrameUs = GLib.get_monotonic_time();
        this._timeline = Clutter.Timeline.new_for_actor(this._dash, 3600 * 1000);
        this._timeline.set_repeat_count(-1);
        this._timeline.connect('new-frame', () => this._onFrame());
        this._timeline.start();
    }

    _stopTimeline() {
        if (!this._timeline)
            return;
        this._timeline.stop();
        this._timeline = null;
    }

    /**
     * Pointer position along the dock axis in the dash's own coordinate
     * frame, the same frame the allocation chain lives in. Mapping the
     * pointer into that frame (instead of mixing stage coordinates with
     * allocation offsets) keeps the anchor correct whatever transforms the
     * dock or its ancestors carry.
     */
    _pointerAxis() {
        const pointer = this._debugPointer ?? global.get_pointer();
        const [ok, lx, ly] = this._dash.transform_stage_point(pointer[0], pointer[1]);
        if (ok)
            return this._horizontal ? lx : ly;
        const [dx, dy] = this._dash.get_transformed_position();
        return this._horizontal ? pointer[0] - dx : pointer[1] - dy;
    }

    _advanceCursor(dt) {
        const raw = this._pointerAxis();
        if (this._cursor === null)
            this._cursor = raw;
        else
            this._cursor += (raw - this._cursor) * (1 - Math.exp(-dt / CURSOR_TAU));
    }

    _onFrame() {
        if (!this._dash.get_stage()) {
            this._stopTimeline();
            return;
        }

        const nowUs = GLib.get_monotonic_time();
        const dt = Math.min(Math.max((nowUs - this._lastFrameUs) / 1e6, 0), MAX_FRAME_DT);
        this._lastFrameUs = nowUs;

        this._advanceCursor(dt);

        // Critically damped spring toward the target envelope.
        const w = SPRING_OMEGA;
        this._velocity += (-2 * w * this._velocity -
                           w * w * (this._envelope - this._target)) * dt;
        this._envelope += this._velocity * dt;
        if (this._envelope < 0)
            this._envelope = 0;

        if (this._target === 0 &&
            Math.abs(this._envelope) < SETTLE_ENVELOPE &&
            Math.abs(this._velocity) < SETTLE_VELOCITY) {
            this._envelope = 0;
            this._velocity = 0;
            this._stopTimeline();
            this._clearTransforms();
            return;
        }

        this.update();
    }

    /**
     * Recompute and apply all transforms for the current pointer position and
     * envelope. Depends only on current state, so it is safe to call at any
     * time.
     */
    update() {
        if (!this._dash._box.has_allocation())
            return;

        // The frame loop owns the smoothed cursor. Calls from outside it, after
        // a relayout or a settings change, reuse the last frame's value.
        const cursor = this._cursor ?? this._pointerAxis();

        const elements = this._collectElements();
        if (elements.length === 0)
            return;

        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const effectWidth = this._effectWidth * scaleFactor;
        const eff = this._envelope * (this._maxScale - 1);

        // Raised-cosine scale for each element from its *base* center.
        const minP = cursor - effectWidth / 2;
        for (const el of elements) {
            const theta = Math.min(Math.max(
                ((el.center - minP) / effectWidth) * 2 * Math.PI, 0),
            2 * Math.PI);
            el.scale = 1 + eff * ((1 - Math.cos(theta)) / 2);
        }

        // Cumulative layout: slot boundaries live midway through the gaps
        // between consecutive elements; each slot stretches by its scale.
        const n = elements.length;
        const bounds = new Array(n + 1);
        bounds[0] = elements[0].p1;
        for (let i = 1; i < n; i++)
            bounds[i] = (elements[i - 1].p2 + elements[i].p1) / 2;
        bounds[n] = elements[n - 1].p2;

        const newBounds = new Array(n + 1);
        newBounds[0] = bounds[0];
        for (let i = 0; i < n; i++) {
            newBounds[i + 1] = newBounds[i] +
                (bounds[i + 1] - bounds[i]) * elements[i].scale;
        }

        // Anchor: the base-space point under the cursor maps to itself, so
        // the icon under the pointer never slides out from beneath it.
        let shift = 0;
        if (cursor > bounds[0] && cursor < bounds[n]) {
            let i = 0;
            while (i < n - 1 && bounds[i + 1] < cursor)
                i++;
            const mapped = newBounds[i] +
                (cursor - bounds[i]) * elements[i].scale;
            shift = cursor - mapped;
        } else if (cursor >= bounds[n]) {
            shift = bounds[n] - newBounds[n];
        }

        // Optional "rise": lift elements off the slab perpendicular to the
        // dock, proportional to their magnification. Applied to the
        // container (never the icon actor, whose perpendicular translation
        // belongs to the launch bounce).
        const riseNorm = this._maxScale > 1
            ? this._rise / (this._maxScale - 1) : 0;

        for (let i = 0; i < n; i++) {
            const el = elements[i];
            const newCenter = newBounds[i] +
                (el.center - bounds[i]) * el.scale + shift;
            this._apply(el.actor, el.scale, newCenter - el.center);
            if (riseNorm > 0) {
                this._applyRise(el.container,
                    riseNorm * el.thickness * (el.scale - 1));
            }
            el.container.updateLabelPosition?.();
        }
        if (riseNorm === 0 && this._risen.size > 0)
            this._clearRisen();

        this._stretchBackground(bounds[0], bounds[n],
            newBounds[0] + shift, newBounds[n] + shift);

        if (this._debug && (this._debugFrame++ % 20) === 0)
            this._logDebug(cursor, elements, bounds, newBounds, shift);
    }

    _logDebug(cursor, elements, bounds, newBounds, shift) {
        const h = this._horizontal;
        const axis = pos => (h ? pos[0] : pos[1]);
        const fmt = v => (Number.isFinite(v) ? v.toFixed(1) : String(v));
        const ptr = global.get_pointer();
        const first = elements[0];
        const last = elements[elements.length - 1];
        const clips = this._clipChain().map(a =>
            `${a.constructor.name}:view=${a.clip_to_view},alloc=${a.clip_to_allocation}`);
        const out = [
            `horizontal=${h} n=${elements.length} env=${fmt(this._envelope)}`,
            `pointerStage=${fmt(ptr[0])},${fmt(ptr[1])} cursorLocal=${fmt(cursor)}`,
            `dashStage=${this._dash.get_transformed_position().map(fmt)}`,
            `bounds0=${fmt(bounds[0])} boundsN=${fmt(bounds[elements.length])}`,
            `newBounds0=${fmt(newBounds[0])} newBoundsN=${fmt(newBounds[elements.length])} shift=${fmt(shift)}`,
            `firstScale=${fmt(first.scale)} lastScale=${fmt(last.scale)}`,
            `firstRenderedStage=${fmt(axis(first.actor.get_transformed_position()))}`,
            `lastRenderedStage=${fmt(axis(last.actor.get_transformed_position()))}`,
            `firstTx=${fmt(first.actor.translation_x)} lastTx=${fmt(last.actor.translation_x)}`,
            `bgLive=${(this._bgLive ?? []).map(fmt)} bgPads=${this._bgRest ? [this._bgRest.padL, this._bgRest.padR].map(fmt) : 'none'}`,
            `dashContainerAlloc=${fmt(this._dash._dashContainer.allocation.x1)},${fmt(this._dash._dashContainer.allocation.x2)} boxAlloc=${fmt(this._dash._box.allocation.x1)},${fmt(this._dash._box.allocation.x2)}`,
            `clips: ${clips.join(' | ')}`,
        ];
        const bg = this._dash._background;
        const dashStage = axis(this._dash.get_transformed_position());
        const bgPos = axis(bg.get_transformed_position());
        const bgSize = h ? bg.get_transformed_size()[0] : bg.get_transformed_size()[1];
        const pads = this._bgRest ?? {padL: NaN, padR: NaN};
        const n = elements.length;
        out.push(
            `bgScale=${fmt(h ? bg.scale_x : bg.scale_y)} bgTx=${fmt(h ? bg.translation_x : bg.translation_y)}`,
            `bgRenderedStage=${fmt(bgPos)}..${fmt(bgPos + bgSize)}`,
            `bgExpectedStage=${fmt(dashStage + newBounds[0] + shift - pads.padL)}..${fmt(dashStage + newBounds[n] + shift + pads.padR)}`,
            `iconsStage=${fmt(dashStage + newBounds[0] + shift)}..${fmt(dashStage + newBounds[n] + shift)}`);
        const grp = this._findBlurGroup();
        const sibs = (this._dash.get_parent()?.get_children() ?? [])
            .map(c => c.name || c.constructor.name).join(',');
        out.push(`siblings=[${sibs}]`);
        if (grp?.has_allocation()) {
            const gp = axis(grp.get_transformed_position());
            const gs = h ? grp.get_transformed_size()[0] : grp.get_transformed_size()[1];
            const ga = h ? [grp.allocation.x1, grp.allocation.x2] : [grp.allocation.y1, grp.allocation.y2];
            out.push(`blurGroupAlloc=${ga.map(fmt)} blurRenderedStage=${fmt(gp)}..${fmt(gp + gs)} blurScale=${fmt(h ? grp.scale_x : grp.scale_y)} blurTx=${fmt(h ? grp.translation_x : grp.translation_y)}`);
        } else {
            out.push('blurGroup=none');
        }
        console.log(`[d2dm v4] ${out.join('  ')}`);
    }

    /**
     * Visible magnifiable elements in base-layout order along the dock's
     * axis, in stage coordinates. Base positions come from the allocation
     * chain up to the dash: allocations never include transforms, so they
     * stay the untransformed truth even for elements (like the separator)
     * that are their own transform target. Includes the Show Apps icon even
     * though it may live in a different box than the app icons.
     */
    _collectElements() {
        const horizontal = this._horizontal;
        const baseP = child => {
            let p = 0;
            for (let a = child; a && a !== this._dash; a = a.get_parent())
                p += horizontal ? a.allocation.x1 : a.allocation.y1;
            return p;
        };

        const elements = [];
        const pushItem = child => {
            if (!child.visible || !child.has_allocation())
                return;
            // Skip items animating out: their container animates itself and
            // will be destroyed; leave them alone entirely.
            if (child.animatingOut)
                return;
            // DashItemContainers get the transform on their child so we
            // never fight the container's own show/hide animation; bare
            // widgets (the separator) are transformed directly.
            const target = child.child ?? child;
            const p = baseP(child);
            const size = horizontal
                ? child.allocation.get_width() : child.allocation.get_height();
            elements.push({
                actor: target,
                container: child,
                p1: p,
                p2: p + size,
                center: p + size / 2,
                // Perpendicular extent, used as the rise unit so that thin
                // widgets such as the separator lift with their neighbours.
                thickness: horizontal
                    ? child.allocation.get_height()
                    : child.allocation.get_width(),
                scale: 1,
            });
        };

        for (const child of this._dash._box.get_children())
            pushItem(child);
        const showApps = this._dash._showAppsIcon;
        if (showApps?.get_parent())
            pushItem(showApps);

        elements.sort((a, b) => a.p1 - b.p1);
        return elements;
    }

    _apply(actor, scale, translation) {
        if (!this._transformed.has(actor)) {
            actor.pivot_point = this._pivot;
            const destroyId = actor.connect('destroy',
                () => this._transformed.delete(actor));
            this._transformed.set(actor, destroyId);
        }
        actor.set_scale(scale, scale);
        if (this._horizontal)
            actor.translation_x = translation;
        else
            actor.translation_y = translation;
    }

    _applyRise(container, offset) {
        if (!this._risen.has(container)) {
            const destroyId = container.connect('destroy',
                () => this._risen.delete(container));
            this._risen.set(container, destroyId);
        }
        // Away from the screen edge the dock sits on.
        switch (this._position) {
        case St.Side.BOTTOM:
            container.translation_y = -offset;
            break;
        case St.Side.TOP:
            container.translation_y = offset;
            break;
        case St.Side.LEFT:
            container.translation_x = offset;
            break;
        case St.Side.RIGHT:
            container.translation_x = -offset;
            break;
        }
    }

    _clearRisen() {
        for (const [container, destroyId] of this._risen) {
            container.disconnect(destroyId);
            if (this._horizontal)
                container.translation_y = 0;
            else
                container.translation_x = 0;
        }
        this._risen.clear();
    }

    /**
     * The slab grows with the strip: stretch the background so icons
     * never overhang its ends. Axis-only scale about the strip-start edge;
     * the slight corner distortion goes away when the glass slab replaces
     * this widget.
     */
    _stretchBackground(baseL, baseR, newL, newR) {
        const bg = this._dash._background;
        if (!bg.has_allocation())
            return;

        const horizontal = this._horizontal;
        const liveP1 = horizontal ? bg.allocation.x1 : bg.allocation.y1;
        const liveP2 = horizontal ? bg.allocation.x2 : bg.allocation.y2;

        // Measure the slab's padding around the icon strip once per hover,
        // while nothing is transformed yet, and reuse it. Re-measuring from
        // the live allocation every frame lets any layout feedback from the
        // magnified icons inflate the padding, and the slab then grows far
        // past the icons on the side its allocation grows towards.
        if (!this._bgRest)
            this._bgRest = {padL: baseL - liveP1, padR: liveP2 - baseR};
        const {padL, padR} = this._bgRest;
        this._bgLive = [liveP1, liveP2];

        const bgP1 = baseL - padL;
        const baseSize = (baseR - baseL) + padL + padR;
        if (baseSize <= 0)
            return;
        const scale = ((newR + padR) - (newL - padL)) / baseSize;

        if (!this._transformed.has(bg)) {
            bg.pivot_point = new Graphene.Point({x: 0, y: 0});
            const destroyId = bg.connect('destroy',
                () => this._transformed.delete(bg));
            this._transformed.set(bg, destroyId);
        }
        const translation = (newL - padL) - bgP1;
        if (horizontal) {
            bg.set_scale(scale, 1);
            bg.translation_x = translation;
        } else {
            bg.set_scale(1, scale);
            bg.translation_y = translation;
        }

        this._stretchBlurGroup(bgP1 + translation, baseSize * scale);
    }

    _findBlurGroup() {
        const parent = this._dash.get_parent();
        if (!parent)
            return null;
        return parent.get_children().find(
            c => c.name === Glass.BLUR_GROUP_NAME) ?? null;
    }

    /**
     * When Blur my Shell blurs this dock it injects its own background actor
     * as a sibling of the dash and positions it over the slab. The slab we
     * just stretched is transparent in that case, so the blur has to follow
     * or the icons would overhang a base-width backdrop while magnified.
     *
     * Rather than assume the group starts out the same size as the slab and
     * scale it by the slab's factor, give it the slab's exact new extents:
     * its scale and translation are derived from its own allocation, so a
     * group that is wider or offset from the slab still lands on the slab.
     *
     * @param {number} targetP1 new slab start, in the dash's own frame
     * @param {number} targetSize new slab length along the dock axis
     */
    _stretchBlurGroup(targetP1, targetSize) {
        const group = this._findBlurGroup();
        if (!group?.has_allocation())
            return;

        const horizontal = this._horizontal;
        // The group is a sibling of the dash, so shift out of the dash's own
        // allocation to reach the shared parent frame. Allocations are used
        // throughout: the group is itself a transform target here, and
        // reading its transformed position would feed back into this.
        const groupP =
            (horizontal ? group.allocation.x1 : group.allocation.y1) -
            (horizontal ? this._dash.allocation.x1 : this._dash.allocation.y1);
        const groupSize = horizontal
            ? group.allocation.get_width() : group.allocation.get_height();
        if (groupSize <= 0)
            return;

        if (!this._transformed.has(group)) {
            group.pivot_point = new Graphene.Point({x: 0, y: 0});
            const destroyId = group.connect('destroy',
                () => this._transformed.delete(group));
            this._transformed.set(group, destroyId);
        }
        const scale = targetSize / groupSize;
        const translation = targetP1 - groupP;
        if (horizontal) {
            group.set_scale(scale, 1);
            group.translation_x = translation;
        } else {
            group.set_scale(1, scale);
            group.translation_y = translation;
        }
    }

    _clearTransforms() {
        for (const [actor, destroyId] of this._transformed) {
            actor.disconnect(destroyId);
            actor.set_scale(1, 1);
            // Only our own axis: the launch bounce owns the other one.
            if (this._horizontal)
                actor.translation_x = 0;
            else
                actor.translation_y = 0;
        }
        this._transformed.clear();
        this._bgRest = null;
        this._bgLive = null;
        this._clearRisen();

        // Reposition any label that is still showing (e.g. pointer parked on
        // an icon while the envelope collapsed).
        for (const child of this._dash._box.get_children())
            child.updateLabelPosition?.();
    }

    // ---- test hooks -------------------------------------------------------

    setDebugState(stageX, stageY, envelope) {
        this._debugPointer = [stageX, stageY];
        this._cursor = this._pointerAxis();
        if (envelope !== undefined)
            this._envelope = envelope;
        this.update();
    }

    clearDebugState() {
        this._debugPointer = null;
        this._cursor = null;
    }
}
