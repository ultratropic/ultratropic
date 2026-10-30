/**
 * Which product this deployment is: the studio's internal tool (Ultratropic
 * wordmark, password sign-in) or the public product (its name, email sign-in).
 * Fetched once before the first render.
 */
export const brand: { mode: 'internal' | 'public'; product: string } = { mode: 'internal', product: 'Review' };

export async function loadBrand(): Promise<void> {
  try {
    const r = await fetch('/api/config');
    if (r.ok) Object.assign(brand, await r.json());
  } catch { /* offline or older server: stay internal */ }
  if (brand.mode === 'public') document.title = brand.product;
}
