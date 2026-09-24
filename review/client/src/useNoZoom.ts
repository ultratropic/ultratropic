import { useEffect } from 'react';

const LOCKED = 'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no';

/**
 * Pins the page at 1x while mounted, so a stray pinch or double-tap doesn't
 * leave the gallery zoomed and sliding around under your finger. Restored on
 * unmount, so the login and join screens stay zoomable.
 *
 * iOS Safari ignores user-scalable=no for pinching, so each layer covers a gap:
 * - the viewport meta: Android Chrome, and iOS's zoom-on-focus of small inputs
 * - touch-action on the root: no pinch or double-tap zoom where it's honoured
 * - cancelling Safari's own gesture events and two-finger moves: iOS pinch
 */
export function useNoZoom(): void {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previous = meta?.content;
    if (meta) meta.content = LOCKED;
    document.documentElement.classList.add('no-zoom');

    const cancel = (e: Event) => e.preventDefault();
    const cancelPinch = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault(); };
    const opts: AddEventListenerOptions = { passive: false };
    document.addEventListener('gesturestart', cancel, opts);
    document.addEventListener('gesturechange', cancel, opts);
    document.addEventListener('touchmove', cancelPinch, opts);

    return () => {
      if (meta && previous !== undefined) meta.content = previous;
      document.documentElement.classList.remove('no-zoom');
      document.removeEventListener('gesturestart', cancel);
      document.removeEventListener('gesturechange', cancel);
      document.removeEventListener('touchmove', cancelPinch);
    };
  }, []);
}
