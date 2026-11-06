import { AzdoError } from "./errors.js";

export interface ClientOptions {
  pat: string;
  maxCallsPerMinute: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_RETRIES = 3;
const MAX_RATE_WAIT_MS = 30_000;

export class AzdoClient {
  private readonly auth: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly calls: number[] = [];
  /** HTTP status codes seen since the last takeStatuses(), for the audit log. */
  private statuses: number[] = [];

  constructor(private readonly o: ClientOptions) {
    this.auth = "Basic " + Buffer.from(":" + o.pat).toString("base64");
    this.fetchFn = o.fetchFn ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  takeStatuses(): number[] {
    const s = this.statuses;
    this.statuses = [];
    return s;
  }

  private async waitForSlot(): Promise<void> {
    const start = this.now();
    for (;;) {
      const t = this.now();
      while (this.calls.length && t - this.calls[0] >= 60_000) this.calls.shift();
      if (this.calls.length < this.o.maxCallsPerMinute) {
        this.calls.push(t);
        return;
      }
      const wait = 60_000 - (t - this.calls[0]);
      if (t - start + wait > MAX_RATE_WAIT_MS) throw new AzdoError("rate_limited");
      await this.sleep(wait);
    }
  }

  /** GET a JSON document. Errors carry fixed messages only. */
  async getJson<T = any>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForSlot();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { Authorization: this.auth, Accept: "application/json" },
          redirect: "manual",
        });
      } catch {
        if (attempt < MAX_RETRIES) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new AzdoError("upstream_error", "network");
      }
      this.statuses.push(res.status);

      if (res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400)) {
        throw new AzdoError("auth_failed");
      }
      if (res.status === 403) throw new AzdoError("forbidden");
      if (res.status === 404) throw new AzdoError("not_found");
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const ra = Number(res.headers.get("retry-after"));
          await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : 500 * 2 ** attempt);
          continue;
        }
        throw res.status === 429 ? new AzdoError("rate_limited") : new AzdoError("upstream_error", String(res.status));
      }
      if (!res.ok) throw new AzdoError("upstream_error", String(res.status));

      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("json")) throw new AzdoError("auth_failed"); // sign-in page served with 200
      return (await res.json()) as T;
    }
  }
}
