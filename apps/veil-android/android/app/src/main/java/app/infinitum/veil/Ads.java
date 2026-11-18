package app.infinitum.veil;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.google.android.gms.ads.AdListener;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

/**
 * Optional AdMob banner. Ads stay off until {@link BuildConfig#ADS_ENABLED} is
 * flipped to true (release builds ship with it false). When off, consent is
 * refused, or a banner fails to load, {@code slot} is GONE and takes no space,
 * so existing screens do not change.
 *
 * Debug builds use Google's test banner unit; release builds use the real unit
 * (still only if ADS_ENABLED is true). UMP consent is requested before any ad.
 */
final class Ads {
    private Ads() {}

    static void attach(Activity activity, FrameLayout slot) {
        slot.setVisibility(View.GONE);
        if (slot.getLayoutParams() != null) {
            slot.getLayoutParams().width = ViewGroup.LayoutParams.MATCH_PARENT;
            slot.getLayoutParams().height = ViewGroup.LayoutParams.WRAP_CONTENT;
        }
        if (!BuildConfig.ADS_ENABLED) {
            return;
        }
        ConsentRequestParameters params = new ConsentRequestParameters.Builder().build();
        var info = UserMessagingPlatform.getConsentInformation(activity);
        info.requestConsentInfoUpdate(
            activity,
            params,
            () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(
                activity,
                formError -> {
                    if (info.canRequestAds()) {
                        showBanner(activity, slot);
                    }
                }),
            requestError -> { /* leave the slot collapsed */ });
    }

    private static void showBanner(Activity activity, FrameLayout slot) {
        MobileAds.initialize(activity, status -> activity.runOnUiThread(() -> {
            AdView ad = new AdView(activity);
            ad.setAdSize(AdSize.BANNER);
            ad.setAdUnitId(BuildConfig.ADMOB_BANNER_ID);
            ad.setAdListener(new AdListener() {
                @Override public void onAdLoaded() {
                    slot.setVisibility(View.VISIBLE);
                    var insets = ViewCompat.getRootWindowInsets(slot);
                    if (insets != null) {
                        Insets bars = insets.getInsets(WindowInsetsCompat.Type.navigationBars());
                        slot.setPadding(0, 0, 0, bars.bottom);
                    }
                }
                @Override public void onAdFailedToLoad(LoadAdError error) {
                    slot.setVisibility(View.GONE);
                    slot.setPadding(0, 0, 0, 0);
                }
            });
            slot.removeAllViews();
            slot.addView(ad, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
            ad.loadAd(new AdRequest.Builder().build());
        }));
    }
}
