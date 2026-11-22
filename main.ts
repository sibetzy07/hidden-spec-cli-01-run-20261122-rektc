// mend: apply AI-written edits in four formats to a tree of text files.
// SPEC.md (version 1) is the whole contract. Node 22+, standard library only.

import { readdirSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`,
 *  and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t\r]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function trimTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Split text at `\n`, each line with one trailing `\r` removed, without the
 *  empty piece after a final `\n`. */
function splitLines(text: string): string[] {
  const raw = text.split('\n');
  const lines = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// File model (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileState {
  eol: '\r\n' | '\n';
  lines: string[];
  endsWithBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { eol: '\n', lines: [], endsWithBreak: false };
  const firstLf = text.indexOf('\n');
  const eol: '\r\n' | '\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(eol);
  const parts = text.split(eol);
  if (endsWithBreak) parts.pop();
  return { eol, lines: parts, endsWithBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.endsWithBreak ? f.eol : '');
}

function normState(f: FileState): FileState {
  if (f.lines.length === 0) return { eol: f.eol, lines: [], endsWithBreak: false };
  return f;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimTrailing(s);
  return trimBoth(s);
}

interface Found {
  tier: number;
  positions: number[];
}

/** First tier (0, 1, 2; only 0 when strict) at which `pat` occurs at least
 *  once in `lines`, with every occurrence position. */
function findOccurrences(lines: string[], pat: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = pat.map((s) => normLine(s, t));
    const pos: number[] = [];
    for (let i = from; i + p.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < p.length; j++) {
        if (normLine(lines[i + j], t) !== p[j]) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** First line at or after `from` equal to `anchor` (a single line) at the
 *  first tier where one is, else -1. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i], t) === a) return i;
    }
  }
  return -1;
}

interface NewItem {
  text: string;
  /** index into O of the context line this replaces, or null for a new line */
  ctx: number | null;
}

/** Replace O (at `pos`, length `oLen`) by N. Context lines of N are written
 *  as the file's own matched lines; at tier 2 every other line of N is
 *  re-indented from O's first line's leading whitespace to the file's. */
function spliceReplace(
  lines: string[],
  pos: number,
  oLen: number,
  nItems: NewItem[],
  tier: number,
  oFirst: string,
): string[] {
  const F = leadingWs(lines[pos] ?? '');
  const P = leadingWs(oFirst);
  const out: string[] = [];
  for (const it of nItems) {
    if (it.ctx !== null) {
      out.push(lines[pos + it.ctx]);
    } else {
      let t = it.text;
      if (tier === 2 && t.length > 0 && !/^[ \t]+$/.test(t) && t.startsWith(P)) {
        t = F + t.slice(P.length);
      }
      out.push(t);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + oLen)];
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

type Tree = Map<string, FileState>;

interface ApplyResult {
  ok: boolean;
  code?: string;
  path?: string;
  move?: [string, string];
}

interface Edit {
  apply(tree: Tree, strict: boolean): ApplyResult;
}

function fail(code: string, path: string): ApplyResult {
  return { ok: false, code, path };
}

function ok(move?: [string, string]): ApplyResult {
  return { ok: true, move };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';

interface BodyLine {
  kind: BodyKind;
  text: string;
}

interface UniHunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null; // null = /dev/null
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string): { a: number } | null {
  const m = HUNK_RE.exec(line);
  if (!m) return null;
  return { a: parseInt(m[1], 10) };
}

/** Path after `--- ` / `+++ `: text after the four characters, up to the first
 *  tab, with surrounding spaces removed; `/dev/null` means no file; a leading
 *  `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  interface Builder extends UniSection {
    pairOld: string | null;
    pairNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    diffOld: string | null;
    diffNew: string | null;
    pairSeen: boolean;
  }
  const sections: UniSection[] = [];
  let cur: Builder | null = null;
  let curHunk: UniHunk | null = null;
  let state: 'outside' | 'header' | 'body' | 'postbody' = 'outside';

  const fresh = (): Builder => ({
    oldPath: null, newPath: null, newFile: false, deletedFile: false, hunks: [],
    pairOld: null, pairNew: null, renameFrom: null, renameTo: null,
    diffOld: null, diffNew: null, pairSeen: false,
  });

  const finishBody = (): void => {
    if (curHunk) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1];
        if (last.kind === 'ctx' && last.text === '') curHunk.body.pop();
        else break;
      }
      curHunk = null;
    }
  };

  const finishSection = (): void => {
    finishBody();
    if (cur) {
      cur.oldPath = cur.pairOld ?? cur.renameFrom ?? cur.diffOld;
      cur.newPath = cur.pairNew ?? cur.renameTo ?? cur.diffNew;
      sections.push(cur);
      cur = null;
    }
  };

  const startFromDiff = (line: string, lineNo: number): void => {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (!m) throw new ParseError(lineNo);
    finishSection();
    cur = fresh();
    cur.diffOld = m[1];
    cur.diffNew = m[2];
    state = 'header';
  };

  const startFromPair = (oldLine: string, newLine: string): void => {
    finishSection();
    cur = fresh();
    cur.pairOld = headerPath(oldLine);
    cur.pairNew = headerPath(newLine);
    cur.pairSeen = true;
    state = 'header';
  };

  const startHunk = (line: string, lineNo: number): void => {
    const h = parseHunkHeader(line);
    if (!h) throw new ParseError(lineNo);
    finishBody();
    curHunk = { a: h.a, body: [] };
    cur!.hunks.push(curHunk);
    state = 'body';
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        startFromDiff(line, i + 1);
        i++;
      } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        startFromPair(line, lines[i + 1]);
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new ParseError(i + 1);
      } else {
        i++;
      }
    } else if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        startFromDiff(line, i + 1);
        i++;
      } else if (line.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          if (!cur!.pairSeen) {
            cur!.pairOld = headerPath(line);
            cur!.pairNew = headerPath(lines[i + 1]);
            cur!.pairSeen = true;
            i += 2;
          } else {
            startFromPair(line, lines[i + 1]);
            i += 2;
          }
        } else {
          throw new ParseError(i + 2);
        }
      } else if (line.startsWith('@@')) {
        startHunk(line, i + 1);
        i++;
      } else if (line.startsWith('rename from ')) {
        if (cur!.renameFrom === null) cur!.renameFrom = line.slice('rename from '.length).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        if (cur!.renameTo === null) cur!.renameTo = line.slice('rename to '.length).trim();
        i++;
      } else if (line.startsWith('new file mode')) {
        cur!.newFile = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        cur!.deletedFile = true;
        i++;
      } else {
        i++;
      }
    } else if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        finishBody();
        startFromDiff(line, i + 1);
        i++;
      } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        finishBody();
        startFromPair(line, lines[i + 1]);
        i += 2;
      } else if (line.startsWith('@@')) {
        startHunk(line, i + 1);
        i++;
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line === '') curHunk!.body.push({ kind: 'ctx', text: '' });
        else if (line[0] === ' ') curHunk!.body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line[0] === '-') curHunk!.body.push({ kind: 'old', text: line.slice(1) });
        else if (line[0] === '+') curHunk!.body.push({ kind: 'new', text: line.slice(1) });
        else curHunk!.body.push({ kind: 'bs', text: line });
        i++;
      } else {
        finishBody();
        state = 'postbody';
      }
    } else {
      // postbody: after a hunk body, prose is ignored
      if (line.startsWith('diff --git ')) {
        startFromDiff(line, i + 1);
        i++;
      } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        startFromPair(line, lines[i + 1]);
        i += 2;
      } else if (line.startsWith('@@')) {
        startHunk(line, i + 1);
        i++;
      } else {
        i++;
      }
    }
  }
  finishSection();
  return sections;
}

/** Split a hunk body into O (context + `-` lines) and N (context + `+`
 *  lines); a context entry of N records its index in O. */
function hunkItems(h: UniHunk): { o: string[]; n: NewItem[] } {
  const o: string[] = [];
  const n: NewItem[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/** Index of the hunk's last context or `+` body line, or -1. */
function lastOutIndex(h: UniHunk): number {
  for (let k = h.body.length - 1; k >= 0; k--) {
    if (h.body[k].kind === 'ctx' || h.body[k].kind === 'new') return k;
  }
  return -1;
}

/** Whether a `\` line immediately follows that last context or `+` line. */
function hasNoEolMarker(h: UniHunk): boolean {
  const k = lastOutIndex(h);
  if (k === -1) return false;
  const next = h.body[k + 1];
  return next !== undefined && next.kind === 'bs';
}

/** Apply a section's hunks in order to `file`'s lines. */
function applyHunks(file: FileState, hunks: UniHunk[], strict: boolean): FileState | null {
  let lines = [...file.lines];
  let endsWithBreak = file.endsWithBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkItems(h);
    if (o.length === 0) {
      const ins = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = ins === lines.length;
      lines = [...lines.slice(0, ins), ...n.map((it) => it.text), ...lines.slice(ins)];
      if (atEnd) endsWithBreak = !hasNoEolMarker(h);
      d += n.length;
      continue;
    }
    const found = findOccurrences(lines, o, strict);
    if (!found) return null;
    const target = h.a - 1 + d;
    let best = found.positions[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const touchesEnd = best + o.length === lines.length;
    lines = spliceReplace(lines, best, o.length, n, found.tier, o[0]);
    if (touchesEnd) endsWithBreak = !hasNoEolMarker(h);
    d += n.length - o.length;
  }
  return normState({ eol: file.eol, lines, endsWithBreak });
}

class UnifiedEdit implements Edit {
  private sec: UniSection;
  constructor(sec: UniSection) {
    this.sec = sec;
  }

  apply(tree: Tree, strict: boolean): ApplyResult {
    const s = this.sec;
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && !isSafePath(oldP)) return fail('unsafe', oldP);
    if (newP !== null && !isSafePath(newP)) return fail('unsafe', newP);
    const isCreate = oldP === null || s.newFile;
    if (isCreate) {
      if (newP === null) return fail('unsafe', '/dev/null');
      if (tree.has(newP)) return fail('exists', newP);
      const plus: string[] = [];
      let lastPlusHunk: UniHunk | null = null;
      let lastPlusIdx = -1;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k].kind === 'new') {
            plus.push(h.body[k].text);
            lastPlusHunk = h;
            lastPlusIdx = k;
          }
        }
      }
      if (plus.length === 0) {
        tree.set(newP, { eol: '\n', lines: [], endsWithBreak: false });
        return ok();
      }
      let endsWithBreak = true;
      if (lastPlusHunk) {
        const next = lastPlusHunk.body[lastPlusIdx + 1];
        if (next !== undefined && next.kind === 'bs') endsWithBreak = false;
      }
      tree.set(newP, { eol: '\n', lines: plus, endsWithBreak });
      return ok();
    }
    const isDelete = newP === null || s.deletedFile;
    if (isDelete) {
      if (oldP === null || !tree.has(oldP)) return fail('missing', oldP ?? '/dev/null');
      tree.delete(oldP);
      return ok();
    }
    if (oldP !== newP) {
      // move
      if (!tree.has(oldP!)) return fail('missing', oldP!);
      if (tree.has(newP!)) return fail('exists', newP!);
      const done = applyHunks(tree.get(oldP!)!, s.hunks, strict);
      if (done === null) return fail('no-match', oldP!);
      tree.delete(oldP!);
      tree.set(newP!, done);
      return ok([oldP!, newP!]);
    }
    // change
    if (!tree.has(oldP!)) return fail('missing', oldP!);
    const done = applyHunks(tree.get(oldP!)!, s.hunks, strict);
    if (done === null) return fail('no-match', oldP!);
    tree.set(oldP!, done);
    return ok();
  }
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let i = 0;
  while (i < lines.length) {
    if (stripTrailingWs(lines[i]) === '<<<<<<< SEARCH') {
      const s = i;
      let j = s + 1;
      while (j < lines.length && stripTrailingWs(lines[j]) !== '=======') j++;
      if (j >= lines.length) throw new ParseError(s + 1);
      let k = j + 1;
      while (k < lines.length && stripTrailingWs(lines[k]) !== '>>>>>>> REPLACE') k++;
      if (k >= lines.length) throw new ParseError(s + 1);
      const oldLines = lines.slice(s + 1, j);
      const newLines = lines.slice(j + 1, k);
      let path: string | null = null;
      for (let p = s - 1; p > prevEnd; p--) {
        const t = lines[p].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1].path;
        else throw new ParseError(s + 1);
      }
      blocks.push({ path, oldLines, newLines });
      prevEnd = k;
      i = k + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

class SREdit implements Edit {
  private block: SRBlock;
  constructor(block: SRBlock) {
    this.block = block;
  }

  apply(tree: Tree, strict: boolean): ApplyResult {
    const b = this.block;
    if (!isSafePath(b.path)) return fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.has(b.path)) return fail('exists', b.path);
      tree.set(b.path, {
        eol: '\n',
        lines: [...b.newLines],
        endsWithBreak: b.newLines.length > 0,
      });
      return ok();
    }
    const f = tree.get(b.path);
    if (!f) return fail('missing', b.path);
    const found = findOccurrences(f.lines, b.oldLines, strict);
    if (!found) return fail('no-match', b.path);
    if (found.positions.length > 1) return fail('ambiguous', b.path);
    const pos = found.positions[0];
    const nItems: NewItem[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const newLines = spliceReplace(f.lines, pos, b.oldLines.length, nItems, found.tier, b.oldLines[0]);
    tree.set(b.path, normState({ ...f, lines: newLines }));
    return ok();
  }
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

type V4AKind = 'add' | 'delete' | 'update';

interface V4AChunk {
  anchor: string; // '' = no anchor
  eof: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: V4AKind;
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
  lineNo: number; // the `*** Update File:` line, for the no-chunk error
}

function parseV4A(lines: string[]): V4ASection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { last = i; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  interface RawSection {
    kind: V4AKind;
    path: string;
    lineNo: number;
    raw: { text: string; lineNo: number }[];
  }

  const interpret = (cur: RawSection): V4ASection => {
    const raw = [...cur.raw];
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
    if (cur.kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new ParseError(r.lineNo);
      }
      return { kind: 'add', path: cur.path, moveTo: null, addLines, chunks: [], lineNo: cur.lineNo };
    }
    if (cur.kind === 'delete') {
      if (raw.length > 0) throw new ParseError(raw[0].lineNo);
      return { kind: 'delete', path: cur.path, moveTo: null, addLines: [], chunks: [], lineNo: cur.lineNo };
    }
    // update
    let moveTo: string | null = null;
    const chunks: V4AChunk[] = [];
    let chunk: V4AChunk | null = null;
    let idx = 0;
    if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
      moveTo = raw[0].text.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    for (; idx < raw.length; idx++) {
      const r = raw[idx];
      const t = r.text;
      if (t === '*** End of File') {
        if (!chunk) throw new ParseError(r.lineNo);
        chunk.eof = true;
        chunk = null;
        continue;
      }
      if (t.startsWith('@@')) {
        chunk = { anchor: t.slice(2).trim(), eof: false, body: [] };
        chunks.push(chunk);
        continue;
      }
      if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
        if (!chunk) {
          if (chunks.length > 0) throw new ParseError(r.lineNo);
          chunk = { anchor: '', eof: false, body: [] };
          chunks.push(chunk);
        }
        if (t === '') chunk.body.push({ kind: 'ctx', text: '' });
        else if (t[0] === ' ') chunk.body.push({ kind: 'ctx', text: t.slice(1) });
        else if (t[0] === '-') chunk.body.push({ kind: 'old', text: t.slice(1) });
        else chunk.body.push({ kind: 'new', text: t.slice(1) });
        continue;
      }
      throw new ParseError(r.lineNo);
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseError(cur.lineNo);
    return { kind: 'update', path: cur.path, moveTo, addLines: [], chunks, lineNo: cur.lineNo };
  };

  const sections: V4ASection[] = [];
  let cur: RawSection | null = null;
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      if (cur) sections.push(interpret(cur));
      const kind: V4AKind = line.startsWith('*** Add File: ')
        ? 'add'
        : line.startsWith('*** Delete File: ')
          ? 'delete'
          : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: line.slice(prefix.length).trim(), lineNo: i + 1, raw: [] };
      i++;
    } else if (line.trim() === '') {
      if (cur) cur.raw.push({ text: line, lineNo: i + 1 });
      i++;
    } else {
      if (!cur) throw new ParseError(i + 1);
      cur.raw.push({ text: line, lineNo: i + 1 });
      i++;
    }
  }
  if (cur) sections.push(interpret(cur));
  return sections;
}

function chunkItems(ch: V4AChunk): { o: string[]; n: NewItem[] } {
  const o: string[] = [];
  const n: NewItem[] = [];
  for (const b of ch.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

class V4AEdit implements Edit {
  private sec: V4ASection;
  constructor(sec: V4ASection) {
    this.sec = sec;
  }

  apply(tree: Tree, strict: boolean): ApplyResult {
    const s = this.sec;
    if (!isSafePath(s.path)) return fail('unsafe', s.path);
    if (s.moveTo !== null && !isSafePath(s.moveTo)) return fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.has(s.path)) return fail('exists', s.path);
      tree.set(s.path, {
        eol: '\n',
        lines: [...s.addLines],
        endsWithBreak: s.addLines.length > 0,
      });
      return ok();
    }
    if (s.kind === 'delete') {
      if (!tree.has(s.path)) return fail('missing', s.path);
      tree.delete(s.path);
      return ok();
    }
    const f = tree.get(s.path);
    if (!f) return fail('missing', s.path);
    if (s.moveTo !== null && tree.has(s.moveTo)) return fail('exists', s.moveTo);
    let lines = [...f.lines];
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== '') {
        const idx = findAnchor(lines, ch.anchor, cursor, strict);
        if (idx === -1) return fail('no-match', s.path);
        cursor = idx + 1;
      }
      const { o, n } = chunkItems(ch);
      if (o.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, ins), ...n.map((it) => it.text), ...lines.slice(ins)];
        cursor = ins + n.length;
        continue;
      }
      const found = findOccurrences(lines, o, strict, cursor);
      if (!found) return fail('no-match', s.path);
      let pos = -1;
      if (ch.eof) {
        for (const p of found.positions) {
          if (p + o.length === lines.length) { pos = p; break; }
        }
        if (pos === -1) return fail('no-match', s.path);
      } else {
        pos = found.positions[0];
      }
      lines = spliceReplace(lines, pos, o.length, n, found.tier, o[0]);
      cursor = pos + n.length;
    }
    const done = normState({ eol: f.eol, lines, endsWithBreak: f.endsWithBreak });
    if (s.moveTo !== null) {
      tree.delete(s.path);
      tree.set(s.moveTo, done);
      return ok([s.path, s.moveTo]);
    }
    tree.set(s.path, done);
    return ok();
  }
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

interface JsonEditData {
  path: string;
  command: 'create' | 'str_replace' | 'insert';
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

function validateJsonEdit(el: unknown): JsonEditData | null {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) return null;
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { path: o.path, command: 'create', file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'str_replace', old_str: o.old_str, new_str: o.new_str ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'insert', insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJsonPatch(text: string, lines: string[]): JsonEditData[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const firstNonWs = lines[firstIdx].trimStart();
  if (firstNonWs.startsWith('[')) {
    // One JSON array of edit objects; any fault is the line where it starts.
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    const edits: JsonEditData[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (!e) throw new ParseError(firstIdx + 1);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: JsonEditData[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (!e) throw new ParseError(i + 1);
    edits.push(e);
  }
  return edits;
}

class JsonEdit implements Edit {
  private data: JsonEditData;
  constructor(data: JsonEditData) {
    this.data = data;
  }

  apply(tree: Tree): ApplyResult {
    const e = this.data;
    if (!isSafePath(e.path)) return fail('unsafe', e.path);
    if (e.command === 'create') {
      if (tree.has(e.path)) return fail('exists', e.path);
      tree.set(e.path, parseFile(e.file_text!));
      return ok();
    }
    if (e.command === 'str_replace') {
      const f = tree.get(e.path);
      if (!f) return fail('missing', e.path);
      const raw = serializeFile(f);
      const isCrlf = f.eol === '\r\n';
      let text = raw;
      let oldS = e.old_str!;
      let newS = e.new_str!;
      if (isCrlf) {
        text = raw.replace(/\r\n/g, '\n');
        oldS = oldS.replace(/\r\n/g, '\n');
        newS = newS.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let firstIdx = -1;
      let idx = 0;
      for (;;) {
        const p = text.indexOf(oldS, idx);
        if (p === -1) break;
        count++;
        if (firstIdx === -1) firstIdx = p;
        idx = p + 1;
      }
      if (count === 0) return fail('no-match', e.path);
      if (count > 1) return fail('ambiguous', e.path);
      let result = text.slice(0, firstIdx) + newS + text.slice(firstIdx + oldS.length);
      if (isCrlf) result = result.replace(/\n/g, '\r\n');
      tree.set(e.path, parseFile(result));
      return ok();
    }
    // insert
    const f = tree.get(e.path);
    if (!f) return fail('missing', e.path);
    const ins = e.insert_line!;
    if (ins < 0 || ins > f.lines.length) return fail('no-match', e.path);
    const newLines = e.new_str === '' ? [] : splitLines(e.new_str!);
    const lines = [...f.lines.slice(0, ins), ...newLines, ...f.lines.slice(ins)];
    tree.set(e.path, normState({ ...f, lines }));
    return ok();
  }
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first].trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  for (const l of lines) {
    if (stripTrailingWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function parsePatch(fmt: string, text: string, lines: string[]): Edit[] {
  if (fmt === 'unified') return parseUnified(lines).map((s) => new UnifiedEdit(s));
  if (fmt === 'search-replace') return parseSearchReplace(lines).map((b) => new SREdit(b));
  if (fmt === 'v4a') return parseV4A(lines).map((s) => new V4AEdit(s));
  return parseJsonPatch(text, lines).map((e) => new JsonEdit(e));
}

// ---------------------------------------------------------------------------
// Tree IO and output (SPEC sections 2 and 10)
// ---------------------------------------------------------------------------

function loadTree(root: string): Tree {
  const out: Tree = new Map();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, prefix + name + '/');
      else if (st.isFile()) out.set(prefix + name, parseFile(readFileSync(p, 'utf8')));
    }
  };
  walk(root, '');
  return out;
}

function computeChanges(initial: Tree, finalTree: Tree, moves: [string, string][]): string[] {
  const out: { key: string; text: string }[] = [];
  const coveredD = new Set<string>();
  const coveredA = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (initial.has(oldP) && !finalTree.has(oldP) && !initial.has(newP) && finalTree.has(newP)) {
      out.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      coveredD.add(oldP);
      coveredA.add(newP);
    }
  }
  const all = new Set([...initial.keys(), ...finalTree.keys()]);
  for (const p of all) {
    const before = initial.get(p);
    const after = finalTree.get(p);
    if (before === undefined && after !== undefined) {
      if (!coveredA.has(p)) out.push({ key: p, text: `A ${p}` });
    } else if (before !== undefined && after === undefined) {
      if (!coveredD.has(p)) out.push({ key: p, text: `D ${p}` });
    } else if (before !== undefined && after !== undefined) {
      if (serializeFile(before) !== serializeFile(after)) out.push({ key: p, text: `M ${p}` });
    }
  }
  out.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return out.map((r) => r.text);
}

function writeTree(root: string, initial: Tree, finalTree: Tree): void {
  for (const p of initial.keys()) {
    if (!finalTree.has(p)) {
      try {
        rmSync(join(root, ...p.split('/')), { force: true });
      } catch {
        // leave it; the check compares files afterwards
      }
    }
  }
  for (const [p, state] of finalTree) {
    const before = initial.get(p);
    if (before !== undefined && serializeFile(before) === serializeFile(state)) continue;
    const f = join(root, ...p.split('/'));
    try {
      if (statSync(f).isDirectory()) rmSync(f, { recursive: true, force: true });
    } catch {
      // not there, or not a directory
    }
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, serializeFile(state), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Command line (SPEC sections 1 and 2)
// ---------------------------------------------------------------------------

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function out2(text: string): number {
  process.stdout.write(text);
  return 2;
}

function runCli(argv: string[]): number {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return out2('error: usage\n');
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return out2('error: usage\n');
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return out2('error: usage\n');
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (!FORMATS.includes(v)) return out2('error: usage\n');
        format = v;
      } else {
        return out2('error: usage\n');
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return out2('error: usage\n');
  const patchArg = positional.length === 1 ? positional[0] : null;

  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return out2('error: no-patch\n');
    }
  }

  const lines = splitLines(patchText);
  const fmt = format ?? detectFormat(lines);
  if (fmt === null) return out2('error: format\n');

  let edits: Edit[];
  try {
    edits = parsePatch(fmt, patchText, lines);
  } catch (e) {
    if (e instanceof ParseError) return out2(`error: parse ${e.line}\n`);
    throw e;
  }
  if (edits.length === 0) return out2('error: parse 1\n');

  const initial = loadTree(process.cwd());
  const tree: Tree = new Map(initial);
  const failures: { code: string; path: string }[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const r = edit.apply(tree, strict);
    if (!r.ok) failures.push({ code: r.code!, path: r.path! });
    else if (r.move) moves.push(r.move);
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }

  const changeLines = computeChanges(initial, tree, moves);
  if (!check) writeTree(process.cwd(), initial, tree);
  let out = '';
  for (const l of changeLines) out += `${l}\n`;
  out += changeLines.length === 1 ? 'ok: 1 file\n' : `ok: ${changeLines.length} files\n`;
  process.stdout.write(out);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point: hand a trial over to the kit's runner when MAKEFUN_ENV_URL is
// set, else run as the CLI.
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  runTrial(process.env.MAKEFUN_ENV_URL).then(
    () => {
      process.exitCode = 0;
    },
    (err: unknown) => {
      process.stderr.write(`trial failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
} else {
  process.exitCode = runCli(process.argv.slice(2));
}
