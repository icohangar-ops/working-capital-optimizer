// Vendored from cubiczan-resilience (typescript/src). No npm registry available,
// so the needed primitives are copied here verbatim. Keep in sync upstream.
export {
  ResilienceError,
  isResilienceError,
  type ResilienceErrorKind,
  type ResilienceErrorOptions,
} from "./errors.js";

export { withTimeout } from "./timeout.js";

export { retry, computeBackoff, type RetryOptions } from "./retry.js";

export {
  safeFetch,
  type SafeFetchOptions,
  type AllowlistHook,
} from "./safeFetch.js";

export {
  SlidingWindowRateLimiter,
  type RateLimitOptions,
  type RateLimitResult,
} from "./rateLimit.js";

export {
  requireAuth,
  requireAuthResponse,
  type AuthResult,
  type RequireAuthOptions,
} from "./auth.js";
