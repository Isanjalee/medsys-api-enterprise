import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";

test("health endpoint", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/healthz"
  });

  assert.equal(response.statusCode, 200);
  await app.close();
});

test("auth status endpoint returns bootstrap metadata", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/status"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as { bootstrapping: unknown; users: unknown };
  assert.equal(typeof body.bootstrapping, "boolean");
  assert.equal(typeof body.users, "number");
  await app.close();
});

test("auth me endpoint requires authentication", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/me"
  });

  assert.equal(response.statusCode, 401);
  await app.close();
});

test("patient history flow and soft delete work for owner", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "owner@medsys.local",
      password: "ChangeMe123!",
      organizationId: ORGANIZATION_ID
    }
  });

  assert.equal(loginResponse.statusCode, 200);
  const loginBody = loginResponse.json() as { accessToken: string };
  assert.equal(typeof loginBody.accessToken, "string");

  const uniqueSuffix = Date.now().toString();
  const createPatientResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      firstName: `History${uniqueSuffix}`,
      lastName: "Patient",
      gender: "other",
      phone: "+94770000000",
      address: "Contract Alignment Test"
    }
  });

  assert.equal(createPatientResponse.statusCode, 201);
  const createdPatient = createPatientResponse.json() as { id: number };
  assert.equal(typeof createdPatient.id, "number");

  const createHistoryResponse = await app.inject({
    method: "POST",
    url: `/v1/patients/${createdPatient.id}/history`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      note: "Observed for 24 hours"
    }
  });

  assert.equal(createHistoryResponse.statusCode, 201);
  const createdHistory = createHistoryResponse.json() as {
    id: number;
    patientId: number;
    note: string;
    createdByUserId: number;
  };
  assert.equal(createdHistory.patientId, createdPatient.id);
  assert.equal(createdHistory.note, "Observed for 24 hours");
  assert.equal(typeof createdHistory.createdByUserId, "number");

  const listHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createdPatient.id}/history`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(listHistoryResponse.statusCode, 200);
  const historyBody = listHistoryResponse.json() as {
    history: Array<{
      id: number;
      note: string;
      created_by_user_id: number;
      created_by_name: string;
      created_by_role: string;
    }>;
  };
  assert.equal(historyBody.history.length > 0, true);
  assert.equal(historyBody.history[0]?.id, createdHistory.id);
  assert.equal(historyBody.history[0]?.note, "Observed for 24 hours");
  assert.equal(historyBody.history[0]?.created_by_role, "owner");

  const deletePatientResponse = await app.inject({
    method: "DELETE",
    url: `/v1/patients/${createdPatient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(deletePatientResponse.statusCode, 200);
  assert.deepEqual(deletePatientResponse.json(), { success: true });

  const getDeletedPatientResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createdPatient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(getDeletedPatientResponse.statusCode, 404);
  await app.close();
});

test("owner can register and list users after bootstrap", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "owner@medsys.local",
      password: "ChangeMe123!",
      organizationId: ORGANIZATION_ID
    }
  });

  assert.equal(loginResponse.statusCode, 200);
  const loginBody = loginResponse.json() as { accessToken: string };

  const uniqueSuffix = Date.now().toString();
  const registerResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      firstName: "Contract",
      lastName: `User${uniqueSuffix}`,
      email: `contract-user-${uniqueSuffix}@medsys.local`,
      password: "strong-pass-123",
      role: "doctor"
    }
  });

  assert.equal(registerResponse.statusCode, 201);
  const registerBody = registerResponse.json() as {
    user: { email: string; role: string; name: string };
  };
  assert.equal(registerBody.user.role, "doctor");
  assert.equal(registerBody.user.email, `contract-user-${uniqueSuffix}@medsys.local`);

  const listUsersResponse = await app.inject({
    method: "GET",
    url: "/v1/users?role=doctor",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(listUsersResponse.statusCode, 200);
  const listUsersBody = listUsersResponse.json() as {
    users: Array<{ email: string }>;
  };
  assert.equal(
    listUsersBody.users.some((user) => user.email === `contract-user-${uniqueSuffix}@medsys.local`),
    true
  );
  await app.close();
});
