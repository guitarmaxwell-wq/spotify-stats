import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import type { Album } from '../types';
import { hashId, sleevePalette } from '../theme';

/* ------------------------------------------------------------------ colors */

export interface AlbumColors {
  primary: string;
  secondary: string;
}

/**
 * The pipeline is adding `colors` (the two dominant colors of the artwork) to
 * every album. It is not in the data yet, so every color here goes through
 * `albumColors`: real colors when they land, otherwise a pair derived from the
 * album id using the SAME hash and hue table the drawn record sleeve uses
 * (`sleevePalette`), so a bar and its sleeve read as the same album.
 */
export function albumColors(album: Album): AlbumColors {
  const c = album.colors;
  if (c && c.primary && c.secondary) return normalizePair(c);
  return fallbackColors(album.id);
}

/**
 * The bright accent drawn from the album — used for the percentage readout.
 * Real artwork secondaries run dark (median relative luminance ~0.19) and some
 * are near-grey, so the raw color is not safe as text on the dark card. This
 * keeps the artwork's hue and forces it up to a legible tone.
 */
export function albumAccent(album: Album): string {
  const hsl = hexToHsl(albumColors(album).secondary);
  if (!hsl) return albumColors(album).secondary;
  return hslToHex(hsl.h, clamp(hsl.s, 38, 92), clamp(hsl.l, 62, 78));
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Smallest angle between two hues, in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Two dominant colors sampled from real artwork are not automatically a
 * gradient: a sepia photo yields two browns 18 RGB units apart, which paints a
 * flat bar. These guards keep the artwork's hues — the whole point of the
 * feature — while guaranteeing the bar still reads as a lit ramp on a dark UI:
 * a saturation floor for near-grey covers, a lightness window so neither end
 * disappears into the card, and a minimum ramp when the two colors are close.
 */
function normalizePair(c: AlbumColors): AlbumColors {
  let a = hexToHsl(c.primary);
  let b = hexToHsl(c.secondary);
  if (!a || !b) return c; // not hex: leave the pipeline's value untouched

  if (a.s < 18) a.s = Math.min(34, a.s + 16);
  if (b.s < 18) b.s = Math.min(34, b.s + 16);
  a.l = clamp(a.l, 30, 78);
  b.l = clamp(b.l, 30, 78);

  // Both colors are the artwork's, and which is "primary" is about dominance,
  // not about where it belongs on a bar. Putting the darker one first costs
  // nothing and makes every bar brighten toward its leading edge.
  if (b.l < a.l) {
    const t = a;
    a = b;
    b = t;
  }

  // Close hues AND close lightness means no visible gradient at all: open the
  // far end up so the ramp is always there to see.
  if (hueGap(a.h, b.h) < 25 && b.l - a.l < 16) {
    b.l = Math.min(80, a.l + 22);
    b.h = (b.h + 14) % 360;
  }

  return { primary: hslToHex(a.h, a.s, a.l), secondary: hslToHex(b.h, b.s, b.l) };
}

function hexToHsl(color: string): Hsl | null {
  const rgb = toRgb(color);
  if (!rgb) return null;
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const bl = rgb[2] / 255;
  const max = Math.max(r, g, bl);
  const min = Math.min(r, g, bl);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - bl) / d) % 6);
    else if (max === g) h = 60 * ((bl - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: s * 100, l: l * 100 };
}

const HSL = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/;

function fallbackColors(id: string): AlbumColors {
  const h = hashId(id);
  const match = HSL.exec(sleevePalette(id).base);
  const hue = match ? Number(match[1]) : h % 360;
  // 30-70 degrees apart: far enough to read as two colors, close enough that
  // it still looks like one object's palette rather than a rainbow.
  const spread = 30 + ((h >> 7) % 41);
  return {
    primary: hslToHex(hue, 76, 50),
    secondary: hslToHex((hue + spread) % 360, 90, 64),
  };
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (n: number) =>
    Math.round(255 * f(n))
      .toString(16)
      .padStart(2, '0');
  return '#' + hex(0) + hex(8) + hex(4);
}

function toRgb(color: string): [number, number, number] | null {
  let hex = color.trim();
  if (hex[0] !== '#') return null;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6 && hex.length !== 8) return null;
  const n = parseInt(hex.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * `#rrggbb` plus an alpha channel. A non-hex color (a shape the pipeline never
 * promised) comes back unchanged rather than corrupted into an invalid value.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = toRgb(color);
  if (!rgb) return color;
  return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + alpha + ')';
}

/** Blend toward white — the specular core of the leading edge. */
function lighten(color: string, amount: number): string {
  const rgb = toRgb(color);
  if (!rgb) return color;
  const m = (v: number) => Math.round(v + (255 - v) * amount);
  return 'rgb(' + m(rgb[0]) + ', ' + m(rgb[1]) + ', ' + m(rgb[2]) + ')';
}

/* ------------------------------------------------------------- shared clock */

/**
 * ONE clock for every bar on the screen: a 0..1 sawtooth living on the UI
 * thread, started once and never stopped. Each bar reads it through its own
 * hash-derived phase offset, which staggers the sweeps for free. Adding a bar
 * costs a worklet, not another timer or another animation driver.
 */
const CYCLE_MS = 2800;
const clock = makeMutable(0);
let clockStarted = false;

function startClock() {
  if (clockStarted) return;
  clockStarted = true;
  clock.value = withRepeat(withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }), -1, false);
}

/* ----------------------------------------------------------------- the bar */

const HEIGHT = 10;
const SWEEP = 0.55; // the fraction of each cycle the sheen is travelling
const TICKS = 12;
const MAX_NOTCHES = 6;

interface Props {
  album: Album;
  /** Force the static treatment (no sweep), regardless of system settings. */
  still?: boolean;
}

export default function ProgressGradientBar({ album, still = false }: Props) {
  const colors = useMemo(() => albumColors(album), [album]);
  const phase = useMemo(() => (hashId(album.id) % 997) / 997, [album.id]);
  const systemReduced = useReducedMotion();
  const reduced = systemReduced || still;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!reduced) startClock();
  }, [reduced]);

  const pct = Math.max(0, Math.min(1, album.completion));
  const fillW = width * pct;
  const sheenW = Math.max(40, Math.min(110, fillW * 0.42));
  const missing = Math.max(0, album.total_tracks - album.played_tracks);
  const remW = Math.max(0, width - fillW);

  // The tracks still missing, drawn as empty slots in the remainder: at 95%
  // the eye gets a countable "one to go" instead of a bar that looks finished.
  const notchW = missing > 0 ? Math.min(7, remW / missing - 2) : 0;
  const showNotches = missing > 0 && missing <= MAX_NOTCHES && notchW >= 3;

  const sheenStyle = useAnimatedStyle(() => {
    if (reduced) {
      return { opacity: 0.18, transform: [{ translateX: fillW * 0.5 }, { skewX: '-16deg' }] };
    }
    const p = (clock.value + phase) % 1;
    if (p > SWEEP) {
      return { opacity: 0, transform: [{ translateX: -sheenW }, { skewX: '-16deg' }] };
    }
    const travel = p / SWEEP;
    return {
      opacity: 1,
      transform: [{ translateX: -sheenW + travel * (fillW + sheenW) }, { skewX: '-16deg' }],
    };
  });

  // A second gradient layer breathing in and out of the first, so the bar's
  // color keeps drifting between sweeps. Opacity only — never any layout.
  const driftStyle = useAnimatedStyle(() => {
    if (reduced) return { opacity: 0.3 };
    const p = (clock.value + phase * 0.37) % 1;
    return { opacity: 0.16 + 0.34 * (0.5 + 0.5 * Math.sin(2 * Math.PI * p)) };
  });

  const edgeStyle = useAnimatedStyle(() => {
    if (reduced) return { opacity: 0.9 };
    const p = (clock.value + phase) % 1;
    return { opacity: 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(2 * Math.PI * p)) };
  });

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  };

  const edge = lighten(colors.secondary, 0.55);

  return (
    <View style={styles.row}>
      {/* The glow sits outside the clipped track so it can actually bleed.
          `boxShadow`, not the shadow* props: RN 0.86 deprecated those and
          react-native-web drops them outright, so the glow simply vanished. */}
      <View
        pointerEvents="none"
        style={[
          styles.glow,
          {
            width: fillW,
            backgroundColor: withAlpha(colors.primary, 0.9),
            boxShadow: '0px 0px 12px ' + withAlpha(colors.secondary, 0.55),
          },
        ]}
      />
      <View style={styles.track} onLayout={onLayout}>
        {width > 0 && (
          <View style={[styles.fill, { width: fillW }]}>
            <LinearGradient
              colors={[colors.primary, colors.secondary]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
            <Animated.View style={[StyleSheet.absoluteFill, driftStyle]}>
              <LinearGradient
                colors={[colors.secondary, withAlpha(colors.primary, 0), colors.secondary]}
                locations={[0, 0.5, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
            <Animated.View style={[styles.sheen, { width: sheenW }, sheenStyle]}>
              <LinearGradient
                colors={[
                  'rgba(255,255,255,0)',
                  'rgba(255,255,255,0.28)',
                  'rgba(255,255,255,0.92)',
                  'rgba(255,255,255,0)',
                ]}
                locations={[0, 0.62, 0.9, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
            <View pointerEvents="none" style={styles.gloss} />
            <Animated.View
              pointerEvents="none"
              style={[
                styles.edge,
                { backgroundColor: edge, boxShadow: '0px 0px 6px ' + edge },
                edgeStyle,
              ]}
            />
          </View>
        )}

        {/* The tick grid sits ON TOP of the fill, so the bar reads as a
            segmented instrument rather than a painted stripe. */}
        <View pointerEvents="none" style={styles.ticks}>
          {Array.from({ length: TICKS - 1 }).map((_, i) => (
            <View key={i} style={styles.tick} />
          ))}
        </View>

        {showNotches && (
          <View pointerEvents="none" style={styles.notches}>
            {Array.from({ length: missing }).map((_, i) => (
              <View key={i} style={[styles.notch, { width: notchW }]} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: HEIGHT, marginTop: 9, justifyContent: 'center' },
  glow: { position: 'absolute', left: 0, height: HEIGHT - 2, borderRadius: HEIGHT / 2 },
  track: {
    height: HEIGHT,
    borderRadius: HEIGHT / 2,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  // RN 0.86 dropped StyleSheet.absoluteFillObject; only `absoluteFill` remains.
  ticks: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
  tick: { flex: 1, borderRightWidth: 1, borderRightColor: 'rgba(8,6,10,0.42)' },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: HEIGHT / 2,
    overflow: 'hidden',
  },
  sheen: { position: 'absolute', top: -HEIGHT, bottom: -HEIGHT, left: 0 },
  // A glass highlight along the top of the capsule.
  gloss: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: HEIGHT * 0.38,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  edge: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 3 },
  notches: {
    position: 'absolute',
    right: 2,
    top: 2.5,
    bottom: 2.5,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 2,
  },
  notch: {
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.30)',
  },
});
