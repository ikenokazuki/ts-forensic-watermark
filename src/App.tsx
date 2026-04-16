import React, { useState, useCallback, useRef } from 'react';
import { Upload, Shield, ShieldAlert, ShieldCheck, FileImage, FileVideo, FileAudio, CheckCircle, AlertTriangle, Key, Download, Settings, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from './lib/utils';
import { 
  generateWatermarkPayloads,
  embedImageWatermarks,
  finalizeImageBuffer,
  analyzeTextWatermarks,
  analyzeAudioWatermarks,
  analyzeImageWatermarks,
  verifyWatermarks,
  generateFskBuffer,
  ForensicOptions
} from '../watermark-lib/src/index';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

type Tab = 'analyze' | 'sign';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('analyze');
  const [secretKey, setSecretKey] = useState('my-super-secret-key');
  const [showSettings, setShowSettings] = useState(false);
  const [forensicOptions, setForensicOptions] = useState<ForensicOptions>({
    delta: 120,
    varianceThreshold: 25,
    arnoldIterations: 7,
    force: false,
    robustAngles: [0, 90, 180, 270, 0.5, -0.5, 1, -1]
  });
  const [isRobustDetection, setIsRobustDetection] = useState(true);

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
            <div className="pt-4 border-t border-gray-200 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
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

              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input 
                    type="checkbox"
                    checked={forensicOptions.force}
                    onChange={(e) => setForensicOptions({ ...forensicOptions, force: e.target.checked })}
                    className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700">Force (強制埋め込み)</span>
                </label>
                <p className="text-xs text-gray-500 ml-3">分散閾値を無視して真っ白な画像などにも埋め込みます。</p>
              </div>

              <div className="md:col-span-2 pt-2">
                <div className="flex flex-col gap-2 p-3 bg-gray-50 border border-gray-100 rounded-md">
                   <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="checkbox"
                      checked={isRobustDetection}
                      onChange={(e) => setIsRobustDetection(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-xs text-gray-700 font-medium">画像回転耐性を有効にする (低速)</span>
                  </label>
                  <p className="text-[10px] text-gray-500 pl-6">
                    画像を 90/180/270度、および ±0.5/1度回転させてスキャンします。傾いた写真でも検出可能です。
                  </p>
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
              robustAngles: isRobustDetection ? forensicOptions.robustAngles : [0]
            }} 
          />
        ) : (
          <SignerTab 
            secretKey={secretKey} 
            options={forensicOptions} 
          />
        )}
      </main>
    </div>
  );
}

function AnalyzerTab({ secretKey, options }: { secretKey: string, options: ForensicOptions }) {
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
          
          const audioWMs = analyzeAudioWatermarks(channelData, { sampleRate: audioBuffer.sampleRate });
          foundWatermarks = [...foundWatermarks, ...audioWMs];
        } catch (e) {
          console.warn("Audio processing failed", e);
        }
      }

      // 4. すべての透かしをライブラリで一括検証（HMAC署名チェック等）
      const verifiedResults = await verifyWatermarks(foundWatermarks, secretKey);

      if (verifiedResults.length === 0) {
        setError("電子透かしを検出できませんでした。ファイルが改ざんされているか、透かしが含まれていません。");
      } else {
        setResults(verifiedResults);
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

function SignerTab({ secretKey, options }: { secretKey: string, options: ForensicOptions }) {
  const [userId, setUserId] = useState('user_12345');
  const [sessionId, setSessionId] = useState('sess_abcde');
  const [prizeId, setPrizeId] = useState('prize_001');
  
  const [signedJson, setSignedJson] = useState<string>('');
  const [securePayload, setSecurePayload] = useState<string>('');
  
  const [sourceMedia, setSourceMedia] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [isSilentVideo, setIsSilentVideo] = useState(false);
  
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
    const payloads = await generateWatermarkPayloads({ userId, sessionId, prizeId }, secretKey);
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
        const fskWavBuffer = generateFskBuffer(securePayload);
        
        // 2. Load files into ffmpeg virtual FS
        setProgressMsg('メディアをメモリに読み込み中...');
        const inputName = 'input_media' + sourceMedia.name.substring(sourceMedia.name.lastIndexOf('.'));
        await ffmpeg.writeFile(inputName, await fetchFile(sourceMedia));
        await ffmpeg.writeFile('fsk.wav', fskWavBuffer);
        
        // 3. Execute FFmpeg Command
        setProgressMsg('動画・音声へ透かしを合成しています...(数分かかる場合があります)');
        const outputName = sourceMedia.type.startsWith('audio/') ? 'watermarked_output.wav' : 'watermarked_output.mp4';
        
        let execCode = 0;
        if (sourceMedia.type.startsWith('audio/')) {
          // Audio only processing (mixing)
          execCode = await ffmpeg.exec(['-i', inputName, '-i', 'fsk.wav', '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '[a]', outputName]);
        } else {
          // Video processing
          if (isSilentVideo) {
            // Add as standard track
            execCode = await ffmpeg.exec(['-i', inputName, '-i', 'fsk.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputName]);
          } else {
            // Mix with existing audio
            execCode = await ffmpeg.exec(['-i', inputName, '-i', 'fsk.wav', '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', outputName]);
          }
        }
        
        if (execCode !== 0) {
          throw new Error("FFmpegプロセスがエラーコードで終了しました。コンソールログを確認してください。無音動画の場合は「強制トラック追加」オプションをお試しください。");
        }
        
        // 4. Download Result
        setProgressMsg('完了処理中...');
        const data = await ffmpeg.readFile(outputName);
        const finalBlob = new Blob([data], { type: sourceMedia.type.startsWith('audio/') ? 'audio/wav' : 'video/mp4' });
        
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
        
        // 1. Embed Forensic Watermark (Secure Payload)
        embedImageWatermarks(imageData, securePayload, options);
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
        const finalBlob = new Blob([finalBuffer], { type: 'image/png' });
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
            {sourceMedia && sourceMedia.type.startsWith('video/') && (
              <div className="flex items-center pt-2">
                <label className="flex items-center gap-2 cursor-pointer bg-gray-50 border border-gray-200 px-3 py-2 rounded-md w-full">
                  <input 
                    type="checkbox"
                    checked={isSilentVideo}
                    onChange={(e) => setIsSilentVideo(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-gray-700">無音動画への音声トラック追加を許可する</span>
                    <span className="text-xs text-gray-500">元々音声がない動画に対して、FSK用の透かし音声トラックを強制的に追加します</span>
                  </div>
                </label>
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
              ※画像には「不可視画像透かし・EOF」、動画・音声には「FSK音声透かし」が埋め込まれます。動画処理はブラウザの性能により時間がかかります。
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
                          <span className="font-semibold text-blue-400 mr-2">セッションID ({securePayload.substring(0, 6).length}文字):</span> 
                          <span className="bg-gray-800 px-2 py-0.5 rounded text-white">{securePayload.substring(0, 6)}</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-4 h-4 rounded bg-purple-500 flex items-center justify-center text-[10px] text-white font-bold">2</span>
                        <span className="text-gray-300 text-xs flex-1">
                          <span className="font-semibold text-purple-400 mr-2">HMAC署名 ({securePayload.substring(6).length}文字):</span> 
                          <span className="bg-gray-800 px-2 py-0.5 rounded text-white">{securePayload.substring(6)}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-600">未生成</span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                ※高度フォレンジックは22バイトの文字数制限があるため、推測不能な 6文字の注文ID + 16文字の改ざん防止用署名 の組み合わせを採用しています。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

