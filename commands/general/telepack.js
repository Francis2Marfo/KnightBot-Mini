/**
 * telepack — Telegram sticker pack link → WhatsApp native pack bubble(s)
 * Downloads the whole set in parallel (Telegram has no pack-ZIP API),
 * converts, zips, and sends. Splits at WA limit (60 per pack).
 * Does not modify .tg / .tgsticker.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { generateMessageID } = require('@whiskeysockets/baileys');
const config = require('../../config');
const { tgsToWebp } = require('../../utils/tgsToWebp');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');

/** Google's img2webp from webp-converter (img2webp-bin is unpublished on npm) */
function getImg2WebpBin() {
  // webp-converter blocks require(.../package.json) via exports — resolve main then walk up
  const main = require.resolve('webp-converter');
  const root = path.join(path.dirname(main), '..');
  let bin;
  if (process.platform === 'win32') {
    bin = path.join(root, 'bin', 'libwebp_win64', 'bin', 'img2webp.exe');
  } else if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'libwebp_osx_arm64' : 'libwebp_osx';
    bin = path.join(root, 'bin', arch, 'bin', 'img2webp');
  } else {
    bin = path.join(root, 'bin', 'libwebp_linux', 'bin', 'img2webp');
  }
  if (process.platform !== 'win32' && fs.existsSync(bin)) {
    try {
      fs.chmodSync(bin, 0o755);
    } catch {
      // ignore
    }
  }
  return bin;
}

const WA_MAX_PER_PACK = 60;
const DL_CONCURRENCY = 12;
/** Panel has 2 vCPU — allow 2 parallel encodes (was 1) */
const CONVERT_CONCURRENCY = 2;
/** WA silently blanks animated stickers over ~500KB */
const MAX_ANIMATED_WEBP_BYTES = 500 * 1024;

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache', 'telepack');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function cachePath(fileUniqueId) {
  const safe = String(fileUniqueId || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 120);
  if (!safe) return null;
  return path.join(CACHE_DIR, `${safe}.webp`);
}

// Wipe stale cache on every boot — cache only persists within a single bot run
try {
  const existing = fs.readdirSync(CACHE_DIR);
  for (const f of existing) fs.unlinkSync(path.join(CACHE_DIR, f));
  if (existing.length) console.log(`[telepack] cache cleared on startup (${existing.length} file(s))`);
} catch (e) {
  console.warn('[telepack] cache startup clear failed:', e.message);
}

/** Helpers live in stickerpack.js so this file stays the command. */
function packLib() {
  return require('./stickerpack');
}

const tgApi = (token, method, params) =>
  axios.get(`https://api.telegram.org/bot${token}/${method}`, { params, timeout: 30000 });

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '…';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `~${m}m ${r}s`;
}

/** Rough ETA from Telegram sticker types (seconds) */
function estimateSeconds(stickers) {
  let tgs = 0;
  let vid = 0;
  let stat = 0;
  for (const s of stickers) {
    if (s.is_animated) tgs++;
    else if (s.is_video) vid++;
    else stat++;
  }
  const dl = (stickers.length * 0.25) / DL_CONCURRENCY;
  // converts are serial on panel
  const conv = tgs * 5 + vid * 3 + stat * 0.05;
  return Math.ceil(dl + conv + 8);
}

function extStats(items) {
  const counts = {};
  for (const it of items) {
    const e = (it.ext || '?').toLowerCase();
    counts[e] = (counts[e] || 0) + 1;
  }
  return counts;
}

function logConvertFail(item, err) {
  const msg = String(err?.message || err || 'unknown');
  const busy = /Resource temporarily unavailable|EAGAIN|ENOMEM|Cannot allocate|too many open/i.test(
    msg
  );
  console.warn(
    `[telepack] FAIL #${(item.i ?? 0) + 1}` +
      ` ext=${item.ext || '?'}` +
      ` size=${item.buffer?.length ?? 0}` +
      ` animated=${!!item.isAnimated}` +
      ` lottie=${!!item.isLottie}` +
      ` busy=${busy}` +
      ` | ${msg.slice(0, 280)}`
  );
}

/** Prefer the useful tail of ffmpeg stderr (banner is at the start). */
function ffmpegErrMessage(stderrBuf, code) {
  const full = Buffer.concat(stderrBuf).toString('utf8').replace(/\r/g, '');
  const lines = full
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const useful = lines.filter(
    (l) =>
      /error|invalid|failed|unknown|not found|does not|cannot|unsupported|no such|unavailable/i.test(
        l
      ) && !/^ffmpeg version/i.test(l)
  );
  const pick = useful.length
    ? useful.slice(-4).join(' | ')
    : lines.slice(-6).join(' | ') || `exit ${code}`;
  return pick.slice(-400);
}

/** Limit parallel ffmpeg to CONVERT_CONCURRENCY (shared across telepack cmds) */
let ffmpegActive = 0;
const ffmpegWaiters = [];
function withFfmpegLock(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      ffmpegActive++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          ffmpegActive--;
          const next = ffmpegWaiters.shift();
          if (next) next();
        });
    };
    if (ffmpegActive < CONVERT_CONCURRENCY) start();
    else ffmpegWaiters.push(start);
  });
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    const err = [];
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', (e) => reject(e));
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(ffmpegErrMessage(err, code)))
    );
  });
}

/**
 * Probe width/height. Prefer a file path (no stdin EPIPE).
 * Buffer path swallows EPIPE — ffmpeg often closes early after reading headers.
 */
function ffprobeSize(fileOrBuffer) {
  return new Promise((resolve) => {
    const usePipe = Buffer.isBuffer(fileOrBuffer);
    const ff = spawn(ffmpegPath, ['-i', usePipe ? 'pipe:0' : fileOrBuffer, '-hide_banner']);
    const err = [];
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', () => done(null));
    ff.on('close', () => {
      const s = Buffer.concat(err).toString('utf8');
      const m =
        s.match(/Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/i) || s.match(/(\d{2,5})x(\d{2,5})/);
      done(m ? { w: +m[1], h: +m[2] } : null);
    });
    if (usePipe) {
      // ffmpeg exits after probing headers → write() throws uncaught EPIPE without this
      ff.stdin.on('error', () => {});
      try {
        ff.stdin.end(fileOrBuffer);
      } catch {
        done(null);
      }
    }
  });
}

/** Run async work over items with a fixed concurrency pool */
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) || 1 }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function parsePackLink(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_]+$/.test(s)) return s;
  return null;
}

async function resolveTelegramFile(token, fileId) {
  const { data } = await tgApi(token, 'getFile', { file_id: fileId });
  const filePath = data.result?.file_path;
  if (!filePath) throw new Error('Could not get file path');
  return {
    filePath,
    url: `https://api.telegram.org/file/bot${token}/${filePath}`,
    ext: path.extname(filePath).toLowerCase() || '.bin',
  };
}

async function downloadUrl(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}

/**
 * Animated WebP via PNG sequence + img2webp — avoids ffmpeg libwebp blend=true ghost trails.
 */
async function encodeAnimatedWebpViaImg2webp(inp, out, core, framesDir, fps, quality = 75) {
  fs.mkdirSync(framesDir, { recursive: true });
  // clean leftover frames if retrying same dir
  try {
    for (const f of fs.readdirSync(framesDir)) {
      if (f.endsWith('.png')) fs.unlinkSync(path.join(framesDir, f));
    }
  } catch {
    // ignore
  }

  await ffmpeg([
    '-y',
    '-c:v',
    'libvpx-vp9',
    '-i',
    inp,
    '-an',
    '-vf',
    `${core},fps=${fps}`,
    '-pix_fmt',
    'rgba',
    path.join(framesDir, 'f_%04d.png'),
  ]);

  const frameFiles = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  if (!frameFiles.length) throw new Error('No frames produced for img2webp');

  const durationMs = Math.max(1, Math.round(1000 / fps));
  const args = ['-loop', '0', '-lossy', '-q', String(quality), '-m', '4'];
  for (const f of frameFiles) {
    args.push('-d', String(durationMs), path.join(framesDir, f));
  }
  args.push('-o', out);

  const bin = getImg2WebpBin();
  if (!fs.existsSync(bin)) {
    throw new Error(`img2webp binary missing at ${bin} — reinstall webp-converter`);
  }

  await new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    const err = [];
    p.stderr.on('data', (d) => err.push(d));
    p.stdout.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              Buffer.concat(err).toString('utf8').slice(-400) || `img2webp exit ${code}`
            )
          )
    );
  });

  for (const f of frameFiles) {
    try {
      fs.unlinkSync(path.join(framesDir, f));
    } catch {
      // ignore
    }
  }
  try {
    fs.rmdirSync(framesDir);
  } catch {
    // ignore
  }
}

async function runWebpEncode(inp, out, animated, dims) {
  const already512 = dims && dims.w === 512 && dims.h === 512;
  const core = already512
    ? 'format=rgba'
    : 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba';

  if (animated) {
    const framesDir = `${out}_frames`;
    await encodeAnimatedWebpViaImg2webp(inp, out, core, framesDir, 15, 75);
    let size = fs.statSync(out).size;
    if (size > MAX_ANIMATED_WEBP_BYTES) {
      // fewer frames / lower quality to fit WA ~500KB cap
      await encodeAnimatedWebpViaImg2webp(inp, out, core, framesDir, 10, 55);
      size = fs.statSync(out).size;
    }
    if (size > MAX_ANIMATED_WEBP_BYTES) {
      await encodeAnimatedWebpViaImg2webp(inp, out, core, framesDir, 8, 40);
    }
    return already512 ? 'img2webp-512' : 'img2webp';
  }

  // static — ffmpeg libwebp is fine (no animated blend bug)
  await ffmpeg([
    '-y',
    '-c:v',
    'libvpx-vp9',
    '-i',
    inp,
    '-an',
    '-vf',
    core,
    '-c:v',
    'libwebp',
    '-quality',
    '75',
    '-compression_level',
    '0',
    out,
  ]);
  return already512 ? 'primary-512' : 'primary';
}

async function runWebpEncodeLocked(inp, out, animated, label, dims) {
  const maxTries = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const mode = await withFfmpegLock(() => runWebpEncode(inp, out, animated, dims));
      if (attempt > 1) {
        console.log(`[telepack] encode OK ${label} on retry ${attempt} (${mode})`);
      }
      return mode;
    } catch (e) {
      lastErr = e;
      const busy = /Resource temporarily unavailable|EAGAIN|ENOMEM|Cannot allocate|too many open/i.test(
        String(e.message || '')
      );
      console.warn(
        `[telepack] encode fail ${label} attempt ${attempt}/${maxTries} busy=${busy} | ${String(e.message || e).slice(0, 200)}`
      );
      if (!busy || attempt === maxTries) break;
      await sleepMs(1000 * attempt);
    }
  }
  throw lastErr || new Error('ffmpeg encode failed');
}

/**
 * Convert Telegram media → WA WebP (no EXIF yet — applied once per pack chunk).
 * Mirrors .tg conversion, kept local so .tg is untouched.
 */
async function toWaWebpRaw(rawBuffer, ext, tempDir, tag) {
  const inp = path.join(tempDir, `${tag}_in${ext || '.bin'}`);
  const out = path.join(tempDir, `${tag}.webp`);

  try {
    if (ext === '.webp') return rawBuffer;

    if (ext === '.tgs') {
      await Promise.race([
        tgsToWebp(rawBuffer, out, tempDir, tag),
        sleepMs(45000).then(() => {
          throw new Error('tgs conversion timeout (45s)');
        }),
      ]);
      if (!fs.existsSync(out)) throw new Error('Animated WebP conversion failed');
      return fs.readFileSync(out);
    }

    fs.writeFileSync(inp, rawBuffer);
    const animated = ext === '.webm' || ext === '.mp4';
    const dims = animated ? await ffprobeSize(inp) : null;
    await Promise.race([
      runWebpEncodeLocked(inp, out, animated, `${tag}${ext}`, dims),
      sleepMs(30000).then(() => {
        throw new Error(`webp encode timeout (30s) ${ext}`);
      }),
    ]);
    if (!fs.existsSync(out) || !fs.statSync(out).size) {
      throw new Error(`Empty webp output (${ext || 'unknown'})`);
    }
    const finalSize = fs.statSync(out).size;
    if (animated && finalSize > MAX_ANIMATED_WEBP_BYTES) {
      console.warn(`[telepack] oversized animated webp: ${finalSize} bytes (tag=${tag})`);
    }
    return fs.readFileSync(out);
  } finally {
    deleteTempFile(inp);
    deleteTempFile(out);
  }
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function safeFileName(i) {
  return `${String(i).padStart(3, '0')}_${crypto.randomBytes(8).toString('hex')}.webp`;
}

module.exports = {
  name: 'telepack',
  aliases: ['tgpack', 'telegrampack', 'tpack'],
  category: 'general',
  description: 'Telegram pack link → WhatsApp sticker pack',
  usage: '.telepack <link> [packname]',

  async execute(sock, msg, args, extra) {
    const packSlug = parsePackLink(args[0]);
    if (!packSlug) {
      return extra.reply(
        '📦 *Telegram → WA pack*\n\n' +
          `\`${config.prefix}telepack <link>\`\n` +
          `\`${config.prefix}telepack <link> My Name\` — custom pack title\n\n` +
          `Example:\n\`${config.prefix}telepack https://t.me/addstickers/cutone_by_Fstick Knight\`\n\n` +
          `_Default title = Telegram pack name. Up to ${WA_MAX_PER_PACK} stickers/pack._`
      );
    }

    const customTitle = args.slice(1).join(' ').trim();
    const BOT_TOKEN = String(config.apiKeys?.telegram || '').trim();
    if (!BOT_TOKEN) {
      return extra.reply('❌ Set `apiKeys.telegram` in config.js (@BotFather)');
    }

    try {
      await extra.react('⏳');

      const { createZip, sendPackPayload, sleep, rewriteWebpPackExif } = packLib();

      const { data: apiData } = await tgApi(BOT_TOKEN, 'getStickerSet', { name: packSlug });
      if (!apiData?.ok || !apiData.result?.stickers?.length) {
        throw new Error(apiData?.description || 'Sticker pack not found');
      }

      const set = apiData.result;
      const stickers = set.stickers;
      const packTitle = customTitle || set.title || set.name || packSlug;
      const maxPerPack = WA_MAX_PER_PACK;
      const partsEst = Math.ceil(stickers.length / maxPerPack);
      const etaSec = estimateSeconds(stickers);
      const hasAnim = stickers.some((s) => s.is_animated || s.is_video);

      await extra.reply(
        `📥 *Downloading pack…*\n` +
          `📛 *${packTitle}*\n` +
          `🧩 Stickers: *${stickers.length}*` +
          (hasAnim ? ' · animated/video' : ' · static') +
          `\n⏱ ETA: *${fmtEta(etaSec)}*` +
          (partsEst > 1 ? `\n📦 Will send as *${partsEst}* WA packs` : '')
      );

      const resolved = await mapPool(stickers, DL_CONCURRENCY, async (st, i) => {
        try {
          const file = await resolveTelegramFile(BOT_TOKEN, st.file_id);
          return {
            i,
            emoji: st.emoji || '🙂',
            isAnimated: !!(st.is_animated || st.is_video),
            isLottie: !!st.is_animated,
            fileUniqueId: st.file_unique_id,
            ...file,
          };
        } catch (e) {
          console.warn(`[telepack] getFile #${i + 1}:`, e.message);
          return null;
        }
      });
      const files = resolved.filter(Boolean);
      if (!files.length) throw new Error('Could not resolve any sticker files');

      const cacheHits = [];
      const needFetch = [];
      for (const f of files) {
        const cp = f.fileUniqueId ? cachePath(f.fileUniqueId) : null;
        if (cp && fs.existsSync(cp)) {
          try {
            cacheHits.push({
              i: f.i,
              emoji: f.emoji,
              isAnimated: f.isAnimated,
              isLottie: f.isLottie,
              webpBuf: fs.readFileSync(cp),
            });
            continue;
          } catch {
            // fall through to fetch
          }
        }
        needFetch.push(f);
      }
      console.log(`[telepack] cache hits=${cacheHits.length}/${files.length}`);

      let rawItems = [];
      if (needFetch.length) {
        const downloaded = await mapPool(needFetch, DL_CONCURRENCY, async (f) => {
          try {
            const buffer = await downloadUrl(f.url);
            return { ...f, buffer };
          } catch (e) {
            console.warn(`[telepack] download #${f.i + 1}:`, e.message);
            return null;
          }
        });
        rawItems = downloaded.filter(Boolean);
      }

      if (!rawItems.length && !cacheHits.length) {
        throw new Error('Download failed for all stickers');
      }

      const byExt = extStats(rawItems);
      console.log(
        `[telepack] downloaded ${rawItems.length}/${needFetch.length} (cache ${cacheHits.length}) | ext ` +
          (Object.keys(byExt).length
            ? Object.entries(byExt)
                .map(([e, n]) => `${e}=${n}`)
                .join(' ')
            : 'none')
      );

      const tempDir = getTempDir();
      let ok = 0;
      let fail = 0;

      console.log(
        `[telepack] mem rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB heap=${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB`
      );
      try {
        const tmp = fs.readdirSync(require('os').tmpdir());
        console.log(`[telepack] tmpdir entries=${tmp.length}`);
      } catch {
        // ignore
      }

      const converted = rawItems.length
        ? await mapPool(rawItems, CONVERT_CONCURRENCY, async (item) => {
            const tag = `tele_${item.i}_${crypto.randomBytes(3).toString('hex')}`;
            try {
              console.log(
                `[telepack] convert start #${item.i + 1}/${rawItems.length}` +
                  ` ext=${item.ext} size=${item.buffer?.length || 0}`
              );
              const webpBuf = await toWaWebpRaw(item.buffer, item.ext, tempDir, tag);
              const cp = item.fileUniqueId ? cachePath(item.fileUniqueId) : null;
              if (cp && webpBuf?.length) {
                try {
                  fs.writeFileSync(cp, webpBuf);
                } catch (e) {
                  console.warn(`[telepack] cache write failed:`, e.message);
                }
              }
              ok++;
              console.log(
                `[telepack] convert OK #${item.i + 1} ext=${item.ext} → webp=${webpBuf.length}` +
                  ` (ok=${ok} fail=${fail})`
              );
              return {
                i: item.i,
                emoji: item.emoji,
                isAnimated: item.isAnimated,
                isLottie: item.isLottie,
                webpBuf,
              };
            } catch (e) {
              fail++;
              logConvertFail(item, e);
              return null;
            }
          })
        : [];

      const ready = [...cacheHits, ...converted.filter(Boolean)].sort((a, b) => a.i - b.i);
      console.log(
        `[telepack] convert done ok=${ok} fail=${fail} cacheHits=${cacheHits.length} ready=${ready.length}` +
          (Object.keys(byExt).length
            ? ` | ext was ` +
              Object.entries(byExt)
                .map(([e, n]) => `${e}=${n}`)
                .join(' ')
            : '')
      );
      if (!ready.length) {
        throw new Error(
          `Could not convert any stickers (0/${rawItems.length || files.length}). Ext: ` +
            (Object.keys(byExt).length
              ? Object.entries(byExt)
                  .map(([e, n]) => `${e}=${n}`)
                  .join(', ')
              : 'n/a')
        );
      }

      const chunks = chunkArray(ready, maxPerPack);
      const totalParts = chunks.length;

      for (let p = 0; p < chunks.length; p++) {
        const chunk = chunks[p];
        const partName =
          totalParts > 1 ? `${packTitle} (${p + 1}/${totalParts})` : packTitle;
        const packId = generateMessageID();
        const entries = [];
        const metaStickers = [];

        for (let j = 0; j < chunk.length; j++) {
          const s = chunk[j];
          const fileName = safeFileName(j);
          const branded = await rewriteWebpPackExif(s.webpBuf, {
            packId,
            packName: partName,
            publisher: '',
            emojis: [s.emoji],
          });
          entries.push({ name: fileName, data: branded });
          metaStickers.push({
            fileName,
            isAnimated: !!s.isAnimated,
            emojis: [s.emoji],
            accessibilityLabel: '',
            isLottie: !!s.isLottie,
            mimetype: 'image/webp',
          });
        }

        const zipBuf = createZip(entries);
        const meta = {
          stickerPackId: packId,
          name: partName,
          publisher: '',
          stickers: metaStickers,
          trayIconFileName: `${packId}.png`,
          stickerPackOrigin: 2,
          imageDataHash: null,
        };

        await sendPackPayload(
          sock,
          extra.from,
          { meta, zipBuf, thumbBuf: null },
          { name: partName, publisher: '', newPackId: false }
        );

        if (p < chunks.length - 1) await sleep(2500);
      }

      await extra.react('✅');
    } catch (e) {
      console.error('[telepack]', e);
      await extra.react('❌').catch(() => {});
      const errMsg =
        e?.response?.status === 401
          ? 'Invalid Telegram token — fix apiKeys.telegram in config.js'
          : e.message || 'Failed';
      return extra.reply(`❌ ${errMsg}`);
    }
  },
};
