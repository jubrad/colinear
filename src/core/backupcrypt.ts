import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Encryption for `coli backup`.
 *
 * A backup is the most concentrated secret colinear can produce: every
 * context's config (tracker API keys included), the transcripts of every
 * conversation an agent has had, and git bundles of work nobody has pushed.
 * It is also, by design, a file you carry somewhere else — a USB stick, scp,
 * a cloud drive, whatever gets it to the new laptop. So it is encrypted by
 * default, and the plaintext path is the one you have to ask for.
 *
 * ## The shape: a random key, wrapped by your passphrase
 *
 * The archive is encrypted with a fresh random 256-bit key, and *that* key is
 * wrapped with a key derived from your passphrase and stored in the file's
 * header. The passphrase never encrypts the bulk data directly.
 *
 * That is worth the extra layer for two reasons. The bulk cipher gets a full
 * random key rather than whatever entropy a human typed, and the passphrase
 * can be changed later by rewrapping 32 bytes instead of re-encrypting a
 * multi-gigabyte archive.
 *
 * ## Why the key travels in the archive rather than beside it
 *
 * The alternative — write the key to a second file and need both to restore —
 * has a stronger-looking property and a worse failure mode. The point of this
 * feature is that the first machine can be thrown away, so anything needed to
 * restore has to survive that trip; a key file kept beside the archive is no
 * protection at all, and a key file kept properly apart is one more thing to
 * lose. The overwhelmingly common way a backup fails is that the restore does
 * not work, and "you also needed a file you did not know to keep" is the
 * likeliest way to get there six months later.
 *
 * A passphrase, by contrast, goes in the password manager the operator
 * already has. One artefact moves, one secret is remembered, and neither is
 * any use without the other.
 *
 * ## Format
 *
 *   COLIBAK1\n                 magic and format version
 *   <one line of JSON>\n       salt, KDF cost, the wrapped key, both IVs
 *   <ciphertext>               AES-256-GCM over the gzipped tar
 *   <16 bytes>                 the bulk cipher's authentication tag
 *
 * The tag is at the end because it does not exist until the last byte is
 * encrypted, and streaming beats buffering a whole installation in memory.
 * It is checked on decryption, so a truncated or edited archive fails loudly
 * rather than unpacking into something subtly wrong.
 */

export const MAGIC = 'COLIBAK1\n';

/**
 * scrypt at 2^17 — about 180ms and 128MB per attempt on a current laptop.
 * Paid once per backup and once per restore, which is nothing; paid per guess
 * by anyone working through a wordlist, which is the point.
 */
const KDF = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface Header {
  v: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  /** the bulk key, encrypted under the passphrase-derived key */
  wrap: { iv: string; tag: string; key: string };
  /** the bulk cipher's IV */
  iv: string;
}

/** Anyone can read this much of a file; it says nothing about its contents. */
export function isEncryptedBackup(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(MAGIC.length);
    const read = readSync(fd, buf, 0, MAGIC.length, 0);
    return read === MAGIC.length && buf.toString('utf8') === MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Encrypt `plain` to `out`. The passphrase is never stored, only its salt. */
export async function encryptBackup(plain: string, out: string, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const kek = await derive(passphrase, salt, KEY_BYTES, KDF);
  const key = randomBytes(KEY_BYTES);

  const wrapIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv('aes-256-gcm', kek, wrapIv);
  const wrapped = Buffer.concat([wrapper.update(key), wrapper.final()]);

  const iv = randomBytes(IV_BYTES);
  const header: Header = {
    v: 1,
    kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    wrap: {
      iv: wrapIv.toString('base64'),
      tag: wrapper.getAuthTag().toString('base64'),
      key: wrapped.toString('base64'),
    },
    iv: iv.toString('base64'),
  };

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sink = createWriteStream(out);
  sink.write(MAGIC);
  sink.write(`${JSON.stringify(header)}\n`);
  await pipeline(createReadStream(plain), cipher, sink);
  // written after the stream, because GCM cannot produce it any earlier
  appendFileSync(out, cipher.getAuthTag());
}

/**
 * Decrypt `archive` to `out`.
 *
 * Throws `wrong passphrase` when the passphrase does not unwrap the key, and
 * `archive failed its integrity check` when it does but the body has been
 * changed since. Those are genuinely different problems for the operator —
 * one is "try the other password", the other is "this copy is damaged".
 */
export async function decryptBackup(archive: string, out: string, passphrase: string): Promise<void> {
  const { header, bodyStart } = readHeader(archive);
  const salt = Buffer.from(header.kdf.salt, 'base64');
  const kek = await derive(passphrase, salt, KEY_BYTES, {
    N: header.kdf.N,
    r: header.kdf.r,
    p: header.kdf.p,
    maxmem: KDF.maxmem,
  });

  let key: Buffer;
  try {
    const unwrapper = createDecipheriv('aes-256-gcm', kek, Buffer.from(header.wrap.iv, 'base64'));
    unwrapper.setAuthTag(Buffer.from(header.wrap.tag, 'base64'));
    key = Buffer.concat([unwrapper.update(Buffer.from(header.wrap.key, 'base64')), unwrapper.final()]);
  } catch {
    // the wrap tag failing is exactly "that passphrase is not this archive's"
    throw new Error('wrong passphrase');
  }

  const size = statSync(archive).size;
  const tagStart = size - TAG_BYTES;
  if (tagStart <= bodyStart) throw new Error('archive is truncated — no authentication tag');

  const fd = openSync(archive, 'r');
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    readSync(fd, tag, 0, TAG_BYTES, tagStart);
  } finally {
    closeSync(fd);
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(archive, { start: bodyStart, end: tagStart - 1 }),
      decipher,
      createWriteStream(out),
    );
  } catch {
    throw new Error('archive failed its integrity check — it has been truncated or modified');
  }
}

/** Magic, then one line of JSON. Returns the header and where the body starts. */
function readHeader(archive: string): { header: Header; bodyStart: number } {
  // 8KB is far more than a header needs and far less than a read worth
  // streaming; the body starts at the first newline after the magic
  const buf = Buffer.alloc(8192);
  const fd = openSync(archive, 'r');
  let read: number;
  try {
    read = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const magic = Buffer.from(MAGIC, 'utf8');
  if (read < magic.length || !timingSafeEqual(buf.subarray(0, magic.length), magic)) {
    throw new Error('not an encrypted colinear backup');
  }
  const end = buf.indexOf('\n', magic.length);
  if (end === -1) throw new Error('encrypted backup has no header');
  const header = JSON.parse(buf.subarray(magic.length, end).toString('utf8')) as Header;
  if (header.v !== 1 || header.kdf?.name !== 'scrypt') {
    throw new Error(`unsupported backup encryption (v${header.v}) — written by a newer colinear`);
  }
  return { header, bodyStart: end + 1 };
}
