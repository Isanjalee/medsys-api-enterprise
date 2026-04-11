import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { organizations, userRoles, users } from "@medsys/db";
import { hasAllResolvedPermissions, normalizeRoles, type UserRole } from "@medsys/types";
import {
  authLoginSchema,
  authLoginWithSlugSchema,
  bootstrapOrganizationSchema,
  createUserFrontendSchema,
  createUserSchema,
  refreshTokenSchema,
  resolveOrganizationSchema,
  switchActiveRoleSchema
} from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { revokeRefreshTokens, rotateRefreshToken, signAccessToken, validateRefreshToken } from "../../lib/auth.js";
import { serializeAuthUser, serializeCreatedUser } from "../../lib/api-serializers.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { splitFullName } from "../../lib/names.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import {
  assertAssignableExtraPermissions,
  normalizeStoredRoles,
  normalizeStoredDoctorWorkflowMode,
  normalizeStoredExtraPermissions,
  resolveActiveRole,
  resolveDoctorWorkflowMode,
  resolveUserPermissionsForRoles,
  resolveUserPermissions
} from "../../lib/user-permissions.js";

const hasAnyKey = (value: unknown, keys: string[]): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );

const toSerializedUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  activeRole?: unknown;
  roles?: readonly UserRole[];
  doctorWorkflowMode: unknown;
  extraPermissions: unknown;
  createdAt?: Date;
}) => {
  const roles = normalizeStoredRoles(row.role, row.roles ?? []);
  const activeRole = resolveActiveRole(roles, row.activeRole as UserRole | null | undefined, row.role);
  const extraPermissions = normalizeStoredExtraPermissions(row.extraPermissions);
  const doctorWorkflowMode = normalizeStoredDoctorWorkflowMode(row.doctorWorkflowMode);
  return serializeAuthUser({
    ...row,
    roles,
    activeRole,
    doctorWorkflowMode,
    extraPermissions,
    permissions: resolveUserPermissionsForRoles(roles, extraPermissions)
  });
};

const buildAuthTokenPayload = (
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  user: ReturnType<typeof toSerializedUser>
) => ({
  accessToken,
  refreshToken,
  expiresIn,
  access_token: accessToken,
  refresh_token: refreshToken,
  expires_in: expiresIn,
  tokenType: "Bearer" as const,
  token_type: "Bearer" as const,
  user
});

const serializeOrganization = (row: {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  createdAt?: Date;
}) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  is_active: row.isActive,
  ...(row.createdAt ? { created_at: row.createdAt } : {})
});

const toSerializedCreatedUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  activeRole?: unknown;
  roles?: readonly UserRole[];
  doctorWorkflowMode: unknown;
  extraPermissions: unknown;
  createdAt: Date;
}) => {
  const roles = normalizeStoredRoles(row.role, row.roles ?? []);
  const activeRole = resolveActiveRole(roles, row.activeRole as UserRole | null | undefined, row.role);
  const extraPermissions = normalizeStoredExtraPermissions(row.extraPermissions);
  const doctorWorkflowMode = normalizeStoredDoctorWorkflowMode(row.doctorWorkflowMode);
  return serializeCreatedUser({
    ...row,
    roles,
    activeRole,
    doctorWorkflowMode,
    extraPermissions,
    permissions: resolveUserPermissionsForRoles(roles, extraPermissions)
  });
};

const normalizePayloadRoles = (payload: {
  role?: UserRole;
  roles?: UserRole[];
  activeRole?: UserRole | null;
}): { roles: UserRole[]; activeRole: UserRole } => {
  const roles = normalizeRoles(payload.roles ?? (payload.role ? [payload.role] : []));
  const activeRole = resolveActiveRole(roles, payload.activeRole, payload.role);
  return { roles, activeRole };
};

const loadRolesByUserIds = async (
  app: { db: { select: Function } },
  userIds: number[]
): Promise<Map<number, UserRole[]>> => {
  const roleMap = new Map<number, UserRole[]>();
  if (userIds.length === 0) {
    return roleMap;
  }

  const rows = await app.db
    .select({
      userId: userRoles.userId,
      role: userRoles.role
    })
    .from(userRoles)
    .where(inArray(userRoles.userId, userIds));

  for (const row of rows as Array<{ userId: number; role: UserRole }>) {
    const existing = roleMap.get(row.userId) ?? [];
    existing.push(row.role);
    roleMap.set(row.userId, normalizeRoles(existing));
  }

  return roleMap;
};

const getLoginThrottleKey = (request: {
  ip: string;
  body?: unknown;
}): string => {
  const body = request.body as Record<string, unknown> | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "unknown";
  const organizationId =
    typeof body?.organizationId === "string" ? body.organizationId.trim() : "unknown";

  return `${organizationId}:${email}:${request.ip}`;
};

const getScopedLoginThrottleKey = (input: { ip: string; email: string; scope: string }): string =>
  `${input.scope}:${input.email.trim().toLowerCase()}:${input.ip}`;

const authRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Auth", "AuthController", {
    "POST /login": {
      operationId: "AuthController_login",
      summary: "Authenticate user with organization ID and issue tokens",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password", "organizationId"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 1 },
          organizationId: { type: "string", format: "uuid" },
          roleHint: { type: "string", enum: ["owner", "doctor", "assistant"], nullable: true }
        }
      },
      bodyExamples: {
        seededOwner: {
          summary: "Seeded default clinic owner login (legacy org-id flow)",
          value: {
            email: "owner@medsys.local",
            password: "ChangeMe123!",
            organizationId: "11111111-1111-1111-1111-111111111111",
            roleHint: "owner"
          }
        },
        tenantOwner: {
          summary: "Tenant owner login with explicit organization ID",
          value: {
            email: "owner@sunrise.local",
            password: "ownerSun@123",
            organizationId: "742a1bcf-c8fd-49b3-b729-3c6d67c19979",
            roleHint: "owner"
          }
        }
      }
    },
    "POST /login-with-slug": {
      operationId: "AuthController_loginWithSlug",
      summary: "Authenticate user with organization slug and issue tokens",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password", "organizationSlug"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 1 },
          organizationSlug: { type: "string", minLength: 3, maxLength: 80 },
          roleHint: { type: "string", enum: ["owner", "doctor", "assistant"], nullable: true }
        }
      },
      bodyExamples: {
        tenantOwnerBySlug: {
          summary: "Recommended login flow for tenant apps",
          value: {
            email: "owner@sunrise.local",
            password: "ownerSun@123",
            organizationSlug: "sunrise-clinic",
            roleHint: "owner"
          }
        },
        doctorBySlug: {
          summary: "Doctor login by organization slug",
          value: {
            email: "doctor@sunrise.local",
            password: "doctorSun@123",
            organizationSlug: "sunrise-clinic",
            roleHint: "doctor"
          }
        }
      }
    },
    "POST /resolve-organization": {
      operationId: "AuthController_resolveOrganization",
      summary: "Resolve organization metadata by slug before login",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["organizationSlug"],
        properties: {
          organizationSlug: { type: "string", minLength: 3, maxLength: 80 }
        }
      },
      bodyExamples: {
        byClinicSlug: {
          summary: "Resolve tenant ID before login",
          value: {
            organizationSlug: "sunrise-clinic"
          }
        },
        shortSlug: {
          summary: "Simple slug variant",
          value: {
            organizationSlug: "sunrise"
          }
        }
      }
    },
    "POST /refresh": {
      operationId: "AuthController_refresh",
      summary: "Rotate refresh token and issue new tokens",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["refreshToken"],
        properties: {
          refreshToken: { type: "string", minLength: 20 }
        }
      },
      bodyExample: {
        refreshToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
      }
    },
    "POST /logout": {
      operationId: "AuthController_logout",
      summary: "Revoke active refresh tokens for the authenticated user"
    },
    "POST /register": {
      operationId: "AuthController_register",
      summary: "Register a user or bootstrap the first owner account",
      security: [],
      bodySchema: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["name", "email", "password", "role"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120 },
              email: { type: "string", format: "email", maxLength: 160 },
              password: { type: "string", minLength: 8, maxLength: 128 },
              role: { type: "string", enum: ["owner", "doctor", "assistant"] },
              roles: { type: "array", items: { type: "string", enum: ["owner", "doctor", "assistant"] } },
              activeRole: { type: "string", enum: ["owner", "doctor", "assistant"], nullable: true },
              doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
              extraPermissions: {
                type: "array",
                items: { type: "string", enum: ["patient.write", "appointment.create", "family.write", "inventory.write", "prescription.dispense"] }
              }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["firstName", "lastName", "email", "password", "role"],
            properties: {
              firstName: { type: "string", minLength: 1, maxLength: 80 },
              lastName: { type: "string", minLength: 1, maxLength: 80 },
              email: { type: "string", format: "email", maxLength: 160 },
              password: { type: "string", minLength: 8, maxLength: 128 },
              role: { type: "string", enum: ["owner", "doctor", "assistant"] },
              roles: { type: "array", items: { type: "string", enum: ["owner", "doctor", "assistant"] } },
              activeRole: { type: "string", enum: ["owner", "doctor", "assistant"], nullable: true },
              doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
              extraPermissions: {
                type: "array",
                items: { type: "string", enum: ["patient.write", "appointment.create", "family.write", "inventory.write", "prescription.dispense"] }
              }
            }
          }
        ]
      },
      bodyExamples: {
        frontend: {
          summary: "Frontend-compatible payload",
            value: {
              name: "System Owner",
              email: "owner@example.com",
              password: "owner-pass-123",
              role: "owner"
          }
        },
        backend: {
          summary: "Direct API payload",
            value: {
              firstName: "System",
              lastName: "Owner",
              email: "owner@example.com",
              password: "owner-pass-123",
              role: "owner"
            }
          },
          doctorSelfService: {
            summary: "Doctor self-service payload",
            value: {
              firstName: "Solo",
              lastName: "Doctor",
              email: "doctor-solo@example.com",
              password: "doctor-pass-123",
              roles: ["doctor"],
              activeRole: "doctor",
              doctorWorkflowMode: "self_service"
            }
          },
          doctorClinicSupported: {
            summary: "Doctor clinic-supported payload",
            value: {
              firstName: "Support",
              lastName: "Doctor",
              email: "doctor-support@example.com",
              password: "doctor-pass-123",
              roles: ["owner", "doctor"],
              activeRole: "doctor",
              doctorWorkflowMode: "clinic_supported",
              extraPermissions: ["inventory.write"]
            }
          }
        }
    },
    "POST /bootstrap-organization": {
      operationId: "AuthController_bootstrapOrganization",
      summary: "Create a new organization and bootstrap its first owner account",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["organizationName", "organizationSlug", "ownerName", "ownerEmail", "password"],
        properties: {
          organizationName: { type: "string", minLength: 2, maxLength: 160 },
          organizationSlug: { type: "string", minLength: 3, maxLength: 80 },
          ownerName: { type: "string", minLength: 2, maxLength: 120 },
          ownerEmail: { type: "string", format: "email", maxLength: 160 },
          password: { type: "string", minLength: 8, maxLength: 128 }
        }
      },
      bodyExample: {
        organizationName: "Sunrise Clinic",
        organizationSlug: "sunrise-clinic",
        ownerName: "Clinic Owner",
        ownerEmail: "owner@sunrise.local",
        password: "owner-pass-123"
      }
    },
    "GET /me": {
      operationId: "AuthController_me",
      summary: "Get the authenticated user profile"
    },
    "POST /active-role": {
      operationId: "AuthController_switchActiveRole",
      summary: "Switch the active role for the authenticated user",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["activeRole"],
        properties: {
          activeRole: { type: "string", enum: ["owner", "doctor", "assistant"] }
        }
      },
      bodyExamples: {
        switchToDoctor: {
          summary: "Switch to doctor workspace",
          value: {
            activeRole: "doctor"
          }
        },
        switchToOwner: {
          summary: "Switch to owner workspace",
          value: {
            activeRole: "owner"
          }
        }
      }
    },
    "GET /status": {
      operationId: "AuthController_status",
      summary: "Get authentication bootstrap status",
      security: []
    }
  });

  const getUserCount = async (): Promise<number> => {
    const result = await app.readDb
      .select({ count: sql<number>`count(*)` })
      .from(users);

    return Number(result[0]?.count ?? 0);
  };

  const issueLoginSuccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    found: {
      id: number;
      passwordHash: string;
      email: string;
      firstName: string;
      lastName: string;
      role: "owner" | "doctor" | "assistant";
      activeRole: UserRole | null;
      doctorWorkflowMode: "self_service" | "clinic_supported" | null;
      extraPermissions: unknown;
      createdAt: Date;
      organizationId: string;
      isActive: boolean;
    },
    organization?: {
      id: string;
      slug: string;
      name: string;
      isActive: boolean;
      createdAt?: Date;
    }
  ) => {
    const accessToken = await signAccessToken(app, {
      sub: String(found.id),
      role: found.role,
      organizationId: found.organizationId
    });
    const refreshToken = await rotateRefreshToken(app, found.id, found.organizationId);

    await writeAuditLog(request, {
      entityType: "auth",
      action: "login_success",
      entityId: found.id
    });

    const foundRoleMap = await loadRolesByUserIds(app, [found.id]);
    return reply.send({
      ...buildAuthTokenPayload(
        accessToken,
        refreshToken,
        app.env.ACCESS_TOKEN_TTL_SECONDS,
        toSerializedUser({
          ...found,
          roles: foundRoleMap.get(found.id) ?? [found.role]
        })
      ),
      ...(organization ? { organization: serializeOrganization(organization) } : {})
    });
  };

  app.post(
    "/resolve-organization",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      const body = parseOrThrowValidation(resolveOrganizationSchema, request.body);

      const organizationRows = await app.readDb
        .select({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
          isActive: organizations.isActive,
          createdAt: organizations.createdAt
        })
        .from(organizations)
        .where(eq(organizations.slug, body.organizationSlug))
        .limit(1);
      assertOrThrow(organizationRows.length === 1, 404, "Organization not found");
      assertOrThrow(organizationRows[0].isActive, 403, "Organization is inactive");

      return reply.send({
        organization: serializeOrganization(organizationRows[0])
      });
    }
  );

  app.post(
    "/login-with-slug",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      const body = parseOrThrowValidation(authLoginWithSlugSchema, request.body);
      const throttleKey = getScopedLoginThrottleKey({
        ip: request.ip,
        email: body.email,
        scope: `slug:${body.organizationSlug}`
      });
      const lockout = await app.securityService.isLoginLocked(throttleKey);
      if (lockout.locked) {
        reply.header("Retry-After", String(lockout.retryAfterSeconds));
      }
      assertOrThrow(!lockout.locked, 429, "Too many failed login attempts");

      const organizationRows = await app.readDb
        .select({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
          isActive: organizations.isActive,
          createdAt: organizations.createdAt
        })
        .from(organizations)
        .where(eq(organizations.slug, body.organizationSlug))
        .limit(1);

      if (organizationRows.length !== 1 || !organizationRows[0].isActive) {
        await app.securityService.registerLoginFailure(throttleKey);
        assertOrThrow(false, 401, "Invalid credentials");
      }

      const organization = organizationRows[0]!;
      const found = await app.db
        .select({
          id: users.id,
          passwordHash: users.passwordHash,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          activeRole: users.activeRole,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt,
          organizationId: users.organizationId,
          isActive: users.isActive
        })
        .from(users)
        .where(and(eq(users.email, body.email), eq(users.organizationId, organization.id)))
        .limit(1);

      if (found.length !== 1 || !verifyPassword(body.password, found[0].passwordHash)) {
        await app.securityService.registerLoginFailure(throttleKey);
        assertOrThrow(false, 401, "Invalid credentials");
      }

      assertOrThrow(found[0].isActive, 403, "User is inactive");
      await app.securityService.clearLoginFailures(throttleKey);

      return issueLoginSuccess(request, reply, found[0], organization);
    }
  );

  app.post(
    "/login",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      const body = parseOrThrowValidation(authLoginSchema, request.body);
      const lockout = await app.securityService.isLoginLocked(getLoginThrottleKey(request));
      if (lockout.locked) {
        reply.header("Retry-After", String(lockout.retryAfterSeconds));
      }
      assertOrThrow(!lockout.locked, 429, "Too many failed login attempts");

      const found = await app.db
        .select({
          id: users.id,
          passwordHash: users.passwordHash,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          activeRole: users.activeRole,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt,
          organizationId: users.organizationId,
          isActive: users.isActive
        })
        .from(users)
        .where(and(eq(users.email, body.email), eq(users.organizationId, body.organizationId)))
        .limit(1);

      if (found.length !== 1 || !verifyPassword(body.password, found[0].passwordHash)) {
        await app.securityService.registerLoginFailure(getLoginThrottleKey(request));
        assertOrThrow(false, 401, "Invalid credentials");
      }

      assertOrThrow(found[0].isActive, 403, "User is inactive");
      await app.securityService.clearLoginFailures(getLoginThrottleKey(request));
      return issueLoginSuccess(request, reply, found[0]);
    }
  );

  app.post("/refresh", async (request, reply) => {
    const body = parseOrThrowValidation(refreshTokenSchema, request.body);

    const payload = app.jwt.verify<{ tokenId: string; sub: string; organizationId: string }>(
      body.refreshToken
    );
    assertOrThrow(payload?.tokenId, 401, "Invalid refresh token");

    const tokenState = await validateRefreshToken(app, payload.tokenId);
    assertOrThrow(tokenState, 401, "Invalid refresh token");
    const validatedTokenState = tokenState!;

    const userRows = await app.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        activeRole: users.activeRole,
        doctorWorkflowMode: users.doctorWorkflowMode,
        extraPermissions: users.extraPermissions,
        createdAt: users.createdAt,
        isActive: users.isActive
      })
      .from(users)
      .where(eq(users.id, validatedTokenState.userId))
      .limit(1);
    assertOrThrow(userRows.length === 1 && userRows[0].isActive, 401, "User not found");
    const refreshedRoleMap = await loadRolesByUserIds(app, [userRows[0].id]);

    const accessToken = await signAccessToken(app, {
        sub: String(userRows[0].id),
        role: userRows[0].role,
        organizationId: validatedTokenState.organizationId
      });
    const refreshToken = await rotateRefreshToken(
      app,
      userRows[0].id,
      validatedTokenState.organizationId,
      {
        tokenId: validatedTokenState.tokenId,
        familyId: validatedTokenState.familyId
      }
    );

    return reply.send(
      buildAuthTokenPayload(
        accessToken,
        refreshToken,
        app.env.ACCESS_TOKEN_TTL_SECONDS,
        toSerializedUser({
          ...userRows[0],
          roles: refreshedRoleMap.get(userRows[0].id) ?? [userRows[0].role]
        })
      )
    );
  });

  app.post("/logout", { preHandler: app.authenticate }, async (request) => {
    const actor = request.actor!;

    await revokeRefreshTokens(app, actor.userId, actor.organizationId);

    await writeAuditLog(request, {
      entityType: "auth",
      action: "logout",
      entityId: actor.userId
    });

    return { success: true };
  });

  app.post(
    "/bootstrap-organization",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      const payload = parseOrThrowValidation(bootstrapOrganizationSchema, request.body);

      const existingOrgRows = await app.readDb
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, payload.organizationSlug))
        .limit(1);
      assertOrThrow(existingOrgRows.length === 0, 409, "Organization slug already exists");

      const nameParts = splitFullName(payload.ownerName);
      assertOrThrow(Boolean(nameParts.firstName && nameParts.lastName), 400, "Owner name must include first and last name");

      const bootstrapResult = await app.db.transaction(async (tx) => {
        const insertedOrganizations = await tx
          .insert(organizations)
          .values({
            slug: payload.organizationSlug,
            name: payload.organizationName
          })
          .returning({
            id: organizations.id,
            slug: organizations.slug,
            name: organizations.name,
            isActive: organizations.isActive,
            createdAt: organizations.createdAt
          });
        const organization = insertedOrganizations[0]!;

        const existingUserRows = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.organizationId, organization.id), eq(users.email, payload.ownerEmail)))
          .limit(1);
        assertOrThrow(existingUserRows.length === 0, 409, "User already exists");

        const insertedUsers = await tx
          .insert(users)
          .values({
            organizationId: organization.id,
            email: payload.ownerEmail,
            passwordHash: hashPassword(payload.password),
            firstName: nameParts.firstName,
            lastName: nameParts.lastName,
            role: "owner",
            activeRole: "owner",
            extraPermissions: []
          })
          .returning({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            role: users.role,
            activeRole: users.activeRole,
            doctorWorkflowMode: users.doctorWorkflowMode,
            extraPermissions: users.extraPermissions,
            createdAt: users.createdAt
          });
        const user = insertedUsers[0]!;

        await tx.insert(userRoles).values({
          userId: user.id,
          role: "owner"
        });

        return { organization, user };
      });

      const accessToken = await signAccessToken(app, {
        sub: String(bootstrapResult.user.id),
        role: bootstrapResult.user.role,
        organizationId: bootstrapResult.organization.id
      });
      const refreshToken = await rotateRefreshToken(app, bootstrapResult.user.id, bootstrapResult.organization.id);

      await writeAuditLog(request, {
        entityType: "organization",
        action: "bootstrap",
        entityId: null,
        payload: {
          organizationId: bootstrapResult.organization.id,
          organizationSlug: bootstrapResult.organization.slug,
          ownerUserId: bootstrapResult.user.id
        }
      });

      const user = toSerializedCreatedUser({
        ...bootstrapResult.user,
        roles: ["owner"]
      });

      return reply.code(201).send({
        organization: serializeOrganization(bootstrapResult.organization),
        ...buildAuthTokenPayload(accessToken, refreshToken, app.env.ACCESS_TOKEN_TTL_SECONDS, user)
      });
    }
  );

  app.post(
    "/register",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      const useFrontendPayload =
        hasAnyKey(request.body, ["name", "email", "password", "role"]) &&
        !hasAnyKey(request.body, ["firstName", "lastName"]);
      const parsedPayload = useFrontendPayload
        ? (() => {
            const frontendPayload = parseOrThrowValidation(createUserFrontendSchema, request.body);
            const nameParts = splitFullName(frontendPayload.name);
            return {
              firstName: nameParts.firstName,
              lastName: nameParts.lastName,
              email: frontendPayload.email,
              password: frontendPayload.password,
              role: frontendPayload.role,
              roles: frontendPayload.roles,
              activeRole: frontendPayload.activeRole,
              doctorWorkflowMode: frontendPayload.doctorWorkflowMode,
              extraPermissions: frontendPayload.extraPermissions ?? []
            };
          })()
        : parseOrThrowValidation(createUserSchema, request.body);
      const normalizedRoleState = normalizePayloadRoles(parsedPayload);
      const payload = {
        ...parsedPayload,
        role: normalizedRoleState.activeRole,
        roles: normalizedRoleState.roles,
        activeRole: normalizedRoleState.activeRole,
        doctorWorkflowMode: resolveDoctorWorkflowMode(normalizedRoleState.roles, parsedPayload.doctorWorkflowMode),
        extraPermissions: assertAssignableExtraPermissions(
          normalizedRoleState.roles,
          parsedPayload.extraPermissions ?? []
        )
      };
      const userCount = await getUserCount();

      let organizationId = app.env.ORGANIZATION_ID;
      let action = "register_bootstrap";

      if (userCount === 0) {
        if (!payload.roles.includes("owner")) {
          throw validationError([
            {
              field: "roles",
              message: "First registered user must include owner role."
            }
          ]);
        }
      } else {
        await app.authenticate(request);
        assertOrThrow(Boolean(request.actor), 401, "Unauthorized");
        assertOrThrow(hasAllResolvedPermissions(request.actor!.permissions, ["user.write"]), 403, "Forbidden");
        const actor = request.actor!;
        organizationId = actor.organizationId;
        action = "register";
      }

      if (userCount > 0) {
        const allowed = await app.securityService.consumeSensitiveAction(
          "user.write",
          request.actor!.role,
          `${organizationId}:${request.actor!.userId}`
        );
        assertOrThrow(allowed, 429, "Sensitive action rate limit exceeded");
      }

      const existing = await app.readDb
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), eq(users.email, payload.email)))
        .limit(1);
      assertOrThrow(existing.length === 0, 409, "User already exists");

      const inserted = await app.db
        .insert(users)
        .values({
          organizationId,
          email: payload.email,
          passwordHash: hashPassword(payload.password),
          firstName: payload.firstName,
          lastName: payload.lastName,
          role: payload.role,
          activeRole: payload.activeRole,
          doctorWorkflowMode: payload.doctorWorkflowMode,
          extraPermissions: payload.extraPermissions
        })
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          activeRole: users.activeRole,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        });

      if (payload.roles.length > 0) {
        await app.db.insert(userRoles).values(
          payload.roles.map((role) => ({
            userId: inserted[0].id,
            role
          }))
        );
      }

      const insertedRoleMap = await loadRolesByUserIds(app, [inserted[0].id]);

      await writeAuditLog(request, {
        entityType: "user",
        action,
        entityId: inserted[0].id
      });

      return reply.code(201).send({
        user: toSerializedCreatedUser({
          ...inserted[0],
          roles: insertedRoleMap.get(inserted[0].id) ?? payload.roles
        })
      });
    }
  );

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const actor = request.actor!;
    const rows = await app.readDb
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        activeRole: users.activeRole,
        doctorWorkflowMode: users.doctorWorkflowMode,
        extraPermissions: users.extraPermissions,
        createdAt: users.createdAt,
        isActive: users.isActive
      })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId)))
      .limit(1);

    assertOrThrow(rows.length === 1, 401, "User not found");
    assertOrThrow(rows[0].isActive, 403, "Inactive account");
    const meRoleMap = await loadRolesByUserIds(app, [rows[0].id]);

    return toSerializedUser({
      ...rows[0],
      roles: meRoleMap.get(rows[0].id) ?? [rows[0].role]
    });
  });

  app.post("/active-role", { preHandler: app.authenticate }, async (request) => {
    const actor = request.actor!;
    const payload = parseOrThrowValidation(switchActiveRoleSchema, request.body);
    assertOrThrow(actor.roles.includes(payload.activeRole), 400, "activeRole must be assigned to the user");

    const updatedRows = await app.db
      .update(users)
      .set({
        role: payload.activeRole,
        activeRole: payload.activeRole,
        updatedAt: new Date()
      })
      .where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId)))
      .returning({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        activeRole: users.activeRole,
        doctorWorkflowMode: users.doctorWorkflowMode,
        extraPermissions: users.extraPermissions,
        createdAt: users.createdAt,
        isActive: users.isActive
      });

    assertOrThrow(updatedRows.length === 1, 404, "User not found");
    assertOrThrow(updatedRows[0].isActive, 403, "Inactive account");

    await writeAuditLog(request, {
      entityType: "auth",
      action: "switch_active_role",
      entityId: actor.userId
    });

    return {
      user: toSerializedUser({
        ...updatedRows[0],
        roles: actor.roles
      })
    };
  });

  app.get("/status", async () => {
    const userCount = await getUserCount();

    return {
      bootstrapping: userCount === 0,
      users: userCount
    };
  });
};

export default authRoutes;
