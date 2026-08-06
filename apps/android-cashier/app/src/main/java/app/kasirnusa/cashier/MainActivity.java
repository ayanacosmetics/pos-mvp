package app.kasirnusa.cashier;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String TRUSTED_HOST = "app.nusapos.my.id";
    private static final String START_URL = BuildConfig.POS_ORIGIN + "/";
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");
    private static final int REQUEST_BLUETOOTH_CONNECT = 301;
    private static final int REQUEST_CAMERA = 302;
    private static final int REQUEST_LOCATION = 304;
    static final String PREFS = "kasir_nusa_cashier";
    static final String NOTIFICATION_PAGE = "notification_page";
    private static final String INSTALLATION_ID = "native_installation_id";
    private static final int REQUEST_NOTIFICATIONS = 303;
    private static WeakReference<MainActivity> activeActivity = new WeakReference<>(null);
    private static final String PRINTER_ADDRESS = "printer_address";
    private static final String PRINTER_NAME = "printer_name";

    private final ExecutorService printerExecutor = Executors.newSingleThreadExecutor();
    private final Object socketLock = new Object();
    private final StringBuilder scannerBuffer = new StringBuilder();
    private WebView webView;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothSocket printerSocket;
    private SharedPreferences preferences;
    private String pendingBluetoothRequestId;
    private PermissionRequest pendingCameraRequest;
    private GeolocationPermissions.Callback pendingLocationCallback;
    private String pendingLocationOrigin;
    private long scannerLastKeyAt;
    private long scannerStartedAt;
    private String pendingNotificationPage;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(23, 76, 79));
        getWindow().setNavigationBarColor(Color.rgb(23, 76, 79));
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        BluetoothManager bluetoothManager = getSystemService(BluetoothManager.class);
        bluetoothAdapter = bluetoothManager == null ? null : bluetoothManager.getAdapter();
        configureWebView();
        pendingNotificationPage = getIntent().getStringExtra(NOTIFICATION_PAGE);
        if (savedInstanceState == null) webView.loadUrl(START_URL);
        else webView.restoreState(savedInstanceState);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(244, 241, 233));
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString() + " KasirNusaAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(new PrinterBridge(), "KasirNusaAndroid");
        webView.setWebViewClient(new LockedWebViewClient());
        webView.setWebChromeClient(new CashierWebChromeClient());
        setContentView(webView);
    }

    private boolean isTrusted(Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && TRUSTED_HOST.equalsIgnoreCase(uri.getHost());
    }

    private boolean isTrustedGeolocationOrigin(String origin) {
        if (origin == null) return false;
        Uri uri = Uri.parse(origin);
        int port = uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme())
                && TRUSTED_HOST.equalsIgnoreCase(uri.getHost())
                && (port == -1 || port == 443)
                && (uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))
                && uri.getQuery() == null
                && uri.getFragment() == null
                && uri.getUserInfo() == null;
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void finishLocationPermission(boolean allowed) {
        GeolocationPermissions.Callback callback = pendingLocationCallback;
        String origin = pendingLocationOrigin;
        pendingLocationCallback = null;
        pendingLocationOrigin = null;
        if (callback != null && origin != null) callback.invoke(origin, allowed, false);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Tidak ada aplikasi untuk membuka tautan ini.", Toast.LENGTH_SHORT).show();
        }
    }

    private final class LockedWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isTrusted(uri)) return false;
            openExternal(uri);
            return true;
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) {
                Toast.makeText(MainActivity.this, "Server Kasir Nusa sedang tidak tersedia.", Toast.LENGTH_LONG).show();
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (!isTrusted(Uri.parse(url))) return;
            emitStoredPushToken();
            emitPendingNotificationPage();
        }
    }

    private final class CashierWebChromeClient extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(
                String origin,
                GeolocationPermissions.Callback callback
        ) {
            runOnUiThread(() -> {
                if (!isTrustedGeolocationOrigin(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                finishLocationPermission(false);
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingLocationOrigin = origin;
                pendingLocationCallback = callback;
                requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                }, REQUEST_LOCATION);
            });
        }

        @Override
        public void onGeolocationPermissionsHidePrompt() {
            finishLocationPermission(false);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                if (!isTrusted(request.getOrigin())) {
                    request.deny();
                    return;
                }
                boolean wantsCamera = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
                }
                if (!wantsCamera) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    pendingCameraRequest = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingCameraRequest == request) pendingCameraRequest = null;
        }
    }

    public final class PrinterBridge {
        @JavascriptInterface
        public boolean isPrinterSelected() {
            return !preferences.getString(PRINTER_ADDRESS, "").isEmpty();
        }

        @JavascriptInterface
        public boolean isPrinterConnected() {
            synchronized (socketLock) {
                return printerSocket != null && printerSocket.isConnected();
            }
        }

        @JavascriptInterface
        public void connectPrinter(String requestId) {
            runOnUiThread(() -> requestPrinterSelection(requestId));
        }

        @JavascriptInterface
        public void disconnectPrinter(String requestId) {
            printerExecutor.execute(() -> {
                closePrinterSocket();
                respond(requestId, true, "Printer diputuskan.");
            });
        }

        @JavascriptInterface
        public void printBase64(String requestId, String payload) {
            printerExecutor.execute(() -> {
                try {
                    byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
                    BluetoothSocket socket = ensurePrinterConnected();
                    OutputStream output = socket.getOutputStream();
                    output.write(bytes);
                    output.flush();
                    respond(requestId, true, "Data ESC/POS berhasil dikirim.");
                } catch (Exception error) {
                    closePrinterSocket();
                    respond(requestId, false, printerError(error));
                }
            });
        }

        @JavascriptInterface
        public boolean isNativePushSupported() {
            return firebaseConfigured();
        }

        @JavascriptInterface
        public String nativePushStatus() {
            JSONObject status = new JSONObject();
            try {
                status.put("supported", firebaseConfigured());
                status.put("permission", notificationPermissionState());
                status.put("installationId", installationId());
                status.put("pushToken", preferences.getString(NusaFirebaseMessagingService.PUSH_TOKEN, ""));
                status.put("appVersion", BuildConfig.VERSION_NAME);
            } catch (Exception ignored) {}
            return status.toString();
        }

        @JavascriptInterface
        public void requestNativePushPermission() {
            runOnUiThread(MainActivity.this::requestPushPermission);
        }

        @JavascriptInterface
        public void refreshNativePushToken() {
            runOnUiThread(MainActivity.this::fetchAndEmitPushToken);
        }

    }

    private boolean firebaseConfigured() {
        return !FirebaseApp.getApps(this).isEmpty();
    }

    private String installationId() {
        String existing = preferences.getString(INSTALLATION_ID, "");
        if (!existing.isEmpty()) return existing;
        String created = UUID.randomUUID().toString();
        preferences.edit().putString(INSTALLATION_ID, created).apply();
        return created;
    }

    private String notificationPermissionState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
                ? "granted" : "prompt";
    }

    private void requestPushPermission() {
        if (!firebaseConfigured()) {
            emitPushError("Firebase belum dipasang pada APK ini.");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
            return;
        }
        fetchAndEmitPushToken();
    }

    private void fetchAndEmitPushToken() {
        if (!firebaseConfigured()) return;
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                emitPushError("Token notifikasi Android belum dapat dibuat.");
                return;
            }
            String token = task.getResult();
            preferences.edit().putString(NusaFirebaseMessagingService.PUSH_TOKEN, token).apply();
            emitPushToken(token);
        });
    }

    private void emitStoredPushToken() {
        String token = preferences.getString(NusaFirebaseMessagingService.PUSH_TOKEN, "");
        if (!token.isEmpty()) emitPushToken(token);
    }

    private void emitPushToken(String token) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("pushToken", token);
            detail.put("installationId", installationId());
            detail.put("permission", notificationPermissionState());
            detail.put("appVersion", BuildConfig.VERSION_NAME);
            detail.put("deviceLabel", Build.MANUFACTURER + " " + Build.MODEL);
        } catch (Exception ignored) {}
        String script = "window.dispatchEvent(new CustomEvent('kasirnusa:native-push-token',{detail:"
                + detail + "}))";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private void emitPushError(String message) {
        String script = "window.dispatchEvent(new CustomEvent('kasirnusa:native-push-error',{detail:{message:"
                + JSONObject.quote(message) + "}}))";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    static void deliverPushTokenToActiveActivity(String token) {
        MainActivity activity = activeActivity.get();
        if (activity != null) activity.emitPushToken(token);
    }

    private void emitPendingNotificationPage() {
        if (pendingNotificationPage == null || pendingNotificationPage.isBlank()) return;
        String page = pendingNotificationPage;
        pendingNotificationPage = null;
        String script = "window.dispatchEvent(new CustomEvent('kasirnusa:native-notification',{detail:{page:"
                + JSONObject.quote(page) + "}}))";
        runOnUiThread(() -> webView.evaluateJavascript(script, null));
    }

    private boolean hasBluetoothConnectPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPrinterSelection(String requestId) {
        if (bluetoothAdapter == null) {
            respond(requestId, false, "Perangkat Android ini tidak memiliki Bluetooth.");
            return;
        }
        if (!hasBluetoothConnectPermission()) {
            pendingBluetoothRequestId = requestId;
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQUEST_BLUETOOTH_CONNECT);
            return;
        }
        if (!bluetoothAdapter.isEnabled()) {
            respond(requestId, false, "Aktifkan Bluetooth Android, lalu coba kembali.");
            return;
        }
        showBondedPrinterDialog(requestId);
    }

    @SuppressLint("MissingPermission")
    private void showBondedPrinterDialog(String requestId) {
        Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
        List<BluetoothDevice> devices = new ArrayList<>(bonded);
        devices.sort(Comparator.comparing(device -> {
            String name = device.getName();
            return name == null ? device.getAddress() : name.toLowerCase(Locale.ROOT);
        }));
        if (devices.isEmpty()) {
            respond(requestId, false, "Belum ada perangkat Bluetooth yang dipasangkan melalui Pengaturan Android.");
            return;
        }
        String[] labels = devices.stream().map(device -> {
            String name = device.getName();
            return (name == null || name.isBlank() ? "Perangkat Bluetooth" : name) + "\n" + device.getAddress();
        }).toArray(String[]::new);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Pilih printer Bluetooth")
                .setItems(labels, (selectedDialog, index) -> {
                    BluetoothDevice selected = devices.get(index);
                    preferences.edit()
                            .putString(PRINTER_ADDRESS, selected.getAddress())
                            .putString(PRINTER_NAME, selected.getName() == null ? "Printer Bluetooth" : selected.getName())
                            .apply();
                    connectSelectedPrinter(requestId, selected);
                })
                .setNegativeButton("Batal", (selectedDialog, which) ->
                        respond(requestId, false, "Pemilihan printer dibatalkan."))
                .create();
        dialog.show();
    }

    private void connectSelectedPrinter(String requestId, BluetoothDevice device) {
        printerExecutor.execute(() -> {
            try {
                connectSocket(device);
                String name = preferences.getString(PRINTER_NAME, "Printer Bluetooth");
                respond(requestId, true, name + " terhubung.");
            } catch (Exception error) {
                closePrinterSocket();
                respond(requestId, false, printerError(error));
            }
        });
    }

    @SuppressLint("MissingPermission")
    private BluetoothSocket ensurePrinterConnected() throws IOException {
        synchronized (socketLock) {
            if (printerSocket != null && printerSocket.isConnected()) return printerSocket;
        }
        String address = preferences.getString(PRINTER_ADDRESS, "");
        if (address.isEmpty()) throw new IOException("Pilih printer Bluetooth terlebih dahulu.");
        BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);
        connectSocket(device);
        synchronized (socketLock) {
            if (printerSocket == null) throw new IOException("Koneksi printer tidak tersedia.");
            return printerSocket;
        }
    }

    @SuppressLint("MissingPermission")
    private void connectSocket(BluetoothDevice device) throws IOException {
        closePrinterSocket();
        IOException firstError = null;
        BluetoothSocket candidate = null;
        try {
            candidate = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
            candidate.connect();
        } catch (IOException insecureError) {
            firstError = insecureError;
            if (candidate != null) try { candidate.close(); } catch (IOException ignored) {}
            candidate = null;
        }
        if (candidate == null) {
            try {
                candidate = device.createRfcommSocketToServiceRecord(SPP_UUID);
                candidate.connect();
            } catch (IOException secureError) {
                if (candidate != null) try { candidate.close(); } catch (IOException ignored) {}
                if (firstError != null) secureError.addSuppressed(firstError);
                throw secureError;
            }
        }
        synchronized (socketLock) {
            printerSocket = candidate;
        }
    }

    private void closePrinterSocket() {
        synchronized (socketLock) {
            if (printerSocket != null) {
                try { printerSocket.close(); } catch (IOException ignored) {}
                printerSocket = null;
            }
        }
    }

    private String printerError(Exception error) {
        String name = preferences.getString(PRINTER_NAME, "printer");
        String detail = error.getMessage();
        if (detail == null || detail.isBlank()) detail = error.getClass().getSimpleName();
        return "Tidak dapat terhubung ke " + name + ". Pastikan printer menyala dan tidak dipakai aplikasi lain. " + detail;
    }

    private void respond(String requestId, boolean success, String message) {
        String script = "window.__kasirNusaNativePrinterResponse("
                + JSONObject.quote(requestId) + ","
                + success + ","
                + JSONObject.quote(message) + ")";
        runOnUiThread(() -> webView.evaluateJavascript(script, null));
    }

    private boolean isExternalScannerEvent(KeyEvent event) {
        InputDevice device = event.getDevice();
        return event.isFromSource(InputDevice.SOURCE_KEYBOARD)
                && device != null
                && !device.isVirtual();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_DOWN || !isExternalScannerEvent(event)) {
            return super.dispatchKeyEvent(event);
        }
        long now = System.currentTimeMillis();
        if (now - scannerLastKeyAt > 250) {
            scannerBuffer.setLength(0);
            scannerStartedAt = now;
        }
        scannerLastKeyAt = now;
        if (event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                || event.getKeyCode() == KeyEvent.KEYCODE_NUMPAD_ENTER) {
            String barcode = scannerBuffer.toString().trim();
            scannerBuffer.setLength(0);
            if (barcode.length() >= 3 && now - scannerStartedAt <= 4000) {
                dispatchBarcode(barcode);
                return true;
            }
            return super.dispatchKeyEvent(event);
        }
        if (event.getKeyCode() == KeyEvent.KEYCODE_DEL) {
            if (scannerBuffer.length() > 0) scannerBuffer.deleteCharAt(scannerBuffer.length() - 1);
            return true;
        }
        int unicode = event.getUnicodeChar();
        if (unicode >= 32 && unicode != 127) {
            scannerBuffer.append((char) unicode);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private void dispatchBarcode(String barcode) {
        String script = "window.dispatchEvent(new CustomEvent('kasirnusa:barcode',{detail:{value:"
                + JSONObject.quote(barcode) + "}}))";
        runOnUiThread(() -> webView.evaluateJavascript(script, null));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQUEST_BLUETOOTH_CONNECT) {
            String requestId = pendingBluetoothRequestId;
            pendingBluetoothRequestId = null;
            if (requestId == null) return;
            if (granted) requestPrinterSelection(requestId);
            else respond(requestId, false, "Izin Perangkat di sekitar diperlukan untuk printer Bluetooth.");
        } else if (requestCode == REQUEST_CAMERA) {
            PermissionRequest request = pendingCameraRequest;
            pendingCameraRequest = null;
            if (request == null) return;
            if (granted) request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else request.deny();
        } else if (requestCode == REQUEST_NOTIFICATIONS) {
            if (granted) fetchAndEmitPushToken();
            else emitPushError("Izin notifikasi Android belum diberikan.");
        } else if (requestCode == REQUEST_LOCATION) {
            finishLocationPermission(hasLocationPermission());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        pendingNotificationPage = intent.getStringExtra(NOTIFICATION_PAGE);
        emitPendingNotificationPage();
    }

    @Override
    protected void onResume() {
        super.onResume();
        activeActivity = new WeakReference<>(this);
        emitStoredPushToken();
    }

    @Override
    protected void onPause() {
        if (activeActivity.get() == this) activeActivity.clear();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        finishLocationPermission(false);
        closePrinterSocket();
        printerExecutor.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("KasirNusaAndroid");
            webView.destroy();
        }
        super.onDestroy();
    }
}
