package dev.pages.vortex_video.twa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;

import androidx.browser.trusted.Token;

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler;


public class DelegationService extends
        com.google.androidbrowserhelper.trusted.DelegationService {

    /* "Name is calling" alerts (from the site's service worker) go on their own channel, which
       rings with the Vortex ringtone and vibrates in its rhythm until answered or dismissed.
       Bump the id if the sound or pattern changes: Android never updates an existing channel. */
    private static final String CALLS_CHANNEL = "vortex_calls_v1";
    // delay, then the ringtone's rhythm: four quick taps and a long buzz, twice, then a rest
    private static final long[] RING_VIBE =
            {0, 80, 40, 80, 40, 80, 40, 320, 220, 80, 40, 80, 40, 80, 40, 450, 1250};

    private int verifiedUid = -1;

    @Override
    public void onCreate() {
        super.onCreate();


            registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());

    }

    @Override
    public boolean onNotifyNotificationWithChannel(String platformTag, int platformId,
            Notification notification, String channelName) {
        if (!isCallAlert(notification) || !callerIsVerifiedBrowser()) {
            return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return false;
        Uri sound = Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.vortex_ring);
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        Notification n;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CALLS_CHANNEL,
                    getString(R.string.callsChannelName), NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(getString(R.string.callsChannelDescription));
            ch.setSound(sound, attrs);
            ch.enableVibration(true);
            ch.setVibrationPattern(RING_VIBE);
            nm.createNotificationChannel(ch);
            NotificationChannel live = nm.getNotificationChannel(CALLS_CHANNEL);
            if (live != null && live.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
            n = Notification.Builder.recoverBuilder(this, notification)
                    .setChannelId(CALLS_CHANNEL)
                    .setCategory(Notification.CATEGORY_CALL)
                    .build();
        } else {
            n = notification;
            n.sound = sound;
            n.audioAttributes = attrs;
            n.vibrate = RING_VIBE;
            n.priority = Notification.PRIORITY_MAX;
            n.category = Notification.CATEGORY_CALL;
        }
        // keep ringing and buzzing until it's answered, declined or the caller hangs up
        n.flags |= Notification.FLAG_INSISTENT;
        nm.notify(platformTag, platformId, n);
        return true;
    }

    private static boolean isCallAlert(Notification n) {
        CharSequence title = n.extras == null ? null : n.extras.getCharSequence(Notification.EXTRA_TITLE);
        return title != null && title.toString().endsWith(" is calling");
    }

    /* The same check the base service makes before posting: only the browser that verified this
       app's site may post through it. */
    private boolean callerIsVerifiedBrowser() {
        int uid = Binder.getCallingUid();
        if (uid == verifiedUid) return true;
        Token token = getTokenStore().load();
        PackageManager pm = getPackageManager();
        String[] packages = pm.getPackagesForUid(uid);
        if (token == null || packages == null) return false;
        for (String p : packages) {
            if (token.matches(p, pm)) {
                verifiedUid = uid;
                return true;
            }
        }
        return false;
    }
}
