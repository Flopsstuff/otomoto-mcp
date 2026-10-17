import { ParserContractError } from '../errors.ts';
import { findAdvert, isRecord } from '../nextdata.ts';
import { sanitizeSellerText, type SellerTextOptions } from '../sanitize.ts';
import type {
  EquipmentGroup,
  ListingDetail,
  ListingParameter,
  ListingSellerSummary,
  PriceDrop,
} from '../types.ts';

/**
 * Listing pages are their own shape: no `urqlState`, no flat `parameters[]`, a `parametersDict`
 * map instead, and a price that arrives as a string. This parser therefore shares nothing with
 * the search parser beyond the output type.
 */

/**
 * Otomoto publishes VIN, plate and first-registration date as encrypted tokens rather than
 * values. They are not data, and passing them through would only invite a caller to treat a
 * ciphertext as a VIN.
 */
const ENCRYPTED_KEYS = new Set(['vin', 'registration', 'date_registration']);

/** `<base64>.<n>.<base64>` is the shape of those tokens; the key list is not exhaustive. */
const ENCRYPTED_VALUE_RE = /^[A-Za-z0-9+/=]{16,}\.\d+\.[A-Za-z0-9+/=]{12,}$/;

export function parseListingPage(
  nextData: Record<string, unknown>,
  url?: string,
  textOptions: SellerTextOptions = {},
): ListingDetail {
  const advert = findAdvert(nextData, url);

  const id = advert['id'];
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new ParserContractError('pageProps.advert has no id', url);
  }
  const advertUrl = advert['url'];
  if (typeof advertUrl !== 'string') {
    throw new ParserContractError(`listing ${String(id)} has no url`, url);
  }

  const price = parseDetailPrice(advert['price']);

  return {
    id: String(id),
    url: advertUrl,
    title: typeof advert['title'] === 'string' ? advert['title'] : '',
    status: typeof advert['status'] === 'string' ? advert['status'] : null,
    price: price.amount,
    currency: price.currency,
    priceLabels: price.labels,
    createdAt: typeof advert['createdAt'] === 'string' ? advert['createdAt'] : null,
    originalCreatedAt:
      typeof advert['originalCreatedAt'] === 'string' ? advert['originalCreatedAt'] : null,
    updatedAt: typeof advert['updatedAt'] === 'string' ? advert['updatedAt'] : null,
    description: sanitizeSellerText(advert['description'], textOptions),
    parameters: parseParametersDict(advert['parametersDict'], url),
    equipment: parseEquipment(advert['equipment']),
    photoUrls: parsePhotos(advert['images']),
    seller: parseSeller(advert['seller']),
    priceDrop: parsePriceDrop(advert['priceDrop']),
    verifiedCar: advert['verifiedCar'] === true,
  };
}

/** Listing pages give the price as a string; search pages give an integer. Both land here as PLN. */
function parseDetailPrice(raw: unknown): {
  amount: number | null;
  currency: string | null;
  labels: string[];
} {
  if (!isRecord(raw)) return { amount: null, currency: null, labels: [] };
  const value = Number(raw['value']);
  const currency = raw['currency'];
  const labels = raw['labels'];
  return {
    amount: Number.isFinite(value) && value > 0 ? Math.round(value) : null,
    currency: typeof currency === 'string' ? currency : null,
    labels: Array.isArray(labels)
      ? labels.filter((label): label is string => typeof label === 'string')
      : [],
  };
}

/**
 * `parametersDict` carries both the specs and every equipment flag, as
 * `{key: {label, values: [{value, label}]}}`. Multi-valued parameters are joined rather than
 * dropped, because a dropped value reads like an absent feature.
 */
function parseParametersDict(
  raw: unknown,
  url: string | undefined,
): Record<string, ListingParameter> {
  if (!isRecord(raw)) {
    throw new ParserContractError('pageProps.advert.parametersDict missing', url);
  }
  const out: Record<string, ListingParameter> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (ENCRYPTED_KEYS.has(key) || !isRecord(entry)) continue;
    const values = entry['values'];
    if (!Array.isArray(values)) continue;

    const codes: string[] = [];
    const labels: string[] = [];
    for (const value of values) {
      if (!isRecord(value)) continue;
      const code = value['value'];
      const label = value['label'];
      if (typeof code === 'string') codes.push(code);
      if (typeof label === 'string') labels.push(label);
    }
    if (codes.length === 0) continue;
    if (codes.some((code) => ENCRYPTED_VALUE_RE.test(code))) continue;

    const entryLabel = entry['label'];
    out[key] = {
      key,
      label: typeof entryLabel === 'string' && entryLabel !== '' ? entryLabel : key,
      value: codes.join(','),
      valueLabel: labels.length > 0 ? labels.join(', ') : codes.join(','),
    };
  }
  return out;
}

function parseEquipment(raw: unknown): EquipmentGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: EquipmentGroup[] = [];
  for (const group of raw) {
    if (!isRecord(group)) continue;
    const key = group['key'];
    if (typeof key !== 'string') continue;
    const values = Array.isArray(group['values']) ? group['values'] : [];
    const items: { key: string; label: string }[] = [];
    for (const value of values) {
      if (!isRecord(value)) continue;
      const itemKey = value['key'];
      if (typeof itemKey !== 'string') continue;
      const itemLabel = value['label'];
      items.push({ key: itemKey, label: typeof itemLabel === 'string' ? itemLabel : itemKey });
    }
    const groupLabel = group['label'];
    out.push({ key, label: typeof groupLabel === 'string' ? groupLabel : key, items });
  }
  return out;
}

function parsePhotos(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw['photos'])) return [];
  const out: string[] = [];
  for (const photo of raw['photos']) {
    if (!isRecord(photo)) continue;
    const url = photo['url'];
    if (typeof url === 'string' && url !== '') out.push(url);
  }
  return out;
}

/**
 * Seller identity only. `phoneNumbers` on the page are encrypted tokens rather than numbers,
 * and this server has no business surfacing contact details either way.
 */
function parseSeller(raw: unknown): ListingSellerSummary {
  if (!isRecord(raw)) return { type: null, name: null, professional: false };
  const type = raw['type'];
  const name = raw['name'];
  const typeCode = typeof type === 'string' ? type : null;
  return {
    type: typeCode,
    name: typeof name === 'string' && name !== '' ? name : null,
    professional: typeCode !== null && typeCode.toUpperCase() !== 'PRIVATE',
  };
}

function parsePriceDrop(raw: unknown): PriceDrop | null {
  if (!isRecord(raw)) return null;
  const percentage = raw['percentage'];
  const lowest = raw['lowestPrice'];
  let lowestPricePln: number | null = null;
  if (isRecord(lowest)) {
    // minorAmount is in grosze; the rest of this server speaks whole PLN.
    const minor = Number(lowest['minorAmount']);
    if (Number.isFinite(minor) && minor > 0) lowestPricePln = Math.round(minor / 100);
  }
  return {
    percentage: typeof percentage === 'number' ? percentage : null,
    lowestPricePln,
  };
}
