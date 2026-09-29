/** Offline MLX transport fixture. POST handlers never receive probe GETs. */
export function withMlxResident(handler: typeof fetch, model: string): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/health')) return Response.json({ loaded_model: model });
    if (url.endsWith('/metrics')) return Response.json({ summary: { in_flight: 0 } });
    return handler(input, init);
  };
}
