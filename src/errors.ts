/**
 * Thrown when a page loaded fine but its internal structure is not what we parse.
 *
 * This exists so that Otomoto changing their Next.js payload can never be mistaken for
 * "your search had no matches" - the two are indistinguishable from the caller's side
 * unless the parser refuses to return an empty result on a shape it does not recognise.
 */
export class ParserContractError extends Error {
  readonly url: string | undefined;
  readonly detail: string;

  constructor(detail: string, url?: string) {
    super(
      `Otomoto page structure not recognised: ${detail}. ` +
        `This usually means Otomoto changed their page format and otomoto-mcp needs an update` +
        (url ? ` (url: ${url})` : ''),
    );
    this.name = 'ParserContractError';
    this.detail = detail;
    this.url = url;
  }
}

/** Thrown when the HTTP layer cannot get a usable response. */
export class FetchError extends Error {
  readonly status: number | undefined;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

/** Thrown when caller-supplied tool arguments are rejected at the edge. */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * Thrown when Otomoto answered a location search without applying the location. It does that
 * with HTTP 200 and the whole country's results, so the page is discarded rather than returned.
 */
export class UnknownLocationError extends Error {
  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = 'UnknownLocationError';
    this.url = url;
  }
}

/**
 * Thrown when Otomoto answered without applying every value of an enum filter it was sent. It
 * ignores what it does not recognise with HTTP 200, so the page would answer a wider question
 * than the one asked.
 */
export class FilterNotAppliedError extends Error {
  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = 'FilterNotAppliedError';
    this.url = url;
  }
}
