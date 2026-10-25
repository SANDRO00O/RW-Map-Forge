import { handleApiRequest } from "../src/worker.js";

export async function onRequest(context) {
  const pathname = new URL(context.request.url).pathname;

  // Keep the static site on Pages' asset-serving path; only API routes use Functions.
  if (!pathname.startsWith("/api/")) return context.next();

  const response = await handleApiRequest(context.request, context);
  return response ?? context.next();
}
