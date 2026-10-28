export abstract class BasicProvider {
  url: string;

  protected apikey: string;

  constructor(url: string, apikey: string) {
    this.url = url;
    // TODO: secure storage
    this.apikey = apikey;
  }

  // Sobrecarga 1: Cuando stream es true, retorna Promise<Response>
  protected async _fetcher<T = any>(
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

  protected async _fetcher<T>(
    path: `/${string}`,
    init: RequestInit & { timeout?: number } = {},
    stream: boolean = false,
  ): Promise<T | Response> {
    const response = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apikey}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) throw new Error(await response.clone().text());

    if (stream) return response;
    return response.json() as Promise<T>;
  }
}
