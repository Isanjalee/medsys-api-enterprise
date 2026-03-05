import fp from "fastify-plugin";
import { loadEnv } from "@medsys/config";

const environmentPlugin = fp(async (app) => {
  app.decorate("env", loadEnv());
});

export default environmentPlugin;
