package app.infinitum.analytics;

import android.content.Context;
import com.amplitude.android.Amplitude;
import com.amplitude.android.AutocaptureOption;
import com.amplitude.android.Configuration;
import com.amplitude.android.TrackingOptions;
import com.amplitude.core.ServerZone;
import java.util.EnumSet;

/**
 * Privacy-first Amplitude analytics, shared by Infinitum's Gradle-less Android apps.
 *
 * Official SDK (com.amplitude:analytics-android 1.37.1, vendored by fetch-deps.sh), US region,
 * public API key only. Records app opens (screen views) and sessions, nothing else: no element or
 * form interactions, no session replay, no remote config, no diagnostics. IP address, city, DMA,
 * latitude/longitude, the advertising ID and the app set ID are never collected, and location
 * listening is off. Users are never identified.
 *
 * Needs the androidx.startup InitializationProvider in the app manifest (it starts
 * ProcessLifecycleOwner, which the SDK uses to see the app enter and leave the foreground).
 */
public final class Analytics {
    /** Amplitude's public (client) API key. The Secret key never ships in an app. */
    private static final String PUBLIC_API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";

    private static Amplitude amplitude;

    private Analytics() {}

    /** Starts analytics once per process. Never throws: analytics must not break the app. */
    public static synchronized void start(Context context) {
        if (amplitude != null) return;
        try {
            Configuration config = new Configuration(PUBLIC_API_KEY, context.getApplicationContext());
            config.setServerZone(ServerZone.US);
            config.setAutocapture(EnumSet.of(AutocaptureOption.SESSIONS, AutocaptureOption.SCREEN_VIEWS));
            config.setEnableAutocaptureRemoteConfig(false);
            config.setEnableDiagnostics(false);
            config.setLocationListening(false);
            config.setUseAdvertisingIdForDeviceId(false);
            config.setUseAppSetIdForDeviceId(false);
            config.setTrackingOptions(new TrackingOptions()
                .disableIpAddress()
                .disableCity()
                .disableDma()
                .disableLatLng()
                .disableAdid()
                .disableAppSetId());
            amplitude = new Amplitude(config);
        } catch (Throwable ignored) {
            // No analytics this run.
        }
    }
}
