const fs = require('fs');
const zlib = require('zlib');

const width = 256, height = 256;
const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y++) {
  raw[y * (width * 4 + 1)] = 0;
  for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    const cx = x - 128, cy = y - 128;
    const dist = Math.sqrt(cx * cx + cy * cy);
    if (dist < 90) {
      raw[offset] = 255; raw[offset + 1] = 255; raw[offset + 2] = 255; raw[offset + 3] = 255;
    } else if (dist < 110) {
      raw[offset] = 30; raw[offset + 1] = 100; raw[offset + 2] = 200; raw[offset + 3] = 255;
    } else {
      raw[offset] = 60; raw[offset + 1] = 140; raw[offset + 2] = 230; raw[offset + 3] = 255;
    }
  }
}

const deflated = zlib.deflateSync(raw);

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const chunks = [];

function addChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(crcData));
  chunks.push(len, typeB, data, crcB);
}

// Signature
chunks.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; ihdr[9] = 6;
addChunk('IHDR', ihdr);

// IDAT
addChunk('IDAT', deflated);

// IEND
addChunk('IEND', Buffer.alloc(0));

const png = Buffer.concat(chunks);
fs.writeFileSync('build/icon.png', png);
console.log('icon.png created (' + png.length + ' bytes)');
