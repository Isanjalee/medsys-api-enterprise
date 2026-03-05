import { buildApp } from "./app.js";

const start = async () => {
  const app = await buildApp();
  await app.listen({
    host: app.env.HOST,
    port: app.env.PORT
  });
};

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
