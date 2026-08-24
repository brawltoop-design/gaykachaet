'use strict';

/*
 * Минимальный ZIP-писатель без зависимостей (метод store, без сжатия).
 * Используется для упаковки каруселей Instagram в один архив.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');


// --- Минимальный ZIP (метод store, без сжатия) ---
// Медиафайлы уже сжаты, так что deflate только жёг бы процессор.
// Пишем потоково: два прохода по файлу (CRC32, затем данные) — без буферизации в память.

function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) |
    (Math.floor(d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) |
    (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function crc32File(file, cb) {
  let crc = 0;
  const rs = fs.createReadStream(file);
  rs.on('data', (chunk) => { crc = zlib.crc32(chunk, crc); });
  rs.on('end', () => cb(null, crc >>> 0));
  rs.on('error', cb);
}

function makeZip(files, zipPath, done) {
  const out = fs.createWriteStream(zipPath);
  const entries = [];
  let offset = 0;
  let i = 0;
  let failed = false;

  const fail = (err) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(zipPath, { force: true }, () => done(err));
  };

  out.on('error', fail);

  const write = (buf, cb) => { out.write(buf) ? cb() : out.once('drain', cb); };

  function next() {
    if (failed) return;
    if (i >= files.length) return finish();
    const file = files[i++];
    const nameBuf = Buffer.from(path.basename(file), 'utf8');

    fs.stat(file, (err, st) => {
      if (err) return fail(err);
      // ZIP32 не умеет записи больше 4 ГБ; для каруселей это недостижимо.
      if (st.size >= 0xffffffff) return fail(new Error('файл больше 4 ГБ'));

      crc32File(file, (err2, crc) => {
        if (err2) return fail(err2);
        const { time, date } = dosDateTime(st.mtime);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);  // сигнатура
        head.writeUInt16LE(20, 4);          // нужная версия
        head.writeUInt16LE(0x0800, 6);      // флаг: имя в UTF-8
        head.writeUInt16LE(0, 8);           // метод: store
        head.writeUInt16LE(time, 10);
        head.writeUInt16LE(date, 12);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(st.size, 18);    // сжатый = исходному
        head.writeUInt32LE(st.size, 22);
        head.writeUInt16LE(nameBuf.length, 26);
        head.writeUInt16LE(0, 28);          // extra

        entries.push({ nameBuf, crc, size: st.size, time, date, offset });

        write(Buffer.concat([head, nameBuf]), () => {
          offset += head.length + nameBuf.length + st.size;
          const rs = fs.createReadStream(file);
          rs.on('error', fail);
          rs.pipe(out, { end: false });
          rs.on('end', next);
        });
      });
    });
  }

  function finish() {
    const cdStart = offset;
    const chunks = [];
    for (const e of entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);   // версия создателя
      h.writeUInt16LE(20, 6);   // нужная версия
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);   // store
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30);   // extra
      h.writeUInt16LE(0, 32);   // комментарий
      h.writeUInt16LE(0, 34);   // номер диска
      h.writeUInt16LE(0, 36);   // внутренние атрибуты
      h.writeUInt32LE(0, 38);   // внешние атрибуты
      h.writeUInt32LE(e.offset, 42);
      chunks.push(h, e.nameBuf);
      offset += h.length + e.nameBuf.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    chunks.push(eocd);
    out.end(Buffer.concat(chunks), () => { if (!failed) done(null); });
  }

  next();
}


module.exports = { makeZip };
