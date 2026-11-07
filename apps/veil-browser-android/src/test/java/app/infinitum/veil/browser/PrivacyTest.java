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

        System.out.println(failures == 0 ? "\nall passed" : "\n" + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }
}
