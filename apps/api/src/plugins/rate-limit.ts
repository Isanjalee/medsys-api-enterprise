import fp from "fastify-plugin";
import fastifyRateLimit from "@fastify/rate-limit";

const rateLimitPlugin = fp(async (app) => {
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      if (request.actor) {
        return `${request.actor.organizationId}:${request.actor.userId}`;
      }
      return request.ip;
    }
  });
});

export default rateLimitPlugin;
