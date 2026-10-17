import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTACT_PLACEHOLDER, redactContactsFromEnv, sanitizeSellerText } from '../src/sanitize.ts';

const REDACT = { redactContacts: true };

/**
 * Two tables, and both halves matter. A phone pattern that is too wide eats the year and the
 * mileage out of a dealer's spec line; one that is too narrow hands a salesperson's mobile to
 * a caller. Every change to the pattern belongs in both lists.
 */
const KEPT: { name: string; text: string }[] = [
  {
    name: 'a spec line whose figures are joined by dashes',
    text: 'Cena 248 000 PLN - 2017 - 117 804 km',
  },
  {
    name: 'an offer number quoted in prose',
    text: 'Numer oferty 123456789 w naszym systemie',
  },
  {
    name: 'engine, mileage, model year and door count',
    text: 'Silnik 2.0 TDI 150 000 km (2015) 5 drzwi',
  },
  {
    name: 'a net price down to the grosz',
    text: 'Faktura VAT 23% cena 125 000 zl netto 101 626.02',
  },
  {
    name: 'the figures from the real listing',
    text: '4969 ccm (464 KM / 341 kW), 75 100 km, rocznik 2020-2026',
  },
  {
    name: 'mileage directly followed by a model year',
    text: 'Przebieg 150 000 2017 r.',
  },
  {
    name: 'comparisons written with angle brackets',
    text: 'cena < 50000 zl, przebieg > 100000 km, stan dobry',
  },
];

const REDACTED: { name: string; text: string; expected: string }[] = [
  {
    name: 'a mobile in groups of three',
    text: '601 234 567',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a mobile with the country code',
    text: '+48 601 234 567',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a mobile with no separators behind the country code',
    text: '+48601234567',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a landline in 2-3-2-2 groups',
    text: '22 123 45 67',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a mobile written with dashes',
    text: '601-234-567',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'an area code in parentheses',
    text: '(22) 123 45 67',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a contiguous block the seller labels a phone',
    text: 'Tel. 601234567',
    expected: `Tel. ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'two numbers in one sentence',
    text: 'Kontakt: tel. 601 234 567 lub 22 123 45 67',
    expected: `Kontakt: tel. ${CONTACT_PLACEHOLDER} lub ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'an e-mail address',
    text: 'Kontakt: jan.kowalski@dealer.pl, tel. +48 601 234 567',
    expected: `Kontakt: ${CONTACT_PLACEHOLDER}, tel. ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'a dealer signature block shaped like the ones real listings end with',
    text:
      'Jan Nowak\nMobile: <span id="hiddenPhoneNumber" phoneNumber="AbCdEf==.1.XyZ=="></span>\n' +
      'Mail: jan.nowak@example.com',
    expected: `Jan Nowak\nMobile:\nMail: ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'a labelled number written with dots',
    text: 'Tel. 601.234.567',
    expected: `Tel. ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'a labelled number written with slashes',
    text: 'tel: 601/234/567',
    expected: `tel: ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'a labelled number in a grouping no Polish number uses',
    text: 'Telefon: 601 234 56 7',
    expected: `Telefon: ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'a mobile whose groups are joined by &nbsp; entities, as found in a live ad',
    text: 'Kontakt: +48&nbsp;601&nbsp;234&nbsp;567',
    expected: `Kontakt: ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'a mobile joined by numeric character references',
    text: '601&#160;234&#xA0;567',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a mobile joined by no-break space characters',
    text: '601\u00a0234\u00a0567',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a mobile joined by narrow no-break spaces',
    text: '601\u202f234\u202f567',
    expected: CONTACT_PLACEHOLDER,
  },
  {
    name: 'a labelled number behind a no-break space',
    text: 'tel.\u00a0601234567',
    expected: `tel. ${CONTACT_PLACEHOLDER}`,
  },
  {
    name: 'an e-mail with an encoded at sign',
    text: 'biuro&#64;example.pl',
    expected: CONTACT_PLACEHOLDER,
  },
];

for (const kept of KEPT) {
  test(`keeps ${kept.name}, with redaction on`, () => {
    assert.equal(sanitizeSellerText(kept.text, REDACT), kept.text);
  });
}

for (const redacted of REDACTED) {
  test(`redacts ${redacted.name}, with redaction on`, () => {
    assert.equal(sanitizeSellerText(redacted.text, REDACT), redacted.expected);
  });
  test(`passes ${redacted.name} through by default`, () => {
    assert.doesNotMatch(sanitizeSellerText(redacted.text) ?? '', /contact details removed/);
  });
}

test('by default a number the seller wrote is passed through, as plain text', () => {
  assert.equal(
    sanitizeSellerText('Kontakt: +48&nbsp;601&nbsp;234&nbsp;567 lub <b>biuro@example.pl</b>'),
    'Kontakt: +48 601 234 567 lub biuro@example.pl',
  );
});

test('OTOMOTO_MCP_REDACT_CONTACTS turns redaction on, off, or stops on a typo', () => {
  for (const on of ['1', 'true', 'YES', ' on ']) {
    assert.equal(redactContactsFromEnv({ OTOMOTO_MCP_REDACT_CONTACTS: on }), true, on);
  }
  for (const off of ['', '0', 'false', 'No', 'off']) {
    assert.equal(redactContactsFromEnv({ OTOMOTO_MCP_REDACT_CONTACTS: off }), false, off);
  }
  assert.equal(redactContactsFromEnv({}), false, 'unset is off');
  assert.throws(() => redactContactsFromEnv({ OTOMOTO_MCP_REDACT_CONTACTS: 'ture' }), /got "ture"/);
});

test('strips HTML tags and the phone token markup Otomoto embeds', () => {
  // The token is Otomoto's encrypted markup, not something the seller typed: always dropped.
  const text = sanitizeSellerText(
    'Mobile: <span id="hiddenPhoneNumber" phoneNumber="AbCdEf==.1.XyZ=="></span> zapraszamy',
  );
  assert.equal(text, 'Mobile: zapraszamy');
});

test('entities in prose are decoded rather than passed through', () => {
  assert.equal(
    sanitizeSellerText('Cena&nbsp;248&nbsp;000&nbsp;zł &amp; FV&nbsp;23% &ndash; okazja'),
    'Cena 248 000 zł & FV 23% – okazja',
  );
});

test('an entity it does not know, or one that is not an entity, is left as written', () => {
  assert.equal(sanitizeSellerText('R&D &copy; A&B &#0; x'), 'R&D &copy; A&B &#0; x');
});

test('empty and non-string input is null, not an empty string', () => {
  assert.equal(sanitizeSellerText(''), null);
  assert.equal(sanitizeSellerText(undefined), null);
  assert.equal(sanitizeSellerText('   '), null);
});
