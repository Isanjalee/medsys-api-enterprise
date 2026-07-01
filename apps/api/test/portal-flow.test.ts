import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";

test("patient portal: signup -> profile -> link doctor -> reads sync to doctor side", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  try {
    const email = `patient_${Date.now()}@example.com`;

    // Sign up
    const signup = await app.inject({
      method: "POST",
      url: "/v1/portal/auth/signup",
      payload: { email, password: "portalPass123" }
    });
    assert.equal(signup.statusCode, 201);
    const signupBody = signup.json() as { accessToken: string; account: { profileCompleted: boolean } };
    assert.ok(signupBody.accessToken);
    assert.equal(signupBody.account.profileCompleted, false);
    const auth = { authorization: `Bearer ${signupBody.accessToken}` };

    // Linking before profile completion is blocked
    const early = await app.inject({
      method: "POST",
      url: "/v1/portal/doctors/link",
      headers: auth,
      payload: { doctorUserId: 1 }
    });
    assert.equal(early.statusCode, 409);

    // Complete profile
    const profile = await app.inject({
      method: "PUT",
      url: "/v1/portal/profile",
      headers: auth,
      payload: {
        firstName: "Portal",
        lastName: "Tester",
        dob: "1992-04-15",
        gender: "male",
        nic: `NIC${Date.now()}`.slice(0, 20),
        phone: "0770000000"
      }
    });
    assert.equal(profile.statusCode, 200);
    assert.equal((profile.json() as { profileCompleted: boolean }).profileCompleted, true);

    // Doctor directory should list the seeded clinic doctor
    const directory = await app.inject({ method: "GET", url: "/v1/portal/doctors/directory", headers: auth });
    assert.equal(directory.statusCode, 200);
    const doctors = directory.json() as Array<{ doctorUserId: number; name: string; organizationId: string }>;
    assert.ok(doctors.length >= 1, "expected at least one doctor in the directory");
    const doctor = doctors.find((d) => d.organizationId === ORGANIZATION_ID) ?? doctors[0];

    // Link the doctor -> creates a self-registered clinic record
    const link = await app.inject({
      method: "POST",
      url: "/v1/portal/doctors/link",
      headers: auth,
      payload: { doctorUserId: doctor.doctorUserId }
    });
    assert.equal(link.statusCode, 201);
    const linkBody = link.json() as { linkId: number; patientId: number };
    assert.ok(linkBody.patientId);

    // My doctors reflects the link
    const myDoctors = await app.inject({ method: "GET", url: "/v1/portal/doctors", headers: auth });
    assert.equal(myDoctors.statusCode, 200);
    const linked = myDoctors.json() as Array<{ patientId: number; status: string }>;
    assert.equal(linked.length, 1);
    assert.equal(linked[0].status, "self_registered");

    // Home + history read cleanly (empty until a consultation happens)
    const home = await app.inject({ method: "GET", url: "/v1/portal/home", headers: auth });
    assert.equal(home.statusCode, 200);
    assert.ok(Array.isArray((home.json() as { timeline: unknown[] }).timeline));

    const history = await app.inject({ method: "GET", url: "/v1/portal/history", headers: auth });
    assert.equal(history.statusCode, 200);

    // The self-registered patient shows up on the doctor side (org-scoped)
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "owner@medsys.local", password: "ChangeMe123!", organizationId: ORGANIZATION_ID }
    });
    assert.equal(ownerLogin.statusCode, 200);
    const ownerToken = (ownerLogin.json() as { accessToken: string }).accessToken;

    const docs = await app.inject({
      method: "GET",
      url: `/v1/documents/patient/${linkBody.patientId}`,
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(docs.statusCode, 200);
    assert.ok(Array.isArray(docs.json()));
  } finally {
    await app.close();
  }
});
