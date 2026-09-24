export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  preview_edge: number;
  has_password: number;
  album_count: number;
  image_count: number;
  reviewer_count: number;
  selected_count: number;
}
