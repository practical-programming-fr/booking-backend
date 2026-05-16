// Vercel Function entry. The vercel.json rewrite sends all paths here.
import { buildApp } from "../src/app.js";

const app = buildApp();

export default async function handler(request: Request): Promise<Response> {
  return app.fetch(request);
}

export const config = {
  runtime: "nodejs",
};
