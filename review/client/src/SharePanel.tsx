import { useState } from 'react';
import { api } from './api';
import CopyLink from './CopyLink';

export interface ShareState {
  shareToken?: string | null;
  hasPassword?: boolean;
}

/**
 * A client link shows one album and nothing else. The token is minted on first
 * share and never changes, so a link already sent keeps working through password
 * changes.
 */
export default function SharePanel({
  albumId,
  state,
  projectHasPassword,
  onSaved,
}: {
  albumId: string;
  state: ShareState;
  projectHasPassword: boolean;
  onSaved: (s: ShareState) => void;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const link = state.shareToken ? `${location.origin}/a/${state.shareToken}` : null;

  async function save(password: string | null | undefined) {
    setBusy(true);
    try {
      const res = await api<{ shareToken: string; hasPassword: boolean }>(
        `/api/admin/albums/${albumId}/share`,
        { method: 'POST', body: JSON.stringify(password === undefined ? {} : { password }) },
      );
      setPw('');
      onSaved(res);
    } finally {
      setBusy(false);
    }
  }

  const unprotected = projectHasPassword
    ? 'No album password — uses the project password.'
    : 'No password — anyone with the link can view.';

  return (
    <div className="share-panel" onClick={(e) => e.stopPropagation()}>
      {!link ? (
        <>
          <p className="meta" style={{ margin: '0 0 12px' }}>
            A client link shows only this album. They can't see or reach anything else in the project.
          </p>
          <div className="share-row">
            <input type="text" placeholder="Password (optional)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <button disabled={busy} onClick={() => save(pw.trim() || undefined)}>Create client link</button>
          </div>
        </>
      ) : (
        <>
          <CopyLink url={link} />
          <p className="meta" style={{ margin: '12px 0 8px' }}>
            {state.hasPassword ? 'Protected with its own password.' : unprotected}
          </p>
          <div className="share-row">
            <input type="text" placeholder={state.hasPassword ? 'New password' : 'Add a password'}
              value={pw} onChange={(e) => setPw(e.target.value)} />
            <button className="ghost" disabled={busy || !pw.trim()} onClick={() => save(pw.trim())}>
              {state.hasPassword ? 'Change' : 'Set'}
            </button>
            {state.hasPassword && (
              <button className="ghost" disabled={busy} onClick={() => save(null)}>Remove</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
