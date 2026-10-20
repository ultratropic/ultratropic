import type { Shape } from './NotesPanel';

/**
 * Geometry for drawn marks, shared by the viewer (SVG) and the retouch sheet
 * (canvas), so a mark looks the same on screen and in the PDF.
 *
 * Everything is in photo pixels: w × h is the photo's size, and `px` is how many
 * photo pixels one screen (or sheet) pixel covers, so strokes and arrowheads keep
 * a constant visual size whatever the zoom or output resolution.
 */

export const STROKE = 3;      // px on screen
export const ARROW_HEAD = 14; // px
export const HALO = 2.2;      // the dark edge under each stroke, as a multiple of its width
export const HALO_COLOR = 'rgba(0,0,0,0.4)';

/** Where a mark is labelled: its pin goes here. */
export const anchorOf = (s: Shape): [number, number] =>
  s.t === 'pen' ? s.p[0]! : s.t === 'ellipse' ? [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1])] : s.a;

export type Geometry =
  | { kind: 'path'; d: string }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

export function geometry(s: Shape, w: number, h: number, px: number): Geometry {
  if (s.t === 'pen') {
    return { kind: 'path', d: s.p.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`).join(' ') };
  }
  if (s.t === 'ellipse') {
    return {
      kind: 'ellipse',
      cx: ((s.a[0] + s.b[0]) / 2) * w, cy: ((s.a[1] + s.b[1]) / 2) * h,
      rx: (Math.abs(s.a[0] - s.b[0]) / 2) * w, ry: (Math.abs(s.a[1] - s.b[1]) / 2) * h,
    };
  }
  const [x1, y1, x2, y2] = [s.a[0] * w, s.a[1] * h, s.b[0] * w, s.b[1] * h];
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = ARROW_HEAD * px;
  const wing = (sign: number) =>
    `${(x2 - head * Math.cos(ang + sign * 0.5)).toFixed(1)} ${(y2 - head * Math.sin(ang + sign * 0.5)).toFixed(1)}`;
  return {
    kind: 'path',
    d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} M${wing(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} L${wing(-1)}`,
  };
}
