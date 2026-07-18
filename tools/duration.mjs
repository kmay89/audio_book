// Audio duration from raw bytes, no dependencies.
// Supports MP3 (Xing/Info/VBRI or full frame walk), M4A/MP4 (mvhd), and WAV (fmt/data).
// Returns duration in seconds (float), or throws if the format is unrecognized.

export function audioDuration(buf, name = ''){
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE')
    return wavDuration(buf);
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp')
    return mp4Duration(buf);
  const mp3 = mp3Duration(buf);
  if (mp3 != null) return mp3;
  throw new Error(`unrecognized audio format: ${name}`);
}

function wavDuration(buf){
  let off = 12, byteRate = 0, dataLen = 0;
  while (off + 8 <= buf.length){
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') dataLen = size;
    off += 8 + size + (size % 2);
  }
  if (!byteRate || !dataLen) throw new Error('bad wav');
  return dataLen / byteRate;
}

function mp4Duration(buf){
  // walk top-level boxes to moov, then moov children to mvhd
  const findBox = (start, end, type) => {
    let off = start;
    while (off + 8 <= end){
      let size = buf.readUInt32BE(off);
      const t = buf.toString('ascii', off + 4, off + 8);
      let head = 8;
      if (size === 1){ size = Number(buf.readBigUInt64BE(off + 8)); head = 16; }
      else if (size === 0) size = end - off;
      if (t === type) return [off + head, off + size];
      off += size;
    }
    return null;
  };
  const moov = findBox(0, buf.length, 'moov');
  if (!moov) throw new Error('no moov');
  const mvhd = findBox(moov[0], moov[1], 'mvhd');
  if (!mvhd) throw new Error('no mvhd');
  const ver = buf[mvhd[0]];
  if (ver === 1){
    const timescale = buf.readUInt32BE(mvhd[0] + 20);
    const duration = Number(buf.readBigUInt64BE(mvhd[0] + 24));
    return duration / timescale;
  }
  const timescale = buf.readUInt32BE(mvhd[0] + 12);
  const duration = buf.readUInt32BE(mvhd[0] + 16);
  return duration / timescale;
}

const BITRATES = { // kbps, [versionKey][layer][index]
  v1l3: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
  v2l3: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
};
const SAMPLE_RATES = {3: [44100,48000,32000], 2: [22050,24000,16000], 0: [11025,12000,8000]};

function mp3Duration(buf){
  let off = 0;
  // skip ID3v2
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3'){
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }
  // find first valid frame
  while (off + 4 < buf.length && !isFrameHeader(buf, off)) off++;
  if (off + 4 >= buf.length) return null;

  const first = parseFrame(buf, off);
  if (!first) return null;

  // Xing/Info header (VBR) — frames count is authoritative
  const xingOff = off + 4 + first.sideInfo;
  if (xingOff + 16 <= buf.length){
    const tag = buf.toString('ascii', xingOff, xingOff + 4);
    if (tag === 'Xing' || tag === 'Info'){
      const flags = buf.readUInt32BE(xingOff + 4);
      if (flags & 1){
        const frames = buf.readUInt32BE(xingOff + 8);
        return frames * first.samplesPerFrame / first.sampleRate;
      }
    }
  }
  // VBRI header
  const vbriOff = off + 4 + 32;
  if (vbriOff + 26 <= buf.length && buf.toString('ascii', vbriOff, vbriOff + 4) === 'VBRI'){
    const frames = buf.readUInt32BE(vbriOff + 14);
    return frames * first.samplesPerFrame / first.sampleRate;
  }
  // walk every frame (accurate for CBR and headerless VBR)
  let seconds = 0, pos = off, bad = 0;
  while (pos + 4 < buf.length){
    const f = isFrameHeader(buf, pos) && parseFrame(buf, pos);
    if (f && f.length > 0){
      seconds += f.samplesPerFrame / f.sampleRate;
      pos += f.length;
      bad = 0;
    } else {
      pos++;
      if (++bad > 2048) break; // trailing tag/garbage — stop scanning
    }
  }
  return seconds > 0 ? seconds : null;
}

function isFrameHeader(buf, off){
  return buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0
    && (buf[off + 1] & 0x18) !== 0x08          // version reserved
    && (buf[off + 1] & 0x06) !== 0x00          // layer reserved
    && (buf[off + 2] & 0xf0) !== 0xf0          // bitrate 'bad'
    && (buf[off + 2] & 0x0c) !== 0x0c;         // samplerate reserved
}

function parseFrame(buf, off){
  const b1 = buf[off + 1], b2 = buf[off + 2], b3 = buf[off + 3];
  const versionBits = (b1 >> 3) & 3;           // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (b1 >> 1) & 3;             // 1=Layer3
  if (layerBits !== 1) return null;            // only Layer III expected
  const mpeg1 = versionBits === 3;
  const bitrateIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 3;
  const padding = (b2 >> 1) & 1;
  const channelMode = (b3 >> 6) & 3;
  const sampleRate = SAMPLE_RATES[versionBits] && SAMPLE_RATES[versionBits][srIdx];
  const bitrate = (mpeg1 ? BITRATES.v1l3 : BITRATES.v2l3)[bitrateIdx] * 1000;
  if (!sampleRate || !bitrate) return null;
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const length = Math.floor(samplesPerFrame / 8 * bitrate / sampleRate) + padding;
  const mono = channelMode === 3;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  return {sampleRate, bitrate, samplesPerFrame, length, sideInfo};
}
