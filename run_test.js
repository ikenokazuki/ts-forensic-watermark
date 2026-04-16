import fs from 'fs';
import { generateFskBuffer, extractFskBuffer } from './watermark-lib/dist/fsk.js';
import { ReedSolomon } from './watermark-lib/dist/forensic.js';

const payload = "sess_12345678901234567";
const buf = generateFskBuffer(payload);
console.log("length", buf.length);

const wavData = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const numSamples = (buf.length - 44) / 2;
const floatData = new Float32Array(numSamples);
for (let i = 0; i < numSamples; i++) {
  floatData[i] = wavData.getInt16(44 + i * 2, true) / 32768.0;
}

const extracted = extractFskBuffer(floatData);
console.log("Extracted:", extracted);
