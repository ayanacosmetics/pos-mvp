package app.kasirnusa.cashier;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Notification;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public final class NusaFirebaseMessagingService extends FirebaseMessagingService {
    public static final String CHANNEL_ID = "nusa_important";
    public static final String PUSH_TOKEN = "native_push_token";

    @Override
    public void onNewToken(String token) {
        getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit().putString(PUSH_TOKEN, token).apply();
        MainActivity.deliverPushTokenToActiveActivity(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        RemoteMessage.Notification remoteNotification = message.getNotification();
        Map<String, String> data = message.getData();
        String title = remoteNotification == null ? data.get("title") : remoteNotification.getTitle();
        String body = remoteNotification == null ? data.get("body") : remoteNotification.getBody();
        showNotification(title == null ? "Kasir Nusa POS" : title,
                body == null ? "Ada pembaruan penting." : body,
                data.get("page"));
    }

    private void showNotification(String title, String body, String page) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Kabar penting Nusa", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Transaksi, absensi, persetujuan restok, dan peringatan penting.");
            channel.enableLights(true);
            channel.setLightColor(Color.rgb(23, 118, 112));
            manager.createNotificationChannel(channel);
        }
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.NOTIFICATION_PAGE, page == null ? "" : page);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setPriority(Notification.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);
        manager.notify((title + body).hashCode(), notification.build());
    }
}
