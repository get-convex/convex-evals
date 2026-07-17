import { defineApp } from "convex/server";
import jobRunner from "./jobRunner/convex.config";

const app = defineApp();
app.use(jobRunner);
export default app;
