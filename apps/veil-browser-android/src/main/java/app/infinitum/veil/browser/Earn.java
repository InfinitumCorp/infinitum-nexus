package app.infinitum.veil.browser;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Opt-in data sharing for the Cumulus Data Exchange (packages/data-exchange, VeilCollector).
 * Off by default. While off, VEIL counts nothing.
 *
 * When the person opts in, VEIL keeps only the aggregates the VEIL dataset is defined by
 * (schema "feature,sessionCount,avgDuration"): how many times each VEIL feature was used,
 * how many sessions, and their average length. Never URLs, hosts, searches, page content,
 * or anything typed. The person sees exactly what is kept (report()) and can delete it.
 *
 * Sales pay 85% to the data owner, the person's Cumulus://ID (RevShareEngine).
 * Nothing is uploaded yet: the exchange API isn't live, so the aggregates stay on the phone.
 */
final class Earn {
    static final String PREFS = "earn";
    /** The only features counted. Adding one means updating the consent text in MainActivity. */
    static final String[] FEATURES = {
        "address_bar", "search", "app_panel", "new_identity", "tor_session", "trackers_blocked", "privacy_view"
    };
    static final int OWNER_SHARE_PCT = 85;

    private final SharedPreferences p;
    private long sessionStart;

    Earn(Context c) {
        p = c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    boolean optedIn() {
        return p.getBoolean("opted_in", false);
    }

    void optIn() {
        p.edit().putBoolean("opted_in", true).putLong("consent_at", System.currentTimeMillis()).apply();
        sessionStart = SystemClock.elapsedRealtime();
    }

    /** Opt out and delete everything kept. */
    void optOutAndDelete() {
        p.edit().clear().apply();
        sessionStart = 0;
    }

    void count(String feature) {
        count(feature, 1);
    }

    void count(String feature, int n) {
        if (!optedIn() || n <= 0) return;
        p.edit().putLong("f_" + feature, p.getLong("f_" + feature, 0) + n).apply();
    }

    void sessionStarted() {
        if (optedIn()) sessionStart = SystemClock.elapsedRealtime();
    }

    void sessionEnded() {
        if (!optedIn() || sessionStart == 0) return;
        long ms = SystemClock.elapsedRealtime() - sessionStart;
        sessionStart = 0;
        if (ms < 1000) return;
        p.edit()
            .putLong("sessions", p.getLong("sessions", 0) + 1)
            .putLong("session_ms", p.getLong("session_ms", 0) + ms)
            .apply();
    }

    /** Exactly what VEIL keeps, in the VEIL dataset's shape. */
    String report() {
        try {
            JSONObject features = new JSONObject();
            for (String f : FEATURES) features.put(f, p.getLong("f_" + f, 0));
            long sessions = p.getLong("sessions", 0);
            return new JSONObject()
                .put("product", "veil")
                .put("feature", features)
                .put("sessionCount", sessions)
                .put("avgDuration", sessions == 0 ? 0 : p.getLong("session_ms", 0) / sessions / 1000)
                .toString(2);
        } catch (JSONException e) {
            return "{}";
        }
    }
}
