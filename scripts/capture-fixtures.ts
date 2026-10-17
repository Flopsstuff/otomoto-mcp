/**
 * Refreshes the test fixtures from live Otomoto. Run it by hand when a parser test starts
 * failing and you need to see what changed - never from CI, and never in a loop.
 *
 *   node scripts/capture-fixtures.ts
 *
 * Deliberately captures a small result set from a professional dealer listing, so there is no
 * private seller in it. A dealer's ad still names people: salespeople sign the description with
 * their name, work e-mail and phone. E-mail addresses and Otomoto's encrypted phone tokens are
 * replaced here; names cannot be found reliably, so the lines that look like a signature are
 * printed and must be replaced by hand before committing (the current fixtures use Jan Nowak
 * and Adam Kowalski).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { HttpClient } from '../src/http.ts';

const TARGETS = [
  { name: 'search-lexus-lc', url: 'https://www.otomoto.pl/osobowe/lexus/lc' },
  {
    name: 'detail-lexus-lc',
    url: 'https://www.otomoto.pl/osobowe/oferta/lexus-lc-ID6I6SJj.html',
  },
];

const client = new HttpClient({ minDelayMs: 2000 });

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Otomoto's encrypted phone and VIN tokens: base64, ".1.", base64. */
const TOKEN_RE = /[A-Za-z0-9+/]{20,}={0,2}\.1\.[A-Za-z0-9+/]{10,}={0,2}/g;
const KEEP_EMAILS = new Set(['example.com']);

/** Replaces what can be replaced mechanically and returns the lines a human must still check. */
function anonymize(html: string): { html: string; review: string[] } {
  const emails = new Map<string, string>();
  let out = html.replace(EMAIL_RE, (email) => {
    if (KEEP_EMAILS.has(email.split('@')[1]!.toLowerCase())) return email;
    if (!emails.has(email)) emails.set(email, `person${emails.size + 1}@example.com`);
    return emails.get(email)!;
  });
  const tokens = new Map<string, string>();
  out = out.replace(TOKEN_RE, (token) => {
    if (!tokens.has(token)) {
      const n = tokens.size;
      tokens.set(token, `SYNTHETICTOKEN${n}AAAAAAAAAAAAAAAAAAAAAAAA==.1.SYNTHETIC${n}BBBBBBBBBBBBB==`);
    }
    return tokens.get(token)!;
  });
  // The line before "Mobile:" or "Mail:" is where the name usually is, so it is included.
  const review = [...new Set(out.match(/[^<>"]{0,80}(?:Mobile|Mail|Tel\.?|Telefon|Kontakt)\s*:[^\n<>"]{0,40}/gi) ?? [])];
  return { html: out, review };
}

for (const target of TARGETS) {
  const page = await client.fetchPage(target.url);
  const out = fileURLToPath(new URL(`../test/fixtures/${target.name}.html.gz`, import.meta.url));
  const { html, review } = anonymize(page.html);
  writeFileSync(out, gzipSync(Buffer.from(html, 'utf8'), { level: 9 }));
  console.log(`${target.name}: HTTP ${page.status}, ${html.length} bytes -> ${out}`);
  if (review.length > 0) {
    console.log('  CHECK BY HAND before committing - replace any real person named here:');
    for (const line of review) console.log(`    ${line.trim()}`);
  }
  if (page.url !== page.requestedUrl) console.log(`  redirected to ${page.url}`);
}
