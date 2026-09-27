export function onRequest(context: { next: () => Promise<Response> }): Promise<Response> {
  return context.next();
}
