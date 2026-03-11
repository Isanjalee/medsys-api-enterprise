import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";

const loginAs = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string
): Promise<{ accessToken: string }> => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email,
      password: "ChangeMe123!",
      organizationId: ORGANIZATION_ID
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { accessToken: string };
};

test("seed data exposes the three baseline users and core sample records", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
    const owner = await loginAs(app, "owner@medsys.local");
    const doctor = await loginAs(app, "doctor@medsys.local");
    const assistant = await loginAs(app, "assistant@medsys.local");

    assert.equal(typeof owner.accessToken, "string");
    assert.equal(typeof doctor.accessToken, "string");
    assert.equal(typeof assistant.accessToken, "string");

    const usersResponse = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });
    assert.equal(usersResponse.statusCode, 200);
    const users = (usersResponse.json() as { users: Array<{ email: string; role: string }> }).users;
    assert.equal(users.some((user) => user.email === "owner@medsys.local" && user.role === "owner"), true);
    assert.equal(users.some((user) => user.email === "doctor@medsys.local" && user.role === "doctor"), true);
    assert.equal(users.some((user) => user.email === "assistant@medsys.local" && user.role === "assistant"), true);

    const patientsResponse = await app.inject({
      method: "GET",
      url: "/v1/patients",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });
    assert.equal(patientsResponse.statusCode, 200);
    const patients = (patientsResponse.json() as { patients: Array<{ id: number }> }).patients;
    assert.equal(patients.length > 0, true);

    const appointmentsResponse = await app.inject({
      method: "GET",
      url: "/v1/appointments",
      headers: {
        authorization: `Bearer ${assistant.accessToken}`
      }
    });
    assert.equal(appointmentsResponse.statusCode, 200);
    const appointments = appointmentsResponse.json() as Array<{ id: number }>;
    assert.equal(appointments.length > 0, true);

    const inventoryResponse = await app.inject({
      method: "GET",
      url: "/v1/inventory",
      headers: {
        authorization: `Bearer ${assistant.accessToken}`
      }
    });
    assert.equal(inventoryResponse.statusCode, 200);
    const inventoryItems = inventoryResponse.json() as Array<{ id: number }>;
    assert.equal(inventoryItems.length > 0, true);

    const analyticsResponse = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });
    assert.equal(analyticsResponse.statusCode, 200);
    const analytics = analyticsResponse.json() as {
      patients: number;
      waitingAppointments: number;
      prescriptions: number;
      lowStockItems: number;
    };
    assert.equal(analytics.patients > 0, true);
    assert.equal(analytics.waitingAppointments >= 0, true);
    assert.equal(analytics.prescriptions >= 0, true);
    assert.equal(analytics.lowStockItems >= 0, true);
  } finally {
    await app.close();
  }
});
