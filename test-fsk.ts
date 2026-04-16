import { generateFskBuffer, extractFskBuffer } from './watermark-lib/src/fsk.ts';
import * as fs from 'fs';

const payload = "sess_12345678901234567"; // 22 bytes
console.log("Testing Payload:", payload);
const buffer = generateFskBuffer(payload, { amplitude: 2000 });
console.log("Generated buffer length:", buffer.length); // Should be wav file length

const wavData = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
const numSamples = (buffer.length - 44) / 2;
const channelData = new Float32Array(numSamples);

for (let i = 0; i < numSamples; i++) {
  const intVal = wavData.getInt16(44 + i * 2, true);
  channelData[i] = intVal / 32768.0;
}

const extracted = extractFskBuffer(channelData, { sampleRate: 44100 });
console.log("Extracted payload:", extracted);
