import { describe, it, expect } from 'vitest';
import { embedLlmVideoFrame, extractLlmVideoFrame } from '../src/llm-dct';

// 512×512 のグレーフレームを生成するヘルパー
function makeGrayFrame(w: number, h: number, value = 128) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i+1] = data[i+2] = value;
    data[i+3] = 255;
  }
  return { data, width: w, height: h };
}

describe('LLM DCT video watermark', () => {
  it('should embed and extract a payload from a gray frame', () => {
    const frame = makeGrayFrame(512, 512);
    const payload = 'TX9901SGVsbG8hV29ybGQ-'; // 22 chars

    embedLlmVideoFrame(frame, payload, { quantStep: 300 });

    // フレームが変化していることを確認
    const original = makeGrayFrame(512, 512);
    let changed = false;
    for (let i = 0; i < frame.data.length; i += 4) {
      if (frame.data[i] !== original.data[i]) { changed = true; break; }
    }
    expect(changed).toBe(true);

    // 抽出して一致確認
    const result = extractLlmVideoFrame(frame, { quantStep: 300 });
    expect(result).not.toBeNull();
    expect(result?.payload).toEqual(payload);
    expect(result?.confidence).toBeGreaterThan(50);
  });

  it('should work with custom payloadSymbols (ECC強化)', () => {
    const frame = makeGrayFrame(256, 256);
    const payload = 'TX9901SGVsbG8h'; // 14 chars (payloadSymbols=15 に合わせパディング)

    embedLlmVideoFrame(frame, payload, { quantStep: 300, payloadSymbols: 15 });
    const result = extractLlmVideoFrame(frame, { quantStep: 300, payloadSymbols: 15 });

    expect(result).not.toBeNull();
    expect(result?.payload.startsWith('TX9901SGVsbG8h')).toBe(true);
  });

  it('round-trip should preserve pixel values within acceptable range', () => {
    const frame = makeGrayFrame(128, 128, 100);
    const snapshot = new Uint8ClampedArray(frame.data);
    const payload = 'AAAAAAAAAAAAAAAAAAAAAA';

    embedLlmVideoFrame(frame, payload, { quantStep: 300 });

    // 最大輝度変化が許容範囲内（±10 以内）であることを確認
    let maxDiff = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      maxDiff = Math.max(maxDiff, Math.abs(frame.data[i] - snapshot[i]));
    }
    expect(maxDiff).toBeLessThanOrEqual(10);
  });
});
