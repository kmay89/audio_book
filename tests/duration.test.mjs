// Unit tests for tools/duration.mjs against synthesized files.
import {audioDuration} from '../tools/duration.mjs';

let fail = 0;
const check = (name, got, want, tol = 0.05) => {
  const ok = Math.abs(got - want) <= tol * want;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${got.toFixed(3)}s want ~${want}s`);
  if (!ok) fail++;
};

// ---- CBR MP3: MPEG1 Layer III, 44100 Hz, 128 kbps, stereo, 100 frames
function mp3Frame(){
  const len = Math.floor(1152 / 8 * 128000 / 44100); // 417, no padding
  const f = Buffer.alloc(len);
  f[0] = 0xff; f[1] = 0xfb;        // sync, MPEG1, Layer III, no CRC
  f[2] = 0x90;                     // bitrate idx 9 (128k), 44100, no padding
  f[3] = 0x00;                     // stereo
  return f;
}
const cbr = Buffer.concat(Array.from({length: 100}, mp3Frame));
check('mp3 CBR (100 frames)', audioDuration(cbr, 'cbr.mp3'), 100 * 1152 / 44100);

// ---- CBR with ID3v2 prefix
const id3 = Buffer.alloc(10 + 200);
id3.write('ID3'); id3[6] = 0; id3[9] = 200 & 0x7f;
check('mp3 CBR + ID3v2', audioDuration(Buffer.concat([id3, cbr]), 'id3.mp3'), 100 * 1152 / 44100);

// ---- VBR MP3 with Xing header claiming 1000 frames
const xingFrame = mp3Frame();
const xo = 4 + 32; // stereo MPEG1 side info
xingFrame.write('Xing', xo);
xingFrame.writeUInt32BE(1, xo + 4);      // flags: FRAMES
xingFrame.writeUInt32BE(1000, xo + 8);   // frame count
const vbr = Buffer.concat([xingFrame, ...Array.from({length: 5}, mp3Frame)]);
check('mp3 Xing (1000 frames)', audioDuration(vbr, 'vbr.mp3'), 1000 * 1152 / 44100);

// ---- WAV: 8000 Hz mono 16-bit, 3 seconds
function wav(seconds, rate = 8000){
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF'); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}
check('wav 3s', audioDuration(wav(3), 't.wav'), 3, 0.01);

// ---- M4A: minimal ftyp + moov>mvhd v0, timescale 600, duration 6000 (10 s)
function m4a(){
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0); ftyp.write('ftyp', 4); ftyp.write('M4A ', 8);
  const mvhd = Buffer.alloc(8 + 100);
  mvhd.writeUInt32BE(108, 0); mvhd.write('mvhd', 4);
  mvhd.writeUInt32BE(600, 8 + 12);   // timescale
  mvhd.writeUInt32BE(6000, 8 + 16);  // duration
  const moov = Buffer.alloc(8);
  moov.writeUInt32BE(8 + mvhd.length, 0); moov.write('moov', 4);
  return Buffer.concat([ftyp, moov, mvhd]);
}
check('m4a mvhd 10s', audioDuration(m4a(), 't.m4a'), 10, 0.01);

// regression: corrupt files must throw/return, never hang or crash
function expectThrow(name, buf){
  try { audioDuration(buf, name); console.log(`FAIL ${name}: did not throw`); process.exitCode = 1; }
  catch(e){ console.log(`PASS ${name}: rejected (${e.message})`); }
}
// m4a with 64-bit box size of 0 (would loop forever without the guard)
const evil = Buffer.alloc(48);
evil.writeUInt32BE(16, 0); evil.write('ftyp', 4);
evil.writeUInt32BE(1, 16); evil.write('moov', 20); evil.writeBigUInt64BE(0n, 24);
expectThrow('m4a corrupt 64-bit size 0', evil);
// truncated wav (fmt chunk header present, body cut off)
const twav = Buffer.alloc(20);
twav.write('RIFF'); twav.writeUInt32LE(100, 4); twav.write('WAVE', 8); twav.write('fmt ', 12); twav.writeUInt32LE(16, 16);
expectThrow('wav truncated', twav);
if (process.exitCode) fail++;
console.log(fail ? `\n${fail} FAILURES` : '\nall duration tests passed');
process.exit(fail ? 1 : 0);
