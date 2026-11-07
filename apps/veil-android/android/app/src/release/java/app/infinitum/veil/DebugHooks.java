package app.infinitum.veil;

import android.widget.LinearLayout;

/** Release builds have no local test peer entry. */
public final class DebugHooks {
    private DebugHooks() {
    }

    public static void attach(MainActivity activity, LinearLayout column) {
    }
}
