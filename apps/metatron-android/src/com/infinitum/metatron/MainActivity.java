package com.infinitum.metatron;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import app.infinitum.analytics.Analytics;

/**
 * METATRON¹⁰⁰ for Android: a full-screen WebView on https://mttrn.app.
 *
 * Pages on mttrn.app are served from the copy bundled in assets/site, under the real
 * https://mttrn.app origin (so Cumulus://ID and checkout see the allow-listed origin).
 * The app therefore opens even where Cloudflare is unreachable, e.g. Russian networks
 * without a VPN. Anything not bundled, and every other host, goes to the network.
 * Cumulus://ID sign-in and Stripe checkout stay in the app; other sites open in the browser.
 */
public class MainActivity extends Activity {
    static final String VERSION = "0.1.0";
    static final String HOST = "mttrn.app";
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("css", "text/css");
        MIME.put("js", "text/javascript");
        MIME.put("png", "image/png");
        MIME.put("svg", "image/svg+xml");
        MIME.put("txt", "text/plain");
        MIME.put("xml", "application/xml");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
    }

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Analytics.start(this); // app opens and sessions only; see apps/android-shared/amplitude
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window w = getWindow();
        w.setStatusBarColor(Color.WHITE);
        w.setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 30) {
            w.getDecorView().post(() -> {
                android.view.WindowInsetsController c = w.getInsetsController();
                int light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                if (c != null) c.setSystemBarsAppearance(light, light);
            });
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " MetatronAndroid/" + VERSION);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!"GET".equalsIgnoreCase(req.getMethod()) || !"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return null;
                return bundled(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (staysInApp(u)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException ignored) {
                    // No browser: stay put.
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline(req.getUrl().toString(), String.valueOf(err.getDescription()));
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                top = bars.top; left = bars.left; right = bars.right; bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });
        setContentView(root);

        if (state != null) web.restoreState(state);
        else web.loadUrl(startUrl(getIntent()));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        web.loadUrl(startUrl(intent));
    }

    /** A https://mttrn.app link that opened the app, or the home page. */
    private String startUrl(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u != null && "https".equals(u.getScheme()) && HOST.equals(u.getHost())) return u.toString();
        return getString(R.string.home_url);
    }

    /** mttrn.app, Cumulus://ID (sign-in, billing) and Stripe checkout open inside the app. */
    static boolean staysInApp(Uri u) {
        if (!"https".equals(u.getScheme()) || u.getHost() == null) return false;
        String h = u.getHost();
        return h.equals(HOST) || h.equals("cumuluscloud.app") || h.endsWith(".cumuluscloud.app")
            || h.equals("checkout.stripe.com") || h.equals("billing.stripe.com");
    }

    /** Maps a URL path to a bundled file: "/" and "/x/" use index.html, "/x" may be x.html. */
    static String assetPath(String path) {
        if (path == null || path.isEmpty() || path.equals("/")) return "site/index.html";
        if (path.contains("..") || path.contains("\\")) return null;
        String p = path.startsWith("/") ? path.substring(1) : path;
        if (p.endsWith("/")) return "site/" + p + "index.html";
        return "site/" + p;
    }

    private WebResourceResponse bundled(String path) {
        String asset = assetPath(path);
        if (asset == null) return null;
        boolean hasExt = asset.indexOf('.', asset.lastIndexOf('/')) >= 0;
        String[] tries = hasExt ? new String[] { asset } : new String[] { asset + ".html", asset + "/index.html" };
        for (String a : tries) {
            try {
                InputStream in = getAssets().open(a);
                String ext = a.substring(a.lastIndexOf('.') + 1).toLowerCase();
                String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                boolean text = mime.startsWith("text/") || mime.contains("xml") || mime.contains("json") || mime.contains("javascript");
                return new WebResourceResponse(mime, text ? "utf-8" : null, in);
            } catch (IOException ignored) {
                // Not bundled: try the next name, then the network.
            }
        }
        return null;
    }

    private void showOffline(String url, String why) {
        String html = "<!doctype html><html lang='en'><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{margin:0;padding:40px 20px;background:#fff;color:#111820;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55}"
            + "h1{font-weight:400;font-size:44px;line-height:1;letter-spacing:-.06em;margin:0 0 20px}"
            + "sup{font-size:.38em;vertical-align:super;line-height:0;letter-spacing:0}"
            + "p{color:#52606b}a{display:inline-block;margin-top:14px;padding:16px 22px;background:#111820;color:#fff;text-decoration:none}</style></head>"
            + "<body><h1>METATRON<sup>100</sup></h1><p>Can't reach this page. " + escape(why) + "</p>"
            + "<a href='" + escape(url) + "'>Retry</a> <a href='" + escape(getString(R.string.home_url)) + "' style='background:#fff;color:#111820;border:1px solid #111820'>Home</a></body></html>";
        web.loadDataWithBaseURL(getString(R.string.home_url), html, "text/html", "utf-8", url);
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;").replace("\"", "&quot;");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
