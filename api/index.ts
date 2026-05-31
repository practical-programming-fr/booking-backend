import { handle } from "@hono/node-server/vercel";
import { buildApp } from "../src/app.js";

export default handle(buildApp());
