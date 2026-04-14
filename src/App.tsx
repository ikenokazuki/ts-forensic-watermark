import React, { useState, useCallback, useRef } from 'react';
import { Upload, Shield, ShieldAlert, ShieldCheck, FileImage, FileVideo, FileAudio, CheckCircle, AlertTriangle, Key, Download } from 'lucide-react';
import { cn } from './lib/utils';
import { 
  appendEofWatermark, 
  extractEofWatermark, 
  signJsonMetadata, 
  verifyJsonSignature,
  generateSecurePayload,
  verifySecurePayload
} from '../watermark-lib/src/utils';
import { embedForensic, extractForensic } from '../watermark-lib/src/forensic';

type Tab = 'analyze' | 'sign';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('analyze');
  const [secretKey, setSecretKey] = useState('my-super-secret-key');

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

        <div className="mb-6 bg-white p-4 rounded-lg border border-gray-200 shadow-sm flex items-center gap-4">
          <Key className="w-5 h-5 text-gray-400" />
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Secret Key (検証・署名用)</label>
            <input 
              type="text" 
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {activeTab === 'analyze' ? <AnalyzerTab secretKey={secretKey} /> : <SignerTab secretKey={secretKey} />}
      </main>
    </div>
  );
}

function AnalyzerTab({ secretKey }: { secretKey: string }) {
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
      const buffer = await selectedFile.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      const foundWatermarks = [];

      // 1. EOE Watermark Extraction
      try {
        const eofDataStr = extractEofWatermark(uint8Array);
        if (eofDataStr) {
          const data = JSON.parse(eofDataStr);
          const isValid = await verifyJsonSignature(data, secretKey, ['userId', 'sessionId']);
          foundWatermarks.push({
            type: 'EOF',
            name: 'EOFメタデータ (ファイル末尾)',
            robustness: 'Low (脆弱)',
            data,
            verification: {
              valid: isValid,
              message: isValid ? 'HMAC署名の検証に成功しました。データは真正です。' : 'HMAC署名が一致しません。改ざんの可能性があります。'
            }
          });
        }
      } catch (err) {
        console.warn("EOF extraction failed", err);
      }

      // 2. Forensic Image Watermark Extraction (if image)
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
            
            // Try extracting with different deltas
            let forensicResult = extractForensic(imageData, { delta: 120 });
            if (!forensicResult || forensicResult.payload === 'RECOVERY_FAILED') {
              forensicResult = extractForensic(imageData, { delta: 60 });
            }

            if (forensicResult && forensicResult.payload !== 'RECOVERY_FAILED' && forensicResult.payload.length > 0) {
              // Check if it's a 22-byte secure payload
              let isValid = false;
              let message = '署名なしのペイロードです。';
              
              if (forensicResult.payload.length === 22) {
                isValid = await verifySecurePayload(forensicResult.payload, secretKey, 6);
                message = isValid ? 'セキュアペイロードの検証に成功しました。' : 'セキュアペイロードの検証に失敗しました。';
              }

              foundWatermarks.push({
                type: 'FORENSIC',
                name: '高度フォレンジック透かし (DWT+DCT+SVD)',
                robustness: 'High (堅牢)',
                data: { payload: forensicResult.payload, confidence: forensicResult.confidence },
                verification: {
                  valid: forensicResult.payload.length === 22 ? isValid : true,
                  message: message
                }
              });
            }
          }
        } catch (err) {
          console.warn("Forensic extraction failed", err);
        }
      }

      if (foundWatermarks.length === 0) {
        setError("電子透かしを検出できませんでした。ファイルが改ざんされているか、透かしが含まれていません。");
      } else {
        setResults(foundWatermarks);
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

function SignerTab({ secretKey }: { secretKey: string }) {
  const [userId, setUserId] = useState('user_12345');
  const [sessionId, setSessionId] = useState('sess_abcde');
  const [prizeId, setPrizeId] = useState('prize_001');
  
  const [signedJson, setSignedJson] = useState<string>('');
  const [securePayload, setSecurePayload] = useState<string>('');
  
  const [sourceImage, setSourceImage] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleGenerate = async () => {
    // 1. Generate Signed JSON for EOF
    const metadata = {
      userId,
      sessionId,
      prizeId,
      timestamp: new Date().toISOString()
    };
    const signed = await signJsonMetadata(metadata, secretKey, ['userId', 'sessionId']);
    setSignedJson(JSON.stringify(signed, null, 2));

    // 2. Generate Secure Payload for Forensic (22 bytes)
    const payload = await generateSecurePayload(sessionId, secretKey, 6);
    setSecurePayload(payload);
  };

  const handleEmbed = async () => {
    if (!sourceImage || !signedJson || !securePayload) return;
    setIsProcessing(true);

    try {
      const img = new Image();
      img.src = URL.createObjectURL(sourceImage);
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
      embedForensic(imageData, securePayload);
      ctx.putImageData(imageData, 0, 0);
      
      // Convert to Blob (PNG)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("Blob creation failed"));
        }, 'image/png');
      });

      // 2. Append EOF Watermark (Signed JSON)
      const buffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      const finalBuffer = appendEofWatermark(uint8Array, signedJson);

      // Download
      const finalBlob = new Blob([finalBuffer], { type: 'image/png' });
      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `watermarked_${sourceImage.name.replace(/\.[^/.]+$/, "")}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (err) {
      console.error(err);
      alert("埋め込み処理に失敗しました。");
    } finally {
      setIsProcessing(false);
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
          <h2 className="text-lg font-bold text-gray-900 mb-4">画像への埋め込み</h2>
          <div className="space-y-4">
            <input 
              type="file" 
              accept="image/*"
              onChange={(e) => setSourceImage(e.target.files?.[0] || null)}
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            <button 
              onClick={handleEmbed}
              disabled={!sourceImage || !signedJson || isProcessing}
              className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-md transition-colors"
            >
              {isProcessing ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              ) : (
                <Download className="w-5 h-5" />
              )}
              透かしを埋め込んでダウンロード
            </button>
            <p className="text-xs text-gray-500 mt-2">
              ※選択した画像に対して、「高度フォレンジック透かし（不可視）」と「EOFメタデータ（署名付きJSON）」の両方を埋め込みます。
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
              <div className="bg-gray-900 text-green-400 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                {securePayload ? <pre>{securePayload}</pre> : <span className="text-gray-600">未生成</span>}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                ※22バイト制限: 6文字のID + 16文字のHMAC-SHA256署名
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

