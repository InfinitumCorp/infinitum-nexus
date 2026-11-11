package id.cumuluscloud.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;

/**
 * +SPCTR for Android. Opens +SPCTR (id.cumuluscloud.app) in a Chrome Custom Tab: the full browser
 * engine, so passkey sign-in (Cumulus://ID) and the session cookie work exactly as on the web.
 *
 * Some networks (Russian ISPs) freeze connections to Cloudflare after the first ~16 KB. When a
 * mirror_url is built in, the app first downloads part of the main site's app script with a short
 * deadline and opens the mirror only if the main site stalls and the mirror answers.
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
        // A visible white window: some OEM power managers (TECNO Hiber) freeze an app whose only
        // window is translucent and empty, which would stop the probe below.
        getWindow().getDecorView().setBackgroundColor(0xFFFFFFFF);
        final String main = getString(R.string.spctr_url);
        final String mirror = getString(R.string.mirror_url);
        if (mirror.isEmpty()) {
            open(target(main));
            return;
        }
        final Handler ui = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            // Probe both at once so the wait is one PROBE_MS at most.
            final boolean[] ok = new boolean[2];
            Thread a = new Thread(() -> ok[0] = reachable(main));
            Thread b = new Thread(() -> ok[1] = reachable(mirror));
            a.start();
            b.start();
            try {
                a.join(PROBE_MS + 500);
                b.join(500);
            } catch (InterruptedException ignored) {
            }
            String base = !ok[0] && ok[1] ? mirror : main;
            ui.post(() -> open(target(base)));
        }).start();
    }

    /** True if the first PROBE_BYTES of the site's app script arrive within PROBE_MS. */
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
            if (status >= 300) return status < 400;
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

    private static Uri target(String base) {
        return Uri.parse(base).buildUpon().path("/").appendQueryParameter("source", "android").build();
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
