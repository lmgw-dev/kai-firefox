// Reads manifest.json out of an XPI (a zip) without a zip library: the signed file AMO hands back
// is checked against what this run meant to sign (scripts/sign.mjs).
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

// The bytes of the entry `name`, or null when the zip has none.
export function readEntry(zip, name) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error("bad zip: central directory entry expected");
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      if (size === 0xffffffff || local === 0xffffffff) throw new Error("zip64 entries are not read");
      if (zip.readUInt32LE(local) !== LOCAL) throw new Error("bad zip: local header expected");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + size);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`zip entry ${name} uses compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

export function xpiManifest(zip) {
  const bytes = readEntry(zip, "manifest.json");
  if (!bytes) throw new Error("the XPI has no manifest.json");
  return JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
}
