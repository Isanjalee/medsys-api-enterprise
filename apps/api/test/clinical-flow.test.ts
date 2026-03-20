import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";
const DEFAULT_PATIENT_DOB = "1990-06-01";

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

const createPatientAs = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  name: string
): Promise<number> => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: {
      name,
      dateOfBirth: DEFAULT_PATIENT_DOB
    }
  });

  assert.equal(response.statusCode, 201);
  return (response.json() as { patient: { id: number } }).patient.id;
};

const getUserIdByEmail = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  role: "owner" | "doctor" | "assistant",
  email: string
): Promise<number> => {
  const response = await app.inject({
    method: "GET",
    url: `/v1/users?role=${role}`,
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    users: Array<{ id: number; email: string }>;
  };
  const user = body.users.find((row) => row.email === email);
  assert.ok(user);
  return user.id;
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

test("analytics overview returns numeric counters for authorized users", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");

  const response = await app.inject({
    method: "GET",
    url: "/v1/analytics/overview",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "lowStockItems",
    "patients",
    "prescriptions",
    "waitingAppointments"
  ]);
  const body = response.json() as Record<string, unknown>;
  assert.equal(typeof body.patients, "number");
  assert.equal(typeof body.waitingAppointments, "number");
  assert.equal(typeof body.prescriptions, "number");
  assert.equal(typeof body.lowStockItems, "number");
  await app.close();
});

test("analytics cache endpoint exposes cache hit and invalidation counters", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Cache Profile ${Date.now()} Patient`);

  const profileHeaders = {
    authorization: `Bearer ${ownerLogin.accessToken}`
  };

  const firstProfile = await app.inject({
    method: "GET",
    url: `/v1/patients/${patientId}/profile`,
    headers: profileHeaders
  });
  assert.equal(firstProfile.statusCode, 200);

  const secondProfile = await app.inject({
    method: "GET",
    url: `/v1/patients/${patientId}/profile`,
    headers: profileHeaders
  });
  assert.equal(secondProfile.statusCode, 200);

  const updatePatient = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${patientId}`,
    headers: profileHeaders,
    payload: {
      address: "Updated Cache Street"
    }
  });
  assert.equal(updatePatient.statusCode, 200);

  const cacheStatsResponse = await app.inject({
    method: "GET",
    url: "/v1/analytics/cache",
    headers: profileHeaders
  });

  assert.equal(cacheStatsResponse.statusCode, 200);
  const stats = cacheStatsResponse.json() as {
    patientProfile: { hits: number; misses: number; invalidations: number; sets: number };
  };
  assert.equal(stats.patientProfile.misses >= 1, true);
  assert.equal(stats.patientProfile.hits >= 1, true);
  assert.equal(stats.patientProfile.invalidations >= 1, true);
  assert.equal(stats.patientProfile.sets >= 1, true);

  await app.close();
});

test("waiting appointment queue uses cache and invalidates on update", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Queue Cache ${Date.now()} Patient`);

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId,
      scheduledAt: "2026-03-15T09:30:00Z",
      priority: "normal"
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const appointmentId = (createResponse.json() as { id: number }).id;

  const firstQueueResponse = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=waiting",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });
  assert.equal(firstQueueResponse.statusCode, 200);

  const secondQueueResponse = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=waiting",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });
  assert.equal(secondQueueResponse.statusCode, 200);

  const updateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/appointments/${appointmentId}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      status: "completed"
    }
  });
  assert.equal(updateResponse.statusCode, 200);

  const cacheStatsResponse = await app.inject({
    method: "GET",
    url: "/v1/analytics/cache",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });
  assert.equal(cacheStatsResponse.statusCode, 200);
  const stats = cacheStatsResponse.json() as {
    appointmentQueue: { hits: number; misses: number; invalidations: number; sets: number };
  };
  assert.equal(stats.appointmentQueue.misses >= 1, true);
  assert.equal(stats.appointmentQueue.hits >= 1, true);
  assert.equal(stats.appointmentQueue.invalidations >= 1, true);

  const queueAfterUpdate = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=waiting",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(queueAfterUpdate.statusCode, 200);
  const rows = queueAfterUpdate.json() as Array<{ id: number }>;
  assert.equal(rows.some((row) => row.id === appointmentId), false);
  await app.close();
});

test("patient search supports paginated lookup", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  await createPatientAs(app, ownerLogin.accessToken, `Searchable ${uniqueSuffix} Alpha`);
  await createPatientAs(app, ownerLogin.accessToken, `Searchable ${uniqueSuffix} Beta`);

  const firstPage = await app.inject({
    method: "GET",
    url: `/v1/search/patients?q=${encodeURIComponent(uniqueSuffix)}&page=1&limit=1`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(firstPage.statusCode, 200);
  const firstPageBody = firstPage.json() as {
    patients: Array<{ id: number; name: string }>;
    total: number;
    page: number;
    limit: number;
  };
  assert.equal(firstPageBody.page, 1);
  assert.equal(firstPageBody.limit, 1);
  assert.equal(firstPageBody.total >= 2, true);
  assert.equal(firstPageBody.patients.length, 1);
  assert.equal(firstPageBody.patients[0]?.name.includes(uniqueSuffix), true);

  const secondPage = await app.inject({
    method: "GET",
    url: `/v1/search/patients?q=${encodeURIComponent(uniqueSuffix)}&page=2&limit=1`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(secondPage.statusCode, 200);
  const secondPageBody = secondPage.json() as { patients: Array<{ id: number }> };
  assert.equal(secondPageBody.patients.length, 1);
  assert.notEqual(secondPageBody.patients[0]?.id, firstPageBody.patients[0]?.id);
  await app.close();
});

test("patient and diagnosis writes sync OpenSearch documents when configured", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalOpenSearchUrl = process.env.OPENSEARCH_URL;
  const calls: Array<{ method: string; url: string }> = [];

  process.env.OPENSEARCH_URL = "http://search.local:9200";
  globalThis.fetch = async (input, init) => {
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url: input.toString()
    });

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  const app = await buildApp();

  try {
    const ownerLogin = await loginAs(app, "owner@medsys.local");
    const patientResponse = await app.inject({
      method: "POST",
      url: "/v1/patients",
      headers: {
        authorization: `Bearer ${ownerLogin.accessToken}`
      },
    payload: {
      name: `Indexed ${Date.now()} Patient`,
      dateOfBirth: DEFAULT_PATIENT_DOB
    }
  });

    assert.equal(patientResponse.statusCode, 201);
    const patientId = (patientResponse.json() as { patient: { id: number } }).patient.id;

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/v1/patients/${patientId}`,
      headers: {
        authorization: `Bearer ${ownerLogin.accessToken}`
      },
      payload: {
        phone: "555-9898"
      }
    });
    assert.equal(updateResponse.statusCode, 200);

    const conditionResponse = await app.inject({
      method: "POST",
      url: `/v1/patients/${patientId}/conditions`,
      headers: {
        authorization: `Bearer ${ownerLogin.accessToken}`
      },
      payload: {
        conditionName: "Indexed Condition",
        icd10Code: "B34.9"
      }
    });
    assert.equal(conditionResponse.statusCode, 201);

    assert.equal(calls.some((call) => call.method === "PUT" && call.url.includes("/medsys_patients/_doc/")), true);
    assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith("/_bulk")), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenSearchUrl === undefined) {
      delete process.env.OPENSEARCH_URL;
    } else {
      process.env.OPENSEARCH_URL = originalOpenSearchUrl;
    }
    await app.close();
  }
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

test("auth logout revokes the current refresh token", async () => {
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
  const loginBody = loginResponse.json() as {
    accessToken: string;
    refreshToken: string;
    access_token: string;
    refresh_token: string;
    expiresIn: number;
    expires_in: number;
    tokenType: string;
    token_type: string;
    user: {
      id: number;
      email: string;
      role: string;
      name: string;
      permissions: string[];
      extra_permissions: string[];
      created_at: string;
    };
  };
  assert.equal(typeof loginBody.accessToken, "string");
  assert.equal(loginBody.access_token, loginBody.accessToken);
  assert.equal(loginBody.refresh_token, loginBody.refreshToken);
  assert.equal(loginBody.expires_in, loginBody.expiresIn);
  assert.equal(loginBody.tokenType, "Bearer");
  assert.equal(loginBody.token_type, "Bearer");
  assert.equal(loginBody.user.email, "owner@medsys.local");
  assert.equal(typeof loginBody.user.created_at, "string");

  const logoutResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(logoutResponse.statusCode, 200);
  assert.deepEqual(logoutResponse.json(), { success: true });

  const refreshResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    payload: {
      refreshToken: loginBody.refreshToken
    }
  });

  assert.equal(refreshResponse.statusCode, 401);
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
      dateOfBirth: DEFAULT_PATIENT_DOB,
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

test("patient delete tolerates an empty JSON body when content-type is set", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");
  const patientId = await createPatientAs(app, loginBody.accessToken, `Delete Body ${Date.now()} Patient`);

  const response = await app.inject({
    method: "DELETE",
    url: `/v1/patients/${patientId}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`,
      "content-type": "application/json"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { success: true });
  await app.close();
});

test("doctor natively has patient and appointment creation permissions", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const meResponse = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(meResponse.statusCode, 200);
  const meBody = meResponse.json() as {
    role: string;
    permissions: string[];
    extra_permissions: string[];
  };
  assert.equal(meBody.role, "doctor");
  assert.equal(meBody.permissions.includes("patient.write"), true);
  assert.equal(meBody.permissions.includes("appointment.create"), true);
  assert.equal(meBody.permissions.includes("prescription.dispense"), true);
  assert.deepEqual(meBody.extra_permissions, []);

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      name: `Doctor Created ${uniqueSuffix}`,
      dateOfBirth: DEFAULT_PATIENT_DOB,
      gender: "male",
      phone: "+94770000123"
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json() as {
    patient: { id: number; name: string; phone: string | null };
  };
  assert.equal(created.patient.name, `Doctor Created ${uniqueSuffix}`);
  assert.equal(created.patient.phone, "+94770000123");

  const updateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${created.patient.id}`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      address: "Doctor Updated Address",
      phone: "+94770000456"
    }
  });

  assert.equal(updateResponse.statusCode, 200);
  const updated = updateResponse.json() as {
    patient: { id: number; address: string | null; phone: string | null };
  };
  assert.equal(updated.patient.id, created.patient.id);
  assert.equal(updated.patient.address, "Doctor Updated Address");
  assert.equal(updated.patient.phone, "+94770000456");

  const appointmentResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      patientId: created.patient.id,
      scheduledAt: "2026-03-23T09:00:00Z"
    }
  });

  assert.equal(appointmentResponse.statusCode, 201);
  await app.close();
});

test("appointments create, read, and update flows work with stable shapes", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");
  const patientId = await createPatientAs(app, loginBody.accessToken, `Appointment ${Date.now()} Patient`);
  const scheduledAt = "2026-03-15T09:30:00Z";

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      patientId,
      scheduledAt,
      reason: "Follow-up",
      priority: "high"
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json() as {
    id: number;
    patientId: number;
    status: string;
    priority: string;
    reason: string | null;
  };
  assert.equal(created.patientId, patientId);
  assert.equal(created.status, "waiting");
  assert.equal(created.priority, "high");
  assert.equal(created.reason, "Follow-up");

  const readResponse = await app.inject({
    method: "GET",
    url: `/v1/appointments/${created.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(readResponse.statusCode, 200);
  const readBody = readResponse.json() as {
    id: number;
    patientId: number;
    status: string;
    scheduledAt: string;
  };
  assert.equal(readBody.id, created.id);
  assert.equal(readBody.patientId, patientId);
  assert.equal(readBody.status, "waiting");
  assert.equal(typeof readBody.scheduledAt, "string");

  const updateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/appointments/${created.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      status: "in_consultation",
      reason: "Doctor review"
    }
  });

  assert.equal(updateResponse.statusCode, 200);
  const updated = updateResponse.json() as {
    id: number;
    status: string;
    reason: string | null;
  };
  assert.equal(updated.id, created.id);
  assert.equal(updated.status, "in_consultation");
  assert.equal(updated.reason, "Doctor review");

  const listResponse = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=in_consultation",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(listResponse.statusCode, 200);
  const listBody = listResponse.json() as Array<{ id: number; status: string }>;
  assert.equal(listBody.some((row) => row.id === created.id && row.status === "in_consultation"), true);
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
      dateOfBirth: DEFAULT_PATIENT_DOB,
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

test("patient create accepts compatibility fields used by the frontend BFF", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `Compat ${uniqueSuffix} Patient`,
      nic: `NIC-${uniqueSuffix}`,
      age: 35,
      gender: "female",
      mobile: "555-3000",
      priority: "high",
      dateOfBirth: DEFAULT_PATIENT_DOB,
      address: "Compat Street"
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const createBody = createResponse.json() as {
    patient: { id: number; name: string; phone: string | null; address: string | null };
  };
  assert.equal(createBody.patient.name, `Compat ${uniqueSuffix} Patient`);
  assert.equal(createBody.patient.phone, "555-3000");
  assert.equal(createBody.patient.address, "Compat Street");

  const profileResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}/profile`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(profileResponse.statusCode, 200);
  const profileBody = profileResponse.json() as {
    patient: { nic: string | null; age: number | null; gender: string | null; phone: string | null };
  };
  assert.equal(profileBody.patient.nic, `NIC-${uniqueSuffix}`);
  assert.equal(profileBody.patient.age, 35);
  assert.equal(profileBody.patient.gender, "female");
  assert.equal(profileBody.patient.phone, "555-3000");
  await app.close();
});

test("patient create with backend-style payload auto-creates family and saves allergies", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      firstName: "Backend",
      lastName: `Create ${uniqueSuffix}`,
      dob: DEFAULT_PATIENT_DOB,
      gender: "male",
      nic: `19900101${uniqueSuffix.slice(-4)}`,
      phone: "+94770000999",
      address: "Backend Create Street",
      bloodGroup: "B+",
      allergies: [{ allergyName: "Dust", severity: "moderate", isActive: true }]
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const createBody = createResponse.json() as {
    patient: { id: number; family_id: number | null };
  };
  assert.notEqual(createBody.patient.family_id, null);

  const familyResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}/family`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(familyResponse.statusCode, 200);
  const familyBody = familyResponse.json() as {
    familyId: number | null;
    family: { familyName: string } | null;
  };
  assert.notEqual(familyBody.familyId, null);
  assert.equal(familyBody.family?.familyName, `Backend Create ${uniqueSuffix} Family`);

  const allergiesResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}/allergies`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(allergiesResponse.statusCode, 200);
  const allergiesBody = allergiesResponse.json() as Array<{ allergyName: string; severity: string | null }>;
  assert.equal(allergiesBody.length, 1);
  assert.equal(allergiesBody[0].allergyName, "Dust");
  assert.equal(allergiesBody[0].severity, "moderate");

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
    user: { id: number; email: string; role: string; name: string; created_at: string };
  };
  assert.equal(registerBody.user.role, "doctor");
  assert.equal(registerBody.user.email, `contract-user-${uniqueSuffix}@medsys.local`);
  assert.equal(registerBody.user.name, `Contract User${uniqueSuffix}`);
  assert.equal(typeof registerBody.user.id, "number");
  assert.equal(typeof registerBody.user.created_at, "string");
  assert.deepEqual((registerBody.user as { extra_permissions?: string[] }).extra_permissions, []);

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

test("family create and member read flow returns the linked patient", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");
  const patientId = await createPatientAs(app, loginBody.accessToken, `Family Flow ${Date.now()} Patient`);

  const createFamilyResponse = await app.inject({
    method: "POST",
    url: "/v1/families",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      familyName: `Family Flow ${Date.now()}`,
      assigned: true
    }
  });

  assert.equal(createFamilyResponse.statusCode, 201);
  const createdFamily = createFamilyResponse.json() as {
    id: number;
    familyName: string;
    assigned: boolean;
  };
  assert.equal(createdFamily.familyName.length > 0, true);
  assert.equal(createdFamily.assigned, true);

  const addMemberResponse = await app.inject({
    method: "POST",
    url: `/v1/families/${createdFamily.id}/members`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      patientId,
      relationship: "child"
    }
  });

  assert.equal(addMemberResponse.statusCode, 201);

  const readFamilyResponse = await app.inject({
    method: "GET",
    url: `/v1/families/${createdFamily.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(readFamilyResponse.statusCode, 200);
  const familyBody = readFamilyResponse.json() as {
    family: { id: number; familyName: string };
    members: Array<{ patientId: number; relationship: string | null }>;
  };
  assert.equal(familyBody.family.id, createdFamily.id);
  assert.equal(
    familyBody.members.some((member) => member.patientId === patientId && member.relationship === "child"),
    true
  );
  await app.close();
});

test("minor patients can link to a guardian patient and be found by guardian NIC", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createFamilyResponse = await app.inject({
    method: "POST",
    url: "/v1/families",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      familyName: `Guardian Family ${uniqueSuffix}`,
      assigned: true
    }
  });

  assert.equal(createFamilyResponse.statusCode, 201);
  const createdFamily = createFamilyResponse.json() as { id: number };

  const guardianResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      firstName: "Guardian",
      lastName: uniqueSuffix,
      dob: "1988-02-10",
      gender: "female",
      nic: `2000${uniqueSuffix.slice(-8)}`,
      phone: "+94771112233",
      familyId: createdFamily.id
    }
  });

  assert.equal(guardianResponse.statusCode, 201);
  const guardianBody = guardianResponse.json() as { patient: { id: number; patient_code: string | null } };
  assert.equal(typeof guardianBody.patient.patient_code, "string");

  const addGuardianToFamilyResponse = await app.inject({
    method: "POST",
    url: `/v1/families/${createdFamily.id}/members`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      patientId: guardianBody.patient.id,
      relationship: "mother"
    }
  });

  assert.equal(addGuardianToFamilyResponse.statusCode, 201);

  const childResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      firstName: "Child",
      lastName: uniqueSuffix,
      dob: "2016-05-20",
      gender: "male",
      familyId: createdFamily.id,
      guardianPatientId: guardianBody.patient.id,
      guardianRelationship: "mother"
    }
  });

  assert.equal(childResponse.statusCode, 201);
  const childBody = childResponse.json() as { patient: { id: number; patient_code: string | null } };
  assert.equal(typeof childBody.patient.patient_code, "string");

  const profileResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${childBody.patient.id}/profile`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(profileResponse.statusCode, 200);
  const profileBody = profileResponse.json() as {
    patient: {
      familyId: number | null;
      guardianPatientId: number | null;
      guardianNic: string | null;
      guardianRelationship: string | null;
    };
  };
  assert.equal(profileBody.patient.familyId, createdFamily.id);
  assert.equal(profileBody.patient.guardianPatientId, guardianBody.patient.id);
  assert.equal(profileBody.patient.guardianRelationship, "mother");

  const searchResponse = await app.inject({
    method: "GET",
    url: `/v1/search/patients?q=${encodeURIComponent(`2000${uniqueSuffix.slice(-8)}`)}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(searchResponse.statusCode, 200);
  const searchBody = searchResponse.json() as {
    patients: Array<{ id: number; guardian_nic: string | null; patient_code: string | null }>;
  };
  assert.equal(searchBody.patients.some((patient) => patient.id === childBody.patient.id), true);
  assert.equal(
    searchBody.patients.some((patient) => patient.id === childBody.patient.id && patient.guardian_nic !== null),
    true
  );

  const patientFamilyResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${childBody.patient.id}/family`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(patientFamilyResponse.statusCode, 200);
  const patientFamilyBody = patientFamilyResponse.json() as {
    familyId: number | null;
    guardianPatientId: number | null;
    members: Array<{ patientId: number; patientCode: string | null; relationship: string | null }>;
  };
  assert.equal(patientFamilyBody.familyId, createdFamily.id);
  assert.equal(patientFamilyBody.guardianPatientId, guardianBody.patient.id);
  assert.equal(
    patientFamilyBody.members.some((member) => member.patientId === childBody.patient.id && member.relationship === "child"),
    true
  );

  await app.close();
});

test("encounter bundle and prescription detail flows remain consistent", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const assistantId = await getUserIdByEmail(app, ownerLogin.accessToken, "assistant", "assistant@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Encounter ${Date.now()} Patient`);

  const appointmentResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId,
      doctorId,
      assistantId,
      scheduledAt: "2026-03-16T10:00:00Z"
    }
  });

  assert.equal(appointmentResponse.statusCode, 201);
  const appointment = appointmentResponse.json() as { id: number };

  const encounterResponse = await app.inject({
    method: "POST",
    url: "/v1/encounters",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      appointmentId: appointment.id,
      patientId,
      doctorId,
      checkedAt: "2026-03-16T10:30:00Z",
      notes: "Stable",
      diagnoses: [{ diagnosisName: "Acute viral fever", icd10Code: "B34.9" }],
      tests: [{ testName: "CBC", status: "ordered" }],
      prescription: {
        items: [
          {
            drugName: "Paracetamol",
            dose: "500mg",
            frequency: "TID",
            duration: "3 days",
            quantity: 9,
            source: "clinical"
          }
        ]
      }
    }
  });

  assert.equal(encounterResponse.statusCode, 201);
  const encounterBody = encounterResponse.json() as {
    encounterId: number;
    prescriptionId: number | null;
  };
  assert.equal(typeof encounterBody.encounterId, "number");
  assert.equal(typeof encounterBody.prescriptionId, "number");

  const queueResponse = await app.inject({
    method: "GET",
    url: "/v1/prescriptions/queue/pending-dispense",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(queueResponse.statusCode, 200);
  const queueBody = queueResponse.json() as Array<{ prescriptionId: number }>;
  assert.equal(queueBody.some((row) => row.prescriptionId === encounterBody.prescriptionId), true);

  const encounterDetailResponse = await app.inject({
    method: "GET",
    url: `/v1/encounters/${encounterBody.encounterId}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(encounterDetailResponse.statusCode, 200);
  const encounterDetail = encounterDetailResponse.json() as {
    encounter: { id: number; patientId: number };
    diagnoses: Array<{ diagnosisName: string; icd10Code: string | null }>;
    tests: Array<{ testName: string; status: string }>;
    prescriptions: Array<{ id: number }>;
    prescriptionItems: Array<{ drugName: string; quantity: string }>;
  };
  assert.equal(encounterDetail.encounter.id, encounterBody.encounterId);
  assert.equal(encounterDetail.encounter.patientId, patientId);
  assert.equal(encounterDetail.diagnoses[0]?.diagnosisName, "Acute viral fever");
  assert.equal(encounterDetail.tests[0]?.testName, "CBC");
  assert.equal(encounterDetail.prescriptions[0]?.id, encounterBody.prescriptionId);
  assert.equal(encounterDetail.prescriptionItems[0]?.drugName, "Paracetamol");

  const diagnosesResponse = await app.inject({
    method: "GET",
    url: `/v1/encounters/${encounterBody.encounterId}/diagnoses`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(diagnosesResponse.statusCode, 200);
  const diagnoses = diagnosesResponse.json() as Array<{ diagnosisName: string; icd10Code: string | null }>;
  assert.equal(diagnoses[0]?.diagnosisName, "Acute viral fever");
  assert.equal(diagnoses[0]?.icd10Code, "B34.9");

  const testsResponse = await app.inject({
    method: "GET",
    url: `/v1/encounters/${encounterBody.encounterId}/tests`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(testsResponse.statusCode, 200);
  const tests = testsResponse.json() as Array<{ testName: string; status: string }>;
  assert.equal(tests[0]?.testName, "CBC");
  assert.equal(tests[0]?.status, "ordered");

  const inventoryResponse = await app.inject({
    method: "POST",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      name: `Encounter Stock ${Date.now()}`,
      category: "medicine",
      unit: "tablet",
      stock: 20,
      reorderLevel: 5
    }
  });

  assert.equal(inventoryResponse.statusCode, 201);
  const inventoryItem = inventoryResponse.json() as { id: number };

  const dispenseResponse = await app.inject({
    method: "POST",
    url: `/v1/prescriptions/${encounterBody.prescriptionId}/dispense`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      assistantId,
      dispensedAt: "2026-03-16T11:00:00Z",
      status: "completed",
      notes: "Dispensed fully",
      items: [{ inventoryItemId: inventoryItem.id, quantity: 9 }]
    }
  });

  assert.equal(dispenseResponse.statusCode, 201);

  const queueAfterDispenseResponse = await app.inject({
    method: "GET",
    url: "/v1/prescriptions/queue/pending-dispense",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(queueAfterDispenseResponse.statusCode, 200);
  const queueAfterDispense = queueAfterDispenseResponse.json() as Array<{ prescriptionId: number }>;
  assert.equal(queueAfterDispense.some((row) => row.prescriptionId === encounterBody.prescriptionId), false);

  const prescriptionDetailResponse = await app.inject({
    method: "GET",
    url: `/v1/prescriptions/${encounterBody.prescriptionId}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(prescriptionDetailResponse.statusCode, 200);
  const prescriptionDetail = prescriptionDetailResponse.json() as {
    prescription: { id: number };
    items: Array<{ drugName: string }>;
    dispenses: Array<{ assistantId: number; status: string }>;
  };
  assert.equal(prescriptionDetail.prescription.id, encounterBody.prescriptionId);
  assert.equal(prescriptionDetail.items[0]?.drugName, "Paracetamol");
  assert.equal(prescriptionDetail.dispenses[0]?.assistantId, assistantId);
  assert.equal(prescriptionDetail.dispenses[0]?.status, "completed");
  await app.close();
});

test("inventory lifecycle routes return stable item and movement data", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      sku: `SKU-${Date.now()}`,
      name: `Inventory Lifecycle ${Date.now()}`,
      category: "medicine",
      unit: "tablet",
      stock: 10,
      reorderLevel: 3,
      isActive: true
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json() as {
    id: number;
    name: string;
    category: string;
    stock: string;
    reorderLevel: string;
  };
  assert.equal(created.category, "medicine");
  assert.equal(created.stock, "10");
  assert.equal(created.reorderLevel, "3");

  const patchResponse = await app.inject({
    method: "PATCH",
    url: `/v1/inventory/${created.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      reorderLevel: 5,
      isActive: false
    }
  });

  assert.equal(patchResponse.statusCode, 200);
  const patched = patchResponse.json() as {
    id: number;
    reorderLevel: string;
    isActive: boolean;
  };
  assert.equal(patched.id, created.id);
  assert.equal(patched.reorderLevel, "5");
  assert.equal(patched.isActive, false);

  const movementResponse = await app.inject({
    method: "POST",
    url: `/v1/inventory/${created.id}/movements`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      movementType: "in",
      quantity: 4,
      referenceType: "adjustment"
    }
  });

  assert.equal(movementResponse.statusCode, 201);
  const movement = movementResponse.json() as {
    inventoryItemId: number;
    movementType: string;
    quantity: string;
  };
  assert.equal(movement.inventoryItemId, created.id);
  assert.equal(movement.movementType, "in");
  assert.equal(movement.quantity, "4");

  const listResponse = await app.inject({
    method: "GET",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(listResponse.statusCode, 200);
  const items = listResponse.json() as Array<{ id: number; name: string }>;
  assert.equal(items.some((item) => item.id === created.id), true);

  const movementsResponse = await app.inject({
    method: "GET",
    url: `/v1/inventory/${created.id}/movements`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(movementsResponse.statusCode, 200);
  const movements = movementsResponse.json() as Array<{ inventoryItemId: number; movementType: string }>;
  assert.equal(movements.some((row) => row.inventoryItemId === created.id && row.movementType === "in"), true);
  await app.close();
});

test("inventory movement accepts the frontend alias payload shape", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      name: `Inventory Alias ${Date.now()}`,
      category: "medicine",
      unit: "tablet",
      stock: 5,
      reorderLevel: 1
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json() as { id: number };

  const movementResponse = await app.inject({
    method: "POST",
    url: `/v1/inventory/${created.id}/movements`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      type: "in",
      quantity: 1,
      note: "Quick frontend alias"
    }
  });

  assert.equal(movementResponse.statusCode, 201);
  const movement = movementResponse.json() as {
    inventoryItemId: number;
    movementType: string;
    quantity: string;
  };
  assert.equal(movement.inventoryItemId, created.id);
  assert.equal(movement.movementType, "in");
  assert.equal(movement.quantity, "1");
  await app.close();
});

test("audit logs endpoint returns filtered audit rows for authorized users", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");

  const patientId = await createPatientAs(app, loginBody.accessToken, `Audit Patient ${Date.now()}`);
  assert.equal(typeof patientId, "number");

  const response = await app.inject({
    method: "GET",
    url: "/v1/audit/logs?entityType=patient&action=create&limit=10",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(response.statusCode, 200);
  const rows = response.json() as Array<{
    entityType: string;
    action: string;
    entityId: number | null;
    createdAt: string;
  }>;
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length > 0, true);
  assert.equal(rows.some((row) => row.entityType === "patient" && row.action === "create"), true);
  assert.equal(typeof rows[0]?.createdAt, "string");
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
      permissions: (response.json() as { user: { permissions: string[] } }).user.permissions,
      extra_permissions: [],
      created_at: (response.json() as { user: { created_at: string } }).user.created_at
    }
  });
  const body = response.json() as { user: { permissions: string[] } };
  assert.equal(body.user.permissions.includes("appointment.create"), true);
  await app.close();
});

test("assistant cannot assign extra permissions to users", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const assistantLogin = await loginAs(app, "assistant@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/users/${doctorId}`,
    headers: {
      authorization: `Bearer ${assistantLogin.accessToken}`
    },
    payload: {
      extraPermissions: ["patient.write"]
    }
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});

test("owner cannot grant owner-only permissions as extra doctor permissions", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/users/${doctorId}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      extraPermissions: ["user.write"]
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [
      {
        field: "extraPermissions",
        message: "Only assistant-support permissions can be granted: user.write"
      }
    ]
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
      dateOfBirth: DEFAULT_PATIENT_DOB,
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
      name: `Empty Patch ${uniqueSuffix}`,
      dateOfBirth: DEFAULT_PATIENT_DOB
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
      name: `Vitals ${uniqueSuffix} Patient`,
      dateOfBirth: DEFAULT_PATIENT_DOB
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

test("patient vitals rejects payloads without any measurement values", async () => {
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
      name: `Vitals Empty ${uniqueSuffix} Patient`,
      dateOfBirth: DEFAULT_PATIENT_DOB
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
      recordedAt: "2026-03-09T10:15:00Z"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [{ field: "body", message: "At least one vital measurement must be provided" }]
  });
  await app.close();
});

test("patient vitals create and list use the stable serialized response shape", async () => {
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
      name: `Vitals Shape ${uniqueSuffix} Patient`,
      dateOfBirth: DEFAULT_PATIENT_DOB
    }
  });

  assert.equal(createPatientResponse.statusCode, 201);
  const createBody = createPatientResponse.json() as { patient: { id: number } };

  const createVitalResponse = await app.inject({
    method: "POST",
    url: `/v1/patients/${createBody.patient.id}/vitals`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      heartRate: 84,
      temperatureC: 36.9,
      recordedAt: "2026-03-09T10:15:00Z"
    }
  });

  assert.equal(createVitalResponse.statusCode, 201);
  const createdVital = createVitalResponse.json() as {
    id: number;
    patient_id: number;
    encounter_id: number | null;
    heart_rate: number | null;
    temperature_c: number | null;
    recorded_at: string;
    created_at: string;
    updated_at: string;
  };
  assert.equal(createdVital.patient_id, createBody.patient.id);
  assert.equal(createdVital.encounter_id, null);
  assert.equal(createdVital.heart_rate, 84);
  assert.equal(createdVital.temperature_c, 36.9);
  assert.equal(typeof createdVital.recorded_at, "string");
  assert.equal(typeof createdVital.created_at, "string");
  assert.equal(typeof createdVital.updated_at, "string");

  const secondVitalResponse = await app.inject({
    method: "POST",
    url: `/v1/patients/${createBody.patient.id}/vitals`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      spo2: 97,
      recordedAt: "2026-03-09T10:20:00Z"
    }
  });

  assert.equal(secondVitalResponse.statusCode, 201);
  const secondVital = secondVitalResponse.json() as {
    id: number;
    spo2: number | null;
    recorded_at: string;
  };
  assert.equal(secondVital.spo2, 97);

  const listVitalsResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}/vitals`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(listVitalsResponse.statusCode, 200);
  const vitals = listVitalsResponse.json() as Array<{
    id: number;
    patient_id: number;
    heart_rate: number | null;
    spo2: number | null;
    temperature_c: number | null;
    recorded_at: string;
  }>;
  assert.equal(vitals.length >= 2, true);
  assert.equal(vitals[0].patient_id, createBody.patient.id);
  assert.equal(vitals[0].id, secondVital.id);
  assert.equal(vitals[0].spo2, 97);
  assert.equal(typeof vitals[0].recorded_at, "string");
  assert.equal(vitals[1].id, createdVital.id);
  assert.equal(vitals[1].heart_rate, 84);

  await app.close();
});

test("patient create rejects mismatched age and DOB with validation envelope", async () => {
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
      firstName: "Mismatch",
      lastName: "Patient",
      dob: "1990-06-01",
      age: 12,
      gender: "other"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Validation failed.",
    issues: [{ field: "age", message: "Age does not match DOB." }]
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
    permissions: string[];
    extra_permissions: string[];
    created_at: string;
  };
  assert.equal(typeof body.id, "number");
  assert.equal(body.name.length > 0, true);
  assert.equal(body.email, "doctor@medsys.local");
  assert.equal(body.role, "doctor");
  assert.equal(body.permissions.includes("appointment.read"), true);
  assert.equal(body.permissions.includes("appointment.create"), true);
  assert.equal(body.permissions.includes("patient.write"), true);
  assert.equal(body.permissions.includes("prescription.dispense"), true);
  assert.deepEqual(body.extra_permissions, []);
  assert.equal(typeof body.created_at, "string");
  assert.equal("organizationId" in body, false);
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
      name: `Protected Patient ${uniqueSuffix}`,
      dateOfBirth: DEFAULT_PATIENT_DOB
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

test("doctor can access dispense queue under self-service policy", async () => {
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

  assert.equal(response.statusCode, 200);
  await app.close();
});

test("appointments list rejects invalid status filter with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "assistant@medsys.local");

  const response = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=invalid",
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
  assert.equal(body.issues[0]?.field, "status");
  await app.close();
});

test("family member add rejects unknown fields with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Family Patient ${Date.now()}`);

  const createFamilyResponse = await app.inject({
    method: "POST",
    url: "/v1/families",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      familyName: `Family ${Date.now()}`
    }
  });

  assert.equal(createFamilyResponse.statusCode, 201);
  const familyId = (createFamilyResponse.json() as { id: number }).id;

  const response = await app.inject({
    method: "POST",
    url: `/v1/families/${familyId}/members`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId,
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

test("inventory movement rejects unknown fields with validation envelope", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");

  const createItemResponse = await app.inject({
    method: "POST",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      name: `Inventory ${Date.now()}`,
      category: "medicine",
      unit: "tablet",
      stock: 10,
      reorderLevel: 2
    }
  });

  assert.equal(createItemResponse.statusCode, 201);
  const itemId = (createItemResponse.json() as { id: number }).id;

  const response = await app.inject({
    method: "POST",
    url: `/v1/inventory/${itemId}/movements`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      movementType: "in",
      quantity: 5,
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

test("assistant cannot create encounters without encounter.write permission", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "assistant@medsys.local");

  const response = await app.inject({
    method: "POST",
    url: "/v1/encounters",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});

test("assistant cannot access audit logs without audit.read permission", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "assistant@medsys.local");

  const response = await app.inject({
    method: "GET",
    url: "/v1/audit/logs",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});
