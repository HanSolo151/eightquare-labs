import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_PGN_BYTES = 128 * 1024 * 1024;

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The EOCD record may be followed by a 65,535-byte ZIP comment.
  const earliest = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= earliest; offset--) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("ZIP end-of-directory record was not found");
}

function readEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const disk = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error("Multi-disk and ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > eocd) throw new Error("ZIP central directory is out of bounds");

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("ZIP central directory entry is invalid");
    }
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const crc32 = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const nameBytes = zip.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString(flags & 0x0800 ? "utf8" : "latin1");

    if ([compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff)) {
      throw new Error("ZIP64 entry metadata is not supported");
    }
    entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractEntry(zip: Buffer, entry: ZipEntry, archivePath: string): Buffer {
  if (entry.flags & 1) throw new Error(`${path.basename(archivePath)} contains an encrypted PGN`);
  if (entry.uncompressedSize > MAX_PGN_BYTES) throw new Error(`${path.basename(archivePath)} PGN exceeds the 128 MiB size limit`);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error(`${path.basename(archivePath)} has an invalid local ZIP header`);
  }
  const nameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > zip.length) throw new Error(`${path.basename(archivePath)} PGN data is truncated`);

  const compressed = zip.subarray(dataOffset, dataEnd);
  let result: Buffer;
  if (entry.method === 0) result = compressed;
  else if (entry.method === 8) result = inflateRawSync(compressed, { maxOutputLength: MAX_PGN_BYTES });
  else throw new Error(`${path.basename(archivePath)} uses unsupported ZIP compression method ${entry.method}`);

  if (result.length !== entry.uncompressedSize || crc32(result) !== entry.crc32) {
    throw new Error(`${path.basename(archivePath)} PGN failed its ZIP integrity check`);
  }
  return result;
}

/** Reads exactly one PGN from a ZIP and verifies its ZIP CRC before returning it. */
export async function readPgnFromZip(archivePath: string): Promise<string> {
  const zip = await readFile(archivePath);
  const entries = readEntries(zip).filter((entry) => entry.name.toLocaleLowerCase().endsWith(".pgn"));
  if (entries.length !== 1) {
    throw new Error(`${path.basename(archivePath)} must contain exactly one .pgn file; found ${entries.length}`);
  }
  const pgn = extractEntry(zip, entries[0], archivePath).toString("utf8");
  if (!/^\s*\[\w+\s+"/m.test(pgn)) {
    throw new Error(`${path.basename(archivePath)} did not contain recognizable PGN headers`);
  }
  return pgn;
}
