export abstract class BasicProvider {
  url: string;

  protected apikey: string;

  constructor(url: string, apikey: string) {
    this.url = url;
    // TODO: secure storage
    this.apikey = apikey;
  }

  protected format(content: string): string {
    return content
      .normalize("NFC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Sobrecarga 1: Cuando stream es true, retorna Promise<Response>
  protected async _fetcher(
    path: `/${string}`,
    init?: RequestInit & { timeout?: number },
    stream?: true,
  ): Promise<Response>;

  // Sobrecarga 2: Cuando stream es false (o por defecto), retorna el JSON parseado Promise<T>
  protected async _fetcher<T>(
    path: `/${string}`,
    init?: RequestInit & { timeout?: number },
    stream?: false,
  ): Promise<T>;

  // Sobrecarga 3: Firma genérica/comodín para cuando se pasa un booleano dinámico (ej. variable let)
  protected async _fetcher<T>(
    path: `/${string}`,
    init?: RequestInit & { timeout?: number },
    stream?: boolean,
  ): Promise<Response | T>;

  // `init.signal` travels to fetch untouched. A rejection caused by it is
  // re-thrown as the signal's own reason, because fetch rejects with a fresh
  // DOMException("AbortError") that says nothing about who cancelled or why.
  // An abort is never retried here: whether to retry belongs to the caller.
  protected async _fetcher<T>(
    path: `/${string}`,
    init: RequestInit & { timeout?: number } = {},
    stream: boolean = false,
  ): Promise<T | Response> {
    let response: Response;

    try {
      response = await fetch(`${this.url}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apikey}`,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      if (init.signal?.aborted) throw init.signal.reason ?? err;
      throw err;
    }

    if (!response.ok) throw new Error(await response.clone().text());

    if (stream) return response;
    return response.json() as Promise<T>;
  }
}
