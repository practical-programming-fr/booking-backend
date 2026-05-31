import { Hono } from "hono";
import { buildApp } from "./src/app.js";

const app: Hono = buildApp();

export default app;
