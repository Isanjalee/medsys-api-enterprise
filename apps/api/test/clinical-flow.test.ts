import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { calculateAgeFromDob } from "../src/lib/date.js";

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

const assertValidationEnvelope = (
  body: {
    error: string;
    code: string;
    severity: string;
    userMessage: string;
    requestId: string;
    statusCode: number;
    issues: Array<{ field: string; message: string }>;
  },
  issues: Array<{ field: string; message: string }>
) => {
  assert.equal(body.error, "Validation failed.");
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.equal(body.severity, "warning");
  assert.equal(body.userMessage, "Please check the highlighted fields and try again.");
  assert.equal(body.statusCode, 400);
  assert.equal(typeof body.requestId, "string");
  assert.deepEqual(body.issues, issues);
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
    "role_context",
    "waitingAppointments"
  ]);
  const body = response.json() as Record<string, unknown>;
  assert.equal(typeof body.patients, "number");
  assert.equal(typeof body.waitingAppointments, "number");
  assert.equal(typeof body.prescriptions, "number");
  assert.equal(typeof body.lowStockItems, "number");
  assert.deepEqual(body.role_context, {
    role: "owner",
    active_role: "owner",
    roles: ["owner"],
    workflow_profile: { mode: "standard" }
  });
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

test("waiting appointment queue returns FIFO order with explicit queue positions", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const patientOneId = await createPatientAs(app, ownerLogin.accessToken, `Queue Order ${Date.now()} Patient A`);
  const patientTwoId = await createPatientAs(app, ownerLogin.accessToken, `Queue Order ${Date.now()} Patient B`);

  const firstCreateResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId: patientOneId,
      scheduledAt: "2026-03-15T09:30:00Z",
      priority: "normal"
    }
  });
  assert.equal(firstCreateResponse.statusCode, 201);
  const firstAppointmentId = (firstCreateResponse.json() as { id: number }).id;

  const secondCreateResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId: patientTwoId,
      scheduledAt: "2026-03-15T10:00:00Z",
      priority: "normal"
    }
  });
  assert.equal(secondCreateResponse.statusCode, 201);
  const secondAppointmentId = (secondCreateResponse.json() as { id: number }).id;

  const queueResponse = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=waiting",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(queueResponse.statusCode, 200);
  const queueRows = queueResponse.json() as Array<{ id: number; queuePosition: number; scheduledAt: string }>;
  const relevantRows = queueRows.filter((row) => row.id === firstAppointmentId || row.id === secondAppointmentId);

  assert.equal(relevantRows.length, 2);
  assert.equal(relevantRows[0].id, firstAppointmentId);
  assert.equal(relevantRows[0].queuePosition, 1);
  assert.equal(relevantRows[1].id, secondAppointmentId);
  assert.equal(relevantRows[1].queuePosition, 2);

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
  assertValidationEnvelope(response.json() as any, [{ field: "extra", message: "Unknown field." }]);
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
      user_id: number;
      email: string;
      role: string;
      roles: string[];
      active_role: string;
      name: string;
      workflow_profiles: {
        doctor: { mode: string } | null;
        assistant: { mode: string } | null;
        owner: { mode: string } | null;
      };
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
  assert.equal(loginBody.user.user_id, loginBody.user.id);
  assert.deepEqual(loginBody.user.roles, ["owner"]);
  assert.equal(loginBody.user.active_role, "owner");
  assert.deepEqual(loginBody.user.workflow_profiles, {
    doctor: null,
    assistant: null,
    owner: { mode: "standard" }
  });
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
    roles: string[];
    active_role: string;
    doctor_workflow_mode: string | null;
    workflow_profiles: {
      doctor: { mode: string } | null;
      assistant: { mode: string } | null;
      owner: { mode: string } | null;
    };
    permissions: string[];
    extra_permissions: string[];
  };
  assert.equal(meBody.role, "doctor");
  assert.deepEqual(meBody.roles, ["doctor"]);
  assert.equal(meBody.active_role, "doctor");
  assert.equal(meBody.doctor_workflow_mode, "self_service");
  assert.deepEqual(meBody.workflow_profiles, {
    doctor: { mode: "self_service" },
    assistant: null,
    owner: null
  });
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
      age: number | null;
      gender: string | null;
      phone: string | null;
      address: string | null;
      created_at: string;
    };
  };
  assert.equal(createBody.patient.name, `Contract ${uniqueSuffix} Patient`);
  assert.equal(createBody.patient.date_of_birth, "1990-06-01");
  assert.equal(createBody.patient.age, 35);
  assert.equal(createBody.patient.gender, "other");

  const listPatientsResponse = await app.inject({
    method: "GET",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(listPatientsResponse.statusCode, 200);
  const listBody = listPatientsResponse.json() as {
    patients: Array<{
      id: number;
      name: string;
      nic: string | null;
      date_of_birth: string | null;
      age: number | null;
      gender: string | null;
      family_name: string | null;
      visit_count: number;
      last_visit_at: string | null;
      next_appointment: { id: number; scheduled_at: string; status: string } | null;
      allergy_highlights: string[];
      major_active_condition: string | null;
      created_at: string;
    }>;
  };
  assert.equal(Array.isArray(listBody.patients), true);
  const listedPatient = listBody.patients.find((patient) => patient.id === createBody.patient.id);
  assert.ok(listedPatient);
  assert.equal(listedPatient?.nic, null);
  assert.equal(listedPatient?.gender, "other");
  assert.equal(typeof listedPatient?.visit_count, "number");
  assert.equal(listedPatient?.next_appointment, null);
  assert.equal(Array.isArray(listedPatient?.allergy_highlights), true);
  assert.equal(listedPatient?.major_active_condition, null);
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
      address: "84 Updated Street",
      bloodGroup: "O+"
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

test("patient patch updates identity fields and refreshed profile reflects them immediately", async () => {
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
      firstName: "Dulan",
      lastName: `Nis ${uniqueSuffix}`,
      dob: "1999-03-15",
      gender: "male",
      nic: `19990315${uniqueSuffix.slice(-4)}`,
      phone: "0776347519",
      bloodGroup: "B+"
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const createBody = createResponse.json() as { patient: { id: number; family_id: number | null } };

  const patchResponse = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${createBody.patient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      firstName: "Dulan",
      lastName: `Nishthunga ${uniqueSuffix}`,
      dob: "2000-10-23",
      gender: "male",
      nic: `20001023${uniqueSuffix.slice(-4)}`,
      phone: "0776347519",
      address: null,
      bloodGroup: "O+",
      familyId: createBody.patient.family_id,
      guardianName: null,
      guardianNic: null,
      guardianPhone: null,
      guardianRelationship: null
    }
  });

  assert.equal(patchResponse.statusCode, 200);

  const getResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });
  assert.equal(getResponse.statusCode, 200);
  const getBody = getResponse.json() as {
    patient: { name: string; date_of_birth: string | null; nic: string | null; bloodGroup?: string | null };
  };
  assert.equal(getBody.patient.name, `Dulan Nishthunga ${uniqueSuffix}`);
  assert.equal(getBody.patient.date_of_birth, "2000-10-23");
  assert.equal(getBody.patient.nic, `20001023${uniqueSuffix.slice(-4)}`);

  const profileResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}/profile`,
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });
  assert.equal(profileResponse.statusCode, 200);
  const profileBody = profileResponse.json() as {
    patient: {
      firstName: string;
      lastName: string;
      fullName: string;
      dob: string;
      age: number;
      nic: string | null;
      bloodGroup: string | null;
    };
    family: {
      members: Array<{ patientId: number; firstName: string; lastName: string; nic: string | null }>;
    };
  };
  assert.equal(profileBody.patient.firstName, "Dulan");
  assert.equal(profileBody.patient.lastName, `Nishthunga ${uniqueSuffix}`);
  assert.equal(profileBody.patient.fullName, `Dulan Nishthunga ${uniqueSuffix}`);
  assert.equal(profileBody.patient.dob, "2000-10-23");
  assert.equal(profileBody.patient.age, calculateAgeFromDob(new Date("2000-10-23")));
  assert.equal(profileBody.patient.nic, `20001023${uniqueSuffix.slice(-4)}`);
  assert.equal(profileBody.patient.bloodGroup, "O+");
  assert.equal(profileBody.family.family?.familyName, `Dulan Nishthunga ${uniqueSuffix} Family`);
  assert.equal(
    profileBody.family.members.some(
      (member) =>
        member.patientId === createBody.patient.id &&
        member.firstName === "Dulan" &&
        member.lastName === `Nishthunga ${uniqueSuffix}` &&
        member.nic === `20001023${uniqueSuffix.slice(-4)}`
    ),
    true
  );

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
    family: { familyId: number | null; family: { id: number; familyName: string } | null; members: unknown[] };
  };
  assert.equal(profileBody.patient.nic, `NIC-${uniqueSuffix}`);
  assert.equal(profileBody.patient.age, 35);
  assert.equal(profileBody.patient.gender, "female");
  assert.equal(profileBody.patient.phone, "555-3000");
  assert.equal(profileBody.family.familyId, null);
  assert.equal(profileBody.family.family, null);
  assert.equal(Array.isArray(profileBody.family.members), true);
  await app.close();
});

test("start visit creates a new in-consultation visit for walk-in doctor flow", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const patientId = await createPatientAs(app, doctorLogin.accessToken, `Walk-In ${Date.now()} Patient`);

  const response = await app.inject({
    method: "POST",
    url: "/v1/visits/start",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      patientId,
      reason: "Walk-in consultation",
      priority: "normal"
    }
  });

  assert.equal(response.statusCode, 201);
  const body = response.json() as {
    reused: boolean;
    visit: {
      patientId: number;
      doctorId: number | null;
      status: string;
      reason: string | null;
      priority: string;
    };
  };
  assert.equal(body.reused, false);
  assert.equal(body.visit.patientId, patientId);
  assert.equal(body.visit.doctorId, doctorId);
  assert.equal(body.visit.status, "in_consultation");
  assert.equal(body.visit.reason, "Walk-in consultation");
  assert.equal(body.visit.priority, "normal");

  await app.close();
});

test("start visit reuses an active waiting visit instead of creating a duplicate", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Reuse Visit ${Date.now()} Patient`);

  const createAppointmentResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId,
      scheduledAt: "2026-03-20T09:00:00Z",
      status: "waiting",
      priority: "high"
    }
  });

  assert.equal(createAppointmentResponse.statusCode, 201);
  const createdAppointment = createAppointmentResponse.json() as { id: number };

  const startVisitResponse = await app.inject({
    method: "POST",
    url: "/v1/visits/start",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      patientId
    }
  });

  assert.equal(startVisitResponse.statusCode, 200);
  const startVisitBody = startVisitResponse.json() as {
    reused: boolean;
    visit: {
      id: number;
      patientId: number;
      doctorId: number | null;
      status: string;
    };
  };
  assert.equal(startVisitBody.reused, true);
  assert.equal(startVisitBody.visit.id, createdAppointment.id);
  assert.equal(startVisitBody.visit.patientId, patientId);
  assert.equal(startVisitBody.visit.doctorId, doctorId);
  assert.equal(startVisitBody.visit.status, "in_consultation");

  const waitingResponse = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=waiting",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(waitingResponse.statusCode, 200);
  const waitingAppointments = waitingResponse.json() as Array<{ id: number }>;
  assert.equal(waitingAppointments.some((row) => row.id === createdAppointment.id), false);

  const inConsultationResponse = await app.inject({
    method: "GET",
    url: "/v1/appointments?status=in_consultation",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(inConsultationResponse.statusCode, 200);
  const inConsultationAppointments = inConsultationResponse.json() as Array<{ id: number; doctorId: number | null }>;
  assert.equal(inConsultationAppointments.some((row) => row.id === createdAppointment.id), true);
  assert.equal(
    inConsultationAppointments.some((row) => row.id === createdAppointment.id && row.doctorId === doctorId),
    true
  );

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
    user: {
      id: number;
      email: string;
      role: string;
      roles: string[];
      active_role: string;
      name: string;
      created_at: string;
      doctor_workflow_mode: string | null;
      workflow_profiles: {
        doctor: { mode: string } | null;
        assistant: { mode: string } | null;
        owner: { mode: string } | null;
      };
    };
  };
  assert.equal(registerBody.user.role, "doctor");
  assert.deepEqual(registerBody.user.roles, ["doctor"]);
  assert.equal(registerBody.user.active_role, "doctor");
  assert.equal(registerBody.user.doctor_workflow_mode, "self_service");
  assert.deepEqual(registerBody.user.workflow_profiles, {
    doctor: { mode: "self_service" },
    assistant: null,
    owner: null
  });
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

test("owner can register a multi-role user and auth reflects persisted roles", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();
  const email = `multi-role-${uniqueSuffix}@medsys.local`;

  const registerResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      firstName: "Multi",
      lastName: "Role",
      email,
      password: "ChangeMe123!",
      roles: ["owner", "doctor"],
      activeRole: "doctor",
      doctorWorkflowMode: "clinic_supported"
    }
  });

  assert.equal(registerResponse.statusCode, 201);
  const registerBody = registerResponse.json() as {
    user: {
      role: string;
      roles: string[];
      active_role: string;
      doctor_workflow_mode: string | null;
      workflow_profiles: {
        doctor: { mode: string } | null;
        assistant: { mode: string } | null;
        owner: { mode: string } | null;
      };
      permissions: string[];
    };
  };
  assert.equal(registerBody.user.role, "doctor");
  assert.deepEqual(registerBody.user.roles, ["owner", "doctor"]);
  assert.equal(registerBody.user.active_role, "doctor");
  assert.equal(registerBody.user.doctor_workflow_mode, "clinic_supported");
  assert.deepEqual(registerBody.user.workflow_profiles, {
    doctor: { mode: "clinic_supported" },
    assistant: null,
    owner: { mode: "standard" }
  });
  assert.equal(registerBody.user.permissions.includes("user.write"), true);
  assert.equal(registerBody.user.permissions.includes("patient.delete"), true);

  const multiRoleLogin = await loginAs(app, email);
  const meResponse = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: {
      authorization: `Bearer ${multiRoleLogin.accessToken}`
    }
  });

  assert.equal(meResponse.statusCode, 200);
  const meBody = meResponse.json() as {
    role: string;
    roles: string[];
    active_role: string;
    permissions: string[];
  };
  assert.equal(meBody.role, "doctor");
  assert.deepEqual(meBody.roles, ["owner", "doctor"]);
  assert.equal(meBody.active_role, "doctor");
  assert.equal(meBody.permissions.includes("user.write"), true);

  const userListResponse = await app.inject({
    method: "GET",
    url: "/v1/users",
    headers: {
      authorization: `Bearer ${multiRoleLogin.accessToken}`
    }
  });

  assert.equal(userListResponse.statusCode, 200);
  await app.close();
});

test("multi-role user can switch active role and see updated role context", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();
  const email = `role-switch-${uniqueSuffix}@medsys.local`;

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      firstName: "Switch",
      lastName: "User",
      email,
      password: "ChangeMe123!",
      roles: ["owner", "doctor"],
      activeRole: "doctor",
      doctorWorkflowMode: "self_service"
    }
  });

  assert.equal(createResponse.statusCode, 201);

  const multiRoleLogin = await loginAs(app, email);
  const switchResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/active-role",
    headers: {
      authorization: `Bearer ${multiRoleLogin.accessToken}`
    },
    payload: {
      activeRole: "owner"
    }
  });

  assert.equal(switchResponse.statusCode, 200);
  const switchBody = switchResponse.json() as {
    user: {
      role: string;
      roles: string[];
      active_role: string;
      workflow_profiles: {
        doctor: { mode: string } | null;
        assistant: { mode: string } | null;
        owner: { mode: string } | null;
      };
    };
  };
  assert.equal(switchBody.user.role, "owner");
  assert.deepEqual(switchBody.user.roles, ["owner", "doctor"]);
  assert.equal(switchBody.user.active_role, "owner");
  assert.deepEqual(switchBody.user.workflow_profiles, {
    doctor: { mode: "self_service" },
    assistant: null,
    owner: { mode: "standard" }
  });

  const meResponse = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: {
      authorization: `Bearer ${multiRoleLogin.accessToken}`
    }
  });

  assert.equal(meResponse.statusCode, 200);
  const meBody = meResponse.json() as {
    role: string;
    active_role: string;
    roles: string[];
  };
  assert.equal(meBody.role, "owner");
  assert.equal(meBody.active_role, "owner");
  assert.deepEqual(meBody.roles, ["owner", "doctor"]);

  const invalidSwitchResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/active-role",
    headers: {
      authorization: `Bearer ${multiRoleLogin.accessToken}`
    },
    payload: {
      activeRole: "assistant"
    }
  });

  assert.equal(invalidSwitchResponse.statusCode, 400);
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
    family: {
      familyId: number | null;
      family: { id: number; familyName: string } | null;
      guardianPatientId: number | null;
      guardianRelationship: string | null;
      members: Array<{ patientId: number; relationship: string | null }>;
    };
  };
  assert.equal(profileBody.patient.familyId, createdFamily.id);
  assert.equal(profileBody.patient.guardianPatientId, guardianBody.patient.id);
  assert.equal(profileBody.patient.guardianRelationship, "mother");
  assert.equal(profileBody.family.familyId, createdFamily.id);
  assert.equal(profileBody.family.family?.id, createdFamily.id);
  assert.equal(profileBody.family.guardianPatientId, guardianBody.patient.id);
  assert.equal(profileBody.family.guardianRelationship, "mother");
  assert.equal(
    profileBody.family.members.some((member) => member.patientId === childBody.patient.id && member.relationship === "child"),
    true
  );

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
  const queueBody = queueResponse.json() as Array<{
    id: number;
    prescriptionId: number;
    appointmentId: number;
    patientId: number;
    patientName: string;
    patient_code: string;
    nic: string | null;
    diagnosis: string | null;
    items: Array<{ drugName: string; quantity: string; inventoryItemId: number | null }>;
  }>;
  const queuedPrescription = queueBody.find((row) => row.prescriptionId === encounterBody.prescriptionId);
  assert.ok(queuedPrescription);
  assert.equal(queuedPrescription.appointmentId, appointment.id);
  assert.equal(queuedPrescription.patientId, patientId);
  assert.equal(typeof queuedPrescription.patientName, "string");
  assert.equal(typeof queuedPrescription.patient_code, "string");
  assert.equal(queuedPrescription.diagnosis?.includes("Acute viral fever"), true);
  assert.equal(queuedPrescription.items[0]?.drugName, "Paracetamol");
  assert.equal(queuedPrescription.items[0]?.quantity, "9");
  assert.equal(queuedPrescription.items[0]?.inventoryItemId, null);

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

  const appointmentAfterDispenseResponse = await app.inject({
    method: "GET",
    url: `/v1/appointments/${appointment.id}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(appointmentAfterDispenseResponse.statusCode, 200);
  const appointmentAfterDispense = appointmentAfterDispenseResponse.json() as { status: string };
  assert.equal(appointmentAfterDispense.status, "completed");
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

test("inventory search supports assistant dispense matching by drug name", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const loginBody = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createOne = await app.inject({
    method: "POST",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      sku: `PCM-500-${uniqueSuffix}`,
      name: `Paracetamol 500mg ${uniqueSuffix}`,
      category: "medicine",
      unit: "tablet",
      stock: 40,
      reorderLevel: 5
    }
  });
  assert.equal(createOne.statusCode, 201);

  const createTwo = await app.inject({
    method: "POST",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    },
    payload: {
      sku: `PCM-SYR-${uniqueSuffix}`,
      name: `Paracetamol Syrup ${uniqueSuffix}`,
      category: "medicine",
      unit: "bottle",
      stock: 15,
      reorderLevel: 3
    }
  });
  assert.equal(createTwo.statusCode, 201);

  const searchResponse = await app.inject({
    method: "GET",
    url: "/v1/inventory/search?q=Paracetamol&limit=10&category=medicine",
    headers: {
      authorization: `Bearer ${loginBody.accessToken}`
    }
  });

  assert.equal(searchResponse.statusCode, 200);
  const searchBody = searchResponse.json() as Array<{
    id: number;
    sku: string | null;
    name: string;
    category: string;
    unit: string;
    stock: string;
    isActive: boolean;
  }>;
  assert.equal(searchBody.length >= 2, true);
  assert.equal(searchBody.every((row) => row.category === "medicine"), true);
  assert.equal(searchBody.some((row) => row.name.includes("Paracetamol 500mg")), true);
  assert.equal(searchBody.some((row) => row.name.includes("Paracetamol Syrup")), true);

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
  const responseBody = response.json() as {
    user: {
      id: number;
      name: string;
      email: string;
      role: string;
      roles: string[];
      active_role: string;
      permissions: string[];
      workflow_profiles: {
        doctor: { mode: string } | null;
        assistant: { mode: string } | null;
        owner: { mode: string } | null;
      };
      extra_permissions: string[];
      created_at: string;
    };
  };
  assert.equal(responseBody.user.name, `Frontend User ${uniqueSuffix}`);
  assert.equal(responseBody.user.email, `frontend-user-${uniqueSuffix}@medsys.local`);
  assert.equal(responseBody.user.role, "assistant");
  assert.deepEqual(responseBody.user.roles, ["assistant"]);
  assert.equal(responseBody.user.active_role, "assistant");
  assert.deepEqual(responseBody.user.workflow_profiles, {
    doctor: null,
    assistant: { mode: "standard" },
    owner: null
  });
  assert.deepEqual(responseBody.user.extra_permissions, []);
  assert.equal(typeof responseBody.user.created_at, "string");
  const body = responseBody as { user: { permissions: string[] } };
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

test("owner can create and update a clinic-supported doctor workflow mode", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      firstName: "Clinic",
      lastName: `Doctor${uniqueSuffix}`,
      email: `clinic-doctor-${uniqueSuffix}@medsys.local`,
      password: "strong-pass-123",
      role: "doctor",
      doctorWorkflowMode: "clinic_supported",
      extraPermissions: ["inventory.write"]
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const createdBody = createResponse.json() as {
    user: {
      id: number;
      role: string;
      doctor_workflow_mode: string | null;
      extra_permissions: string[];
    };
  };
  assert.equal(createdBody.user.role, "doctor");
  assert.equal(createdBody.user.doctor_workflow_mode, "clinic_supported");
  assert.deepEqual(createdBody.user.extra_permissions, ["inventory.write"]);

  const updateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/users/${createdBody.user.id}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      doctorWorkflowMode: "self_service"
    }
  });

  assert.equal(updateResponse.statusCode, 200);
  const updatedBody = updateResponse.json() as {
    user: {
      doctor_workflow_mode: string | null;
    };
  };
  assert.equal(updatedBody.user.doctor_workflow_mode, "self_service");

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
  assertValidationEnvelope(response.json() as any, [
    {
      field: "extraPermissions",
      message: "Only assistant-support permissions can be granted: user.write"
    }
  ]);
  await app.close();
});

test("non-doctor users cannot receive doctor workflow mode", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const response = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      firstName: "Assistant",
      lastName: `Mode${uniqueSuffix}`,
      email: `assistant-mode-${uniqueSuffix}@medsys.local`,
      password: "strong-pass-123",
      role: "assistant",
      doctorWorkflowMode: "clinic_supported"
    }
  });

  assert.equal(response.statusCode, 400);
  assertValidationEnvelope(response.json() as any, [
    {
      field: "doctorWorkflowMode",
      message: "doctorWorkflowMode is only allowed for doctor users."
    }
  ]);

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

test("clinical icd10 endpoint falls back to curated suggestions when ICD10 provider is unavailable", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };

    const response = await app.inject({
      method: "GET",
      url: "/v1/clinical/icd10?terms=gas",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { suggestions: string[] };
    assert.equal(body.suggestions.length > 0, true);
    assert.equal(body.suggestions.some((item) => item.toLowerCase().includes("gas")), true);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical diagnoses endpoint returns normalized diagnosis objects", async () => {
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
      url: "/v1/clinical/diagnoses?terms=chol&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      diagnoses: [
        { code: "A00", codeSystem: "ICD-10-CM", display: "Cholera" },
        { code: "J18.9", codeSystem: "ICD-10-CM", display: "Pneumonia, unspecified organism" }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical diagnoses endpoint reuses cached terminology results for identical queries", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify([
          1,
          ["K29.70"],
          null,
          [["K29.70", "Gastritis, unspecified, without bleeding"]]
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    };

    const firstResponse = await app.inject({
      method: "GET",
      url: "/v1/clinical/diagnoses?terms=gas&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    const secondResponse = await app.inject({
      method: "GET",
      url: "/v1/clinical/diagnoses?terms=gas&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical diagnoses endpoint falls back to curated diagnoses when ICD10 provider is unavailable", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };

    const response = await app.inject({
      method: "GET",
      url: "/v1/clinical/diagnoses?terms=gas&limit=10",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      diagnoses: Array<{ code: string; codeSystem: string; display: string }>;
    };
    assert.equal(body.diagnoses.length > 0, true);
    assert.equal(body.diagnoses.some((item) => item.display.toLowerCase().includes("gas")), true);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical tests endpoint returns normalized loinc-like test objects", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          expansion: {
            contains: [
              {
                code: "4548-4",
                display: "Hemoglobin A1c/Hemoglobin.total in Blood"
              },
              {
                code: "1558-6",
                display: "Fasting glucose [Mass/volume] in Serum or Plasma"
              }
            ]
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );

    const response = await app.inject({
      method: "GET",
      url: "/v1/clinical/tests?terms=glucose&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      tests: [
        {
          code: "4548-4",
          codeSystem: "LOINC",
          display: "Hemoglobin A1c/Hemoglobin.total in Blood",
          category: null
        },
        {
          code: "1558-6",
          codeSystem: "LOINC",
          display: "Fasting glucose [Mass/volume] in Serum or Plasma",
          category: null
        }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical tests endpoint supports normalized clinical tables loinc search results", async () => {
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
          ["3016-3", "4548-4"],
          null,
          [
            ["3016-3", "Thyrotropin (TSH) [Units/volume] in Serum or Plasma"],
            ["4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood"]
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
      url: "/v1/clinical/tests?terms=TSH&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      tests: [
        {
          code: "3016-3",
          codeSystem: "LOINC",
          display: "Thyrotropin (TSH) [Units/volume] in Serum or Plasma",
          category: null
        },
        {
          code: "4548-4",
          codeSystem: "LOINC",
          display: "Hemoglobin A1c/Hemoglobin.total in Blood",
          category: null
        }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical tests endpoint filters out note and questionnaire style loinc noise", async () => {
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
          5,
          ["97711-6", "58302-1", "46021-2", "18708-8", "54533-5"],
          null,
          [
            ["97711-6", "Heart failure Outpatient Note"],
            ["58302-1", "Ever told by doctor that you had rheumatic heart or heart valve problems"],
            ["46021-2", "Heart or circulation diseases or conditions Set"],
            ["18708-8", "Heart rate"],
            ["54533-5", "Heart/circulation during assessment period [CMS Assessment]"]
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
      url: "/v1/clinical/tests?terms=heart&limit=10",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      tests: [
        {
          code: "18708-8",
          codeSystem: "LOINC",
          display: "Heart rate",
          category: null
        }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical tests endpoint falls back to curated tests when LOINC provider is unavailable", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    globalThis.fetch = async () => {
      throw new Error("provider offline");
    };

    const response = await app.inject({
      method: "GET",
      url: "/v1/clinical/tests?terms=glucose&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      tests: [
        {
          code: "1558-6",
          codeSystem: "LOINC",
          display: "Fasting glucose [Mass/volume] in Serum or Plasma",
          category: "laboratory"
        }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical tests endpoint serves cached provider results when the next provider call fails", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    globalThis.fetch = async () => {
      fetchCount += 1;

      if (fetchCount === 1) {
        return new Response(
          JSON.stringify([
            1,
            ["3016-3"],
            null,
            [["3016-3", "Thyrotropin (TSH) [Units/volume] in Serum or Plasma"]]
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error("provider offline");
    };

    const firstResponse = await app.inject({
      method: "GET",
      url: "/v1/clinical/tests?terms=TSH&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(firstResponse.statusCode, 200);

    const secondResponse = await app.inject({
      method: "GET",
      url: "/v1/clinical/tests?terms=TSH&limit=5",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(secondResponse.statusCode, 200);
    assert.deepEqual(secondResponse.json(), {
      tests: [
        {
          code: "3016-3",
          codeSystem: "LOINC",
          display: "Thyrotropin (TSH) [Units/volume] in Serum or Plasma",
          category: null
        }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("clinical recommended tests endpoint returns curated mappings for a diagnosis code", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
    const loginBody = await loginAs(app, "doctor@medsys.local");

    const response = await app.inject({
      method: "GET",
      url: "/v1/clinical/diagnoses/J45.909/recommended-tests",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      diagnosis: { code: string; codeSystem: string };
      source: string;
      tests: Array<{ code: string; codeSystem: string; display: string; category: string | null }>;
    };
    assert.equal(body.diagnosis.code, "J45.909");
    assert.equal(body.diagnosis.codeSystem, "ICD-10-CM");
    assert.equal(body.source, "curated");
    assert.equal(body.tests.some((test) => test.code === "20150-9"), true);
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
  assertValidationEnvelope(response.json() as any, [{ field: "unknownField", message: "Unknown field." }]);
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
  assertValidationEnvelope(response.json() as any, [{ field: "body", message: "At least one field must be provided." }]);
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
  assertValidationEnvelope(response.json() as any, [{ field: "extra", message: "Unknown field." }]);
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
  assertValidationEnvelope(response.json() as any, [{ field: "body", message: "At least one vital measurement must be provided" }]);
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

test("patient vitals can be updated through the correction endpoint", async () => {
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
      name: `Vitals Update ${uniqueSuffix} Patient`,
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
    heart_rate: number | null;
    temperature_c: number | null;
    recorded_at: string;
  };

  const updateVitalResponse = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${createBody.patient.id}/vitals/${createdVital.id}`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      heartRate: 88,
      temperatureC: 37.1,
      recordedAt: "2026-03-09T10:18:00Z"
    }
  });

  assert.equal(updateVitalResponse.statusCode, 200);
  const updatedVital = updateVitalResponse.json() as {
    id: number;
    patient_id: number;
    heart_rate: number | null;
    temperature_c: number | null;
    recorded_at: string;
    updated_at: string;
  };
  assert.equal(updatedVital.id, createdVital.id);
  assert.equal(updatedVital.patient_id, createBody.patient.id);
  assert.equal(updatedVital.heart_rate, 88);
  assert.equal(updatedVital.temperature_c, 37.1);
  assert.equal(updatedVital.recorded_at, "2026-03-09T10:18:00.000Z");
  assert.equal(typeof updatedVital.updated_at, "string");

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
    heart_rate: number | null;
    temperature_c: number | null;
    recorded_at: string;
  }>;
  assert.equal(vitals[0].id, createdVital.id);
  assert.equal(vitals[0].heart_rate, 88);
  assert.equal(vitals[0].temperature_c, 37.1);
  assert.equal(vitals[0].recorded_at, "2026-03-09T10:18:00.000Z");

  await app.close();
});

test("patient vitals patch rejects an empty body with validation envelope", async () => {
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
      name: `Vitals Empty Patch ${uniqueSuffix} Patient`,
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
      heartRate: 82,
      recordedAt: "2026-03-09T10:15:00Z"
    }
  });

  assert.equal(createVitalResponse.statusCode, 201);
  const createdVital = createVitalResponse.json() as { id: number };

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${createBody.patient.id}/vitals/${createdVital.id}`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 400);
  assertValidationEnvelope(response.json() as any, [{ field: "body", message: "At least one field must be provided" }]);
  await app.close();
});

test("patient vitals can be soft deleted and disappear from the list", async () => {
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
      name: `Vitals Delete ${uniqueSuffix} Patient`,
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
      spo2: 98,
      recordedAt: "2026-03-09T10:15:00Z"
    }
  });

  assert.equal(createVitalResponse.statusCode, 201);
  const createdVital = createVitalResponse.json() as { id: number };

  const deleteVitalResponse = await app.inject({
    method: "DELETE",
    url: `/v1/patients/${createBody.patient.id}/vitals/${createdVital.id}`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(deleteVitalResponse.statusCode, 200);
  assert.deepEqual(deleteVitalResponse.json(), {
    deleted: true,
    id: createdVital.id
  });

  const listVitalsResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${createBody.patient.id}/vitals`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(listVitalsResponse.statusCode, 200);
  const vitals = listVitalsResponse.json() as Array<{ id: number }>;
  assert.equal(vitals.some((row) => row.id === createdVital.id), false);

  const deleteAgainResponse = await app.inject({
    method: "DELETE",
    url: `/v1/patients/${createBody.patient.id}/vitals/${createdVital.id}`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(deleteAgainResponse.statusCode, 404);

  await app.close();
});

test("patient vitals reject encounter ids that belong to a different patient", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const assistantId = await getUserIdByEmail(app, ownerLogin.accessToken, "assistant", "assistant@medsys.local");
  const patientAId = await createPatientAs(app, ownerLogin.accessToken, `Encounter Link A ${Date.now()} Patient`);
  const patientBId = await createPatientAs(app, ownerLogin.accessToken, `Encounter Link B ${Date.now()} Patient`);

  const appointmentResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId: patientAId,
      doctorId,
      assistantId,
      scheduledAt: "2026-03-20T10:00:00Z"
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
      patientId: patientAId,
      doctorId,
      checkedAt: "2026-03-20T10:30:00Z",
      diagnoses: [],
      tests: []
    }
  });

  assert.equal(encounterResponse.statusCode, 201);
  const encounterBody = encounterResponse.json() as { encounterId: number };

  const createWrongEncounterResponse = await app.inject({
    method: "POST",
    url: `/v1/patients/${patientBId}/vitals`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      encounterId: encounterBody.encounterId,
      heartRate: 84,
      recordedAt: "2026-03-20T10:35:00Z"
    }
  });

  assert.equal(createWrongEncounterResponse.statusCode, 404);
  assert.deepEqual(createWrongEncounterResponse.json(), {
    error: "Encounter not found for patient"
  });

  const createVitalResponse = await app.inject({
    method: "POST",
    url: `/v1/patients/${patientBId}/vitals`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      heartRate: 80,
      recordedAt: "2026-03-20T10:36:00Z"
    }
  });

  assert.equal(createVitalResponse.statusCode, 201);
  const createdVital = createVitalResponse.json() as { id: number };

  const updateWrongEncounterResponse = await app.inject({
    method: "PATCH",
    url: `/v1/patients/${patientBId}/vitals/${createdVital.id}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      encounterId: encounterBody.encounterId
    }
  });

  assert.equal(updateWrongEncounterResponse.statusCode, 404);
  assert.deepEqual(updateWrongEncounterResponse.json(), {
    error: "Encounter not found for patient"
  });

  await app.close();
});

test("consultation workflow can quick-create a minor patient, map guardian by NIC, and save treatment data", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const guardianResponse = await app.inject({
    method: "POST",
    url: "/v1/patients",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      firstName: "Guardian",
      lastName: `Flow ${uniqueSuffix}`,
      dob: "1988-03-10",
      gender: "female",
      nic: `19880310${uniqueSuffix.slice(-4)}`,
      phone: "+94770000111"
    }
  });

  assert.equal(guardianResponse.statusCode, 201);
  const guardianBody = guardianResponse.json() as {
    patient: { id: number; family_id: number | null };
  };

  const consultationResponse = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      patientDraft: {
        name: `Child Flow ${uniqueSuffix}`,
        dateOfBirth: "2012-04-15",
        guardianName: "Guardian Flow",
        guardianNic: `19880310${uniqueSuffix.slice(-4)}`,
        guardianRelationship: "mother"
      },
      checkedAt: "2026-03-24T10:30:00Z",
      reason: "Walk-in consultation",
      notes: "Stable child visit",
      clinicalSummary: "Child reviewed for fever. Supportive care and hydration advised.",
      diagnoses: [
        { diagnosisName: "Acute viral fever", icd10Code: "B34.9" },
        { diagnosisName: "Childhood asthma", icd10Code: "J45.909", persistAsCondition: true }
      ],
      allergies: [{ allergyName: "Dust", severity: "moderate", isActive: true }],
      vitals: {
        heartRate: 92,
        temperatureC: 37.4
      },
      prescription: {
        items: [
          {
            drugName: "Paracetamol",
            dose: "250mg",
            frequency: "TID",
            duration: "3 days",
            quantity: 9,
            source: "clinical"
          }
        ]
      }
    }
  });

  assert.equal(consultationResponse.statusCode, 201);
  const consultationBody = consultationResponse.json() as {
    patient_created: boolean;
    patient: { id: number; family_id: number | null; guardian_patient_id: number | null };
    visit: { doctor_id: number | null };
    encounter_id: number;
    prescription_id: number | null;
    vital: { patient_id: number; encounter_id: number | null; heart_rate: number | null } | null;
  };

  assert.equal(consultationBody.patient_created, true);
  assert.equal(consultationBody.patient.guardian_patient_id, guardianBody.patient.id);
  assert.equal(consultationBody.patient.family_id, guardianBody.patient.family_id);
  assert.equal(consultationBody.visit.doctor_id, doctorId);
  assert.equal(typeof consultationBody.encounter_id, "number");
  assert.equal(typeof consultationBody.prescription_id, "number");
  assert.equal(consultationBody.vital?.patient_id, consultationBody.patient.id);
  assert.equal(consultationBody.vital?.encounter_id, consultationBody.encounter_id);
  assert.equal(consultationBody.vital?.heart_rate, 92);

  const familyResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${consultationBody.patient.id}/family`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(familyResponse.statusCode, 200);
  const familyBody = familyResponse.json() as {
    familyId: number | null;
    guardianPatientId: number | null;
    members: Array<{ patientId: number; relationship: string | null }>;
  };
  assert.equal(familyBody.familyId, guardianBody.patient.family_id);
  assert.equal(familyBody.guardianPatientId, guardianBody.patient.id);
  assert.equal(
    familyBody.members.some(
      (member) => member.patientId === consultationBody.patient.id && member.relationship === "child"
    ),
    true
  );

  const allergyResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${consultationBody.patient.id}/allergies`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(allergyResponse.statusCode, 200);
  const allergies = allergyResponse.json() as Array<{ allergyName: string; severity: string | null }>;
  assert.equal(allergies.some((row) => row.allergyName === "Dust" && row.severity === "moderate"), true);

  const profileResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${consultationBody.patient.id}/profile`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(profileResponse.statusCode, 200);
  const profileBody = profileResponse.json() as {
    family: { members: Array<{ patientId: number; relationship: string | null }> };
    conditions: Array<{ conditionName: string; icd10Code: string | null }>;
    timeline: Array<{ title: string; eventKind: string | null; description: string | null }>;
  };
  assert.equal(
    profileBody.family.members.some(
      (member) => member.patientId === consultationBody.patient.id && member.relationship === "child"
    ),
    true
  );
  assert.equal(
    profileBody.conditions.some(
      (condition) => condition.conditionName === "Childhood asthma" && condition.icd10Code === "J45.909"
    ),
    true
  );
  assert.equal(
    profileBody.timeline.some(
      (event) =>
        event.title === "Consultation completed" &&
        event.eventKind === "consultation" &&
        event.description?.includes("Child reviewed for fever") === true
    ),
    true
  );

  const consultationsResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${consultationBody.patient.id}/consultations`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(consultationsResponse.statusCode, 200);
  const consultationsBody = consultationsResponse.json() as {
    consultations: Array<{
      encounter_id: number;
      reason: string | null;
      diagnoses: Array<{ name: string; code: string | null }>;
      tests: Array<{ name: string; status: string }>;
      drugs: Array<{ name: string; source: string }>;
    }>;
  };
  const savedConsultation = consultationsBody.consultations.find(
    (consultation) => consultation.encounter_id === consultationBody.encounter_id
  );
  assert.ok(savedConsultation);
  assert.equal(savedConsultation?.reason, "Walk-in consultation");
  assert.equal(
    savedConsultation?.diagnoses.some((diagnosis) => diagnosis.name === "Acute viral fever"),
    true
  );
  assert.equal(savedConsultation?.tests.length, 0);
  assert.equal(savedConsultation?.drugs.some((drug) => drug.name === "Paracetamol" && drug.source === "clinical"), true);

  const historyResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${consultationBody.patient.id}/history`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(historyResponse.statusCode, 200);
  const historyBody = historyResponse.json() as {
    history: Array<{ note: string }>;
  };
  assert.equal(
    historyBody.history.some((entry) => entry.note === "Child reviewed for fever. Supportive care and hydration advised."),
    true
  );

  await app.close();
});

test("consultation workflow supports appointment mode with doctor-completed outcome", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Appointment Mode ${Date.now()} Patient`);

  const appointmentResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId,
      doctorId,
      scheduledAt: "2026-03-24T09:30:00Z",
      status: "waiting",
      priority: "normal",
      reason: "Scheduled review"
    }
  });

  assert.equal(appointmentResponse.statusCode, 201);
  const appointment = appointmentResponse.json() as { id: number };

  const consultationResponse = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      workflowType: "appointment",
      appointmentId: appointment.id,
      patientId,
      checkedAt: "2026-03-24T10:30:00Z",
      diagnoses: [{ diagnosisName: "Follow-up review", icd10Code: "Z09.9" }],
      prescription: {
        items: [
          {
            drugName: "Paracetamol",
            dose: "500mg",
            frequency: "TID",
            duration: "2 days",
            quantity: 6,
            source: "clinical"
          }
        ]
      }
    }
  });

  assert.equal(consultationResponse.statusCode, 201);
  const consultationBody = consultationResponse.json() as {
    patient_created: boolean;
    visit: { id: number; status: string };
    appointment_id: number | null;
    prescription_id: number | null;
    workflow_type: string;
    workflow_status: string;
    dispense_status: string;
    doctor_direct_dispense: boolean;
  };
  assert.equal(consultationBody.patient_created, false);
  assert.equal(consultationBody.visit.id, appointment.id);
  assert.equal(consultationBody.appointment_id, appointment.id);
  assert.equal(consultationBody.visit.status, "in_consultation");
  assert.equal(consultationBody.workflow_type, "appointment");
  assert.equal(consultationBody.workflow_status, "doctor_completed");
  assert.equal(consultationBody.dispense_status, "pending");
  assert.equal(consultationBody.doctor_direct_dispense, false);
  assert.equal(typeof consultationBody.prescription_id, "number");

  const queueResponse = await app.inject({
    method: "GET",
    url: "/v1/prescriptions/queue/pending-dispense",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(queueResponse.statusCode, 200);
  const queueBody = queueResponse.json() as Array<{
    id: number;
    prescriptionId: number;
    appointmentId: number;
    patientId: number;
    diagnosis: string | null;
    items: Array<{ drugName: string }>;
  }>;
  const queuedPrescription = queueBody.find((row) => row.prescriptionId === consultationBody.prescription_id);
  assert.ok(queuedPrescription);
  assert.equal(queuedPrescription.appointmentId, appointment.id);
  assert.equal(queuedPrescription.patientId, patientId);
  assert.equal(queuedPrescription.diagnosis?.includes("Follow-up review"), true);
  assert.equal(queuedPrescription.items[0]?.drugName, "Paracetamol");

  const appointmentAfterSave = await app.inject({
    method: "GET",
    url: `/v1/appointments/${appointment.id}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(appointmentAfterSave.statusCode, 200);
  const appointmentBody = appointmentAfterSave.json() as { status: string };
  assert.equal(appointmentBody.status, "in_consultation");

  await app.close();
});

test("consultation workflow completes appointment mode when prescription has outside items only", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Outside Only ${Date.now()} Patient`);

  const appointmentResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId,
      doctorId,
      scheduledAt: "2026-03-24T13:30:00Z",
      status: "waiting",
      priority: "normal",
      reason: "Outside pharmacy prescription"
    }
  });

  assert.equal(appointmentResponse.statusCode, 201);
  const appointment = appointmentResponse.json() as { id: number };

  const consultationResponse = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      workflowType: "appointment",
      appointmentId: appointment.id,
      patientId,
      checkedAt: "2026-03-24T14:00:00Z",
      prescription: {
        items: [
          {
            drugName: "Vitamin C",
            dose: "250mg",
            frequency: "OD",
            duration: "10 days",
            quantity: 10,
            source: "outside"
          }
        ]
      }
    }
  });

  assert.equal(consultationResponse.statusCode, 201);
  const consultationBody = consultationResponse.json() as {
    workflow_status: string;
    dispense_status: string;
    clinical_item_count: number;
    outside_item_count: number;
    prescription_id: number | null;
    visit: { status: string };
  };
  assert.equal(consultationBody.workflow_status, "completed");
  assert.equal(consultationBody.dispense_status, "none");
  assert.equal(consultationBody.clinical_item_count, 0);
  assert.equal(consultationBody.outside_item_count, 1);
  assert.equal(consultationBody.visit.status, "completed");
  assert.equal(typeof consultationBody.prescription_id, "number");

  const queueResponse = await app.inject({
    method: "GET",
    url: "/v1/prescriptions/queue/pending-dispense",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(queueResponse.statusCode, 200);
  const queueBody = queueResponse.json() as Array<{ prescriptionId: number }>;
  assert.equal(queueBody.some((row) => row.prescriptionId === consultationBody.prescription_id), false);

  await app.close();
});

test("pending dispense queue includes only clinical items for mixed prescriptions", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Mixed Source ${Date.now()} Patient`);

  const appointmentResponse = await app.inject({
    method: "POST",
    url: "/v1/appointments",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      patientId,
      doctorId,
      scheduledAt: "2026-03-24T15:00:00Z",
      status: "waiting",
      priority: "normal",
      reason: "Mixed prescription consultation"
    }
  });

  assert.equal(appointmentResponse.statusCode, 201);
  const appointment = appointmentResponse.json() as { id: number };

  const consultationResponse = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      workflowType: "appointment",
      appointmentId: appointment.id,
      patientId,
      checkedAt: "2026-03-24T15:15:00Z",
      diagnoses: [{ diagnosisName: "Hypertension", icd10Code: "I10" }],
      prescription: {
        items: [
          {
            drugName: "Paracetamol",
            dose: "500mg",
            frequency: "TID",
            duration: "3 days",
            quantity: 6,
            source: "clinical"
          },
          {
            drugName: "Vitamin C",
            dose: "250mg",
            frequency: "OD",
            duration: "10 days",
            quantity: 10,
            source: "outside"
          }
        ]
      }
    }
  });

  assert.equal(consultationResponse.statusCode, 201);
  const consultationBody = consultationResponse.json() as {
    workflow_status: string;
    dispense_status: string;
    clinical_item_count: number;
    outside_item_count: number;
    prescription_id: number | null;
  };
  assert.equal(consultationBody.workflow_status, "doctor_completed");
  assert.equal(consultationBody.dispense_status, "pending");
  assert.equal(consultationBody.clinical_item_count, 1);
  assert.equal(consultationBody.outside_item_count, 1);

  const queueResponse = await app.inject({
    method: "GET",
    url: "/v1/prescriptions/queue/pending-dispense",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(queueResponse.statusCode, 200);
  const queueBody = queueResponse.json() as Array<{
    prescriptionId: number;
    items: Array<{ drugName: string; source: string }>;
  }>;
  const queuedPrescription = queueBody.find((row) => row.prescriptionId === consultationBody.prescription_id);
  assert.ok(queuedPrescription);
  assert.equal(queuedPrescription.items.length, 1);
  assert.equal(queuedPrescription.items[0]?.drugName, "Paracetamol");
  assert.equal(queuedPrescription.items[0]?.source, "clinical");

  await app.close();
});

test("walk-in consultation save returns conflict when an active consultation already exists for the patient", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Active Walkin ${Date.now()} Patient`);

  const firstSave = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      workflowType: "walk_in",
      patientId,
      checkedAt: "2026-03-24T16:30:00Z",
      diagnoses: [{ diagnosisName: "Acute pain", icd10Code: "R52" }],
      prescription: {
        items: [
          {
            drugName: "Paracetamol",
            dose: "500mg",
            frequency: "TID",
            duration: "3 days",
            quantity: 6,
            source: "clinical"
          }
        ]
      }
    }
  });

  assert.equal(firstSave.statusCode, 201);

  const secondSave = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      workflowType: "walk_in",
      patientId,
      checkedAt: "2026-03-24T16:45:00Z",
      diagnoses: [{ diagnosisName: "Follow-up pain review", icd10Code: "R52" }]
    }
  });

  assert.equal(secondSave.statusCode, 409);
  assert.deepEqual(secondSave.json(), {
    error:
      "Active walk-in consultation already exists for this patient. Complete or dispense the current consultation before starting a new one."
  });

  await app.close();
});

test("consultation workflow can create a guardian patient from guardianDraft and link family automatically", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const uniqueSuffix = Date.now().toString();

  const response = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      patientDraft: {
        name: `Child Draft ${uniqueSuffix}`,
        dateOfBirth: "2014-05-20",
        guardianRelationship: "father"
      },
      guardianDraft: {
        name: `Saman Draft ${uniqueSuffix}`,
        dateOfBirth: "1985-08-12",
        nic: `19850812${uniqueSuffix.slice(-4)}`,
        gender: "male",
        phone: "+94770000333"
      },
      checkedAt: "2026-03-24T11:00:00Z",
      clinicalSummary: "Minor patient seen with newly captured guardian details.",
      diagnoses: [{ diagnosisName: "Upper respiratory tract infection", icd10Code: "J06.9" }]
    }
  });

  assert.equal(response.statusCode, 201);
  const body = response.json() as {
    patient: { id: number; family_id: number | null; guardian_patient_id: number | null };
  };

  assert.notEqual(body.patient.guardian_patient_id, null);
  assert.notEqual(body.patient.family_id, null);

  const childFamilyResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${body.patient.id}/family`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(childFamilyResponse.statusCode, 200);
  const childFamily = childFamilyResponse.json() as {
    familyId: number | null;
    guardianPatientId: number | null;
    members: Array<{ patientId: number; relationship: string | null }>;
  };

  assert.equal(childFamily.familyId, body.patient.family_id);
  assert.equal(childFamily.guardianPatientId, body.patient.guardian_patient_id);
  assert.equal(
    childFamily.members.some((member) => member.patientId === body.patient.id && member.relationship === "child"),
    true
  );
  assert.equal(
    childFamily.members.some(
      (member) => member.patientId === body.patient.guardian_patient_id && member.relationship === "father"
    ),
    true
  );

  const guardianDetailResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${body.patient.guardian_patient_id}`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(guardianDetailResponse.statusCode, 200);
  const guardianDetail = guardianDetailResponse.json() as {
    patient: { family_id: number | null };
  };
  assert.equal(guardianDetail.patient.family_id, body.patient.family_id);

  await app.close();
});

test("consultation workflow supports walk-in doctor direct dispense completion", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorLogin = await loginAs(app, "doctor@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");

  const inventoryResponse = await app.inject({
    method: "POST",
    url: "/v1/inventory",
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    },
    payload: {
      name: `Direct Dispense Stock ${Date.now()}`,
      category: "medicine",
      unit: "tablet",
      stock: 20,
      reorderLevel: 5
    }
  });

  assert.equal(inventoryResponse.statusCode, 201);
  const inventoryItem = inventoryResponse.json() as { id: number };

  const consultationResponse = await app.inject({
    method: "POST",
    url: "/v1/consultations/save",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    },
    payload: {
      workflowType: "walk_in",
      patientDraft: {
        name: `Direct Dispense ${Date.now()} Patient`,
        dateOfBirth: "1991-04-18"
      },
      checkedAt: "2026-03-24T12:30:00Z",
      diagnoses: [{ diagnosisName: "Acute pain", icd10Code: "R52" }],
      prescription: {
        items: [
          {
            drugName: "Ibuprofen",
            dose: "400mg",
            frequency: "BD",
            duration: "3 days",
            quantity: 6,
            source: "clinical"
          }
        ]
      },
      dispense: {
        mode: "doctor_direct",
        dispensedAt: "2026-03-24T12:35:00Z",
        notes: "Handed directly by doctor",
        items: [{ inventoryItemId: inventoryItem.id, quantity: 6 }]
      }
    }
  });

  assert.equal(consultationResponse.statusCode, 201);
  const consultationBody = consultationResponse.json() as {
    prescription_id: number | null;
    appointment_id: number | null;
    workflow_type: string;
    workflow_status: string;
    dispense_status: string;
    doctor_direct_dispense: boolean;
  };
  assert.equal(consultationBody.appointment_id, null);
  assert.equal(consultationBody.workflow_type, "walk_in");
  assert.equal(consultationBody.workflow_status, "completed");
  assert.equal(consultationBody.dispense_status, "completed");
  assert.equal(consultationBody.doctor_direct_dispense, true);
  assert.equal(typeof consultationBody.prescription_id, "number");

  const queueResponse = await app.inject({
    method: "GET",
    url: "/v1/prescriptions/queue/pending-dispense",
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(queueResponse.statusCode, 200);
  const queueBody = queueResponse.json() as Array<{ prescriptionId: number }>;
  assert.equal(queueBody.some((row) => row.prescriptionId === consultationBody.prescription_id), false);

  const prescriptionDetailResponse = await app.inject({
    method: "GET",
    url: `/v1/prescriptions/${consultationBody.prescription_id}`,
    headers: {
      authorization: `Bearer ${doctorLogin.accessToken}`
    }
  });

  assert.equal(prescriptionDetailResponse.statusCode, 200);
  const prescriptionDetail = prescriptionDetailResponse.json() as {
    dispenses: Array<{ assistantId: number; status: string }>;
  };
  assert.equal(prescriptionDetail.dispenses[0]?.assistantId, doctorId);
  assert.equal(prescriptionDetail.dispenses[0]?.status, "completed");

  await app.close();
});

test("encounter bundle can create initial vitals in the same workflow", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const assistantId = await getUserIdByEmail(app, ownerLogin.accessToken, "assistant", "assistant@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Encounter Vitals ${Date.now()} Patient`);

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
      scheduledAt: "2026-03-20T11:00:00Z"
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
      checkedAt: "2026-03-20T11:05:00Z",
      vitals: {
        bpSystolic: 120,
        bpDiastolic: 80,
        heartRate: 78,
        temperatureC: 37.2,
        spo2: 98
      },
      diagnoses: [],
      tests: []
    }
  });

  assert.equal(encounterResponse.statusCode, 201);
  const encounterBody = encounterResponse.json() as {
    encounterId: number;
    prescriptionId: number | null;
    vitalId: number | null;
  };
  assert.equal(typeof encounterBody.encounterId, "number");
  assert.equal(encounterBody.prescriptionId, null);
  assert.equal(typeof encounterBody.vitalId, "number");

  const listVitalsResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${patientId}/vitals`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(listVitalsResponse.statusCode, 200);
  const vitals = listVitalsResponse.json() as Array<{
    id: number;
    patient_id: number;
    encounter_id: number | null;
    bp_systolic: number | null;
    bp_diastolic: number | null;
    heart_rate: number | null;
    temperature_c: number | null;
    spo2: number | null;
  }>;
  assert.equal(vitals.length >= 1, true);
  assert.equal(vitals[0].id, encounterBody.vitalId);
  assert.equal(vitals[0].patient_id, patientId);
  assert.equal(vitals[0].encounter_id, encounterBody.encounterId);
  assert.equal(vitals[0].bp_systolic, 120);
  assert.equal(vitals[0].bp_diastolic, 80);
  assert.equal(vitals[0].heart_rate, 78);
  assert.equal(vitals[0].temperature_c, 37.2);
  assert.equal(vitals[0].spo2, 98);

  await app.close();
});

test("encounter bundle vitals default recordedAt to checkedAt when omitted", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const ownerLogin = await loginAs(app, "owner@medsys.local");
  const doctorId = await getUserIdByEmail(app, ownerLogin.accessToken, "doctor", "doctor@medsys.local");
  const assistantId = await getUserIdByEmail(app, ownerLogin.accessToken, "assistant", "assistant@medsys.local");
  const patientId = await createPatientAs(app, ownerLogin.accessToken, `Encounter Vitals Default ${Date.now()} Patient`);

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
      scheduledAt: "2026-03-20T12:00:00Z"
    }
  });

  assert.equal(appointmentResponse.statusCode, 201);
  const appointment = appointmentResponse.json() as { id: number };

  const checkedAt = "2026-03-20T12:05:00Z";
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
      checkedAt,
      vitals: {
        heartRate: 76
      },
      diagnoses: [],
      tests: []
    }
  });

  assert.equal(encounterResponse.statusCode, 201);
  const encounterBody = encounterResponse.json() as {
    encounterId: number;
    vitalId: number | null;
  };
  assert.equal(typeof encounterBody.vitalId, "number");

  const listVitalsResponse = await app.inject({
    method: "GET",
    url: `/v1/patients/${patientId}/vitals`,
    headers: {
      authorization: `Bearer ${ownerLogin.accessToken}`
    }
  });

  assert.equal(listVitalsResponse.statusCode, 200);
  const vitals = listVitalsResponse.json() as Array<{
    id: number;
    encounter_id: number | null;
    heart_rate: number | null;
    recorded_at: string;
  }>;
  assert.equal(vitals[0].id, encounterBody.vitalId);
  assert.equal(vitals[0].encounter_id, encounterBody.encounterId);
  assert.equal(vitals[0].heart_rate, 76);
  assert.equal(vitals[0].recorded_at, "2026-03-20T12:05:00.000Z");

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
  assertValidationEnvelope(response.json() as any, [{ field: "age", message: "Age does not match DOB." }]);
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
    user_id: number;
    name: string;
    email: string;
    role: string;
    roles: string[];
    active_role: string;
    doctor_workflow_mode: string | null;
    workflow_profiles: {
      doctor: { mode: string } | null;
      assistant: { mode: string } | null;
      owner: { mode: string } | null;
    };
    permissions: string[];
    extra_permissions: string[];
    created_at: string;
  };
  assert.equal(typeof body.id, "number");
  assert.equal(body.user_id, body.id);
  assert.equal(body.name.length > 0, true);
  assert.equal(body.email, "doctor@medsys.local");
  assert.equal(body.role, "doctor");
  assert.deepEqual(body.roles, ["doctor"]);
  assert.equal(body.active_role, "doctor");
  assert.equal(body.doctor_workflow_mode, "self_service");
  assert.deepEqual(body.workflow_profiles, {
    doctor: { mode: "self_service" },
    assistant: null,
    owner: null
  });
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
  assertValidationEnvelope(response.json() as any, [{ field: "extra", message: "Unknown field." }]);
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
  assertValidationEnvelope(response.json() as any, [{ field: "extra", message: "Unknown field." }]);
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
  assertValidationEnvelope(response.json() as any, [{ field: "extra", message: "Unknown field." }]);
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
