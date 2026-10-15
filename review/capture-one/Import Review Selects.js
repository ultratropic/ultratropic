// Import Review Selects — a Capture One script (JavaScript for Automation).
//
// Reads the CSV (or plain filename list) exported from review.ultra-tropic.com
// and brings those picks into the open Capture One session or catalog:
//   - always: an album group named after the export, with "All selects" plus
//     one album per person. Nothing that already exists is changed.
//   - if chosen: star rating = how many people picked the frame (max 5), and/or
//     a green colour tag on every select. Both overwrite existing values.
//
// Frames are matched on filename without extension, ignoring case and the
// " 1" / " copy" suffix macOS adds to duplicates, so a web JPEG finds its RAW.
// When a frame exists as both RAW and JPEG, the RAW is used.
//
// Install: Capture One → Scripts → Open Scripts Folder, put the compiled .scpt
// there, then Scripts → Update Scripts Menu.

ObjC.import('Foundation');

const APP_NAME = 'Capture One';
const GREEN = 4;          // Capture One colour tags: 1 red, 2 orange, 3 yellow, 4 green, 5 blue, 6 pink, 7 purple
const JPEG_EXT = /\.(jpe?g|png|tiff?|heic|webp)$/i;
const COPY_SUFFIX = /^(.*\d)(?: \d{1,2}| copy(?: \d{1,2})?)$/i;   // same rule as the web app

const stripExt = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; };
const rawKey = (n) => { const b = stripExt(n); const m = b.match(COPY_SUFFIX); return (m ? m[1] : b).toLowerCase(); };

function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** The export as frames: [{ key, filename, pickers: [names] }]. */
function readExport(path) {
  const ns = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (ns.isNil()) throw new Error('Could not read that file as text.');
  const text = ObjC.unwrap(ns).replace(/^﻿/, '');
  const rows = parseCSV(text);
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);

  if (col('filename') >= 0) {
    const f = col('filename'), r = col('raw_match'), s = col('selected_by');
    return rows.slice(1).map((row) => ({
      filename: row[f],
      key: (r >= 0 && row[r] ? row[r] : rawKey(row[f])).toLowerCase(),
      // Names were written with a leading ' if they started with = + - @ (spreadsheet safety).
      pickers: s >= 0 && row[s] ? row[s].split(';').map((n) => n.trim().replace(/^'(?=[=+\-@])/, '')).filter(Boolean) : [],
    }));
  }
  // The plain "Filenames" export: one filename per line, no people.
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((filename) => ({ filename, key: rawKey(filename), pickers: [] }));
}

/** Every variant in a collection, fetched in bulk (one Apple event per property). */
function variantsIn(coll) {
  const vs = coll.variants;
  const names = vs.name();
  const ids = vs.id();
  return names.map((name, i) => ({ name, id: ids[i], ref: vs.at(i) }));
}

function allCollections(parent, out = []) {
  for (const c of parent.collections()) {
    let kind = '';
    try { kind = c.kind(); } catch (e) { /* some built-ins don't report a kind */ }
    if (kind === 'smart album') continue; // derived from folders we visit anyway, and can be slow
    out.push(c);
    allCollections(c, out);
  }
  return out;
}

function uniqueName(existing, base) {
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) if (!existing.includes(`${base} (${n})`)) return `${base} (${n})`;
}

/**
 * The import itself, without any dialogs. Returns the summary lines.
 * opts: { albums, rating, green }
 */
function importSelects(c1, doc, path, opts) {
  path = String(path);
  const exportName = stripExt(path.split('/').pop());
  const frames = readExport(path);
  if (!frames.length) return ['That file has no selects in it.'];

  // Find the frames: what's on screen first, then the rest of the document.
  const wanted = new Set(frames.map((f) => f.key));
  const byKey = new Map();   // key -> best variant so far
  const seen = new Set();
  const consider = (v) => {
    if (seen.has(v.id)) return;
    seen.add(v.id);
    const key = rawKey(v.name);
    if (!wanted.has(key)) return;
    const current = byKey.get(key);
    // Prefer the RAW over a JPEG (or other rendered file) of the same frame.
    if (!current || (JPEG_EXT.test(current.name) && !JPEG_EXT.test(v.name))) byKey.set(key, v);
  };
  variantsIn(doc.currentCollection()).forEach(consider);
  if ([...wanted].some((k) => !byKey.has(k))) {
    for (const c of allCollections(doc)) {
      try { variantsIn(c).forEach(consider); } catch (e) { /* unreadable built-in collection */ }
      if ([...wanted].every((k) => byKey.has(k))) break;
    }
  }

  const matched = frames.filter((f) => byKey.has(f.key));
  const missing = frames.filter((f) => !byKey.has(f.key));
  if (!matched.length) {
    return [`None of the ${frames.length} selects were found in “${doc.name()}”.`, '',
      `First few: ${frames.slice(0, 5).map((f) => f.filename).join(', ')}`];
  }

  // Albums, grouped under the export's name so repeated imports stay tidy.
  let groupName = '';
  if (opts.albums) {
    groupName = uniqueName(doc.collections.name(), `Review · ${exportName}`);
    doc.collections.push(c1.Collection({ kind: 'group', name: groupName }));
    const g = doc.collections.byName(groupName);

    const albums = [['All selects', matched]];
    const people = [...new Set(matched.flatMap((f) => f.pickers))];
    for (const person of people) albums.push([person, matched.filter((f) => f.pickers.includes(person))]);
    for (const [name, list] of albums) {
      g.collections.push(c1.Collection({ kind: 'album', name }));
      c1.addInside(g.collections.byName(name), { variants: list.map((f) => byKey.get(f.key).ref) });
    }
  }

  for (const f of matched) {
    const v = byKey.get(f.key).ref;
    if (opts.rating) v.rating = Math.min(5, Math.max(1, f.pickers.length || 1));
    if (opts.green) v.colorTag = GREEN;
  }

  const lines = [`Matched ${matched.length} of ${frames.length} selects in “${doc.name()}”.`];
  if (opts.albums) lines.push(`Albums are in the “${groupName}” group.`);
  if (opts.rating) lines.push('Star ratings set to the number of people who picked each frame.');
  if (opts.green) lines.push('Green tags applied.');
  if (missing.length) {
    lines.push('', `Not found (${missing.length}):`, ...missing.slice(0, 12).map((f) => `  ${f.filename}`));
    if (missing.length > 12) lines.push(`  …and ${missing.length - 12} more`);
  }
  return lines;
}

/**
 * From Capture One's Scripts menu: dialogs for the file and the options.
 * From a terminal: osascript -l JavaScript "Import Review Selects.scpt" <file> [albums] [rating] [green]
 * runs without dialogs and prints the summary.
 */
function run(argv) {
  const c1 = Application(APP_NAME);
  // Capture One's Scripts menu passes run() an argument of its own, which isn't a
  // path; only a string naming a file means "from a terminal, no dialogs".
  const headless = Array.isArray(argv) && typeof argv[0] === 'string' && /\.(csv|txt)$/i.test(argv[0]);

  if (headless) {
    if (!c1.running() || c1.documents.length === 0) return 'No session or catalog is open in Capture One.';
    const flags = new Set(argv.slice(1));
    const opts = { albums: flags.size === 0 || flags.has('albums'), rating: flags.has('rating'), green: flags.has('green') };
    return importSelects(c1, c1.documents[0], argv[0], opts).join('\n');
  }

  const sys = Application.currentApplication();
  sys.includeStandardAdditions = true;
  const say = (msg, buttons = ['OK']) =>
    sys.displayDialog(msg, { withTitle: 'Import Review Selects', buttons, defaultButton: buttons[buttons.length - 1] });

  if (!c1.running() || c1.documents.length === 0) {
    say('Open the session or catalog with the shoot in Capture One first.');
    return;
  }
  const doc = c1.documents[0];

  let path;
  try {
    path = sys.chooseFile({ withPrompt: 'Choose the selects exported from Review (CSV or Filenames)' }).toString();
  } catch (e) { return; } // cancelled

  let frames;
  try { frames = readExport(path); } catch (e) { say(e.message); return; }
  if (!frames.length) { say('That file has no selects in it.'); return; }

  const OPT_ALBUMS = 'Albums: All selects + one per person  (safe, changes nothing)';
  const OPT_RATING = 'Star rating = number of people who picked it  (overwrites ratings)';
  const OPT_GREEN = 'Green colour tag on every select  (overwrites tags)';
  const hasPeople = frames.some((f) => f.pickers.length);
  const picked = sys.chooseFromList(hasPeople ? [OPT_ALBUMS, OPT_RATING, OPT_GREEN] : [OPT_ALBUMS, OPT_GREEN], {
    withTitle: 'Import Review Selects',
    withPrompt: `${frames.length} selects in “${stripExt(path.split('/').pop())}”. What should this do?\n(⌘-click to choose more than one)`,
    defaultItems: [OPT_ALBUMS],
    multipleSelectionsAllowed: true,
  });
  if (!picked) return;
  const opts = { albums: picked.includes(OPT_ALBUMS), rating: picked.includes(OPT_RATING), green: picked.includes(OPT_GREEN) };
  if ((opts.rating || opts.green) && say(
    `This will ${[opts.rating && 'set star ratings', opts.green && 'set colour tags'].filter(Boolean).join(' and ')} ` +
    'on the matched frames, replacing whatever they have now. Continue?', ['Cancel', 'Continue'],
  ).buttonReturned !== 'Continue') return;

  try {
    say(importSelects(c1, doc, path, opts).join('\n'));
  } catch (e) {
    say(`Something went wrong: ${e.message}`);
  }
}
