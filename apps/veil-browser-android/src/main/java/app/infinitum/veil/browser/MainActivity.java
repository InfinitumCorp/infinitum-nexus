package app.infinitum.veil.browser;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.util.HashSet;
import java.util.Set;

/**
 * VEIL for Android: a private WebView browser.
 *
 * Every session is anonymous: no third-party cookies, HTTPS-first, tracking
 * parameters stripped, nothing saved after the app closes, and New Identity
 * wipes cookies, storage, cache and history on demand.
 *
 * Tor: Android WebView cannot be pointed at a SOCKS proxy without AndroidX,
 * so VEIL routes through Orbot's VPN mode, and "Tor" checks the exit.
 */
public class MainActivity extends Activity {
    static final String HUB = "file:///android_asset/hub/index.html";
    static final String TOR_CHECK = "https://check.torproject.org/";
    static final String ORBOT = "org.torproject.android";

    static final int BG = Color.parseColor("#ffffff");
    static final int CARD = Color.parseColor("#ffffff");
    static final int LINE = Color.parseColor("#d6dce1");
    static final int FG = Color.parseColor("#111820");
    static final int MUTED = Color.parseColor("#52606b");
    // Phase I browser frame (veil-prototype/static/shell.css).
    static final int QUIET = Color.parseColor("#5f6670");
    static final int RULE = Color.parseColor("#e3e4e8");
    static final int OMNI = Color.parseColor("#eef0f3");
    static final int HOVER = Color.parseColor("#f3f3f5");
    static final int FOCUS = Color.parseColor("#1f5fd6");
    static final int ACCENT = Color.parseColor("#5b3fd1");
    static final int GOOD = Color.parseColor("#1a7f37");
    static final int BAD = Color.parseColor("#c62828");

    /** What VEIL can't see. Same statement as the extension and the web app. */
    static final String PRIVACY_STATEMENT = "Every check runs on this phone. VEIL doesn't send your pages, searches, passwords, forms or downloads anywhere, keeps no browsing history, and can't see what you do in other apps.";

    WebView web;
    EditText address;
    ProgressBar progress;
    TextView shield;
    int stripped = 0;
    /** Blocked on the current page. Written from WebView's network thread. */
    volatile int blocked = 0;
    volatile int blockedSession = 0;
    volatile String pageHost = "";
    /** Host of the page being opened, before it starts loading. */
    String navHost = "";
    volatile boolean blocking = true;
    /** Hosts the person chose to keep on plain HTTP this session. */
    final Set<String> allowedInsecure = new HashSet<>();
    AlertDialog alert;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Keep page contents out of screenshots and the recent-apps preview.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        // White bars with dark icons, like the other Infinitum apps.
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        setContentView(buildUi());
        configureWebView();

        Uri data = getIntent() != null ? getIntent().getData() : null;
        if (data != null && Privacy.isWeb(data.toString())) open(data.toString());
        else web.loadUrl(HUB);
    }

    // ---------------- UI ----------------

    int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    GradientDrawable rounded(int fill, int stroke, float radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radius));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    /** Round button, as in the Phase I browser frame: quiet grey glyph, grey circle when pressed. */
    Button toolButton(String label, String description, View.OnClickListener onClick) {
        boolean word = label.length() > 1;
        Button b = new Button(this);
        b.setText(label);
        b.setContentDescription(description);
        b.setAllCaps(false);
        b.setTextColor(word ? FG : QUIET);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, word ? 13 : 22);
        b.setTypeface(Typeface.SANS_SERIF);
        GradientDrawable pressed = new GradientDrawable();
        pressed.setColor(HOVER);
        if (word) pressed.setCornerRadius(dp(20)); else pressed.setShape(GradientDrawable.OVAL);
        android.graphics.drawable.StateListDrawable bg = new android.graphics.drawable.StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_pressed}, pressed);
        bg.addState(new int[]{}, rounded(BG, 0, 0));
        b.setBackground(bg);
        b.setStateListAnimator(null);
        b.setPadding(0, 0, 0, 0);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(44), word ? 1.3f : 1f);
        lp.leftMargin = lp.rightMargin = dp(2);
        b.setLayoutParams(lp);
        return b;
    }

    View rule() {
        View v = new View(this);
        v.setBackgroundColor(RULE);
        v.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));
        return v;
    }

    View buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setFitsSystemWindows(true);

        // Top bar: one grey pill (the omnibox) holding the white "Anonymous" chip and the address field.
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(10), dp(6), dp(10), dp(6));

        LinearLayout omni = new LinearLayout(this);
        omni.setOrientation(LinearLayout.HORIZONTAL);
        omni.setGravity(Gravity.CENTER_VERTICAL);
        omni.setBackground(rounded(OMNI, 0, 20));
        omni.setPadding(dp(5), 0, dp(6), 0);
        omni.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40)));

        shield = new TextView(this);
        shield.setContentDescription("VEIL privacy status");
        shield.setTextColor(FG);
        shield.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        shield.setGravity(Gravity.CENTER_VERTICAL);
        shield.setSingleLine(true);
        shield.setPadding(dp(10), 0, dp(11), 0);
        shield.setBackground(rounded(CARD, 0, 15));
        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL);
        dot.setColor(ACCENT);
        dot.setSize(dp(7), dp(7));
        shield.setCompoundDrawablesWithIntrinsicBounds(dot, null, null, null);
        shield.setCompoundDrawablePadding(dp(6));
        shield.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(30)));
        shield.setOnClickListener(v -> showPrivacy());
        shield.setText("Anonymous");
        omni.addView(shield);

        address = new EditText(this);
        address.setSingleLine(true);
        address.setHint("Search privately or enter address");
        address.setContentDescription("Address bar");
        address.setHintTextColor(QUIET);
        address.setTextColor(FG);
        address.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        address.setSelectAllOnFocus(true);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setBackground(null);
        address.setPadding(dp(10), 0, dp(8), 0);
        address.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
        address.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                String url = Privacy.fromInput(address.getText().toString());
                if (url != null) open(url);
                hideKeyboard();
                return true;
            }
            return false;
        });
        omni.addView(address);
        top.addView(omni);
        root.addView(top);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(FOCUS));
        progress.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(RULE));
        progress.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));
        root.addView(progress);

        web = new WebView(this);
        web.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        web.setBackgroundColor(BG);
        root.addView(web);

        // Bottom toolbar: round buttons under a hairline rule.
        root.addView(rule());
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(2), dp(6), dp(2));
        bar.setBackgroundColor(BG);
        bar.addView(toolButton("‹", "Back", v -> { if (web.canGoBack()) web.goBack(); }));
        bar.addView(toolButton("›", "Forward", v -> { if (web.canGoForward()) web.goForward(); }));
        bar.addView(toolButton("↻", "Reload", v -> web.reload()));
        bar.addView(toolButton("Tor", "Check Tor", v -> torCheck()));
        bar.addView(toolButton("Identity", "New Identity", v -> confirmNewIdentity()));
        bar.addView(toolButton("Home", "VEIL home", v -> web.loadUrl(HUB)));
        root.addView(bar);
        return root;
    }

    void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(address.getWindowToken(), 0);
        address.clearFocus();
    }

    // ---------------- WebView ----------------

    void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // wiped on exit and on New Identity
        s.setAllowFileAccess(false);            // android_asset still loads
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSafeBrowsingEnabled(false);        // no URL lookups sent to Google
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file:///android_asset/")) return false;
                if (request.isForMainFrame()) navHost = String.valueOf(request.getUrl().getHost());
                if (!Privacy.isWeb(url)) {
                    Toast.makeText(MainActivity.this, "VEIL only opens web pages", Toast.LENGTH_SHORT).show();
                    return true;
                }
                String cleaned = Privacy.clean(url);
                if (!cleaned.equals(url)) {
                    if (!Privacy.stripTrackers(url).equals(url)) stripped++;
                    view.loadUrl(cleaned);
                    return true;
                }
                return false;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Ad networks, trackers and data brokers, as third-party subresources only.
                if (!blocking || request.isForMainFrame()) return null;
                String host = request.getUrl().getHost();
                if (!Blocklist.isBlocked(host) || !Privacy.isThirdParty(host, pageHost)) return null;
                blocked++;
                blockedSession++;
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                String host = Uri.parse(url).getHost();
                pageHost = host == null ? "" : host;
                blocked = 0;
                showAddress(url);
                showShield();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                showAddress(url);
                showShield();
                progress.setVisibility(View.INVISIBLE);
                checkConnection(url);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); // never proceed past a certificate error
                // Alert for the page itself; a broken subresource just doesn't load.
                String host = Uri.parse(error.getUrl()).getHost();
                if (host != null && (host.equals(navHost) || host.equals(pageHost))) certificateAlert(error);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                progress.setVisibility(p < 100 ? View.VISIBLE : View.INVISIBLE);
                progress.setProgress(p);
            }
        });
    }

    void showShield() {
        boolean insecure = Privacy.isInsecure(web.getUrl());
        shield.setText(insecure ? "Not secure" : blocked > 0 ? "Anonymous · " + blocked : "Anonymous");
        shield.setTextColor(insecure ? BAD : FG);
        shield.setContentDescription(insecure ? "VEIL: this page is not encrypted"
            : "VEIL privacy status, " + blocked + " trackers blocked on this page");
    }

    // ---------------- Connection alerts ----------------

    void showAlert(AlertDialog.Builder b) {
        if (isFinishing()) return;
        if (alert != null && alert.isShowing()) alert.dismiss();
        alert = b.show();
    }

    void goBackOrHub() {
        if (web.canGoBack()) web.goBack();
        else web.loadUrl(HUB);
    }

    /** One-tap fixes for plain HTTP pages and look-alike addresses. */
    void checkConnection(String url) {
        if (url == null || url.startsWith("file:")) return;
        Uri u = Uri.parse(url);
        String host = u.getHost();
        if (host == null || allowedInsecure.contains(host)) return;
        if (Privacy.isInsecure(url)) {
            String https = "https://" + url.substring(7);
            showAlert(new AlertDialog.Builder(this)
                .setTitle("This page isn't encrypted")
                .setMessage(host + " loaded over plain HTTP, so anyone on the network can read or change it. Don't type passwords or personal details here.")
                .setPositiveButton("Try HTTPS", (d, w) -> web.loadUrl(https))
                .setNeutralButton("Go back", (d, w) -> goBackOrHub())
                .setNegativeButton("Stay", (d, w) -> allowedInsecure.add(host)));
        } else if (Privacy.isLookalike(host)) {
            showAlert(new AlertDialog.Builder(this)
                .setTitle("Look-alike address")
                .setMessage(host + " uses international letters that can imitate a familiar name. Check the address before you sign in.")
                .setPositiveButton("Go back", (d, w) -> goBackOrHub())
                .setNegativeButton("It's fine", (d, w) -> allowedInsecure.add(host)));
        }
    }

    void certificateAlert(SslError error) {
        String why;
        switch (error.getPrimaryError()) {
            case SslError.SSL_EXPIRED: why = "Its certificate has expired."; break;
            case SslError.SSL_IDMISMATCH: why = "Its certificate is for a different site."; break;
            case SslError.SSL_UNTRUSTED: why = "Its certificate isn't from a trusted authority."; break;
            case SslError.SSL_NOTYETVALID: why = "Its certificate isn't valid yet."; break;
            case SslError.SSL_DATE_INVALID: why = "Its certificate date is invalid."; break;
            default: why = "Its certificate isn't valid.";
        }
        String host = Uri.parse(error.getUrl()).getHost();
        showAlert(new AlertDialog.Builder(this)
            .setTitle("Connection blocked")
            .setMessage("VEIL stopped loading " + (host == null ? "this site" : host) + ". " + why
                + " Someone may be intercepting the connection, or the site is misconfigured.")
            .setPositiveButton("Go back", (d, w) -> goBackOrHub())
            .setNeutralButton("Check over Tor", (d, w) -> torCheck()));
    }

    void showAddress(String url) {
        if (url == null || address.hasFocus()) return;
        address.setText(url.startsWith(HUB) ? "" : url);
    }

    void open(String url) {
        String cleaned = Privacy.clean(url);
        navHost = String.valueOf(Uri.parse(cleaned).getHost());
        if (!cleaned.equals(url) && !Privacy.stripTrackers(url).equals(url)) stripped++;
        web.loadUrl(cleaned);
    }

    // ---------------- Privacy actions ----------------

    boolean orbotInstalled() {
        try {
            getPackageManager().getPackageInfo(ORBOT, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    void torCheck() {
        if (!orbotInstalled()) {
            new AlertDialog.Builder(this)
                .setTitle("Route VEIL through Tor")
                .setMessage("VEIL uses Orbot (Tor for Android) in VPN mode to send traffic over Tor. Orbot isn't installed. You can still check whether this connection is on Tor.")
                .setPositiveButton("Check connection", (d, w) -> open(TOR_CHECK))
                .setNeutralButton("Get Orbot", (d, w) -> openExternal("https://orbot.app/download/"))
                .setNegativeButton("Cancel", null)
                .show();
            return;
        }
        open(TOR_CHECK);
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            open(url);
        }
    }

    void confirmNewIdentity() {
        new AlertDialog.Builder(this)
            .setTitle("New Identity")
            .setMessage("Clear cookies, site storage, cache and history, and start fresh?")
            .setPositiveButton("Clear", (d, w) -> {
                wipe();
                web.loadUrl(HUB);
                Toast.makeText(this, "New Identity: everything cleared", Toast.LENGTH_SHORT).show();
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    void wipe() {
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        WebStorage.getInstance().deleteAllData();
        web.clearCache(true);
        web.clearHistory();
        web.clearFormData();
        stripped = 0;
        blocked = 0;
        blockedSession = 0;
        allowedInsecure.clear();
    }

    void showPrivacy() {
        boolean insecure = Privacy.isInsecure(web.getUrl());
        String title = insecure ? "Not encrypted" : blocking ? "Protected" : "Blocking is off";
        String msg = (pageHost.isEmpty() ? "" : pageHost + "\n\n")
            + "• Trackers and ads blocked: " + blocked + " on this page, " + blockedSession + " this session\n"
            + "• Tracking parameters stripped: " + stripped + " this session\n"
            + "• HTTPS-first, certificate errors blocked\n"
            + "• Third-party cookies off\n"
            + "• Nothing kept after you close VEIL\n"
            + "• Screenshots of pages blocked\n\n"
            + PRIVACY_STATEMENT + "\n\n"
            + (orbotInstalled() ? "Orbot is installed. Turn on its VPN mode to route VEIL over Tor." : "Install Orbot to route VEIL over Tor.");
        new AlertDialog.Builder(this).setTitle(title).setMessage(msg)
            .setPositiveButton("OK", null)
            .setNeutralButton(blocking ? "Turn blocking off" : "Turn blocking on", (d, w) -> {
                blocking = !blocking;
                Toast.makeText(this, blocking ? "Blocking trackers, ads and data brokers" : "Blocking is off until you turn it on", Toast.LENGTH_SHORT).show();
                web.reload();
            })
            .show();
    }

    // ---------------- Lifecycle ----------------

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri data = intent.getData();
        if (data != null && Privacy.isWeb(data.toString())) open(data.toString());
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) wipe(); // anonymous by default: nothing survives the session
        web.destroy();
        super.onDestroy();
    }

    static boolean isBlank(CharSequence s) {
        return TextUtils.isEmpty(s) || s.toString().trim().isEmpty();
    }
}
