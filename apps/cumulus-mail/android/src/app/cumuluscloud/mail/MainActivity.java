package app.cumuluscloud.mail;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import java.util.List;

/**
 * Cumulus Mail for Android. Opens Cumulus://Mail in a Chrome Custom Tab: the full browser engine,
 * so passkey sign-in (Cumulus://ID) and the session cookie work exactly as on the web, and the
 * page's service worker keeps it fast. mailto: links open the composer.
 */
public class MainActivity extends Activity {
    private static final String EXTRA_SESSION = "android.support.customtabs.extra.SESSION";
    private static final String EXTRA_TOOLBAR_COLOR = "android.support.customtabs.extra.TOOLBAR_COLOR";
    private static final String EXTRA_TITLE_VISIBILITY = "android.support.customtabs.extra.TITLE_VISIBILITY";
    private static final String EXTRA_SHARE_STATE = "androidx.browser.customtabs.extra.SHARE_STATE";
    private static final String EXTRA_ENABLE_URLBAR_HIDING = "android.support.customtabs.extra.ENABLE_URLBAR_HIDING";
    private static final String ACTION_CUSTOM_TABS = "android.support.customtabs.action.CustomTabsService";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Uri target = targetFor(getIntent());
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

    private Uri targetFor(Intent intent) {
        Uri base = Uri.parse(getString(R.string.mail_url));
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
