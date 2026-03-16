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

const createPatient = async (
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

test("critical flow: appointment -> encounter bundle -> prescription detail remains consistent", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
    const owner = await loginAs(app, "owner@medsys.local");
    const doctor = await loginAs(app, "doctor@medsys.local");
    const uniqueSuffix = Date.now().toString();
    const patientId = await createPatient(app, owner.accessToken, `Critical Flow ${uniqueSuffix}`);

    const appointmentResponse = await app.inject({
      method: "POST",
      url: "/v1/appointments",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      },
      payload: {
        patientId,
        scheduledAt: "2026-03-20T10:00:00Z",
        reason: "Critical flow check"
      }
    });

    assert.equal(appointmentResponse.statusCode, 201);
    const appointmentId = (appointmentResponse.json() as { id: number }).id;

    const doctorUsersResponse = await app.inject({
      method: "GET",
      url: "/v1/users?role=doctor",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });
    assert.equal(doctorUsersResponse.statusCode, 200);
    const doctorId = (doctorUsersResponse.json() as { users: Array<{ id: number; email: string }> }).users.find(
      (user) => user.email === "doctor@medsys.local"
    )?.id;
    assert.ok(doctorId);

    const encounterResponse = await app.inject({
      method: "POST",
      url: "/v1/encounters",
      headers: {
        authorization: `Bearer ${doctor.accessToken}`
      },
      payload: {
        appointmentId,
        patientId,
        doctorId,
        checkedAt: "2026-03-20T10:15:00Z",
        notes: "Critical flow encounter",
        diagnoses: [{ diagnosisName: "Acute viral fever", icd10Code: "B34.9" }],
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
    assert.ok(encounterBody.prescriptionId);

    const encounterDetail = await app.inject({
      method: "GET",
      url: `/v1/encounters/${encounterBody.encounterId}`,
      headers: {
        authorization: `Bearer ${doctor.accessToken}`
      }
    });

    assert.equal(encounterDetail.statusCode, 200);
    const detailBody = encounterDetail.json() as {
      encounter: { id: number };
      diagnoses: Array<{ diagnosisName: string }>;
      prescriptions: Array<{ id: number }>;
      prescriptionItems: Array<{ drugName: string }>;
    };
    assert.equal(detailBody.encounter.id, encounterBody.encounterId);
    assert.equal(detailBody.diagnoses[0]?.diagnosisName, "Acute viral fever");
    assert.equal(detailBody.prescriptions[0]?.id, encounterBody.prescriptionId);
    assert.equal(detailBody.prescriptionItems[0]?.drugName, "Paracetamol");

    const prescriptionDetail = await app.inject({
      method: "GET",
      url: `/v1/prescriptions/${encounterBody.prescriptionId}`,
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });

    assert.equal(prescriptionDetail.statusCode, 200);
    const prescriptionBody = prescriptionDetail.json() as {
      prescription: { id: number };
      items: Array<{ drugName: string; quantity: string }>;
    };
    assert.equal(prescriptionBody.prescription.id, encounterBody.prescriptionId);
    assert.equal(prescriptionBody.items[0]?.drugName, "Paracetamol");
    assert.equal(prescriptionBody.items[0]?.quantity, "9");
  } finally {
    await app.close();
  }
});

test("critical flow: prescription dispense creates inventory movement and closes the queue item", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
    const owner = await loginAs(app, "owner@medsys.local");
    const assistant = await loginAs(app, "assistant@medsys.local");
    const doctor = await loginAs(app, "doctor@medsys.local");
    const uniqueSuffix = Date.now().toString();
    const patientId = await createPatient(app, owner.accessToken, `Dispense Flow ${uniqueSuffix}`);

    const doctorUsersResponse = await app.inject({
      method: "GET",
      url: "/v1/users?role=doctor",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });
    assert.equal(doctorUsersResponse.statusCode, 200);
    const doctorId = (doctorUsersResponse.json() as { users: Array<{ id: number; email: string }> }).users.find(
      (user) => user.email === "doctor@medsys.local"
    )?.id;
    assert.ok(doctorId);

    const assistantUsersResponse = await app.inject({
      method: "GET",
      url: "/v1/users?role=assistant",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });
    assert.equal(assistantUsersResponse.statusCode, 200);
    const assistantId = (assistantUsersResponse.json() as { users: Array<{ id: number; email: string }> }).users.find(
      (user) => user.email === "assistant@medsys.local"
    )?.id;
    assert.ok(assistantId);

    const appointmentResponse = await app.inject({
      method: "POST",
      url: "/v1/appointments",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      },
      payload: {
        patientId,
        scheduledAt: "2026-03-21T09:00:00Z"
      }
    });
    assert.equal(appointmentResponse.statusCode, 201);
    const appointmentId = (appointmentResponse.json() as { id: number }).id;

    const encounterResponse = await app.inject({
      method: "POST",
      url: "/v1/encounters",
      headers: {
        authorization: `Bearer ${doctor.accessToken}`
      },
      payload: {
        appointmentId,
        patientId,
        doctorId,
        checkedAt: "2026-03-21T09:15:00Z",
        prescription: {
          items: [
            {
              drugName: "Paracetamol",
              dose: "500mg",
              frequency: "TID",
              duration: "3 days",
              quantity: 2,
              source: "clinical"
            }
          ]
        }
      }
    });
    assert.equal(encounterResponse.statusCode, 201);
    const prescriptionId = (encounterResponse.json() as { prescriptionId: number }).prescriptionId;

    const pendingQueueResponse = await app.inject({
      method: "GET",
      url: "/v1/prescriptions/queue/pending-dispense",
      headers: {
        authorization: `Bearer ${assistant.accessToken}`
      }
    });
    assert.equal(pendingQueueResponse.statusCode, 200);
    const queue = pendingQueueResponse.json() as Array<{ prescriptionId: number }>;
    assert.equal(queue.some((row) => row.prescriptionId === prescriptionId), true);

    const dispenseResponse = await app.inject({
      method: "POST",
      url: `/v1/prescriptions/${prescriptionId}/dispense`,
      headers: {
        authorization: `Bearer ${assistant.accessToken}`
      },
      payload: {
        assistantId,
        dispensedAt: "2026-03-21T09:20:00Z",
        status: "completed",
        items: [{ inventoryItemId: 1, quantity: 2 }]
      }
    });
    assert.equal(dispenseResponse.statusCode, 201);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/v1/prescriptions/${prescriptionId}`,
      headers: {
        authorization: `Bearer ${assistant.accessToken}`
      }
    });
    assert.equal(detailResponse.statusCode, 200);
    const detail = detailResponse.json() as {
      dispenses: Array<{ prescriptionId: number; assistantId: number }>;
    };
    assert.equal(detail.dispenses[0]?.prescriptionId, prescriptionId);
    assert.equal(detail.dispenses[0]?.assistantId, assistantId);

    const movementResponse = await app.inject({
      method: "GET",
      url: "/v1/inventory/1/movements",
      headers: {
        authorization: `Bearer ${owner.accessToken}`
      }
    });
    assert.equal(movementResponse.statusCode, 200);
    const movements = movementResponse.json() as Array<{
      inventoryItemId: number;
      movementType: string;
      referenceType: string | null;
      referenceId: number | null;
    }>;
    assert.equal(
      movements.some(
        (movement) =>
          movement.inventoryItemId === 1 &&
          movement.movementType === "out" &&
          movement.referenceType === "prescription" &&
          movement.referenceId === prescriptionId
      ),
      true
    );
  } finally {
    await app.close();
  }
});

test("role access matrix enforces critical allow and deny paths", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
    const owner = await loginAs(app, "owner@medsys.local");
    const doctor = await loginAs(app, "doctor@medsys.local");
    const assistant = await loginAs(app, "assistant@medsys.local");
    const patientId = await createPatient(app, owner.accessToken, `Matrix ${Date.now()}`);

    const cases = [
      {
        name: "owner can list users",
        accessToken: owner.accessToken,
        method: "GET" as const,
        url: "/v1/users",
        expectedStatus: 200
      },
      {
        name: "doctor cannot list users",
        accessToken: doctor.accessToken,
        method: "GET" as const,
        url: "/v1/users",
        expectedStatus: 403
      },
      {
        name: "assistant can create appointments",
        accessToken: assistant.accessToken,
        method: "POST" as const,
        url: "/v1/appointments",
        payload: {
          patientId,
          scheduledAt: "2026-03-22T09:00:00Z"
        },
        expectedStatus: 201
      },
      {
        name: "doctor cannot create appointments under current policy",
        accessToken: doctor.accessToken,
        method: "POST" as const,
        url: "/v1/appointments",
        payload: {
          patientId,
          scheduledAt: "2026-03-22T09:15:00Z"
        },
        expectedStatus: 403
      },
      {
        name: "assistant cannot create encounters",
        accessToken: assistant.accessToken,
        method: "POST" as const,
        url: "/v1/encounters",
        payload: {},
        expectedStatus: 403
      },
      {
        name: "assistant can access pending dispense queue",
        accessToken: assistant.accessToken,
        method: "GET" as const,
        url: "/v1/prescriptions/queue/pending-dispense",
        expectedStatus: 200
      },
      {
        name: "doctor cannot access pending dispense queue",
        accessToken: doctor.accessToken,
        method: "GET" as const,
        url: "/v1/prescriptions/queue/pending-dispense",
        expectedStatus: 403
      },
      {
        name: "owner can access audit logs",
        accessToken: owner.accessToken,
        method: "GET" as const,
        url: "/v1/audit/logs",
        expectedStatus: 200
      },
      {
        name: "assistant cannot access audit logs",
        accessToken: assistant.accessToken,
        method: "GET" as const,
        url: "/v1/audit/logs",
        expectedStatus: 403
      }
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: {
          authorization: `Bearer ${testCase.accessToken}`
        },
        payload: testCase.payload
      });

      assert.equal(response.statusCode, testCase.expectedStatus, testCase.name);
    }
  } finally {
    await app.close();
  }
});
