import React, { useState, useCallback, useRef } from 'react';
import { Upload, Shield, ShieldAlert, ShieldCheck, FileImage, FileVideo, FileAudio, CheckCircle, AlertTriangle, Key, Download, Settings, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from './lib/utils';
// ✅ ブラウザ安全なエントリーポイントを使用
// index.ts は Node.js専用の node.ts（jimp, fs, fluent-ffmpeg）をre-exportするため
// ブラウザ環境では browser.ts を使う必要があります。
// browser.ts = forensic + utils + fsk + analyzer のみ（Node.js依存なし）
import {
  generateWatermarkPayloads,
  embedImageWatermarks,
  embedLlmImageWatermark,
  finalizeImageBuffer,
  analyzeTextWatermarks,
  analyzeAudioWatermarks,
  analyzeImageWatermarks,
  analyzeLlmImageWatermarks,
  verifyWatermarks,
  generateFskBuffer,
  embedLlmVideoFrame,
  extractLlmVideoFrame,
  ForensicOptions,
  LlmVideoOptions
} from '../watermark-lib/src/browser';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

type Tab = 'analyze' | 'sign';

// ─── ブラウザ用 PNG ↔ ImageData 変換ヘルパー ────────────────────────────────
async function pngBytesToImageData(bytes: Uint8Array): Promise<ImageData> {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageDataToPngBytes(imageData: ImageData): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

// ─── 動画から均等間隔でフレームをサンプリング（ブラウザネイティブ） ────────
async function sampleVideoFrames(file: File, count: number): Promise<ImageData[]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = async () => {
      const duration = video.duration || 10;
      const step = duration / (count + 1);
      const timestamps = Array.from({ length: count }, (_, i) => step * (i + 1));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d')!;
      const frames: ImageData[] = [];
      for (const ts of timestamps) {
        await new Promise<void>(r => {
          video.onseeked = () => {
            ctx.drawImage(video, 0, 0);
            frames.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
            r();
          };
          video.currentTime = ts;
        });
      }
      URL.revokeObjectURL(url);
      resolve(frames);
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('video load failed')); };
    video.src = url;
  });
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('analyze');
  const [secretKey, setSecretKey] = useState('my-super-secret-key');
  const [showSettings, setShowSettings] = useState(false);
  const [forensicOptions, setForensicOptions] = useState<ForensicOptions>({
    delta: 120,
    varianceThreshold: 25,
    arnoldIterations: 7,
    force: false,
    robustAngles: [0, 90, 180, 270, 0.5, -0.5, 1, -1, 2, -2, 3, -3]
  });
  const [fskOptions, setFskOptions] = useState({
    bitDuration: 0.025,
    amplitude: 50,
  });
  const [secureIdLength, setSecureIdLength] = useState(6);
  const [payloadSymbols, setPayloadSymbols] = useState(22);
  const [isRobustDetection, setIsRobustDetection] = useState(true);
  const [llmOptions, setLlmOptions] = useState<LlmVideoOptions>({
    quantStep: 300,
    coeffRow: 2,
    coeffCol: 1,
    arnoldIterations: 7,
  });
  const [useLlmEmbed, setUseLlmEmbed] = useState(false);
  const [useLlmVideoEmbed, setUseLlmVideoEmbed] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <Shield className="w-8 h-8 text-blue-600" />
          <h1 className="text-xl font-bold">Forensic Watermark Studio</h1>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6">
        <div className="flex gap-4 mb-6 border-b border-gray-200 pb-2">
          <button
            onClick={() => setActiveTab('analyze')}
            className={cn(
              "px-4 py-2 font-medium rounded-t-lg transition-colors",
              activeTab === 'analyze' ? "bg-blue-50 text-blue-700 border-b-2 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
            )}
          >
            透かし解析 (Analyze)
          </button>
          <button
            onClick={() => setActiveTab('sign')}
            className={cn(
              "px-4 py-2 font-medium rounded-t-lg transition-colors",
              activeTab === 'sign' ? "bg-blue-50 text-blue-700 border-b-2 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
            )}
          >
            署名・埋め込み (Sign & Embed)
          </button>
        </div>

        <div className="mb-6 bg-white p-4 rounded-lg border border-gray-200 shadow-sm flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Key className="w-5 h-5 text-gray-400" />
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Secret Key (検証・署名用共通キー)</label>
              <input 
                type="text" 
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="mt-6 flex items-center gap-2 px-3 py-2 border border-blue-200 text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors whitespace-nowrap"
            >
              <Settings className="w-4 h-4" />
              透かし詳細設定
              {showSettings ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {showSettings && (
            <div className="pt-4 border-t border-gray-200 flex flex-col gap-4">

              {/* ── 共通設定 ── */}
              <div>
                <h3 className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-wider">共通設定（全メディア対象）</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Payload Symbols (ペイロード長)</label>
                    <select
                      value={payloadSymbols}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setPayloadSymbols(next);
                        // ID長がペイロード長を超えないよう自動調整
                        if (secureIdLength >= next) setSecureIdLength(Math.min(6, next - 1));
                      }}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm"
                    >
                      {[
                        { v: 10, label: '10 シンボル — 画像・LLM DCT ECC53 / FSK ECC30（超高耐性）' },
                        { v: 15, label: '15 シンボル — 画像・LLM DCT ECC48 / FSK ECC25（高耐性）' },
                        { v: 22, label: '22 シンボル — 画像・LLM DCT ECC41 / FSK ECC18（推奨）' },
                        { v: 30, label: '30 シンボル — 画像・LLM DCT ECC33 / FSK ECC10（長いID向け）' },
                        { v: 40, label: '40 シンボル — 画像・LLM DCT ECC23 / FSK ECC0（非推奨）' },
                      ].map(({ v, label }) => (
                        <option key={v} value={v}>{label}</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      小さいほどECCが強くなり破損耐性が向上します。<span className="text-amber-600 font-medium">埋め込みと解析で必ず同じ値を使用してください。</span>
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Secure ID Length (ID長)</label>
                    <select
                      value={secureIdLength}
                      onChange={(e) => setSecureIdLength(Number(e.target.value))}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm"
                    >
                      {[4, 6, 8, 10, 12].filter(v => v < payloadSymbols).map(v => {
                        const hmacBits = (payloadSymbols - v) * 6;
                        const rec =
                          hmacBits >= 96 ? (v <= 4 ? '★セキュリティ優先' : '★推奨') :
                          hmacBits >= 80 ? 'NIST最小基準充足' :
                          hmacBits >= 64 ? '⚠ 注意' : '⛔ 非推奨';
                        return (
                          <option key={v} value={v}>
                            {v}文字 — HMAC {payloadSymbols - v}文字/{hmacBits}bit ({rec})
                          </option>
                        );
                      })}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      ID長が長いほどHMACが短くなり署名の偽造耐性が低下します。<span className="text-amber-600 font-medium">署名時と解析時で必ず一致させてください。</span>
                    </p>
                  </div>
                </div>
              </div>

              {/* ── 画像透かし設定 ── */}
              <div className="pt-2 border-t border-gray-100">
                <h3 className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-wider">画像透かし設定</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                  <div>
                    <label className="block text-sm justify-between flex mb-1">
                      <span className="font-medium text-gray-700">Delta (彫りの深さ)</span>
                      <span className="text-gray-500">{forensicOptions.delta}</span>
                    </label>
                    <input
                      type="range" min="10" max="255" step="10"
                      value={forensicOptions.delta}
                      onChange={(e) => setForensicOptions({ ...forensicOptions, delta: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500">高くすると圧縮耐性が上がりますが、ノイズが目立ちます。(推奨: 120)</p>
                  </div>

                  <div>
                    <label className="block text-sm justify-between flex mb-1">
                      <span className="font-medium text-gray-700">Variance Threshold (分散閾値)</span>
                      <span className="text-gray-500">{forensicOptions.varianceThreshold}</span>
                    </label>
                    <input
                      type="range" min="0" max="100" step="5"
                      value={forensicOptions.varianceThreshold}
                      onChange={(e) => setForensicOptions({ ...forensicOptions, varianceThreshold: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500">平坦な部分（青空など）への埋め込みを避ける閾値です。(推奨: 25)</p>
                  </div>

                  <div>
                    <label className="block text-sm justify-between flex mb-1">
                      <span className="font-medium text-gray-700">Arnold Iterations (スクランブル強度)</span>
                      <span className="text-gray-500">{forensicOptions.arnoldIterations}</span>
                    </label>
                    <input
                      type="range" min="1" max="20" step="1"
                      value={forensicOptions.arnoldIterations}
                      onChange={(e) => setForensicOptions({ ...forensicOptions, arnoldIterations: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500">空間スプレッドの反復回数です。(推奨: 7)</p>
                  </div>

                  <div className="flex flex-col gap-3 pt-6">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={forensicOptions.force}
                        onChange={(e) => setForensicOptions({ ...forensicOptions, force: e.target.checked })}
                        className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                      />
                      <span className="text-sm font-medium text-gray-700">Force (強制埋め込み)</span>
                    </label>
                    <p className="text-xs text-gray-500">分散閾値を無視して真っ白な画像などにも埋め込みます。</p>

                    <div className="flex flex-col gap-2 p-3 bg-gray-50 border border-gray-100 rounded-md">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isRobustDetection}
                          onChange={(e) => setIsRobustDetection(e.target.checked)}
                          className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                        />
                        <span className="text-xs text-gray-700 font-medium">画像回転耐性を有効にする（低速）</span>
                      </label>
                      <p className="text-[10px] text-gray-500 pl-6">
                        画像を 90/180/270度、±0.5/1度回転させてスキャンします。傾いた写真でも検出可能です。
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── 音声・動画 (FSK) 設定 ── */}
              <div className="pt-2 border-t border-gray-100">
                <h3 className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-wider">音声・動画 (FSK) 設定</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                  <div>
                    <label className="block text-sm justify-between flex mb-1">
                      <span className="font-medium text-gray-700">Bit Duration (1ビット長)</span>
                      <span className="text-gray-500">{fskOptions.bitDuration}s</span>
                    </label>
                    <input
                      type="range" min="0.01" max="0.1" step="0.005"
                      value={fskOptions.bitDuration}
                      onChange={(e) => setFskOptions({ ...fskOptions, bitDuration: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500">長いほど堅牢ですが、透かし信号が長くなります。(推奨: 0.025)</p>
                  </div>

                  <div>
                    <label className="block text-sm justify-between flex mb-1">
                      <span className="font-medium text-gray-700">FSK Amplitude (振幅)</span>
                      <span className="text-gray-500">{fskOptions.amplitude}</span>
                    </label>
                    <input
                      type="range" min="10" max="5000" step="10"
                      value={fskOptions.amplitude}
                      onChange={(e) => setFskOptions({ ...fskOptions, amplitude: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500">高いほど検出率が上がりますが、ノイズが聞こえやすくなります。(推奨: 2000)</p>
                  </div>
                </div>
              </div>

              {/* ── 動画フレーム (LLM DCT) 設定 ── */}
              <div className="pt-2 border-t border-gray-100">
                <h3 className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-wider">動画フレーム透かし (LLM DCT) 設定</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                  <div>
                    <label className="block text-sm justify-between flex mb-1">
                      <span className="font-medium text-gray-700">Quant Step (量子化ステップ)</span>
                      <span className="text-gray-500">{llmOptions.quantStep}</span>
                    </label>
                    <input
                      type="range" min="50" max="1000" step="50"
                      value={llmOptions.quantStep}
                      onChange={(e) => setLlmOptions({ ...llmOptions, quantStep: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500">大きいほどH.264圧縮への耐性が上がりますが、輝度変化が大きくなります。(推奨: 300)</p>
                  </div>

                  <div>
                    <label className="block text-sm justify-between flex mb-1">
                      <span className="font-medium text-gray-700">Coeff Position (係数位置 行, 列)</span>
                      <span className="text-gray-500">({llmOptions.coeffRow}, {llmOptions.coeffCol})</span>
                    </label>
                    <div className="flex gap-2">
                      <select
                        value={llmOptions.coeffRow}
                        onChange={(e) => setLlmOptions({ ...llmOptions, coeffRow: Number(e.target.value) })}
                        className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                      >
                        {[1,2,3,4,5,6].map(v => <option key={v} value={v}>行 {v}</option>)}
                      </select>
                      <select
                        value={llmOptions.coeffCol}
                        onChange={(e) => setLlmOptions({ ...llmOptions, coeffCol: Number(e.target.value) })}
                        className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                      >
                        {[0,1,2,3,4,5,6].map(v => <option key={v} value={v}>列 {v}</option>)}
                      </select>
                    </div>
                    <p className="text-xs text-gray-500">埋め込み先のDCT係数位置。低周波(1〜3)が推奨。(推奨: 行2, 列1)</p>
                  </div>
                </div>
              </div>

            </div>
          )}
        </div>

        {activeTab === 'analyze' ? (
          <AnalyzerTab
            secretKey={secretKey}
            options={{
              ...forensicOptions,
              payloadSymbols,
              robustAngles: isRobustDetection ? forensicOptions.robustAngles : [0]
            }}
            fskOptions={{ ...fskOptions, payloadSymbols }}
            llmOptions={{ ...llmOptions, payloadSymbols, robustAngles: isRobustDetection ? forensicOptions.robustAngles : [0] }}
            secureIdLength={secureIdLength}
            payloadSymbols={payloadSymbols}
          />
        ) : (
          <SignerTab
            secretKey={secretKey}
            options={{ ...forensicOptions, payloadSymbols }}
            fskOptions={{ ...fskOptions, payloadSymbols }}
            llmOptions={{ ...llmOptions, payloadSymbols }}
            useLlmEmbed={useLlmEmbed}
            setUseLlmEmbed={setUseLlmEmbed}
            useLlmVideoEmbed={useLlmVideoEmbed}
            setUseLlmVideoEmbed={setUseLlmVideoEmbed}
            secureIdLength={secureIdLength}
            payloadSymbols={payloadSymbols}
          />
        )}
      </main>
    </div>
  );
}

function AnalyzerTab({ secretKey, options, fskOptions, llmOptions, secureIdLength, payloadSymbols }: { secretKey: string, options: ForensicOptions, fskOptions: any, llmOptions: LlmVideoOptions, secureIdLength: number, payloadSymbols: number }) {
  const [file, setFile] = useState<File | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleFileDrop = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setIsAnalyzing(true);
    setResults([]);
    setError(null);

    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let foundWatermarks: any[] = [];

      // 1. 文字列ベースの透かし（EOF, UUID, SEI）をライブラリで一括解析
      const textWMs = analyzeTextWatermarks(uint8Array);
      foundWatermarks = [...foundWatermarks, ...textWMs];

      // 2. 画像フォレンジック透かし（画像の場合）
      if (selectedFile.type.startsWith('image/')) {
        try {
          const img = new Image();
          img.src = URL.createObjectURL(selectedFile);
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });

          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const imageWMs = analyzeImageWatermarks(imageData, options);
            foundWatermarks = [...foundWatermarks, ...imageWMs];
            const llmWMs = analyzeLlmImageWatermarks(imageData, llmOptions);
            foundWatermarks = [...foundWatermarks, ...llmWMs];
          }
        } catch (err) {
          console.warn("Image processing failed", err);
        }
      }
      
      // 3. 音声FSK透かし（音声・動画の場合）
      if (!selectedFile.type.startsWith('image/')) {
        try {
          console.log("--- 音声解析開始 ---");
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
            sampleRate: 44100, 
          });
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
          const channelData = audioBuffer.getChannelData(0);
          
          const audioWMs = analyzeAudioWatermarks(channelData, { 
            sampleRate: audioBuffer.sampleRate,
            ...fskOptions
          });
          foundWatermarks = [...foundWatermarks, ...audioWMs];
        } catch (e) {
          console.warn("Audio processing failed", e);
        }
      }

      // 4. 動画フレームの LLM DCT 透かし解析（動画の場合のみ・ブラウザネイティブ）
      if (selectedFile.type.startsWith('video/')) {
        try {
          const frames = await sampleVideoFrames(selectedFile, 5);
          let best: { payload: string; confidence: number } | null = null;
          for (const frame of frames) {
            const result = extractLlmVideoFrame(frame, llmOptions);
            if (result && (!best || result.confidence > best.confidence)) best = result;
          }
          if (best && best.payload) {
            foundWatermarks.push({
              type: 'LLM_VIDEO',
              name: 'LLM DCT動画フレーム透かし (Reed-Solomon自己修復)',
              robustness: 'High (堅牢)',
              data: { payload: best.payload, confidence: best.confidence }
            });
          }
        } catch (e) {
          console.warn('LLM DCT video frame analysis failed', e);
        }
      }

      // 5. すべての透かしをライブラリで一括検証（HMAC署名チェック等）
      const verifiedResults = await verifyWatermarks(foundWatermarks, secretKey, secureIdLength, payloadSymbols);

      // 6. ピクセル系透かし（FORENSIC / LLM_VIDEO）の表示フィルタ
      // (a) confidence ≤ 50 かつ全A（全ゼロビット）のペイロードは抽出失敗のゴミデータとして除外
      // (b) 片方の方式が有効な検証済みである場合、もう片方の「失敗」結果は
      //     方式不一致による誤検出なので表示しない
      const isNullPayload = (w: typeof verifiedResults[0]) => {
        const p = w.data?.payload ?? '';
        return /^A+$/.test(p) && (w.data?.confidence ?? 100) <= 50;
      };
      const hasValidLlm      = verifiedResults.some(w => w.type === 'LLM_VIDEO' && w.verification?.valid && !isNullPayload(w));
      const hasValidForensic = verifiedResults.some(w => w.type === 'FORENSIC'  && w.verification?.valid && !isNullPayload(w));
      const filteredResults = verifiedResults.filter(w => {
        if ((w.type === 'FORENSIC' || w.type === 'LLM_VIDEO') && isNullPayload(w)) return false;
        if (w.type === 'FORENSIC'  && !w.verification?.valid && hasValidLlm)      return false;
        if (w.type === 'LLM_VIDEO' && !w.verification?.valid && hasValidForensic) return false;
        return true;
      });

      if (filteredResults.length === 0) {
        setError("電子透かしを検出できませんでした。ファイルが改ざんされているか、透かしが含まれていません。");
      } else {
        setResults(filteredResults);
      }
    } catch (err) {
      console.error(err);
      setError("ファイルの解析中にエラーが発生しました。");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-8 rounded-xl border border-gray-200 shadow-sm text-center">
        <div className="max-w-md mx-auto">
          <label className="cursor-pointer flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              <Upload className="w-10 h-10 text-gray-400 mb-3" />
              <p className="mb-2 text-sm text-gray-500"><span className="font-semibold">クリックしてファイルを選択</span> またはドラッグ＆ドロップ</p>
              <p className="text-xs text-gray-500">PNG, JPG, MP4, MP3</p>
            </div>
            <input type="file" className="hidden" onChange={handleFileDrop} />
          </label>
        </div>
        {file && (
          <p className="mt-4 text-sm text-gray-600">
            選択されたファイル: <span className="font-medium">{file.name}</span> ({(file.size / 1024 / 1024).toFixed(2)} MB)
          </p>
        )}
      </div>

      {isAnalyzing && (
        <div className="flex items-center justify-center p-8 bg-white rounded-xl border border-gray-200 shadow-sm">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <span className="text-gray-600 font-medium">透かしを解析中...</span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-r-lg">
          <div className="flex items-center">
            <AlertTriangle className="h-5 w-5 text-red-500 mr-2" />
            <p className="text-red-700">{error}</p>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-gray-900">検出された透かし情報 ({results.length}件)</h2>
          {results.map((wm, idx) => (
            <div key={idx} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="bg-gray-50 px-6 py-4 border-b border-gray-200 flex justify-between items-center">
                <h3 className="font-bold text-gray-900">{wm.name}</h3>
                <span className={cn(
                  "px-3 py-1 text-xs font-bold rounded-full",
                  wm.robustness.includes('High') ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"
                )}>
                  {wm.robustness}
                </span>
              </div>
              <div className="p-6 space-y-4">
                <div className="bg-gray-50 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                  <pre className="text-gray-700">{JSON.stringify(wm.data, null, 2)}</pre>
                </div>
                
                {wm.verification && (
                  <div className={cn(
                    "flex items-start p-4 rounded-lg border",
                    wm.verification.valid ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
                  )}>
                    {wm.verification.valid ? (
                      <ShieldCheck className="w-6 h-6 text-green-600 mr-3 flex-shrink-0" />
                    ) : (
                      <ShieldAlert className="w-6 h-6 text-red-600 mr-3 flex-shrink-0" />
                    )}
                    <div>
                      <h4 className={cn(
                        "font-bold mb-1",
                        wm.verification.valid ? "text-green-800" : "text-red-800"
                      )}>
                        {wm.verification.valid ? "認証済み (真正)" : "認証失敗 (改ざんの疑い)"}
                      </h4>
                      <p className={cn(
                        "text-sm",
                        wm.verification.valid ? "text-green-700" : "text-red-700"
                      )}>
                        {wm.verification.message}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SignerTab({ secretKey, options, fskOptions, llmOptions, useLlmEmbed, setUseLlmEmbed, useLlmVideoEmbed, setUseLlmVideoEmbed, secureIdLength, payloadSymbols }: { secretKey: string, options: ForensicOptions, fskOptions: any, llmOptions: LlmVideoOptions, useLlmEmbed: boolean, setUseLlmEmbed: (v: boolean) => void, useLlmVideoEmbed: boolean, setUseLlmVideoEmbed: (v: boolean) => void, secureIdLength: number, payloadSymbols: number }) {
  const [userId, setUserId] = useState('user_12345');
  const [sessionId, setSessionId] = useState('sess_abcde');
  const [prizeId, setPrizeId] = useState('prize_001');
  
  const [signedJson, setSignedJson] = useState<string>('');
  const [securePayload, setSecurePayload] = useState<string>('');
  
  const [sourceMedia, setSourceMedia] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  
  const ffmpegRef = useRef(new FFmpeg());

  const loadFFmpeg = async () => {
    const ffmpeg = ffmpegRef.current;
    if (ffmpeg.loaded) return;
    
    setProgressMsg('WebAssembly Core Loading...');
    ffmpeg.on('log', ({ message }) => {
      console.log(message);
    });
    
    try {
      const baseURL = window.location.origin;
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    } catch (e: any) {
      console.error("FFmpeg load failed:", e);
      throw new Error("Failed to load FFmpeg core: " + (e.message || String(e)));
    }
  };

  const handleGenerate = async () => {
    const payloads = await generateWatermarkPayloads({ userId, sessionId, prizeId }, secretKey, secureIdLength, payloadSymbols);
    setSignedJson(payloads.jsonString);
    setSecurePayload(payloads.securePayload);
  };

  const handleEmbed = async () => {
    if (!sourceMedia || !signedJson || !securePayload) return;
    setIsProcessing(true);
    setProgressMsg('処理を開始しています...');

    try {
      const isVideo = sourceMedia.type.startsWith('video/') || sourceMedia.type.startsWith('audio/');
      
      if (isVideo) {
        setProgressMsg('FFmpeg 準備中...');
        await loadFFmpeg();
        const ffmpeg = ffmpegRef.current;
        
        // 1. Generate FSK Buffer in memory
        setProgressMsg('FSK 音声ストリームを生成中...');
        const fskWavBuffer = generateFskBuffer(securePayload, fskOptions);
        
        // 2. Load files into ffmpeg virtual FS
        setProgressMsg('メディアをメモリに読み込み中...');
        const inputName = 'input_media' + sourceMedia.name.substring(sourceMedia.name.lastIndexOf('.'));
        await ffmpeg.writeFile(inputName, await fetchFile(sourceMedia));
        await ffmpeg.writeFile('fsk.wav', fskWavBuffer);

        const outputName = sourceMedia.type.startsWith('audio/') ? 'watermarked_output.wav' : 'watermarked_output.mp4';
        let execCode = 0;

        // 3a. LLM DCT 動画フレーム透かし（動画のみ・オプション）
        if (useLlmVideoEmbed && sourceMedia.type.startsWith('video/')) {
          // FPS をログから検出
          let detectedFps = 25;
          const fpsListener = ({ message }: { message: string }) => {
            const m = message.match(/(\d+(?:\.\d+)?)\s+fps/);
            if (m) detectedFps = parseFloat(m[1]);
          };
          ffmpeg.on('log', fpsListener);
          setProgressMsg('動画情報を解析中...');
          await ffmpeg.exec(['-i', inputName]).catch(() => {});
          ffmpeg.off('log', fpsListener);

          // 全フレームを PNG 連番に展開
          setProgressMsg('全フレームを展開中（長い動画は時間がかかります）...');
          await ffmpeg.exec(['-i', inputName, '-vsync', '0', 'llm_%06d.png']);

          // フレーム一覧を取得して LLM DCT 埋め込み
          const allFiles = await ffmpeg.listDir('/');
          const frameNames = allFiles
            .filter((f: any) => !f.isDir && /^llm_\d+\.png$/.test(f.name))
            .map((f: any) => f.name)
            .sort();

          let done = 0;
          for (const fname of frameNames) {
            done++;
            if (done % 30 === 0 || done === frameNames.length) {
              setProgressMsg(`LLM DCT 埋め込み中... ${done}/${frameNames.length} フレーム`);
            }
            const raw = await ffmpeg.readFile(fname) as Uint8Array;
            const imageData = await pngBytesToImageData(raw);
            embedLlmVideoFrame(imageData, securePayload, llmOptions);
            const outBytes = await imageDataToPngBytes(imageData);
            await ffmpeg.writeFile(fname, outBytes);
          }

          // フレーム連番 + FSK 音声で再エンコード（元動画に音声があればamix、なければトラック追加）
          setProgressMsg('LLM DCT フレームを動画に再エンコード中...');
          execCode = await ffmpeg.exec([
            '-framerate', String(detectedFps), '-i', 'llm_%06d.png',
            '-i', inputName, '-i', 'fsk.wav',
            '-map', '0:v',
            '-filter_complex', '[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=2[a]',
            '-map', '[a]',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k', '-shortest',
            outputName
          ]);
          // 元動画に音声がない場合のフォールバック（amixが失敗する）
          if (execCode !== 0) {
            try { await ffmpeg.deleteFile(outputName); } catch (_) {}
            setProgressMsg('無音動画を検出 — FSK音声トラックを追加して再試行中...');
            execCode = await ffmpeg.exec([
              '-framerate', String(detectedFps), '-i', 'llm_%06d.png',
              '-i', 'fsk.wav',
              '-map', '0:v', '-map', '1:a',
              '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-b:a', '192k', '-shortest',
              outputName
            ]);
          }
        } else {
          // 3b. 通常処理（FSK のみ）
          setProgressMsg('動画・音声へ透かしを合成しています...(数分かかる場合があります)');
          if (sourceMedia.type.startsWith('audio/')) {
            execCode = await ffmpeg.exec(['-i', inputName, '-i', 'fsk.wav', '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '[a]', outputName]);
          } else {
            // まず amix を試みる（元動画に音声あり）
            execCode = await ffmpeg.exec(['-i', inputName, '-i', 'fsk.wav', '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', outputName]);
            // 失敗した場合は無音動画と判断してトラック追加
            if (execCode !== 0) {
              try { await ffmpeg.deleteFile(outputName); } catch (_) {}
              setProgressMsg('無音動画を検出 — FSK音声トラックを追加して再試行中...');
              execCode = await ffmpeg.exec(['-i', inputName, '-i', 'fsk.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outputName]);
            }
          }
        }

        if (execCode !== 0) {
          throw new Error("FFmpegプロセスがエラーコードで終了しました。コンソールログを確認してください。");
        }

        // 4. Download Result
        setProgressMsg('完了処理中...');
        const rawData = await ffmpeg.readFile(outputName) as Uint8Array;
        const data = new Uint8Array(rawData);
        const finalBlob = new Blob([data.buffer as ArrayBuffer], { type: sourceMedia.type.startsWith('audio/') ? 'audio/wav' : 'video/mp4' });
        
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `watermarked_${sourceMedia.name.replace(/\.[^/.]+$/, "")}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
      } else {
        // --- Image Processing ---
        setProgressMsg('画像に透かしを埋め込んでいます...');
        const img = new Image();
        img.src = URL.createObjectURL(sourceMedia);
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error("Canvas context not available");
        
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        // 1. Embed watermark (Forensic DWT+DCT+SVD or LLM DCT)
        if (useLlmEmbed) {
          embedLlmImageWatermark(imageData, securePayload, llmOptions);
        } else {
          embedImageWatermarks(imageData, securePayload, options);
        }
        ctx.putImageData(imageData, 0, 0);
        
        // Convert to Blob (PNG)
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error("Blob creation failed"));
          }, 'image/png');
        });

        // 2. Append EOF Watermark (Signed JSON)
        setProgressMsg('EOFメタデータを付与しています...');
        const buffer = await blob.arrayBuffer();
        const finalBuffer = finalizeImageBuffer(new Uint8Array(buffer), signedJson);

        // Download
        const finalBlob = new Blob([finalBuffer.buffer as ArrayBuffer], { type: 'image/png' });
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `watermarked_${sourceMedia.name.replace(/\.[^/.]+$/, "")}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

    } catch (err: any) {
      console.error(err);
      alert("埋め込み処理に失敗しました。詳細: " + (err.message || String(err)));
    } finally {
      setIsProcessing(false);
      setProgressMsg('');
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="space-y-6">
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <h2 className="text-lg font-bold text-gray-900 mb-4">メタデータ入力</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">User ID</label>
              <input 
                type="text" 
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Session ID (注文ID等)</label>
              <input 
                type="text" 
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Prize ID (賞品ID等)</label>
              <input 
                type="text" 
                value={prizeId}
                onChange={(e) => setPrizeId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button 
              onClick={handleGenerate}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition-colors"
            >
              署名を生成する
            </button>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <h2 className="text-lg font-bold text-gray-900 mb-4">メディアへの埋め込み</h2>
          <div className="space-y-4">
            <input 
              type="file" 
              accept="image/*,video/*,audio/*"
              onChange={(e) => setSourceMedia(e.target.files?.[0] || null)}
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            <div className="flex flex-col gap-2 p-3 bg-gray-50 border border-gray-100 rounded-md">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useLlmEmbed}
                  onChange={(e) => setUseLlmEmbed(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-700 font-medium">【画像】LLM DCT透かしを使用（動画フレーム向け）</span>
              </label>
              <p className="text-[10px] text-gray-500 pl-6">
                ONにすると高精度なLLM DCT埋め込みを使用します。OFFは従来のDWT+DCT+SVD透かしです。
              </p>
            </div>

            {sourceMedia && sourceMedia.type.startsWith('video/') && (
              <div className="flex flex-col gap-2 p-3 bg-indigo-50 border border-indigo-100 rounded-md">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useLlmVideoEmbed}
                    onChange={(e) => setUseLlmVideoEmbed(e.target.checked)}
                    className="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-indigo-800 font-medium">【動画】全フレームに LLM DCT 透かしを埋め込む（低速）</span>
                </label>
                <p className="text-[10px] text-indigo-600 pl-6">
                  全フレームを展開して DCT 透かしを埋め込み再エンコードします。FSK 音声透かしと同時に適用されます。フレーム数に比例して処理時間が増加します。
                </p>
              </div>
            )}

            <button
              onClick={handleEmbed}
              disabled={!sourceMedia || !signedJson || isProcessing}
              className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-md transition-colors"
            >
              {isProcessing ? (
                <div className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  <span>{progressMsg}</span>
                </div>
              ) : (
                <>
                  <Download className="w-5 h-5" />
                  透かしを埋め込んでダウンロード
                </>
              )}
            </button>
            <p className="text-xs text-gray-500 mt-2">
              ※画像には「不可視画像透かし・EOF」、動画・音声には「FSK音声透かし」が埋め込まれます。LLM DCT ON時は加えて全フレームに映像透かしも埋め込まれます（大幅に時間増加）。
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm h-full">
          <h2 className="text-lg font-bold text-gray-900 mb-4">生成結果</h2>
          
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-bold text-gray-700 mb-2">1. 署名付き JSON (EOF / UUID Box用)</h3>
              <div className="bg-gray-900 text-green-400 p-4 rounded-lg font-mono text-sm min-h-[150px] overflow-x-auto">
                {signedJson ? <pre>{signedJson}</pre> : <span className="text-gray-600">未生成</span>}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-bold text-gray-700 mb-2">2. セキュアペイロード (高度フォレンジック用)</h3>
              <div className="bg-gray-900 border border-gray-800 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                {securePayload ? (
                  <div className="space-y-3">
                    <div className="text-green-400 break-all">{securePayload}</div>
                    
                    <div className="mt-2 pt-3 border-t border-gray-700 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="w-4 h-4 rounded bg-blue-500 flex items-center justify-center text-[10px] text-white font-bold">1</span>
                        <span className="text-gray-300 text-xs flex-1">
                          <span className="font-semibold text-blue-400 mr-2">セッションID ({secureIdLength}文字):</span>
                          <span className="bg-gray-800 px-2 py-0.5 rounded text-white">{securePayload.substring(0, secureIdLength)}</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-4 h-4 rounded bg-purple-500 flex items-center justify-center text-[10px] text-white font-bold">2</span>
                        <span className="text-gray-300 text-xs flex-1">
                          <span className="font-semibold text-purple-400 mr-2">HMAC署名 ({payloadSymbols - secureIdLength}文字 / {(payloadSymbols - secureIdLength) * 6}ビット):</span>
                          <span className="bg-gray-800 px-2 py-0.5 rounded text-white">{securePayload.substring(secureIdLength)}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-600">未生成</span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                ※{secureIdLength}文字のセッションID + {payloadSymbols - secureIdLength}文字のHMAC署名（{(payloadSymbols - secureIdLength) * 6}ビット強度）の組み合わせです。詳細設定で変更できます。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

