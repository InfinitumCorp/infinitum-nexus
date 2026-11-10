package app.infinitum.veil.browser;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Pure URL rules shared by the browser. No Android types, so it is unit-tested
 * on the JVM. TRACKERS must match apps/veil/lib/privacy.js (checked by the test).
 */
public final class Privacy {
    private Privacy() {}

    public static final Set<String> TRACKERS = new HashSet<>(Arrays.asList(
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
        "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid",
        "igshid", "li_fat_id", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "oly_enc_id",
        "oly_anon_id", "vero_id", "wickedid", "s_cid", "_ga", "_gl"));

    /** VEIL's own results page, bundled with the app: searches never show a search engine's page. */
    public static final String SEARCH = "file:///android_asset/hub/search.html?q=";

    /** Remove tracking parameters. Returns the input unchanged when nothing matched. */
    public static String stripTrackers(String url) {
        int q = url.indexOf('?');
        if (q < 0) return url;
        int hash = url.indexOf('#', q);
        String base = url.substring(0, q);
        String query = hash < 0 ? url.substring(q + 1) : url.substring(q + 1, hash);
        String frag = hash < 0 ? "" : url.substring(hash);
        StringBuilder kept = new StringBuilder();
        boolean changed = false;
        for (String part : query.split("&")) {
            if (part.isEmpty()) continue;
            int eq = part.indexOf('=');
            String key = eq < 0 ? part : part.substring(0, eq);
            if (TRACKERS.contains(key)) { changed = true; continue; }
            if (kept.length() > 0) kept.append('&');
            kept.append(part);
        }
        if (!changed) return url;
        return base + (kept.length() > 0 ? "?" + kept : "") + frag;
    }

    /** Hosts that stay on plain HTTP: onion services and this device. */
    static boolean isLocalOrOnion(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.endsWith(".onion") || h.equals("localhost") || h.equals("127.0.0.1") || h.equals("[::1]");
    }

    /** HTTPS-first: http becomes https except for onion and loopback hosts. */
    public static String httpsFirst(String url) {
        if (!url.regionMatches(true, 0, "http://", 0, 7)) return url;
        try {
            if (isLocalOrOnion(new URI(url).getHost())) return url;
        } catch (Exception e) {
            return url;
        }
        return "https://" + url.substring(7);
    }

    /** Only web pages load inside VEIL. */
    public static boolean isWeb(String url) {
        return url.regionMatches(true, 0, "https://", 0, 8) || url.regionMatches(true, 0, "http://", 0, 7);
    }

    /** Turn what the person typed into a URL: an address, or a private search. */
    public static String fromInput(String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (isWeb(s)) return clean(s);
        boolean looksLikeHost = !s.contains(" ") && s.contains(".") && !s.startsWith(".") && !s.endsWith(".");
        if (looksLikeHost) return clean("https://" + s);
        return SEARCH + URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    /** Registrable-ish site: the last two labels, as the extension compares them. */
    public static String site(String host) {
        if (host == null) return "";
        String[] parts = host.toLowerCase(Locale.ROOT).split("\\.");
        int n = parts.length;
        return n <= 2 ? host.toLowerCase(Locale.ROOT) : parts[n - 2] + "." + parts[n - 1];
    }

    /** A request to another site than the page it belongs to. */
    public static boolean isThirdParty(String host, String pageHost) {
        if (host == null || pageHost == null || pageHost.isEmpty()) return false;
        return !site(host).equals(site(pageHost));
    }

    /** Punycode labels can imitate a familiar name with look-alike letters. */
    public static boolean isLookalike(String host) {
        if (host == null) return false;
        for (String label : host.toLowerCase(Locale.ROOT).split("\\.")) if (label.startsWith("xn--")) return true;
        return false;
    }

    /** A page that loaded over plain HTTP, other than onion services and this device. */
    public static boolean isInsecure(String url) {
        if (url == null || !url.regionMatches(true, 0, "http://", 0, 7)) return false;
        try {
            return !isLocalOrOnion(new URI(url).getHost());
        } catch (Exception e) {
            return false;
        }
    }

    /** Full clean-up applied to every navigation. */
    public static String clean(String url) {
        return httpsFirst(stripTrackers(url));
    }
}
