import { brand } from './brand';

const RATIO = 149 / 1000;

/**
 * The Ultratropic wordmark, drawn as a mask filled with the text colour: white
 * on the dark theme, near-black if a viewer's device is in light mode, where a
 * white mark would vanish into the page. The public product shows its name.
 */
export default function Logo({ width = 120, style }: { width?: number; style?: React.CSSProperties }) {
  if (brand.mode === 'public') {
    return (
      <span className="wordmark" style={{ fontSize: Math.round(width * 0.16), ...style }}>
        {brand.product}
      </span>
    );
  }
  return (
    <span
      className="logo"
      role="img"
      aria-label="Ultratropic"
      style={{ width, height: Math.round(width * RATIO), ...style }}
    />
  );
}
