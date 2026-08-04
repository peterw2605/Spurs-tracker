// Minimal RSS/Atom reader. Deliberately dependency-free: the only thing we need
// out of these feeds is a flat list of {title, link, publishedAt, outlet}, and a
// full XML parser is a lot of surface area for that.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#039': "'",
  '#8217': '’',
  '#8216': '‘',
  '#8220': '“',
  '#8221': '”',
  '#8211': '–',
  '#8212': '—',
  '#163': '£',
  '#8364': '€',
};

export function decodeEntities(input) {
  if (!input) return '';
  let out = input;
  // Feeds are frequently double-encoded (&amp;#039;), so run twice.
  for (let pass = 0; pass < 2; pass += 1) {
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
      if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code < 0x10ffff) {
          return String.fromCodePoint(code);
        }
      }
      return match;
    });
  }
  return out;
}

function stripCdata(value) {
  const trimmed = value.trim();
  const match = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

function tagValue(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const match = re.exec(block);
  if (!match) return '';
  return decodeEntities(stripCdata(match[1])).replace(/\s+/g, ' ').trim();
}

function linkValue(block) {
  const plain = tagValue(block, 'link');
  if (plain) return plain;
  // Atom puts the URL in an attribute instead of the element body.
  const href = /<link[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
  return href ? decodeEntities(href[1]) : '';
}

function parseDate(block) {
  for (const tag of ['pubDate', 'published', 'updated', 'dc:date']) {
    const raw = tagValue(block, tag);
    if (!raw) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Google News titles arrive as "Headline text - Outlet Name". Splitting on the
 * final " - " recovers the publisher, which is what the reliability tiers key on.
 */
export function splitTitleOutlet(title) {
  const idx = title.lastIndexOf(' - ');
  if (idx === -1 || idx < 12) return { headline: title, outlet: null };
  const outlet = title.slice(idx + 3).trim();
  // Outlet names are short; a long tail is almost certainly part of the headline.
  if (!outlet || outlet.length > 40 || outlet.includes('  ')) {
    return { headline: title, outlet: null };
  }
  return { headline: title.slice(0, idx).trim(), outlet };
}

export function parseFeed(xml) {
  if (!xml) return [];
  const items = [];
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const rawTitle = tagValue(block, 'title');
    if (!rawTitle) continue;
    items.push({
      rawTitle,
      link: linkValue(block),
      publishedAt: parseDate(block),
      description: tagValue(block, 'description') || tagValue(block, 'summary'),
    });
  }
  return items;
}

export async function fetchText(url, { timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Guardian, football.london and Standard all 403 a non-browser
        // user-agent, so send a conventional one.
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'application/rss+xml, application/xml, text/xml, text/html, */*',
        'accept-language': 'en-GB,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
