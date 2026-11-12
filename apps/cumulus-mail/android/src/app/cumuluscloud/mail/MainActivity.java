package app.cumuluscloud.mail;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telephony.TelephonyManager;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import app.infinitum.analytics.Analytics;

/**
 * Cumulus Mail for Android. Opens Cumulus://Mail in a Chrome Custom Tab: the full browser engine,
 * so passkey sign-in (Cumulus://ID) and the session cookie work exactly as on the web, and the
 * page's service worker keeps it fast. mailto: links open the composer.
 *
 * Some networks (Russian ISPs) freeze connections to Cloudflare after the first ~16 KB, so the
 * app first downloads a ~55 KB file from the main site with a short deadline and, if that fails,
 * opens the CloudFront mirror (mirror_url) instead. Both share passkeys and the same account.
 */
public class MainActivity extends Activity {
    private static final String EXTRA_SESSION = "android.support.customtabs.extra.SESSION";
    private static final String EXTRA_TOOLBAR_COLOR = "android.support.customtabs.extra.TOOLBAR_COLOR";
    private static final String EXTRA_TITLE_VISIBILITY = "android.support.customtabs.extra.TITLE_VISIBILITY";
    private static final String EXTRA_SHARE_STATE = "androidx.browser.customtabs.extra.SHARE_STATE";
    private static final String EXTRA_ENABLE_URLBAR_HIDING = "android.support.customtabs.extra.ENABLE_URLBAR_HIDING";
    private static final String ACTION_CUSTOM_TABS = "android.support.customtabs.action.CustomTabsService";

    private static final int PROBE_MS = 4000;
    private static final int PROBE_BYTES = 40 * 1024;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Analytics.start(this); // app opens and sessions only; see apps/android-shared/amplitude
        final Intent intent = getIntent();
        final String main = getString(R.string.mail_url);
        final String mirror = getString(R.string.mirror_url);
        final Handler ui = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            // The main site is the default and needs nothing else. On a Russian mobile network the
            // throttling of Cloudflare comes and goes, so a quick probe can pass while the page itself
            // then crawls; there the mirror is used whenever it answers. Elsewhere, switch only when
            // the main site is throttled AND the mirror answers, so the app works with no mirror at all.
            String base = main;
            if (!mirror.isEmpty()) {
                if (onRussianNetwork()) {
                    if (reachable(mirror)) base = mirror;
                } else if (!reachable(main) && reachable(mirror)) {
                    base = mirror;
                }
            }
            final String chosen = base;
            ui.post(() -> open(targetFor(intent, chosen)));
        }).start();
    }

    /** True when the phone is registered on a Russian mobile network (or, with none, has a Russian SIM). Needs no permission. */
    private boolean onRussianNetwork() {
        try {
            TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
            if (tm == null) return false;
            String country = tm.getNetworkCountryIso();
            if (country == null || country.isEmpty()) country = tm.getSimCountryIso();
            return "ru".equalsIgnoreCase(country);
        } catch (Exception e) {
            return false;
        }
    }

    /** True if the first PROBE_BYTES of the main site's app script arrive within PROBE_MS. */
    static boolean reachable(String base) {
        long deadline = System.currentTimeMillis() + PROBE_MS;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/app.js").openConnection();
            c.setConnectTimeout(PROBE_MS);
            c.setReadTimeout(PROBE_MS);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(false);
            int status = c.getResponseCode();
            if (status >= 300) return status < 400; // a redirect (e.g. a sign-in gate) proves the host answers
            InputStream in = c.getInputStream();
            byte[] buf = new byte[8192];
            int total = 0;
            for (int n; total < PROBE_BYTES && (n = in.read(buf)) > 0; ) {
                total += n;
                if (System.currentTimeMillis() > deadline) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void open(Uri target) {
        Intent tab = new Intent(Intent.ACTION_VIEW, target);
        Bundle extras = new Bundle();
        extras.putBinder(EXTRA_SESSION, null); // marks this as a Custom Tab request
        tab.putExtras(extras);
        tab.putExtra(EXTRA_TOOLBAR_COLOR, 0xFFFFFFFF);
        tab.putExtra(EXTRA_TITLE_VISIBILITY, 1);
        tab.putExtra(EXTRA_SHARE_STATE, 2); // no share button
        tab.putExtra(EXTRA_ENABLE_URLBAR_HIDING, true);
        String browser = customTabsBrowser();
        if (browser != null) tab.setPackage(browser);
        try {
            startActivity(tab);
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Intent.ACTION_VIEW, target));
        }
        finish();
    }

    private Uri targetFor(Intent intent, String baseUrl) {
        Uri base = Uri.parse(baseUrl);
        Uri data = intent == null ? null : intent.getData();
        if (data != null && "mailto".equalsIgnoreCase(data.getScheme())) {
            String to = data.getSchemeSpecificPart();
            int q = to.indexOf("?");
            if (q >= 0) to = to.substring(0, q);
            return base.buildUpon().path("/").appendQueryParameter("compose", "1").appendQueryParameter("to", to).build();
        }
        return base.buildUpon().path("/").appendQueryParameter("source", "android").build();
    }

    /** Prefer Chrome, else any browser that offers Custom Tabs. */
    private String customTabsBrowser() {
        PackageManager pm = getPackageManager();
        List<ResolveInfo> services = pm.queryIntentServices(new Intent(ACTION_CUSTOM_TABS), 0);
        String first = null;
        for (ResolveInfo info : services) {
            String pkg = info.serviceInfo.packageName;
            if ("com.android.chrome".equals(pkg)) return pkg;
            if (first == null) first = pkg;
        }
        return first;
    }
}
