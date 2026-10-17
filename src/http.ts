import { FetchError } from './errors.ts';

/**
 * Every outbound request in this server goes through fetchPage. It is the only place that
 * talks to the network, so politeness is a property of the architecture rather than of each
 * caller remembering to be careful.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/** A library-default User-Agent gets a flat 403 from Otomoto; a browser UA gets 200. */
export const DEFAULT_MIN_DELAY_MS = 1000;

/** Politeness floor. Configuration can raise the delay but never lower it past this. */
export const MIN_DELAY_FLOOR_MS = 500;

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Search result pages run ~1.5 MB; anything far past that is not a page we asked for. */
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export interface HttpClientOptions {
  userAgent?: string;
  minDelayMs?: number;
  timeoutMs?: number;
}

export interface PageResponse {
  /** The URL after redirects. Otomoto rewrites some model slugs, so callers must see this. */
  url: string;
  requestedUrl: string;
  status: number;
  html: string;
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export class HttpClient {
  readonly userAgent: string;
  readonly minDelayMs: number;
  readonly timeoutMs: number;

  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: HttpClientOptions = {}) {
    this.userAgent =
      options.userAgent ?? process.env['OTOMOTO_MCP_USER_AGENT'] ?? DEFAULT_USER_AGENT;
    const requestedDelay =
      options.minDelayMs ?? readPositiveIntEnv('OTOMOTO_MCP_MIN_DELAY_MS') ?? DEFAULT_MIN_DELAY_MS;
    this.minDelayMs = Math.max(MIN_DELAY_FLOOR_MS, requestedDelay);
    this.timeoutMs =
      options.timeoutMs ?? readPositiveIntEnv('OTOMOTO_MCP_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Requests are serialized through a single promise chain: two concurrent tool calls still
   * produce one request at a time, spaced by minDelayMs.
   */
  async fetchPage(url: string): Promise<PageResponse> {
    const run = this.queue.then(
      () => this.fetchSerialized(url),
      () => this.fetchSerialized(url),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchSerialized(url: string): Promise<PageResponse> {
    await this.waitForSlot();
    try {
      return await this.attempt(url);
    } catch (error) {
      if (error instanceof FetchError && error.status !== undefined && error.status >= 500) {
        await this.waitForSlot();
        return this.attempt(url);
      }
      throw error;
    }
  }

  private async waitForSlot(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    const wait = this.minDelayMs - elapsed;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }

  private async attempt(url: string): Promise<PageResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
        },
      });
    } catch (error) {
      clearTimeout(timer);
      const reason = error instanceof Error ? error.message : String(error);
      throw new FetchError(`Request to Otomoto failed: ${reason}`, url);
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new FetchError(
        `Otomoto returned HTTP ${response.status} for ${url}`,
        url,
        response.status,
      );
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new FetchError(
        `Response too large (${declaredLength} bytes) for ${url}`,
        url,
        response.status,
      );
    }

    const html = await response.text();
    if (html.length > MAX_RESPONSE_BYTES) {
      throw new FetchError(`Response too large (${html.length} bytes) for ${url}`, url, response.status);
    }

    return {
      url: response.url || url,
      requestedUrl: url,
      status: response.status,
      html,
    };
  }
}
