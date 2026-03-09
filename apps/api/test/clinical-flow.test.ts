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

test("auth login rejects unknown fields with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "owner@medsys.local",
      password: "ChangeMe123!",
      organizationId: ORGANIZATION_ID,
      extra: true
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [{ field: "extra", message: "Unknown field." }]
  });
  await app.close();
});

test("patient history flow and soft delete work for owner", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginBody = await loginAs(app, "owner@medsys.local");
  assert.equal(typeof loginBody.accessToken, "string");

  const uniqueSuffix = Date.now().toString();
  const createPatientResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `History${uniqueSuffix} Patient`,
      phone: "+94770000000",
      address: "Contract Alignment Test"
    }
  });

  assert.equal(createPatientResponse.statusCode, 201);
  const createdPatient = createPatientResponse.json() as {
    patient: { id: number; name: string; date_of_birth: string | null; phone: string | null; address: string | null };
  };
  assert.equal(typeof createdPatient.patient.id, "number");
  assert.equal(createdPatient.patient.name, `History${uniqueSuffix} Patient`);

  const createHistoryResponse = await app.inject({
    method: "POST",
    url: `/v1/patients/${createdPatient.patient.id}/history`,
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
  assert.equal(createdHistory.patientId, createdPatient.patient.id);
  assert.equal(createdHistory.note, "Observed for 24 hours");
  assert.equal(typeof createdHistory.createdByUserId, "number");

  const listHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createdPatient.patient.id}/history`,
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
    url: `/v1/patients/${createdPatient.patient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(deletePatientResponse.statusCode, 200);
  assert.deepEqual(deletePatientResponse.json(), { success: true });

  const getDeletedPatientResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createdPatient.patient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(getDeletedPatientResponse.statusCode, 404);
  await app.close();
});

test("patient routes expose frontend-compatible list/detail/update shapes", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginBody = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createPatientResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `Contract ${uniqueSuffix} Patient`,
      dateOfBirth: "1990-06-01",
      phone: "555-2222",
      address: "42 Main Street"
    }
  });

  assert.equal(createPatientResponse.statusCode, 201);
  const createBody = createPatientResponse.json() as {
    patient: {
      id: number;
      name: string;
      date_of_birth: string | null;
      phone: string | null;
      address: string | null;
      created_at: string;
    };
  };
  assert.equal(createBody.patient.name, `Contract ${uniqueSuffix} Patient`);
  assert.equal(createBody.patient.date_of_birth, "1990-06-01");

  const listPatientsResponse = await app.inject({
    method: "GET",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(listPatientsResponse.statusCode, 200);
  const listBody = listPatientsResponse.json() as {
    patients: Array<{ id: number; name: string; date_of_birth: string | null; created_at: string }>;
  };
  assert.equal(Array.isArray(listBody.patients), true);
  assert.equal(listBody.patients.some((patient) => patient.id === createBody.patient.id), true);

  const getPatientResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(getPatientResponse.statusCode, 200);
  const getBody = getPatientResponse.json() as {
    patient: { id: number; name: string; phone: string | null; address: string | null };
    history: unknown[];
  };
  assert.equal(getBody.patient.id, createBody.patient.id);
  assert.equal(getBody.patient.name, `Contract ${uniqueSuffix} Patient`);
  assert.equal(Array.isArray(getBody.history), true);

  const patchPatientResponse = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${createBody.patient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      address: "84 Updated Street"
    }
  });

  assert.equal(patchPatientResponse.statusCode, 200);
  const patchBody = patchPatientResponse.json() as {
    patient: { id: number; address: string | null };
  };
  assert.equal(patchBody.patient.id, createBody.patient.id);
  assert.equal(patchBody.patient.address, "84 Updated Street");

  await app.close();
});

test("owner can register and list users after bootstrap", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginBody = await loginAs(app, "owner@medsys.local");

  const uniqueSuffix = Date.now().toString();
  const registerResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `Contract User${uniqueSuffix}`,
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

test("users create accepts frontend-compatible name payload", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginBody = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const response = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `Frontend User ${uniqueSuffix}`,
      email: `frontend-user-${uniqueSuffix}@medsys.local`,
      password: "strong-pass-123",
      role: "assistant"
    }
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    user: {
      id: (response.json() as { user: { id: number } }).user.id,
      name: `Frontend User ${uniqueSuffix}`,
      email: `frontend-user-${uniqueSuffix}@medsys.local`,
      role: "assistant",
      created_at: (response.json() as { user: { created_at: string } }).user.created_at
    }
  });
  await app.close();
});

test("doctor cannot access users list without user.read permission", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginBody = await loginAs(app, "doctor@medsys.local");

  const response = await app.inject({
    method: "GET",
    url: "/v1/users",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});

test("clinical icd10 endpoint maps provider suggestions", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify([
          2,
          ["A00", "J18.9"],
          null,
          [
            ["A00", "Cholera"],
            ["J18.9", "Pneumonia, unspecified organism"]
          ]
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );

    const response = await app.inject({
      method: "GET",
      url: "/v1/clinical/icd10?terms=chol",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      suggestions: ["A00 - Cholera", "J18.9 - Pneumonia, unspecified organism"]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical icd10 endpoint returns empty suggestions for short terms", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("[]", { status: 200 });
    };

    const response = await app.inject({
      method: "GET",
      url: "/v1/clinical/icd10?terms=a",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { suggestions: [] });
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical icd10 rejects oversized terms with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");
    const response = await app.inject({
      method: "GET",
      url: `/v1/clinical/icd10?terms=${"a".repeat(101)}`,
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: "Validation failed.",
      issues: [{ field: "terms", message: "String must contain at most 100 character(s)." }]
    });
  } finally {
    await app.close();
  }
});

test("patient create rejects unknown fields with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginBody = await loginAs(app, "owner@medsys.local");

  const response = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: "Validation Patient",
      unknownField: "x"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [{ field: "unknownField", message: "Unknown field." }]
  });
  await app.close();
});

test("patient patch rejects empty body with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  const loginBody = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createPatientResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `Empty Patch ${uniqueSuffix}`
    }
  });

  assert.equal(createPatientResponse.statusCode, 201);
  const createBody = createPatientResponse.json() as { patient: { id: number } };

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${createBody.patient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [{ field: "body", message: "At least one field must be provided." }]
  });
  await app.close();
});

test("patient vitals rejects unknown fields with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createPatientResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      name: `Vitals ${uniqueSuffix} Patient`
    }
  });

  assert.equal(createPatientResponse.statusCode, 201);
  const createBody = createPatientResponse.json() as { patient: { id: number } };

  const response = await app.inject({
    method: "POST",
    url: `/v1/patients/${createBody.patient.id}/vitals`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      recordedAt: "2026-03-09T10:15:00Z",
      extra: true
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [{ field: "extra", message: "Unknown field." }]
  });
  await app.close();
});

test("auth me returns authenticated identity shape", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "doctor@medsys.local");

  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    id: number;
    name: string;
    email: string;
    role: string;
    organizationId: string;
  };
  assert.equal(typeof body.id, "number");
  assert.equal(body.email, "doctor@medsys.local");
  assert.equal(body.role, "doctor");
  assert.equal(body.organizationId, ORGANIZATION_ID);
  await app.close();
});

test("users list rejects invalid role filter with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");

  const response = await app.inject({
    method: "GET",
    url: "/v1/users?role=invalid-role",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(response.statusCode, 400);
  const body = response.json() as {
    error: string;
    issues: Array<{ field: string; message: string }>;
  };
  assert.equal(body.error, "Validation failed.");
  assert.equal(body.issues[0]?.field, "role");
  await app.close();
});

test("users create rejects unknown fields with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");

  const response = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: "Bad User",
      email: "bad-user@medsys.local",
      password: "strong-pass-123",
      role: "doctor",
      extra: true
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [{ field: "extra", message: "Unknown field." }]
  });
  await app.close();
});

test("doctor cannot register users after bootstrap", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "doctor@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `Denied User ${uniqueSuffix}`,
      email: `denied-user-${uniqueSuffix}@medsys.local`,
      password: "strong-pass-123",
      role: "assistant"
    }
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});

test("doctor cannot delete patients without patient.delete permission", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createPatientResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      name: `Protected Patient ${uniqueSuffix}`
    }
  });

  assert.equal(createPatientResponse.statusCode, 201);
  const createBody = createPatientResponse.json() as { patient: { id: number } };

  const response = await app.inject({
    method: "DELETE",
    url: `/v1/patients/${createBody.patient.id}`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});

test("doctor cannot access dispense queue without prescription.dispense permission", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "doctor@medsys.local");

  const response = await app.inject({
    method: "GET",
    url: "/v1/prescriptions/queue/pending-dispense",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});
