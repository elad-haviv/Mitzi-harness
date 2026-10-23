// Reads one file out of a .zip in the browser, without loading the whole archive: data exports can
// be gigabytes of images, and we only need conversations.json.

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

async function view(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

async function centralDirectory(file: Blob): Promise<Entry[]> {
  // The end-of-central-directory record is in the last 64 KB (plus the comment).
  const tailStart = Math.max(0, file.size - 66_000);
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This isn’t a zip file');
  let count = u16(tail, eocd + 10);
  let size = u32(tail, eocd + 12);
  let offset = u32(tail, eocd + 16);
  // Archives over 4 GB keep the real values in a ZIP64 record.
  if (offset === 0xffffffff || size === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const z64 = await view(file, u64(tail, loc + 8), u64(tail, loc + 8) + 56);
      count = u64(z64, 32);
      size = u64(z64, 40);
      offset = u64(z64, 48);
    }
  }
  const cd = await view(file, offset, offset + size);
  const entries: Entry[] = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10);
    let compressedSize = u32(cd, p + 20);
    let uncompressedSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localOffset = u32(cd, p + 42);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // ZIP64 extra field: the 64-bit values appear in order, only for fields that overflowed.
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen; ) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressedSize === 0xffffffff) (uncompressedSize = u64(cd, q)), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = u64(cd, q)), (q += 8);
        if (localOffset === 0xffffffff) localOffset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The text of the first file in the zip whose name ends with `suffix`, or undefined. */
export async function readZipText(file: Blob, suffix: string): Promise<string | undefined> {
  const entry = (await centralDirectory(file)).find((e) => e.name === suffix || e.name.endsWith(`/${suffix}`));
  if (!entry) return undefined;
  const local = await view(file, entry.localOffset, entry.localOffset + 30);
  const start = entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
  const data = file.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return data.text();
  if (entry.method !== 8) throw new Error('This zip uses a compression method Mitzi can’t read');
  const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Names of the files in a zip. */
export async function zipNames(file: Blob): Promise<string[]> {
  return (await centralDirectory(file)).map((e) => e.name);
}

/** The text of every file whose name matches, by name (Office documents are zips of XML parts). */
export async function readZipTexts(file: Blob, match: (name: string) => boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of (await centralDirectory(file)).filter((e) => match(e.name))) {
    const local = await view(file, entry.localOffset, entry.localOffset + 30);
    const start = entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
    const data = file.slice(start, start + entry.compressedSize);
    if (entry.method === 0) out.set(entry.name, await data.text());
    else if (entry.method === 8) out.set(entry.name, await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text());
  }
  return out;
}
