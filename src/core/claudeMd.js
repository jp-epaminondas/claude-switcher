'use strict';

// The global CLAUDE.md as removable pieces: sections (headings, with everything under them)
// and items (a list item with its continuation, a paragraph, a code block). Rules joined from
// the project memories go in a "Preferências" section.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsutil');

const PREFS_TITLE = 'Preferências';
const KEEP_BACKUPS = 20;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST = /^ ?(?:[-*+]|\d+[.)])\s/; // top level only; deeper indents belong to the item above
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const blank = (l) => !l || !l.trim();

const claudeMdPath = (paths) => path.join(paths.configDir, 'CLAUDE.md');

function readClaudeMd(paths) {
  try {
    return fs.readFileSync(claudeMdPath(paths), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

// Keeps a copy of what is being replaced, then writes.
async function writeClaudeMd(paths, switcherDir, text) {
  const file = claudeMdPath(paths);
  if (fs.existsSync(file)) {
    const dir = path.join(switcherDir, 'memory-backup', 'CLAUDE.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${stamp()}.md`));
    const old = fs.readdirSync(dir).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(dir, f));
  }
  await writeFileAtomic(file, text);
}

const stamp = (t = Date.now()) => new Date(t).toISOString().replace(/[:.]/g, '-');

function parseClaudeMd(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const open = []; // sections still collecting lines
  const close = (level, end) => {
    while (open.length && open[open.length - 1].level >= level) {
      const s = open.pop();
      s.end = Math.max(s.start, end);
      s.text = lines.slice(s.start, s.end + 1).join('\n');
    }
  };
  const parent = () => open[open.length - 1] || null;
  const startsBlock = (l) => HEADING.test(l) || LIST.test(l) || FENCE.test(l);

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      close(h[1].length, i - 1);
      const s = { kind: 'section', level: h[1].length, title: h[2], start: i, parent: parent() };
      open.push(s);
      blocks.push(s);
      i++;
      continue;
    }
    let end = i;
    const fence = FENCE.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      end = i + 1;
      while (end < lines.length && !closing.test(lines[end])) end++;
      end = Math.min(end, lines.length - 1);
    } else if (LIST.test(line)) {
      // Continues until a blank line, another block or the next item; indented lines after a
      // blank one are still part of it (nested lists, code).
      let j = i + 1;
      while (j < lines.length) {
        if (blank(lines[j])) {
          let k = j;
          while (k < lines.length && blank(lines[k])) k++;
          if (k < lines.length && /^\s{2,}\S/.test(lines[k])) {
            j = k;
            continue;
          }
          break;
        }
        if (startsBlock(lines[j])) break;
        j++;
      }
      end = j - 1;
    } else {
      while (end + 1 < lines.length && !blank(lines[end + 1]) && !startsBlock(lines[end + 1])) end++;
    }
    blocks.push({ kind: 'item', start: i, end, text: lines.slice(i, end + 1).join('\n'), parent: parent() });
    i = end + 1;
  }
  close(1, lines.length - 1);
  return { eol, lines, blocks };
}

// What identifies a block across edits: its text, or a section's heading.
const blockKey = (b) => (b.kind === 'section' ? `${b.level}:${b.title}` : b.text);

// Plain view of a block, safe to pass around (no parent links).
const refOf = (b) => ({ kind: b.kind, start: b.start, key: blockKey(b) });

// The block `ref` points to in `doc`, or null when the file changed under it. When the same
// text shows up more than once, the one nearest to where it was wins.
function findBlock(doc, ref) {
  let best = null;
  for (const b of doc.blocks) {
    if (b.kind !== ref.kind || blockKey(b) !== ref.key) continue;
    if (!best || Math.abs(b.start - ref.start) < Math.abs(best.start - ref.start)) best = b;
  }
  return best;
}

// Rule text without the list marker and with spaces collapsed, to compare rules.
const normalizeRule = (s) =>
  String(s)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

// `text` without the block, or null when it isn't there any more.
function removeBlock(text, ref) {
  const doc = parseClaudeMd(text);
  const b = findBlock(doc, ref);
  if (!b) return null;
  const lines = doc.lines.slice();
  lines.splice(b.start, b.end - b.start + 1);
  tidy(lines, b.start);
  return lines.join(doc.eol);
}

// `text` without the Preferências section once nothing is left in it.
function dropEmptyPrefs(text) {
  const doc = parseClaudeMd(text);
  const sec = doc.blocks.find((b) => b.kind === 'section' && b.title.trim().toLowerCase() === PREFS_TITLE.toLowerCase());
  if (!sec || doc.blocks.some((b) => b.parent === sec)) return text;
  return removeBlock(text, refOf(sec)) ?? text;
}

// No two blank lines where a block was cut out, no blank lines at the top, and at most one
// line break at the end.
function tidy(lines, at) {
  if (at === 0) while (lines.length && blank(lines[0])) lines.shift();
  else while (at < lines.length && blank(lines[at]) && blank(lines[at - 1])) lines.splice(at, 1);
  while (lines.length > 1 && blank(lines[lines.length - 1]) && blank(lines[lines.length - 2])) lines.pop();
}

// `text` with `rule` as the last item of section `title` (Preferências by default), created
// at the end when missing. Unchanged when the same rule is already in that section.
function addRule(text, rule, title = PREFS_TITLE) {
  const bullet = `- ${normalizeRule(rule)}`;
  const doc = parseClaudeMd(text);
  const lines = doc.lines.slice();
  const sec = doc.blocks.find((b) => b.kind === 'section' && b.title.trim().toLowerCase() === String(title).trim().toLowerCase());
  if (!sec) {
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    if (lines.length) lines.push('');
    lines.push(`# ${String(title).trim()}`, '', bullet, '');
    return lines.join(doc.eol);
  }
  const inSection = doc.blocks.filter((b) => b.kind === 'item' && b.start > sec.start && b.end <= sec.end);
  if (inSection.some((b) => normalizeRule(b.text) === normalizeRule(rule))) return text;
  let at = sec.end;
  while (at > sec.start && blank(lines[at])) at--;
  if (at === sec.start) lines.splice(at + 1, 0, '', bullet);
  else lines.splice(at + 1, 0, bullet);
  return lines.join(doc.eol);
}

// The item whose text is `rule` (list marker and spacing aside), anywhere in the file.
function findItem(text, rule) {
  const want = normalizeRule(rule);
  return parseClaudeMd(text).blocks.find((b) => b.kind === 'item' && normalizeRule(b.text) === want) || null;
}

module.exports = {
  PREFS_TITLE,
  findItem,
  claudeMdPath,
  readClaudeMd,
  writeClaudeMd,
  parseClaudeMd,
  findBlock,
  refOf,
  blockKey,
  removeBlock,
  dropEmptyPrefs,
  addRule,
  normalizeRule,
  stamp,
};
