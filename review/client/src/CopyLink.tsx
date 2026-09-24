import { useState } from 'react';

/** The whole URL, visible, and one click puts it on the clipboard. */
export default function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Older Safari, or a page not served over https: fall back to a selection copy.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button type="button" className={`copy-link${copied ? ' copied' : ''}`} onClick={copy} title="Click to copy">
      <span className="copy-url mono">{url}</span>
      <span className="copy-hint">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
