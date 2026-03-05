import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

const docsPlugin = fp(async (app) => {
  await app.register(swagger, {
    hideUntagged: true,
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "MEDSYS API",
        version: "1.0.0"
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT"
          }
        }
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: "Auth" },
        { name: "Patients" },
        { name: "Families" },
        { name: "Appointments" },
        { name: "Encounters" },
        { name: "Prescriptions" },
        { name: "Inventory" },
        { name: "Analytics" },
        { name: "Audit" }
      ]
    }
  });
  await app.register(swaggerUi, {
    routePrefix: "/api/v1/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      displayOperationId: true
    }
  });
});

export default docsPlugin;
