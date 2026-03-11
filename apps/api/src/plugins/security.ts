import fp from "fastify-plugin";
import { assertOrThrow } from "../lib/http-error.js";
import { SecurityService } from "../lib/security-service.js";

const securityPlugin = fp(async (app) => {
  const securityService = new SecurityService(app.env);
  await securityService.connect();

  app.decorate("securityService", securityService);
  app.decorate("enforceSensitiveRateLimit", (action) => {
    return async (request: any, reply: any) => {
      assertOrThrow(request.actor, 401, "Unauthorized");
      const allowed = await securityService.consumeSensitiveAction(
        action,
        request.actor.role,
        `${request.actor.organizationId}:${request.actor.userId}`
      );
      if (!allowed) {
        reply.header("Retry-After", String(app.env.SECURITY_SENSITIVE_WINDOW_SECONDS));
      }
      assertOrThrow(allowed, 429, "Sensitive action rate limit exceeded");
    };
  });

  app.addHook("onClose", async () => {
    await securityService.close();
  });
});

export default securityPlugin;
