export abstract class BasicProvider {
  url: string;

  protected apikey: string;

  constructor(url: string, apikey: string) {
    this.url = url;
    // TODO: secure storage
    this.apikey = apikey;
  }

  protected async _fetcher<T>(
    path: `/${string}`,
    init: RequestInit & { timeout?: number } = {},
  ): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apikey}`,
      },
    });

    return response.json() as Promise<T>;
  }
}
