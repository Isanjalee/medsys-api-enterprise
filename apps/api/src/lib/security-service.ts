import { createClient } from "redis";
import type { AppEnv } from "@medsys/config";

type BucketState = {
  count: number;
  expiresAt: number;
};

type LoginFailureState = {
  count: number;
  lockedUntil: number | null;
};

type SensitiveAction = "prescription.dispense" | "inventory.write" | "user.write";

const REDIS_CONNECT_TIMEOUT_MS = 1500;

const SENSITIVE_LIMITS: Record<
  SensitiveAction,
  Partial<Record<"owner" | "doctor" | "assistant", number>>
> = {
  "prescription.dispense": { owner: 120, doctor: 60, assistant: 60 },
  "inventory.write": { owner: 240, assistant: 180 },
  "user.write": { owner: 40 }
};

export class SecurityService {
  private redis: ReturnType<typeof createClient> | null = null;
  private readonly memoryBuckets = new Map<string, BucketState>();
  private readonly memoryLockouts = new Map<string, LoginFailureState>();
  private readonly metrics = {
    loginLockouts: 0,
    sensitiveRateLimitDenials: 0
  };

  constructor(private readonly env: AppEnv) {}

  async connect(): Promise<void> {
    if (!this.env.REDIS_URL) {
      return;
    }

    const redis = createClient({
      url: this.env.REDIS_URL,
      socket: {
        reconnectStrategy: false,
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS
      }
    });

    redis.on("error", () => {
      this.redis = null;
    });

    try {
      await redis.connect();
      this.redis = redis;
    } catch {
      this.redis = null;
    }
  }

  async close(): Promise<void> {
    if (this.redis?.isOpen) {
      await this.redis.quit();
    }
  }

  async isLoginLocked(key: string): Promise<{ locked: boolean; retryAfterSeconds: number }> {
    const now = Date.now();

    if (this.redis?.isOpen) {
      const raw = await this.redis.get(`medsys:security:login:${key}`);
      if (!raw) {
        return { locked: false, retryAfterSeconds: 0 };
      }
      const parsed = JSON.parse(raw) as LoginFailureState;
      if (!parsed.lockedUntil || parsed.lockedUntil <= now) {
        return { locked: false, retryAfterSeconds: 0 };
      }
      return {
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((parsed.lockedUntil - now) / 1000))
      };
    }

    const state = this.memoryLockouts.get(key);
    if (!state || !state.lockedUntil || state.lockedUntil <= now) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntil - now) / 1000))
    };
  }

  async registerLoginFailure(key: string): Promise<void> {
    const now = Date.now();

    if (this.redis?.isOpen) {
      const redisKey = `medsys:security:login:${key}`;
      const raw = await this.redis.get(redisKey);
      const state: LoginFailureState = raw ? (JSON.parse(raw) as LoginFailureState) : { count: 0, lockedUntil: null };
      state.count += 1;
      if (state.count >= this.env.AUTH_LOGIN_MAX_ATTEMPTS) {
        state.lockedUntil = now + this.env.AUTH_LOGIN_LOCKOUT_SECONDS * 1000;
        this.metrics.loginLockouts += 1;
      }
      await this.redis.set(redisKey, JSON.stringify(state), {
        EX: this.env.AUTH_LOGIN_LOCKOUT_SECONDS
      });
      return;
    }

    const state = this.memoryLockouts.get(key) ?? { count: 0, lockedUntil: null };
    state.count += 1;
    if (state.count >= this.env.AUTH_LOGIN_MAX_ATTEMPTS) {
      state.lockedUntil = now + this.env.AUTH_LOGIN_LOCKOUT_SECONDS * 1000;
      this.metrics.loginLockouts += 1;
    }
    this.memoryLockouts.set(key, state);
  }

  async clearLoginFailures(key: string): Promise<void> {
    if (this.redis?.isOpen) {
      await this.redis.del(`medsys:security:login:${key}`);
      return;
    }
    this.memoryLockouts.delete(key);
  }

  async consumeSensitiveAction(action: SensitiveAction, role: "owner" | "doctor" | "assistant", principal: string): Promise<boolean> {
    const limit = SENSITIVE_LIMITS[action][role];
    if (!limit) {
      this.metrics.sensitiveRateLimitDenials += 1;
      return false;
    }

    const redisKey = `medsys:security:action:${action}:${role}:${principal}`;
    const expiresIn = this.env.SECURITY_SENSITIVE_WINDOW_SECONDS;
    const now = Date.now();

    if (this.redis?.isOpen) {
      const total = await this.redis.incr(redisKey);
      if (total === 1) {
        await this.redis.expire(redisKey, expiresIn);
      }
      if (total > limit) {
        this.metrics.sensitiveRateLimitDenials += 1;
        return false;
      }
      return true;
    }

    const bucket = this.memoryBuckets.get(redisKey);
    const activeBucket =
      !bucket || bucket.expiresAt <= now
        ? { count: 0, expiresAt: now + expiresIn * 1000 }
        : bucket;
    activeBucket.count += 1;
    this.memoryBuckets.set(redisKey, activeBucket);

    if (activeBucket.count > limit) {
      this.metrics.sensitiveRateLimitDenials += 1;
      return false;
    }

    return true;
  }

  getStats() {
    return {
      loginLockouts: this.metrics.loginLockouts,
      sensitiveRateLimitDenials: this.metrics.sensitiveRateLimitDenials,
      backend: this.redis?.isOpen ? "redis" : "memory"
    };
  }
}
