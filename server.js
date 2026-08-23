'use strict';

/*
 * GAYkachaet — вставь ссылку, получи видео в идеальном качестве.
 * Тонкая веб-обёртка над yt-dlp + ffmpeg. Без внешних зависимостей.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TMP_ROOT = path.join(os.tmpdir(), 'gaykachaet');
const FILE_TTL_MS = 15 * 60 * 1000; // готовый файл живёт 15 минут

fs.mkdirSync(TMP_ROOT, { recursive: true });

// token -> { dir, filepath, filename, timer }
const files = new Map();

function cleanupToken(token) {
  const entry = files.get(token);
  if (!entry) return;
  clearTimeout(entry.timer);
  files.delete(token);
  fs.rm(entry.dir, { recursive: true, force: true }, () => {});
}

function registerFile(dir, filepath) {
  const token = crypto.randomBytes(9).toString('hex');
  const filename = path.basename(filepath);
  const timer = setTimeout(() => cleanupToken(token), FILE_TTL_MS);
  if (timer.unref) timer.unref();
  files.set(token, { dir, filepath, filename, timer });
  return { token, filename };
}

// ---------- SSE helpers ----------

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 15000\n\n');
}

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------- yt-dlp download ----------

const MERGE_FORMAT = process.env.MERGE_FORMAT || 'mp4';

function handleDownload(req, res, query) {
  const url = (query.get('url') || '').trim();
  const audioOnly = query.get('audio') === '1';
  const compat = query.get('quality') === 'compat';
  // «Файл для QuickTime/Premiere»: если скачалось в VP9/AV1 — перекодировать в H.264.
  const wantH264 = query.get('h264') === '1';

  // Обрезка: start и dur в секундах. Качается только нужный кусок.
  const trimStart = query.has('start') ? parseFloat(query.get('start')) : null;
  const trimDur = query.has('dur') ? parseFloat(query.get('dur')) : null;
  const trim = trimStart !== null || trimDur !== null;

  if (!/^https?:\/\//i.test(url)) {
    sseInit(res);
    sseSend(res, 'fail', { message: 'Нужна корректная ссылка (http/https).' });
    return res.end();
  }

  if (trim) {
    const badStart = !Number.isFinite(trimStart) || trimStart < 0;
    const badDur = !Number.isFinite(trimDur) || trimDur <= 0 || trimDur > 3600;
    if (badStart || badDur) {
      sseInit(res);
      sseSend(res, 'fail', { message: 'Неверное время обрезки: укажи начало и длительность (до часа).' });
      return res.end();
    }
  }

  sseInit(res);

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(TMP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });

  const outTemplate = path.join(dir, '%(title).150B [%(id)s].%(ext)s');
  const finalPathFile = path.join(dir, '.finalpath');
  const progTemplate =
    'download:@@@%(progress._percent_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s';

  const args = [
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--progress-template', progTemplate,
    '--print-to-file', 'after_move:%(filepath)s', finalPathFile,
    '-o', outTemplate,
  ];

  if (trim) {
    // Качаем только нужный отрезок (yt-dlp тянет по HTTP только эти байты).
    // --force-keyframes-at-cuts даёт точный старт (иначе резалось бы по
    // ближайшему ключевому кадру, с промахом в пару секунд).
    args.push(
      '--download-sections', `*${trimStart}-${trimStart + trimDur}`,
      '--force-keyframes-at-cuts'
    );
  }

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (compat) {
    // Режим «играет везде»: только H.264+AAC — QuickTime, Safari, телефоны,
    // телевизоры. На YouTube это максимум 1080p. Фолбэки — для сайтов,
    // где H.264 не раздают вовсе.
    args.push(
      '-f', 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/bv*+ba/b',
      '-S', 'res,fps,vcodec:h264,acodec:aac',
      '--merge-output-format', MERGE_FORMAT
    );
  } else {
    // Идеальнейшее качество: лучшее видео + лучший звук, склейка в один файл.
    // Приоритет — максимальное разрешение и fps; при равенстве предпочитаем
    // H.264/AAC, чтобы файл открывался везде (QuickTime, Safari, телефоны).
    // Экзотичные кодеки (AV1/VP9/Opus) берутся только там, где без них
    // недоступно более высокое разрешение (4K/8K) — QuickTime такие не играет,
    // фронт покажет подсказку (см. vcodec в событии done).
    args.push(
      '-f', 'bv*+ba/b',
      '-S', 'res,fps,vcodec:h264,acodec:aac',
      '--merge-output-format', MERGE_FORMAT
    );
  }
  args.push(url);

  let finished = false;
  let lastError = '';
  let phase = 'download';
  let ffmpegChild = null; // живой процесс конвертации — убить при уходе клиента

  const yt = spawn('yt-dlp', args, { windowsHide: true });

  const stdoutSplit = lineSplitter(handleLine);
  const stderrSplit = lineSplitter(handleLine);
  yt.stdout.on('data', stdoutSplit);
  yt.stderr.on('data', stderrSplit);

  function handleLine(line) {
    if (!line) return;

    if (line.startsWith('@@@')) {
      const [pct, size, speed, eta] = line.slice(3).split('|');
      const percent = parseFloat(pct);
      sseSend(res, 'progress', {
        percent: Number.isFinite(percent) ? percent : null,
        size: clean(size),
        speed: clean(speed),
        eta: clean(eta),
        phase,
      });
      return;
    }

    if (line.includes('[Merger]')) {
      phase = 'merge';
      sseSend(res, 'phase', { phase, label: 'Склейка видео и звука…' });
    } else if (line.includes('[ExtractAudio]')) {
      phase = 'convert';
      sseSend(res, 'phase', { phase, label: 'Извлечение звука…' });
    } else if (/\[(VideoConvertor|Fixup)/.test(line)) {
      phase = 'convert';
      sseSend(res, 'phase', { phase, label: 'Обработка…' });
    } else if (/^ERROR/i.test(line) || /^\s*yt-dlp: error/i.test(line)) {
      lastError = line.replace(/^ERROR:?\s*/i, '').trim();
    }
  }

  yt.on('error', (err) => {
    if (finished) return;
    finished = true;
    sseSend(res, 'fail', {
      message:
        err.code === 'ENOENT'
          ? 'yt-dlp не найден на сервере.'
          : 'Не удалось запустить загрузчик.',
    });
    res.end();
    fs.rm(dir, { recursive: true, force: true }, () => {});
  });

  yt.on('close', (code) => {
    if (finished) return;
    finished = true;

    if (code !== 0) {
      sseSend(res, 'fail', {
        message: friendlyError(lastError) || 'Не удалось скачать это видео.',
      });
      res.end();
      fs.rm(dir, { recursive: true, force: true }, () => {});
      return;
    }

    const filepath = resolveOutputFile(dir, finalPathFile);
    if (!filepath) {
      sseSend(res, 'fail', { message: 'Файл не найден после загрузки.' });
      res.end();
      fs.rm(dir, { recursive: true, force: true }, () => {});
      return;
    }

    finishUp(filepath);
  });

  function finishUp(filepath) {
    probeMedia(filepath, (info) => {
      const exotic = info.vcodec && !/^(h264|avc|hevc|h265|mpeg4)/i.test(info.vcodec);
      if (!(wantH264 && !audioOnly && exotic)) {
        const { token, filename } = registerFile(dir, filepath);
        sseSend(res, 'done', { token, filename, vcodec: info.vcodec });
        return res.end();
      }

      sseSend(res, 'phase', { phase: 'h264', label: 'Конвертация в H.264…' });
      transcodeH264(filepath, info, {
        onSpawn: (child) => { ffmpegChild = child; },
        onProgress: (p) => sseSend(res, 'progress', {
          percent: p.percent, size: '', speed: p.speed, eta: '', phase: 'h264',
        }),
        onDone: (outPath) => {
          const finalPath = outPath || filepath; // не вышло — отдаём как есть, фронт предупредит
          probeMedia(finalPath, (info2) => {
            const { token, filename } = registerFile(dir, finalPath);
            sseSend(res, 'done', { token, filename, vcodec: info2.vcodec });
            res.end();
          });
        },
      });
    });
  }

  // Клиент ушёл — гасим процессы и чистим временную папку.
  req.on('close', () => {
    if (finished && !ffmpegChild) return;
    if (finished && ffmpegChild && ffmpegChild.exitCode !== null) return;
    finished = true;
    try { yt.kill('SIGKILL'); } catch (_) {}
    try { if (ffmpegChild) ffmpegChild.kill('SIGKILL'); } catch (_) {}
    fs.rm(dir, { recursive: true, force: true }, () => {});
  });
}

function resolveOutputFile(dir, finalPathFile) {
  // 1) Точный путь из --print-to-file.
  try {
    const recorded = fs.readFileSync(finalPathFile, 'utf8').trim().split('\n').pop();
    if (recorded && fs.existsSync(recorded)) return recorded;
  } catch (_) {}
  // 2) Фолбэк: самый большой готовый файл в папке.
  try {
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith('.') && !f.endsWith('.part'))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, size: fs.statSync(p).size };
      })
      .sort((a, b) => b.size - a.size);
    return candidates.length ? candidates[0].p : null;
  } catch (_) {
    return null;
  }
}

// ---------- file serving ----------

function handleFile(req, res, token) {
  const entry = files.get(token);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Ссылка истекла. Скачай заново.');
  }

  fs.stat(entry.filepath, (err, stat) => {
    if (err) {
      cleanupToken(token);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Файл больше недоступен.');
    }

    const isMp3 = entry.filename.toLowerCase().endsWith('.mp3');
    const asciiName = entry.filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');

    res.writeHead(200, {
      'Content-Type': isMp3 ? 'audio/mpeg' : 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition':
        `attachment; filename="${asciiName}"; ` +
        `filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    });

    const stream = fs.createReadStream(entry.filepath);
    stream.pipe(res);
    stream.on('error', () => res.destroy());
    res.on('close', () => {
      // Отдали (или клиент прервал) — убираем за собой.
      cleanupToken(token);
    });
  });
}

// ---------- static ----------

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream',
    });
    res.end(data);
  });
}

// ---------- router ----------

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

  if (pathname === '/api/download') return handleDownload(req, res, parsed.searchParams);

  const fileMatch = pathname.match(/^\/api\/file\/([a-f0-9]+)$/);
  if (fileMatch) return handleFile(req, res, fileMatch[1]);

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`GAYkachaet запущен → http://localhost:${PORT}`);
});

// ---------- utils ----------

function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    // yt-dlp с --newline шлёт и \n, и \r (обновление прогресса).
    let idx;
    while ((idx = buf.search(/[\r\n]/)) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
}

function clean(s) {
  if (!s) return '';
  const t = s.trim();
  return t === 'NA' || t === 'Unknown' ? '' : t;
}

function shorten(s) {
  if (!s) return '';
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

// Кодеки, высота и длительность готового файла (для подсказок и конвертации).
function probeMedia(filepath, cb) {
  const ff = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,height',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filepath,
  ], { windowsHide: true });
  const empty = { vcodec: '', acodec: '', height: 0, duration: 0 };
  let out = '';
  let called = false;
  const once = (v) => { if (!called) { called = true; cb(v); } };
  ff.stdout.on('data', (d) => { out += d; });
  ff.on('error', () => once(empty));
  ff.on('close', () => {
    try {
      const j = JSON.parse(out);
      const v = (j.streams || []).find((s) => s.codec_type === 'video');
      const a = (j.streams || []).find((s) => s.codec_type === 'audio');
      once({
        vcodec: (v && v.codec_name) || '',
        acodec: (a && a.codec_name) || '',
        height: (v && v.height) || 0,
        duration: parseFloat(j.format && j.format.duration) || 0,
      });
    } catch (_) { once(empty); }
  });
}

// Перекодирование VP9/AV1 → H.264: на маке аппаратно (VideoToolbox), иначе libx264.
// Успех: удаляем оригинал, отдаём outPath. Провал: onDone(null) — отдадим оригинал.
function transcodeH264(inPath, info, hooks) {
  const outPath = inPath.replace(/\.[^.\/]+$/, '') + ' (H.264).mp4';
  const h = info.height || 1080;
  const bitrate = h >= 2160 ? '40M' : h >= 1440 ? '24M' : h >= 1080 ? '12M' : '8M';
  const audioArgs = /^(aac|mp4a)/i.test(info.acodec || '')
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '192k'];

  const attempt = (videoArgs, fallback) => {
    const ff = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inPath,
      '-pix_fmt', 'yuv420p',
      ...videoArgs,
      ...audioArgs,
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      outPath,
    ], { windowsHide: true });
    hooks.onSpawn(ff);

    const durUs = (info.duration || 0) * 1e6;
    let pct = 0;
    let speed = '';
    let buf = '';
    ff.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        // ffmpeg пишет out_time_us / out_time_ms — оба в микросекундах
        const t = line.match(/^out_time_[um]s=(\d+)/);
        if (t && durUs > 0) pct = Math.min(100, (parseInt(t[1], 10) / durUs) * 100);
        const s = line.match(/^speed=\s*([\d.]+x)/);
        if (s) speed = s[1];
        if (line.startsWith('progress=')) {
          hooks.onProgress({ percent: Math.round(pct * 10) / 10, speed });
        }
      }
    });
    ff.on('error', () => (fallback ? fallback() : hooks.onDone(null)));
    ff.on('close', (code) => {
      if (code === 0) {
        fs.rm(inPath, { force: true }, () => hooks.onDone(outPath));
      } else if (fallback) {
        fallback();
      } else {
        fs.rm(outPath, { force: true }, () => hooks.onDone(null));
      }
    });
  };

  const vt = ['-c:v', 'h264_videotoolbox', '-b:v', bitrate];
  const x264 = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18'];
  if (process.platform === 'darwin') attempt(vt, () => attempt(x264, null));
  else attempt(x264, null);
}

// Переводим частые ошибки yt-dlp в понятные подсказки.
function friendlyError(s) {
  if (!s) return '';
  if (/403|Forbidden/i.test(s)) {
    return 'YouTube отклонил запрос (403). Обычно это устаревший yt-dlp — обнови его: brew upgrade yt-dlp (или pip install -U yt-dlp) и попробуй снова.';
  }
  if (/Sign in to confirm|not a bot/i.test(s)) {
    return 'YouTube требует подтверждение (антибот). С серверных IP это частое дело — нужны cookies браузера, см. README.';
  }
  if (/Private video|Video unavailable|removed/i.test(s)) {
    return 'Видео недоступно: приватное, удалено или закрыто по региону.';
  }
  if (/Unsupported URL/i.test(s)) {
    return 'Этот сайт не поддерживается yt-dlp. Проверь ссылку.';
  }
  return shorten(s);
}
