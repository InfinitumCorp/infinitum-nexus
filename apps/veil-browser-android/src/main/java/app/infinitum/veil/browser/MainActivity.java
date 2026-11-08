package app.infinitum.veil.browser;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
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
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.util.HashSet;
import java.util.Set;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

/**
 * VEIL for Android: a private WebView browser.
 *
 * Every session is anonymous: no third-party cookies, HTTPS-first, tracking
 * parameters stripped, nothing saved after the app closes, and New Identity
 * wipes cookies, storage, cache and history on demand.
 *
 * Tor is built in (see Tor.java). Every WebView in the app is pointed at Tor's
 * SOCKS port with androidx.webkit's ProxyController, and VEIL fails closed: no
 * web page loads until that proxy is in place and Tor has connected. If Tor
 * stops, pages stop loading instead of going out directly.
 */
public class MainActivity extends Activity {
    static final String HUB = "file:///android_asset/hub/index.html";
    static final String TOR_CHECK = "https://check.torproject.org/";
    /** WebRTC can reach the network over UDP outside the proxy and reveal the real IP, so pages don't get it. */
    static final String NO_WEBRTC = "(function(){['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel',"
        + "'RTCIceCandidate','RTCSessionDescription','RTCRtpSender','RTCRtpReceiver','RTCRtpTransceiver'].forEach(function(k){"
        + "try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false});}catch(e){}});})();";

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

    // Tor state. Web pages load only when proxyReady && tor.ready().
    final Tor tor = Tor.get();
    /** True when this APK was built without the Tor binaries (see build.sh VEIL_ABIS). */
    boolean torOff;
    TextView torBox;
    volatile boolean proxyReady = false;
    /** Set when this phone's WebView can't be pointed at Tor; VEIL then refuses to browse. */
    String proxyProblem;
    /** Where to go once Tor connects (main view), or the panel to open (url, title). */
    String pendingUrl;
    String[] pendingPanel;
    boolean torWasReady = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Keep page contents out of screenshots and the recent-apps preview.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        // White bars with dark icons, like the other Infinitum apps.
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        torOff = !new java.io.File(getApplicationInfo().nativeLibraryDir, "libTor.so").exists();
        setContentView(wrapWithPanel(buildUi()));
        configureWebView();

        Uri data = getIntent() != null ? getIntent().getData() : null;
        if (data != null && Privacy.isWeb(data.toString())) pendingUrl = data.toString();

        // Point every WebView at Tor before anything loads, then start Tor.
        if (torOff) {
            // Built without Tor (VEIL_ABIS=""): browse directly, and say so in the Tor box.
            updateTorBox();
            web.loadUrl(HUB);
            if (pendingUrl != null) { String u = pendingUrl; pendingUrl = null; open(u); }
            return;
        }
        startProxy();
        tor.setListener(this::onTorState);
        tor.start(this);
    }

    // ---------------- Tor ----------------

    void startProxy() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            proxyProblem = "This phone's Android System WebView is too old to send VEIL's traffic over Tor. Update \"Android System WebView\" from the Play Store, then reopen VEIL.";
            updateTorBox();
            web.loadUrl(HUB); // local page; nothing remote loads (proxyReady stays false)
            return;
        }
        ProxyConfig config = new ProxyConfig.Builder()
            .addProxyRule("socks5://127.0.0.1:" + tor.socksPort) // SOCKS5: host names resolve inside Tor, not on the phone
            .build();
        try {
            ProxyController.getInstance().setProxyOverride(config, getMainExecutor(), () -> {
                proxyReady = true;
                web.loadUrl(HUB);
                onTorState(tor.progress, tor.summary, tor.error);
            });
        } catch (RuntimeException e) {
            proxyProblem = "VEIL couldn't point this phone's WebView at Tor (" + e.getMessage() + "), so it won't load pages.";
            updateTorBox();
            web.loadUrl(HUB);
        }
    }

    boolean torReady() {
        return torOff || (proxyReady && tor.ready());
    }

    void onTorState(int progress, String summary, String error) {
        updateTorBox();
        if (!torReady()) { torWasReady = false; return; }
        if (!torWasReady) {
            torWasReady = true;
            if (pendingUrl != null) { String u = pendingUrl; pendingUrl = null; open(u); }
            if (pendingPanel != null) { String[] p = pendingPanel; pendingPanel = null; openPanel(p[0], p[1]); }
        }
    }

    /** Box right of the address bar: "Tor 45%" while connecting, "● Tor" when connected. */
    void updateTorBox() {
        if (torBox == null) return;
        if (torOff) {
            torBox.setText("Tor off");
            torBox.setTextColor(QUIET);
            torBox.setContentDescription("This version doesn't use Tor. Tap for details");
            return;
        }
        String text;
        int color;
        if (proxyProblem != null || tor.error != null) {
            text = "Tor ✕";
            color = BAD;
            torBox.setContentDescription("Tor isn't connected. Tap for details");
        } else if (torReady()) {
            android.text.SpannableString s = new android.text.SpannableString("● Tor");
            s.setSpan(new android.text.style.ForegroundColorSpan(GOOD), 0, 1, 0);
            torBox.setText(s);
            torBox.setTextColor(FG);
            torBox.setContentDescription("Connected to Tor. Tap to check");
            return;
        } else {
            text = "Tor " + tor.progress + "%";
            color = QUIET;
            torBox.setContentDescription("Connecting to Tor, " + tor.progress + " percent");
        }
        torBox.setText(text);
        torBox.setTextColor(color);
    }

    void torTapped() {
        if (torOff) {
            new AlertDialog.Builder(this).setTitle("Tor isn't in this version")
                .setMessage("This version of VEIL connects directly, not over Tor. Built-in Tor is coming in the next update. You can check this connection on the Tor Project's site.")
                .setPositiveButton("Check connection", (d, w) -> open(TOR_CHECK))
                .setNegativeButton("OK", null).show();
            return;
        }
        if (proxyProblem != null) {
            new AlertDialog.Builder(this).setTitle("Tor is unavailable").setMessage(proxyProblem)
                .setPositiveButton("OK", null).show();
        } else if (tor.error != null) {
            new AlertDialog.Builder(this).setTitle("Tor isn't connected")
                .setMessage(tor.error + "\n\nVEIL won't load pages until Tor is back.")
                .setPositiveButton("Reconnect", (d, w) -> tor.start(this))
                .setNegativeButton("Cancel", null).show();
        } else if (torReady()) {
            open(TOR_CHECK);
        } else {
            Toast.makeText(this, "Connecting to Tor" + (tor.bridges ? " over bridges" : "") + ": " + tor.progress + "% (" + tor.summary + ")", Toast.LENGTH_SHORT).show();
        }
    }

    /** True when the URL may load now. Otherwise it's held until Tor connects (fails closed). */
    boolean torGate(String url) {
        if (torReady()) return true;
        if (proxyProblem != null || tor.error != null) torTapped();
        else Toast.makeText(this, "Connecting to Tor… " + tor.progress + "%. VEIL will open it when Tor is ready.", Toast.LENGTH_SHORT).show();
        return false;
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

    /** Fixed 36dp round button for the toolbar, grey circle when pressed (Chrome style). */
    Button iconButton(String glyph, String description, View.OnClickListener onClick) {
        Button b = toolButton(glyph, description, onClick);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(36), dp(36));
        b.setLayoutParams(lp);
        return b;
    }

    void showMenu(View anchor) {
        android.widget.PopupMenu m = new android.widget.PopupMenu(this, anchor);
        m.getMenu().add(0, 1, 0, "Home");
        m.getMenu().add(0, 3, 2, "New identity");
        m.getMenu().add(0, 4, 3, "Privacy");
        m.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1: web.loadUrl(HUB); return true;
                case 3: confirmNewIdentity(); return true;
                case 4: showPrivacy(); return true;
            }
            return false;
        });
        m.show();
    }

    // ---------------- App side panel ----------------
    // Infinitum apps (:\ARCHITCT\, SCALVS.ai, FABRIC++) open in a panel that slides in
    // from the left over the page, like a chat sidebar. It is its own WebView because
    // those sites refuse to be framed (X-Frame-Options: DENY).

    static final String PANEL_SCHEME = "veil-panel";
    FrameLayout shell;
    View scrim;
    LinearLayout panel;
    WebView panelWeb;
    TextView panelTitle;
    boolean panelOpen = false;
    volatile String panelHost = "";

    View wrapWithPanel(View content) {
        shell = new FrameLayout(this);
        shell.setBackgroundColor(BG);
        shell.addView(content, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        scrim = new View(this);
        scrim.setBackgroundColor(Color.argb(102, 17, 24, 32)); // ink at 40%
        scrim.setVisibility(View.GONE);
        scrim.setOnClickListener(v -> closePanel());
        shell.addView(scrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(BG);
        panel.setClickable(true);
        panel.setFitsSystemWindows(true);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(16), dp(4), dp(4), dp(4));
        panelTitle = new TextView(this);
        panelTitle.setTextColor(FG);
        panelTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        panelTitle.setSingleLine(true);
        panelTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        head.addView(panelTitle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button full = iconButton("↗", "Open in the main window", v -> {
            String u = panelWeb.getUrl();
            closePanel();
            if (u != null && Privacy.isWeb(u)) open(u);
        });
        full.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        head.addView(full);
        Button close = iconButton("✕", "Close panel", v -> closePanel());
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        head.addView(close);
        panel.addView(head);
        panel.addView(rule());

        panelWeb = new WebView(this);
        panelWeb.setBackgroundColor(BG);
        WebSettings s = panelWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // wiped with the main view on New Identity and exit
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setSafeBrowsingEnabled(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(panelWeb, false);
        panelWeb.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (!Privacy.isWeb(url)) return true;
                if (!torReady()) { torGate(url); return true; }
                if (request.isForMainFrame()) panelHost = String.valueOf(request.getUrl().getHost());
                String cleaned = Privacy.clean(url);
                if (!cleaned.equals(url)) { view.loadUrl(cleaned); return true; }
                return false;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!torReady() && isNetwork(request)) return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
                String host = request.getUrl().getHost();
                if (blocking && host != null && Blocklist.isBlocked(host) && Privacy.isThirdParty(host, panelHost)) {
                    return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
        });
        panel.addView(panelWeb, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        int width = Math.min((int) (getResources().getDisplayMetrics().widthPixels * 0.88f), dp(420));
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START);
        shell.addView(panel, plp);
        panel.post(() -> panel.setTranslationX(-panel.getWidth() - dp(2)));
        panel.setVisibility(View.INVISIBLE);
        return shell;
    }

    /** veil-panel://open?u=<https url>&t=<title>, honoured only from VEIL's own start page. */
    boolean handlePanelLink(WebView view, String url) {
        if (!url.startsWith(PANEL_SCHEME + ":")) return false;
        String from = view.getUrl();
        if (from == null || !from.startsWith("file:///android_asset/hub/")) return true;
        Uri u = Uri.parse(url);
        String target = u.getQueryParameter("u");
        String title = u.getQueryParameter("t");
        if (target == null || !target.startsWith("https://")) return true;
        String t = title != null ? title : target;
        if (torReady()) openPanel(target, t);
        else { pendingPanel = new String[]{target, t}; torGate(target); }
        return true;
    }

    void openPanel(String url, String title) {
        panelTitle.setText(title);
        panelHost = String.valueOf(Uri.parse(url).getHost());
        panelWeb.loadUrl(url);
        if (panelOpen) return;
        panelOpen = true;
        hideKeyboard();
        scrim.setAlpha(0f);
        scrim.setVisibility(View.VISIBLE);
        scrim.animate().alpha(1f).setDuration(200).start();
        panel.setVisibility(View.VISIBLE);
        panel.setTranslationX(-panel.getWidth());
        panel.animate().translationX(0).setDuration(220).setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
    }

    void closePanel() {
        if (!panelOpen) return;
        panelOpen = false;
        scrim.animate().alpha(0f).setDuration(180).withEndAction(() -> scrim.setVisibility(View.GONE)).start();
        panel.animate().translationX(-panel.getWidth() - dp(2)).setDuration(200)
            .setInterpolator(new android.view.animation.AccelerateInterpolator())
            .withEndAction(() -> panel.setVisibility(View.INVISIBLE)).start();
    }

    void resetPanel() {
        closePanel();
        panelWeb.loadUrl("about:blank");
        panelWeb.clearCache(true);
        panelWeb.clearHistory();
        panelWeb.clearFormData();
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

        // Chrome-style toolbar: back, forward, reload, the omnibox (grey pill with the
        // white "Anonymous" chip), then the overflow menu.
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(4), dp(6), dp(2), dp(6));
        top.addView(iconButton("‹", "Back", v -> { if (web.canGoBack()) web.goBack(); }));
        top.addView(iconButton("›", "Forward", v -> { if (web.canGoForward()) web.goForward(); }));
        top.addView(iconButton("↻", "Reload", v -> web.reload()));

        LinearLayout omni = new LinearLayout(this);
        omni.setOrientation(LinearLayout.HORIZONTAL);
        omni.setGravity(Gravity.CENTER_VERTICAL);
        omni.setBackground(rounded(OMNI, 0, 20));
        omni.setPadding(dp(5), 0, dp(6), 0);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(0, dp(40), 1f);
        olp.leftMargin = dp(4);
        olp.rightMargin = dp(2);
        omni.setLayoutParams(olp);

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
        address.setHint("Search or type URL");
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
        // Tor box right of the address bar: connection progress, then "● Tor"; tap to check.
        TextView tor = new TextView(this);
        torBox = tor;
        tor.setText("Tor 0%");
        tor.setContentDescription("Connecting to Tor");
        tor.setTextColor(FG);
        tor.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tor.setGravity(Gravity.CENTER);
        tor.setPadding(dp(9), 0, dp(9), 0);
        android.graphics.drawable.StateListDrawable torBg = new android.graphics.drawable.StateListDrawable();
        torBg.addState(new int[]{android.R.attr.state_pressed}, rounded(HOVER, RULE, 4));
        torBg.addState(new int[]{}, rounded(BG, RULE, 4));
        tor.setBackground(torBg);
        tor.setClickable(true);
        tor.setOnClickListener(v -> torTapped());
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(30));
        tlp.leftMargin = dp(4);
        tor.setLayoutParams(tlp);
        top.addView(tor);
        View menuButton = iconButton("⋮", "More options", null);
        menuButton.setOnClickListener(v -> showMenu(menuButton));
        top.addView(menuButton);
        root.addView(top);

        root.addView(rule());

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

        return root;
    }

    void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(address.getWindowToken(), 0);
        address.clearFocus();
    }

    // ---------------- WebView ----------------

    static boolean isNetwork(WebResourceRequest r) {
        String scheme = r.getUrl().getScheme();
        return scheme != null && !scheme.equals("file") && !scheme.equals("data") && !scheme.equals("blob") && !scheme.equals("about");
    }

    /** No WebRTC in any frame of either view (see NO_WEBRTC). */
    static void blockWebRtc(WebView v) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(v, NO_WEBRTC, java.util.Collections.singleton("*"));
        }
    }

    void configureWebView() {
        blockWebRtc(web);
        blockWebRtc(panelWeb);
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
                if (handlePanelLink(view, url)) return true;
                if (url.startsWith("file:///android_asset/")) return false;
                if (request.isForMainFrame()) navHost = String.valueOf(request.getUrl().getHost());
                if (!Privacy.isWeb(url)) {
                    Toast.makeText(MainActivity.this, "VEIL only opens web pages", Toast.LENGTH_SHORT).show();
                    return true;
                }
                if (!torReady()) {
                    if (request.isForMainFrame()) { pendingUrl = url; torGate(url); }
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
                // Fail closed: before Tor is up (or if it stops), nothing reaches the network.
                if (!torReady() && isNetwork(request)) return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
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
            .setNeutralButton("Check Tor", (d, w) -> open(TOR_CHECK)));
    }

    void showAddress(String url) {
        if (url == null || address.hasFocus()) return;
        address.setText(url.startsWith(HUB) ? "" : url);
    }

    void open(String url) {
        if (!torGate(url)) { pendingUrl = url; return; }
        String cleaned = Privacy.clean(url);
        navHost = String.valueOf(Uri.parse(cleaned).getHost());
        if (!cleaned.equals(url) && !Privacy.stripTrackers(url).equals(url)) stripped++;
        web.loadUrl(cleaned);
    }

    // ---------------- Privacy actions ----------------

    void confirmNewIdentity() {
        new AlertDialog.Builder(this)
            .setTitle("New Identity")
            .setMessage("Clear cookies, site storage, cache and history, and switch to new Tor circuits?")
            .setPositiveButton("Clear", (d, w) -> {
                wipe();
                tor.newIdentity();
                web.loadUrl(HUB);
                Toast.makeText(this, "New Identity: everything cleared, new Tor circuits", Toast.LENGTH_SHORT).show();
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
        if (panelWeb != null) resetPanel();
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
            + "• " + (torOff ? "Tor: not in this version (direct connection)" : torReady() ? "Every page goes over Tor (built in)" : "Tor: " + (tor.error != null || proxyProblem != null ? "not connected, pages blocked" : "connecting, " + tor.progress + "%")) + "\n"
            + "• Third-party cookies off\n"
            + "• Nothing kept after you close VEIL\n"
            + "• Screenshots of pages blocked\n\n"
            + PRIVACY_STATEMENT;
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
        if (panelOpen) {
            if (panelWeb.canGoBack()) panelWeb.goBack(); else closePanel();
            return;
        }
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            wipe(); // anonymous by default: nothing survives the session
            tor.setListener(null);
            tor.stop();
        }
        web.destroy();
        super.onDestroy();
    }

    static boolean isBlank(CharSequence s) {
        return TextUtils.isEmpty(s) || s.toString().trim().isEmpty();
    }
}
