import { defineApp } from "convex/server";
import auditSink from "./auditSink/convex.config";

const app = defineApp();
app.use(auditSink);
export default app;
