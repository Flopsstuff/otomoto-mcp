/**
 * The normalised shapes the tools return. Search pages and listing pages disagree about
 * almost everything (integer vs string price, flat `parameters[]` vs `parametersDict`), and
 * the point of this module is that none of that asymmetry is visible past the parsers.
 *
 * Machine codes are the keys; Polish display labels ride along only where they are the sole
 * human-readable form, because nothing else translates `brown-beige` or a Polish free-text
 * description.
 */

/** Price in whole PLN, or null when Otomoto has no usable price (it publishes 0 for some ads). */
export type PricePln = number | null;

export interface Location {
  city: string | null;
  region: string | null;
}

/** One row of a search result page. */
export interface Listing {
  /** Numeric advert id. Not the base62 id in the URL - see listing-id.ts. */
  id: string;
  url: string;
  title: string;
  /** Seller's one-line teaser, Polish free text. */
  shortDescription: string | null;
  /** Otomoto make and model slugs, e.g. `bmw`, `seria-3` - the same codes the filters take. */
  make: string | null;
  model: string | null;
  price: PricePln;
  currency: string | null;
  /**
   * Otomoto's own verdict on the price against comparable listings: `BELOW`, `IN` or `ABOVE`
   * the average. Null when Otomoto gives none (`NONE`), which is common.
   */
  priceEvaluation: string | null;
  year: number | null;
  mileageKm: number | null;
  /** Machine code, e.g. `petrol`. Use otomoto_filter_options for the vocabulary. */
  fuelType: string | null;
  fuelTypeLabel: string | null;
  gearbox: string | null;
  gearboxLabel: string | null;
  enginePowerHp: number | null;
  engineCapacityCm3: number | null;
  /** Otomoto's trim/variant code, e.g. `ver-500-bespoke`. Often absent. */
  version: string | null;
  versionLabel: string | null;
  /** Old vehicle registration codes, not ISO: `d` is Germany, `cdn` Canada. */
  countryOrigin: string | null;
  countryOriginLabel: string | null;
  location: Location;
  seller: ListingSeller;
  createdAt: string | null;
}

/** Who published a search row. */
export interface ListingSeller {
  /** Otomoto's seller id: the same on every ad one seller publishes, private or dealer. */
  id: string | null;
  /** `PRIVATE` or `PROFESSIONAL`, the codes otomoto_listing reports too. */
  type: string | null;
  professional: boolean;
  /** Dealer display name. Otomoto publishes none for private sellers. */
  name: string | null;
  /** The dealer's storefront on Otomoto. */
  pageUrl: string | null;
}

export interface ListingSellerSummary {
  /** `PRIVATE` or `PROFESSIONAL` as Otomoto reports it. */
  type: string | null;
  /** Dealer or seller display name as published on the listing. */
  name: string | null;
  professional: boolean;
}

export interface ListingParameter {
  key: string;
  /** Otomoto's own label for the parameter; frequently just the key again. */
  label: string;
  /** Machine code. Boolean-ish parameters use `1`/`0`. */
  value: string;
  /** Polish display form, e.g. `75 100 km`. */
  valueLabel: string;
}

export interface EquipmentGroup {
  key: string;
  /** Polish group label, e.g. `Audio i multimedia`. */
  label: string;
  items: { key: string; label: string }[];
}

export interface PriceDrop {
  percentage: number | null;
  lowestPricePln: PricePln;
}

/** A full listing page. */
export interface ListingDetail {
  id: string;
  url: string;
  title: string;
  /** `ACTIVE` on a live ad. */
  status: string | null;
  price: PricePln;
  currency: string | null;
  priceLabels: string[];
  createdAt: string | null;
  /** When the ad was first published, as opposed to last re-listed. */
  originalCreatedAt: string | null;
  updatedAt: string | null;
  /** Polish free text written by the seller. */
  description: string | null;
  /**
   * Every spec and every equipment flag Otomoto publishes for the ad, keyed by machine code.
   * Encrypted tokens (VIN, registration date) are dropped rather than passed through.
   */
  parameters: Record<string, ListingParameter>;
  equipment: EquipmentGroup[];
  photoUrls: string[];
  seller: ListingSellerSummary;
  priceDrop: PriceDrop | null;
  verifiedCar: boolean;
}

/** One enum value, or several meaning any of them. */
export type EnumValue = string | string[];

export interface SearchFilters {
  /** Path segment. Must be one of Otomoto's make slugs; a wrong one returns zero rows silently. */
  make?: string;
  /** Path segment, only valid together with `make`. */
  model?: string;
  priceFrom?: number;
  priceTo?: number;
  yearFrom?: number;
  yearTo?: number;
  mileageFrom?: number;
  mileageTo?: number;
  enginePowerFrom?: number;
  enginePowerTo?: number;
  engineCapacityFrom?: number;
  engineCapacityTo?: number;
  fuelType?: EnumValue;
  gearbox?: EnumValue;
  bodyType?: EnumValue;
  countryOrigin?: EnumValue;
  /** `new` or `used`. */
  condition?: EnumValue;
  /** `private` or `business`. */
  sellerType?: EnumValue;
  /** Any other enum filter from otomoto_filter_options, keyed by its short name. */
  enums?: Record<string, EnumValue>;
  /** Polish place name or Otomoto slug (`Kraków`, `krakow`). Path segment; pairs with `radiusKm`. */
  city?: string;
  /** Otomoto's internal city id (Warszawa is 17871); pairs with `radiusKm`. */
  cityId?: number;
  radiusKm?: number;
  /** A sort id from otomoto_filter_options, e.g. `filter_float_price:asc`. */
  sort?: string;
}

/** What Otomoto says it actually applied - the antidote to a silently dropped filter. */
export interface AppliedFilter {
  name: string;
  value: string;
  labels: string[];
}

export interface AdministrativeLevel {
  /** Otomoto's id at this level; a city id is what `search[city_id]` takes. */
  id: number;
  name: string;
  slug: string;
}

/**
 * The place Otomoto actually searched around. Place names repeat - there are dozens of
 * `Nowa Wieś` - and Otomoto picks one without saying so, so the powiat and voivodeship are the
 * only way to tell which.
 */
export interface AppliedLocation {
  city: AdministrativeLevel | null;
  /** Powiat. */
  subregion: AdministrativeLevel | null;
  /** Voivodeship. */
  region: AdministrativeLevel | null;
}

export interface SearchResult {
  listings: Listing[];
  /** Total matches Otomoto reports for the query, across all pages. */
  totalCount: number | null;
  page: number;
  pageSize: number;
  hasMorePages: boolean;
  /** The URL that was requested. */
  requestedUrl: string;
  /** The URL after redirects: `/osobowe/audi/a4` arrives as `/osobowe/audi/a4-avant`. */
  resolvedUrl: string;
  appliedFilters: AppliedFilter[];
  /** Null when the query named no place, or when Otomoto did not recognise the one it named. */
  appliedLocation: AppliedLocation | null;
  /** True when Otomoto widened the query itself because the exact one was too narrow. */
  relaxationApplied: boolean;
}
