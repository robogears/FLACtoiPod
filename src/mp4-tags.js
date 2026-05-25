// Minimal MP4 / M4A atom toolkit for writing iTunes-style freeform atoms
// (`----:com.apple.iTunes:KEY`). ffmpeg's MP4 muxer doesn't support freeform
// atoms via `-metadata`, and Rockbox / foobar2000 / MusicBee only read
// ReplayGain from these specific atoms — so we write them by hand.
//
// References:
//   - ISO/IEC 14496-12 (MP4 base file format)
//   - Apple "Metadata Item Atoms" docs
//   - mutagen's mp4/__init__.py (algorithm cribbed from)
//
// What we do per file:
//   1. Read whole file (these are small, ≤ ~20MB each, fine for in-memory).
//   2. Walk the box hierarchy to locate moov.udta.meta.ilst; create the path
//      if any link is missing.
//   3. Strip any existing children of ilst whose name matches the keys we're
//      about to write (so we replace, not duplicate).
//   4. Append new `----` atoms for each (mean=com.apple.iTunes, name=KEY, data=VALUE).
//   5. Recompute every parent atom's size up the chain.
//   6. If mdat sits AFTER moov in the file (faststart layout — the default for
//      our converted files), the bytes inside mdat shifted; update every stco
//      / co64 chunk offset in the tree by the moov size delta.
//   7. Write out: ftyp + new_moov + everything-after-old-moov.

'use strict';

const fs = require('fs');

// ─── Low-level box reader ─────────────────────────────────────────────────

// Parse a single box starting at `offset` in `buf`. Returns
// { size, type, headerSize, contentStart, contentEnd, end }.
// `size` is the total bytes the box consumes in the file (including header).
function readBoxHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    // 64-bit extended size
    if (offset + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    // box extends to end of file
    size = buf.length - offset;
  }
  return {
    type,
    size,
    headerSize,
    contentStart: offset + headerSize,
    contentEnd: offset + size,
    end: offset + size,
  };
}

// Iterate all direct child boxes inside [start, end). Calls cb(box) per child.
function eachChildBox(buf, start, end, cb) {
  let p = start;
  while (p < end) {
    const box = readBoxHeader(buf, p);
    if (!box || box.end > end) break;
    cb(box);
    p = box.end;
  }
}

// Find the first child box of a given type within [start, end).
function findChildBox(buf, start, end, type) {
  let found = null;
  eachChildBox(buf, start, end, (box) => {
    if (!found && box.type === type) found = box;
  });
  return found;
}

// ─── Box writer ───────────────────────────────────────────────────────────

function box(type, ...payloadChunks) {
  const typeBuf = Buffer.from(type, 'latin1');
  if (typeBuf.length !== 4) throw new Error(`Bad atom type: ${type}`);
  const payload = Buffer.concat(payloadChunks);
  const size = 8 + payload.length;
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(size, 0);
  return Buffer.concat([sizeBuf, typeBuf, payload]);
}

// Build a freeform `----` atom: mean/name/data triplet.
function freeformAtom(meanStr, nameStr, valueStr) {
  // mean and name carry 4 bytes of version+flags (always 0) before the string.
  const versionFlags = Buffer.alloc(4);
  const mean = box('mean', versionFlags, Buffer.from(meanStr, 'utf8'));
  const name = box('name', versionFlags, Buffer.from(nameStr, 'utf8'));
  // data atom: 4 bytes type indicator (1 = UTF-8 text) + 4 bytes locale (0) + value.
  const dataHeader = Buffer.alloc(8);
  dataHeader.writeUInt32BE(1, 0);  // type = UTF-8 text
  // locale stays 0
  const data = box('data', dataHeader, Buffer.from(valueStr, 'utf8'));
  return box('----', mean, name, data);
}

// ─── ilst manipulation ────────────────────────────────────────────────────

// Read ilst contents and split into [keep[], dropOriginalsForKeys[]].
// `keysToReplace` is a Set of freeform names whose ---- atoms should be dropped.
function partitionIlst(buf, ilstStart, ilstEnd, keysToReplace) {
  const keep = [];
  eachChildBox(buf, ilstStart, ilstEnd, (child) => {
    if (child.type === '----') {
      // Inspect the child's name atom to see if it matches a key we're replacing.
      const nameAtom = findChildBox(buf, child.contentStart, child.contentEnd, 'name');
      if (nameAtom) {
        const nameStr = buf.toString('utf8', nameAtom.contentStart + 4, nameAtom.contentEnd);
        if (keysToReplace.has(nameStr)) return;  // drop
      }
    }
    keep.push(buf.subarray(child.end - child.size, child.end));
  });
  return keep;
}

// Build a new ilst body from a list of child atom buffers.
function buildIlst(childBuffers) {
  return box('ilst', ...childBuffers);
}

// ─── meta / udta / moov reconstruction ────────────────────────────────────

// meta box has a special 4-byte version+flags prefix before children.
function buildMeta(childBuffers) {
  const versionFlags = Buffer.alloc(4);
  // Standard handler for iTunes-style metadata: mdir / appl.
  const hdlr = buildHdlr();
  return box('meta', versionFlags, hdlr, ...childBuffers);
}

function buildHdlr() {
  // hdlr: 4 bytes version+flags, 4 bytes predefined (0), 4 bytes handler_type (mdir),
  //       12 bytes reserved, then null-terminated name string.
  const buf = Buffer.alloc(4 + 4 + 4 + 12 + 1);
  // version+flags = 0
  // predefined = 0
  buf.write('mdir', 8, 4, 'latin1');
  // reserved = zeros
  // name = "" (1 null byte)
  return box('hdlr', buf);
}

function buildUdta(childBuffers) {
  return box('udta', ...childBuffers);
}

// ─── stco / co64 offset patcher ───────────────────────────────────────────

// Walk a Buffer representing the moov box content, find every stco / co64,
// and add `delta` to each chunk offset. Mutates buf in place.
function updateChunkOffsets(buf, start, end, delta) {
  if (delta === 0) return;
  let p = start;
  while (p < end) {
    const box = readBoxHeader(buf, p);
    if (!box || box.end > end) break;
    if (box.type === 'stco') {
      // 4 bytes version+flags, 4 bytes entry_count, then N x 4-byte offsets.
      const entryCount = buf.readUInt32BE(box.contentStart + 4);
      let q = box.contentStart + 8;
      for (let i = 0; i < entryCount; i++) {
        buf.writeUInt32BE(buf.readUInt32BE(q) + delta, q);
        q += 4;
      }
    } else if (box.type === 'co64') {
      const entryCount = buf.readUInt32BE(box.contentStart + 4);
      let q = box.contentStart + 8;
      for (let i = 0; i < entryCount; i++) {
        const v = buf.readBigUInt64BE(q);
        buf.writeBigUInt64BE(v + BigInt(delta), q);
        q += 8;
      }
    } else if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts'].includes(box.type)) {
      // Recurse into known container boxes.
      updateChunkOffsets(buf, box.contentStart, box.contentEnd, delta);
    }
    p = box.end;
  }
}

// ─── Top-level: write/replace freeform tags in a file ─────────────────────

// tagMap: object with { KEY: VALUE } pairs, e.g.
//   { REPLAYGAIN_TRACK_GAIN: '-6.10 dB', REPLAYGAIN_TRACK_PEAK: '1.000000' }
// Values that are empty strings cause the key to be removed (cleared).
function setFreeformTags(filePath, tagMap) {
  const original = fs.readFileSync(filePath);

  // Locate top-level boxes.
  const tops = [];
  let p = 0;
  while (p < original.length) {
    const b = readBoxHeader(original, p);
    if (!b) break;
    tops.push(b);
    p = b.end;
  }
  const moov = tops.find((b) => b.type === 'moov');
  const mdat = tops.find((b) => b.type === 'mdat');
  if (!moov) throw new Error('No moov box found');

  // Walk moov children to find existing children (mvhd, trak..., udta).
  const moovChildren = [];
  let oldUdta = null;
  eachChildBox(original, moov.contentStart, moov.contentEnd, (child) => {
    if (child.type === 'udta') { oldUdta = child; return; }   // we'll rebuild it
    moovChildren.push(original.subarray(child.end - child.size, child.end));
  });

  // Walk old udta.meta.ilst, partition existing entries.
  let oldUdtaSiblings = [];        // non-meta children of udta we'll keep
  let oldIlstChildren = [];        // ilst children minus the keys we're replacing
  const keysToReplace = new Set(Object.keys(tagMap));

  if (oldUdta) {
    eachChildBox(original, oldUdta.contentStart, oldUdta.contentEnd, (child) => {
      if (child.type !== 'meta') {
        oldUdtaSiblings.push(original.subarray(child.end - child.size, child.end));
        return;
      }
      // meta has the 4-byte version+flags prefix.
      const metaStart = child.contentStart + 4;
      eachChildBox(original, metaStart, child.contentEnd, (metaChild) => {
        if (metaChild.type === 'ilst') {
          oldIlstChildren = partitionIlst(original, metaChild.contentStart, metaChild.contentEnd, keysToReplace);
        }
        // hdlr we drop and re-emit a canonical one
      });
    });
  }

  // Build new freeform atoms.
  const newFreeforms = [];
  for (const [k, v] of Object.entries(tagMap)) {
    if (typeof v === 'string' && v !== '') {
      newFreeforms.push(freeformAtom('com.apple.iTunes', k, v));
    }
    // else: just dropped via keysToReplace, nothing new to add
  }

  // Assemble: new ilst → new meta → new udta → new moov.
  const newIlst = buildIlst([...oldIlstChildren, ...newFreeforms]);
  const newMeta = buildMeta([newIlst]);
  const newUdta = buildUdta([...oldUdtaSiblings, newMeta]);
  const newMoov = box('moov', ...moovChildren, newUdta);

  // If mdat lives AFTER moov in the original, growing moov shifts mdat down.
  // Patch every stco / co64 entry in newMoov by the delta.
  if (mdat && mdat.contentStart > moov.contentStart) {
    const delta = newMoov.length - moov.size;
    // We need to walk INSIDE newMoov, skipping the outer 8-byte header.
    updateChunkOffsets(newMoov, 8, newMoov.length, delta);
  }

  // Reassemble the file.
  const before = original.subarray(0, moov.contentStart - moov.headerSize);
  const after = original.subarray(moov.contentEnd);
  const result = Buffer.concat([before, newMoov, after]);

  // Atomic-ish replace via temp + rename in the same dir.
  const tmp = filePath + '.tags.tmp';
  fs.writeFileSync(tmp, result);
  fs.renameSync(tmp, filePath);
}

// ─── Read freeform tags (for verification) ────────────────────────────────

function readFreeformTags(filePath) {
  const buf = fs.readFileSync(filePath);
  const tops = [];
  let p = 0;
  while (p < buf.length) {
    const b = readBoxHeader(buf, p);
    if (!b) break;
    tops.push(b);
    p = b.end;
  }
  const moov = tops.find((b) => b.type === 'moov');
  if (!moov) return {};

  const udta = findChildBox(buf, moov.contentStart, moov.contentEnd, 'udta');
  if (!udta) return {};
  const meta = findChildBox(buf, udta.contentStart, udta.contentEnd, 'meta');
  if (!meta) return {};
  const ilst = findChildBox(buf, meta.contentStart + 4, meta.contentEnd, 'ilst');
  if (!ilst) return {};

  const out = {};
  eachChildBox(buf, ilst.contentStart, ilst.contentEnd, (child) => {
    if (child.type !== '----') return;
    let mean = '', name = '', value = '';
    eachChildBox(buf, child.contentStart, child.contentEnd, (sub) => {
      if (sub.type === 'mean') mean = buf.toString('utf8', sub.contentStart + 4, sub.contentEnd);
      else if (sub.type === 'name') name = buf.toString('utf8', sub.contentStart + 4, sub.contentEnd);
      else if (sub.type === 'data') value = buf.toString('utf8', sub.contentStart + 8, sub.contentEnd);
    });
    if (mean === 'com.apple.iTunes' && name) out[name] = value;
  });
  return out;
}

module.exports = { setFreeformTags, readFreeformTags };
