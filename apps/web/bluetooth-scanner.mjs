const nativeRequests = new Map();
const nativeBridge = () => typeof window !== 'undefined' ? window.KasirNusaAndroid : null;

if (typeof window !== 'undefined') {
  window.__kasirNusaNativeScannerResponse = (requestId, success, message) => {
    const request = nativeRequests.get(requestId);
    if (!request) return;
    nativeRequests.delete(requestId);
    if (success) request.resolve(message);
    else request.reject(new Error(message || 'Operasi scanner Android gagal.'));
  };
}

function nativeRequest(method) {
  return new Promise((resolve, reject) => {
    const bridge = nativeBridge();
    if (!bridge?.[method]) return reject(new Error('Gunakan aplikasi Kasir Nusa Android untuk menyambungkan scanner.'));
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      if (!nativeRequests.has(requestId)) return;
      nativeRequests.delete(requestId);
      reject(new Error('Scanner tidak merespons. Pastikan scanner menyala dan mode pairing aktif.'));
    }, 60000);
    nativeRequests.set(requestId, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    bridge[method](requestId);
  });
}

export const supportsDirectScannerConnection = () => Boolean(nativeBridge()?.connectScanner);
export const scannerSelected = () => supportsDirectScannerConnection() && Boolean(nativeBridge().isScannerSelected());
export const scannerConnected = () => supportsDirectScannerConnection() && Boolean(nativeBridge().isScannerConnected());
export const scannerName = () => supportsDirectScannerConnection() ? String(nativeBridge().getScannerName?.() ?? '') : '';
export const connectBluetoothScanner = () => nativeRequest('connectScanner');
export const disconnectBluetoothScanner = () => nativeRequest('disconnectScanner');
