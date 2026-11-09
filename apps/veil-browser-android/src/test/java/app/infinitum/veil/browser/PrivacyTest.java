package app.infinitum.veil.browser;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Plain-JVM checks (no JUnit download needed). Run by scripts/build.sh test. */
public final class PrivacyTest {
    static int failures = 0;

    static void eq(String name, Object want, Object got) {
        if (want == null ? got == null : want.equals(got)) {
            System.out.println("ok   " + name);
        } else {
            failures++;
            System.out.println("FAIL " + name + "\n     want: " + want + "\n     got:  " + got);
        }
    }

    public static void main(String[] args) throws Exception {
        eq("strips trackers, keeps the rest and the fragment",
            "https://example.com/a?id=1#h", Privacy.stripTrackers("https://example.com/a?utm_source=x&id=1&fbclid=y#h"));
        eq("drops the ? when nothing is left", "https://example.com/a", Privacy.stripTrackers("https://example.com/a?gclid=1"));
        eq("unchanged when clean", "https://example.com/?id=1", Privacy.stripTrackers("https://example.com/?id=1"));
        eq("keeps ref", "https://github.com/o/r?ref=main", Privacy.stripTrackers("https://github.com/o/r?ref=main"));

        eq("http upgrades to https", "https://example.com/", Privacy.httpsFirst("http://example.com/"));
        eq("onion stays http", "http://abc.onion/", Privacy.httpsFirst("http://abc.onion/"));
        eq("localhost stays http", "http://localhost:3000/", Privacy.httpsFirst("http://localhost:3000/"));

        eq("bare host becomes https", "https://example.com", Privacy.fromInput("example.com"));
        eq("words become a private search", "https://duckduckgo.com/?q=tor+browser", Privacy.fromInput("tor browser"));
        eq("typed URL is cleaned", "https://example.com/?a=1", Privacy.fromInput("http://example.com/?a=1&utm_medium=x"));
        eq("empty input", null, Privacy.fromInput("   "));

        eq("javascript is not web", false, Privacy.isWeb("javascript:alert(1)"));
        eq("file is not web", false, Privacy.isWeb("file:///sdcard/x"));
        eq("intent is not web", false, Privacy.isWeb("intent://x#Intent;end"));

        // Same tracker list as the extension.
        Path js = Path.of(args.length > 0 ? args[0] : "../veil/lib/privacy.js");
        String src = Files.readString(js);
        Matcher block = Pattern.compile("TRACKERS = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)").matcher(src);
        if (!block.find()) throw new IllegalStateException("TRACKERS not found in " + js);
        Set<String> fromJs = new HashSet<>();
        Matcher m = Pattern.compile("\"([^\"]+)\"").matcher(block.group(1));
        while (m.find()) fromJs.add(m.group(1));
        eq("tracker list matches apps/veil/lib/privacy.js", fromJs, Privacy.TRACKERS);

        eq("site keeps the last two labels", "example.com", Privacy.site("a.b.Example.com"));
        eq("subdomain is first-party", false, Privacy.isThirdParty("cdn.example.com", "www.example.com"));
        eq("other site is third-party", true, Privacy.isThirdParty("doubleclick.net", "news.example"));
        eq("punycode host is a look-alike", true, Privacy.isLookalike("xn--pple-43d.com"));
        eq("plain host is not a look-alike", false, Privacy.isLookalike("apple.com"));
        eq("plain HTTP is insecure", true, Privacy.isInsecure("http://example.com/"));
        eq("onion HTTP is fine", false, Privacy.isInsecure("http://abc.onion/"));
        eq("HTTPS is fine", false, Privacy.isInsecure("https://example.com/"));
        eq("blocklist matches subdomains", true, Blocklist.isBlocked("stats.g.doubleclick.net"));
        eq("blocklist ignores look-alike suffixes", false, Blocklist.isBlocked("notdoubleclick.net"));
        eq("blocklist leaves first parties", false, Blocklist.isBlocked("facebook.com"));

        // Same blocklist as the extension.
        Path bl = js.resolveSibling("blocklist.js");
        Matcher list = Pattern.compile("BLOCKLIST = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);").matcher(Files.readString(bl));
        if (!list.find()) throw new IllegalStateException("BLOCKLIST not found in " + bl);
        Set<String> blFromJs = new HashSet<>();
        Matcher h = Pattern.compile("\"([^\"]+)\"").matcher(list.group(1));
        while (h.find()) blFromJs.add(h.group(1));
        eq("blocklist matches apps/veil/lib/blocklist.js", blFromJs, new HashSet<>(Blocklist.HOSTS));
        eq("geosite extra adds a host", true, Blocklist.matchesExtra("a.tracker.example", java.util.List.of("tracker.example")));
        eq("geosite extra does not replace the curated list", false, Blocklist.isBlocked("tracker.example"));
        eq("onion is never a geosite bypass", java.util.List.of("direct.example"), Blocklist.bypassHosts(java.util.List.of("hidden.onion", "direct.example")));

        System.out.println(failures == 0 ? "\nall passed" : "\n" + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }
}
