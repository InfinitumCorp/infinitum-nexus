/**
 * Where VEILBot starts: reference, news, science, software and privacy sites, in several
 * languages. Links from these pages lead to the rest. robots.txt still decides what is
 * crawled on each. Wikipedia is not crawled: VEIL answers from its search API instead, and
 * Wikimedia asks bots to use its dumps and APIs.
 */
export const SEEDS = [
  "https://www.eff.org/",
  "https://www.torproject.org/",
  "https://www.privacyguides.org/en/",
  "https://www.mozilla.org/en-US/",
  "https://developer.mozilla.org/en-US/",
  "https://www.w3.org/",
  "https://www.gnu.org/",
  "https://www.kernel.org/",
  "https://www.debian.org/",
  "https://www.python.org/",
  "https://nodejs.org/en",
  "https://www.rust-lang.org/",
  "https://go.dev/",
  "https://www.postgresql.org/",
  "https://www.sqlite.org/index.html",
  "https://www.apache.org/",
  "https://www.nasa.gov/",
  "https://www.noaa.gov/",
  "https://www.who.int/",
  "https://www.un.org/en/",
  "https://www.europa.eu/",
  "https://www.bbc.com/news",
  "https://apnews.com/",
  "https://www.npr.org/",
  "https://www.theguardian.com/international",
  "https://www.dw.com/en/",
  "https://www.france24.com/en/",
  "https://www.nature.com/",
  "https://arxiv.org/",
  "https://www.khanacademy.org/",
  "https://ocw.mit.edu/",
  "https://www.openstreetmap.org/about",
  "https://archive.org/",
  "https://www.gutenberg.org/",
  "https://www.wikihow.com/Main-Page",
  "https://stackoverflow.com/questions",
  "https://news.ycombinator.com/",
  "https://lobste.rs/",
  "https://habr.com/ru/",
  "https://www.spiegel.de/",
  "https://www.lemonde.fr/",
  "https://elpais.com/",
];

/** Hosts VEILBot never crawls. */
export const NEVER = [
  /(^|\.)wikipedia\.org$/, /(^|\.)wikimedia\.org$/, /(^|\.)wikidata\.org$/,
  /(^|\.)google\.[a-z.]+$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)yandex\.[a-z.]+$/,
  /(^|\.)facebook\.com$/, /(^|\.)instagram\.com$/, /(^|\.)linkedin\.com$/,
  /(^|\.)x\.com$/, /(^|\.)twitter\.com$/, /(^|\.)tiktok\.com$/,
  /(^|\.)infinitumveil\.app$/,
];

export function neverCrawl(host) {
  return NEVER.some((re) => re.test(host));
}
