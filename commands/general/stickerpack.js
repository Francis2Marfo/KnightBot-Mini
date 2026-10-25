/**
 * Helpers for .telepack only. Not a command.
 */

const crypto = require('crypto');
const webp = require('node-webpmux');
const {
  hkdf,
  generateMessageID,
  generateWAMessageFromContent,
  unixTimestampSeconds,
  MEDIA_PATH_MAP,
  MEDIA_HKDF_KEY_MAPPING,
} = require('@whiskeysockets/baileys');

MEDIA_HKDF_KEY_MAPPING['sticker-pack'] = 'Sticker Pack';
MEDIA_HKDF_KEY_MAPPING['thumbnail-sticker-pack'] = 'Sticker Pack Thumbnail';
MEDIA_PATH_MAP['sticker-pack'] = '/mms/sticker-pack';
MEDIA_PATH_MAP['thumbnail-sticker-pack'] = '/mms/thumbnail-sticker-pack';

const INFO_ZIP = 'WhatsApp Sticker Pack Keys';
const INFO_THUMB = 'WhatsApp Sticker Pack Thumbnail Keys';

async function deriveKeys(mediaKey, info) {
  const key = Buffer.isBuffer(mediaKey) ? mediaKey : Buffer.from(mediaKey);
  const expanded = await hkdf(key, 112, { info });
  return {
    iv: expanded.slice(0, 16),
    cipherKey: expanded.slice(16, 48),
    macKey: expanded.slice(48, 80),
  };
}

function encodeUploadB64(fileEncSha256) {
  return encodeURIComponent(
    Buffer.from(fileEncSha256)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  );
}

async function encryptMedia(plaintext, info, mediaKey = crypto.randomBytes(32)) {
  const { iv, cipherKey, macKey } = await deriveKeys(mediaKey, info);
  const aes = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const enc = Buffer.concat([aes.update(plaintext), aes.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(enc).digest().slice(0, 10);
  const encFile = Buffer.concat([enc, mac]);
  return {
    mediaKey,
    fileSha256: crypto.createHash('sha256').update(plaintext).digest(),
    fileEncSha256: crypto.createHash('sha256').update(encFile).digest(),
    fileLength: plaintext.length,
    encFile,
  };
}

async function uploadEncrypted(sock, encFile, mmsPath, fileEncSha256) {
  const paths = Array.isArray(mmsPath) ? mmsPath : [mmsPath];
  const hash = fileEncSha256 || crypto.createHash('sha256').update(encFile).digest();
  const fileEncSha256B64 = encodeUploadB64(hash);
  let lastErr;
  let uploadInfo = await sock.refreshMediaConn(true);

  for (const pathName of paths) {
    uploadInfo = await sock.refreshMediaConn(false);
    for (const { hostname } of uploadInfo.hosts || []) {
      try {
        const auth = encodeURIComponent(uploadInfo.auth);
        const url = `https://${hostname}/mms/${pathName}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
        const res = await fetch(url, {
          method: 'POST',
          body: encFile,
          headers: {
            'Content-Type': 'application/octet-stream',
            Origin: 'https://web.whatsapp.com',
          },
        });
        const text = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        const directPath = parsed?.direct_path || parsed?.directPath;
        if (parsed?.url || directPath) {
          return { mediaUrl: parsed.url, directPath };
        }
        lastErr = new Error(`upload ${pathName}@${hostname} HTTP ${res.status}: ${text.slice(0, 180)}`);
        uploadInfo = await sock.refreshMediaConn(true);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('Media upload failed on all hosts');
}

function extractZip(zipBuf) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuf, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const files = new Map();
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zipfile.readEntry();
        zipfile.openReadStream(entry, (e2, stream) => {
          if (e2) return reject(e2);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(files));
      zipfile.on('error', reject);
    });
  });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const list = Array.isArray(entries)
    ? entries
    : [...entries.entries()].map(([name, data]) => ({ name, data }));
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of list) {
    const nameBuf = Buffer.from(name, 'utf8');
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = crc32(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(payload.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);

    parts.push(local, nameBuf, payload);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

function buildWebpExif({ packId, packName, publisher, emojis }) {
  const json = {
    'sticker-pack-id': packId,
    'sticker-pack-name': packName,
    'sticker-pack-publisher': publisher || '',
    emojis: Array.isArray(emojis) && emojis.length ? emojis : ['🙂'],
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  return exif;
}

function parseWebpEmojis(exifBuf) {
  if (!exifBuf?.length) return null;
  try {
    const raw = exifBuf.toString('utf8');
    const i = raw.indexOf('{');
    if (i < 0) return null;
    const parsed = JSON.parse(raw.slice(i));
    return Array.isArray(parsed.emojis) ? parsed.emojis : null;
  } catch {
    return null;
  }
}

async function rewriteWebpPackExif(webpBuf, { packId, packName, publisher, emojis }) {
  const img = new webp.Image();
  await img.load(webpBuf);
  const kept = emojis || parseWebpEmojis(img.exif) || ['🙂'];
  img.exif = buildWebpExif({ packId, packName, publisher, emojis: kept });
  return img.save(null);
}

async function makeTrayIconPng(sourceBuf) {
  const sharp = require('sharp');
  return sharp(sourceBuf, { pages: 1, animated: false })
    .resize(252, 252, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function ensureTrayInZip(zipBuf, trayIconFileName, meta = {}) {
  const files = await extractZip(zipBuf);
  if (files.get(trayIconFileName)?.length) return zipBuf;

  let trayPng = null;
  const existingPng = [...files.entries()].find(([n, d]) => /\.png$/i.test(n) && d?.length);
  if (existingPng) {
    try {
      trayPng = await makeTrayIconPng(existingPng[1]);
    } catch {
      trayPng = existingPng[1];
    }
  }

  if (!trayPng?.length) {
    const stickerName =
      meta.stickers?.[0]?.fileName || [...files.keys()].find((n) => /\.webp$/i.test(n));
    const src = stickerName ? files.get(stickerName) : null;
    if (src?.length) {
      try {
        trayPng = await makeTrayIconPng(src);
      } catch (e) {
        console.warn('[telepack] tray PNG from webp failed:', e.message);
      }
    }
  }

  if (!trayPng?.length) return zipBuf;
  files.set(trayIconFileName, trayPng);
  return createZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

async function resolveCoverBuffer(zipBuf, thumbBuf, meta) {
  const sharp = require('sharp');
  const files = await extractZip(zipBuf);
  const candidates = [
    meta.trayIconFileName,
    [...files.keys()].find((n) => /\.png$/i.test(n)),
    meta.stickers?.[0]?.fileName,
    [...files.keys()].find((n) => /\.webp$/i.test(n)),
  ].filter(Boolean);

  for (const fname of candidates) {
    const raw = files.get(fname);
    if (!raw?.length) continue;
    try {
      return await sharp(raw, { pages: 1, animated: false })
        .resize(252, 252, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      // next
    }
  }

  if (thumbBuf?.length) {
    try {
      return await sharp(thumbBuf).resize(252, 252, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
    } catch {
      // fall through
    }
  }

  return sharp({
    create: { width: 252, height: 252, channels: 3, background: { r: 40, g: 40, b: 40 } },
  })
    .jpeg({ quality: 60 })
    .toBuffer();
}

async function sendPackPayload(sock, jid, { meta, zipBuf, thumbBuf }, opts = {}) {
  const stickerPackId = meta.stickerPackId || generateMessageID();
  const stickers = meta.stickers || [];
  const packName =
    opts.name != null && String(opts.name).trim() ? String(opts.name).trim() : meta.name || 'Sticker Pack';
  const packPublisher = opts.publisher != null ? String(opts.publisher) : meta.publisher || '';

  const trayIconFileName =
    meta.trayIconFileName && /\.png$/i.test(meta.trayIconFileName)
      ? meta.trayIconFileName
      : `${stickerPackId}.png`;
  const finalZip = await ensureTrayInZip(zipBuf, trayIconFileName, { stickers });
  const cover = await resolveCoverBuffer(finalZip, thumbBuf, { ...meta, trayIconFileName, stickers });
  const mediaKey = crypto.randomBytes(32);
  const [zipEnc, thumbEnc] = await Promise.all([
    encryptMedia(finalZip, INFO_ZIP, mediaKey),
    encryptMedia(cover, INFO_THUMB, mediaKey),
  ]);
  const [zipUp, thumbUp] = await Promise.all([
    uploadEncrypted(sock, zipEnc.encFile, ['sticker-pack', 'sticker'], zipEnc.fileEncSha256),
    uploadEncrypted(sock, thumbEnc.encFile, ['thumbnail-sticker-pack', 'image'], thumbEnc.fileEncSha256),
  ]);
  if (!zipUp.directPath) throw new Error('Pack zip upload returned no directPath');
  if (!thumbUp.directPath) throw new Error('Pack thumbnail upload returned no directPath');

  const stickerPackMessage = {
    name: packName,
    publisher: packPublisher,
    stickerPackId,
    packDescription: meta.packDescription || undefined,
    stickerPackOrigin: meta.stickerPackOrigin ?? 2,
    stickerPackSize: zipEnc.fileLength,
    stickers: stickers.map((s) => ({
      fileName: s.fileName,
      isAnimated: !!s.isAnimated,
      emojis: Array.isArray(s.emojis) ? s.emojis : [],
      accessibilityLabel: s.accessibilityLabel || '',
      isLottie: !!s.isLottie,
      mimetype: s.mimetype || 'image/webp',
    })),
    fileSha256: zipEnc.fileSha256,
    fileEncSha256: zipEnc.fileEncSha256,
    mediaKey: zipEnc.mediaKey,
    directPath: zipUp.directPath,
    fileLength: zipEnc.fileLength,
    mediaKeyTimestamp: unixTimestampSeconds(),
    trayIconFileName,
    imageDataHash: crypto.createHash('sha256').update(cover).digest('base64'),
    thumbnailDirectPath: thumbUp.directPath,
    thumbnailSha256: thumbEnc.fileSha256,
    thumbnailEncSha256: thumbEnc.fileEncSha256,
    thumbnailHeight: 252,
    thumbnailWidth: 252,
  };

  const full = generateWAMessageFromContent(jid, { stickerPackMessage }, {});
  await sock.relayMessage(jid, full.message, { messageId: full.key.id });
  return {
    ...meta,
    name: packName,
    publisher: packPublisher,
    stickerPackId,
    total: stickers.length,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { createZip, sendPackPayload, sleep, rewriteWebpPackExif };
