import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";

test("refresh token replay revokes the full token family", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
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
    const loginBody = loginResponse.json() as { refreshToken: string };

    const firstRefresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: {
        refreshToken: loginBody.refreshToken
      }
    });
    assert.equal(firstRefresh.statusCode, 200);
    const firstRefreshBody = firstRefresh.json() as { refreshToken: string };

    const replayAttempt = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: {
        refreshToken: loginBody.refreshToken
      }
    });
    assert.equal(replayAttempt.statusCode, 401);

    const familyRevokedAttempt = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: {
        refreshToken: firstRefreshBody.refreshToken
      }
    });
    assert.equal(familyRevokedAttempt.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("login brute-force lockout returns 429 after repeated failures", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const originalMaxAttempts = process.env.AUTH_LOGIN_MAX_ATTEMPTS;
  const originalLockoutSeconds = process.env.AUTH_LOGIN_LOCKOUT_SECONDS;
  process.env.AUTH_LOGIN_MAX_ATTEMPTS = "3";
  process.env.AUTH_LOGIN_LOCKOUT_SECONDS = "60";

  const app = await buildApp();

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
          email: "owner@medsys.local",
          password: "WrongPassword!",
          organizationId: ORGANIZATION_ID
        }
      });

      assert.equal(response.statusCode, 401);
    }

    const lockedResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "owner@medsys.local",
        password: "WrongPassword!",
        organizationId: ORGANIZATION_ID
      }
    });

    assert.equal(lockedResponse.statusCode, 429);
    assert.equal(lockedResponse.headers["retry-after"], "60");
  } finally {
    if (originalMaxAttempts === undefined) {
      delete process.env.AUTH_LOGIN_MAX_ATTEMPTS;
    } else {
      process.env.AUTH_LOGIN_MAX_ATTEMPTS = originalMaxAttempts;
    }

    if (originalLockoutSeconds === undefined) {
      delete process.env.AUTH_LOGIN_LOCKOUT_SECONDS;
    } else {
      process.env.AUTH_LOGIN_LOCKOUT_SECONDS = originalLockoutSeconds;
    }

    await app.close();
  }
});

test("observability surfaces expose metrics, traces, and PHI scrubbing", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();

  try {
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

    const overviewResponse = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });
    assert.equal(overviewResponse.statusCode, 200);

    const observabilityResponse = await app.inject({
      method: "GET",
      url: "/v1/analytics/observability",
      headers: {
        authorization: `Bearer ${loginBody.accessToken}`
      }
    });

    assert.equal(observabilityResponse.statusCode, 200);
    const observabilityBody = observabilityResponse.json() as {
      metrics: {
        routes: Array<{ route: string; count: number }>;
        recentTraces: Array<{ requestId: string; traceId: string; route: string; dbQueryCount: number }>;
      };
      security: { loginLockouts: number };
    };
    assert.equal(
      observabilityBody.metrics.routes.some(
        (route) => route.route === "/v1/analytics/overview" && route.count >= 1
      ),
      true
    );
    assert.equal(
      observabilityBody.metrics.recentTraces.some(
        (trace) =>
          trace.route === "/v1/analytics/overview" &&
          trace.requestId.length > 0 &&
          trace.traceId.length > 0 &&
          trace.dbQueryCount >= 1
      ),
      true
    );

    const metricsResponse = await app.inject({
      method: "GET",
      url: "/metrics"
    });
    assert.equal(metricsResponse.statusCode, 200);
    assert.equal(metricsResponse.body.includes("medsys_http_requests_total"), true);

    const phiCheckResponse = await app.inject({
      method: "GET",
      url: "/security/phi-check"
    });
    assert.equal(phiCheckResponse.statusCode, 200);
    assert.deepEqual(phiCheckResponse.json(), {
      scrubbedExample: {
        patient: {
          name: "[REDACTED]",
          nic: "[REDACTED]",
          phone: "[REDACTED]",
          address: "[REDACTED]"
        },
        password: "[REDACTED]"
      }
    });
  } finally {
    await app.close();
  }
});
