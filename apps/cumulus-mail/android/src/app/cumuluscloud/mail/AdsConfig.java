package app.cumuluscloud.mail;

import android.content.Context;
import android.content.pm.ApplicationInfo;

/**
 * AdMob identifiers for Cumulus Mail Android.
 *
 * TODO: This app is built with the plain Android SDK tools, not Gradle.
 * The Google Mobile Ads SDK and the User Messaging Platform (UMP) ship as
 * Maven AARs with many transitive dependencies, so they cannot be added here
 * without breaking the no-Gradle build. When this app is moved to Gradle, add:
 *   implementation("com.google.android.gms:play-services-ads:24.7.0")
 *   implementation("com.google.android.ump:user-messaging-platform:3.2.0")
 * request UMP consent, then load a banner into a collapsing bottom slot that
 * is GONE when AdsConfig.ADS_ENABLED is false, consent is refused, or the ad
 * fails. Do not change existing screens.
 *
 * The real AdMob App ID is already in AndroidManifest.xml
 * (com.google.android.gms.ads.APPLICATION_ID). Ads stay off until
 * AdsConfig.ADS_ENABLED is flipped to true.
 *
 * This activity opens a Chrome Custom Tab and immediately finish()es, so
 * there is no in-app surface for a banner today. A banner would need a
 * persistent activity (or a pre-launch screen) before the SDK can be shown.
 * Cumulus Mail is also a privacy-oriented product; review that before
 * flipping ADS_ENABLED.
 */
public final class AdsConfig {
    private AdsConfig() {}

    /** Flip to true only after review. Release and debug both ship false. */
    public static final boolean ADS_ENABLED = false;

    public static final String APP_ID = "ca-app-pub-7308175971826620~8759597812";
    public static final String TEST_BANNER = "ca-app-pub-3940256099942544/6300978111";
    public static final String RELEASE_BANNER = "ca-app-pub-7308175971826620/7172998064";

    /** Google's test unit in debuggable builds; the real unit in release builds. */
    public static String bannerUnit(Context ctx) {
        boolean debug = (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        return debug ? TEST_BANNER : RELEASE_BANNER;
    }
}
