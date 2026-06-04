import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import { AppError } from './error.middleware';

export interface AuthRequest extends Request {
  user?: any;
  file?: Express.Multer.File;
  files?: Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] };
}

/**
 * Avoids running heavy usage aggregation on every API call.
 * TTL is 5 minutes — lock status changes are rare events (plan upgrades / limit exhaustion).
 * When lock status changes (e.g. user upgrades), call clearOrgLockCache(orgId) to evict.
 */
const orgLockCache = new Map<
  string,
  { at: number; locked: boolean; reason: string | null }
>();
const ORG_LOCK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** One async usage+lock warm per org when usage cache is cold (avoids stampedes). */
const orgUsageLockWarmInFlight = new Set<string>();

export function clearOrgLockCache(organizationId: string): void {
  orgLockCache.delete(organizationId);
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'No token provided');
    }

    const token = authHeader.substring(7);

    const jwtSecret = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_in_production';
    const decoded: any = jwt.verify(token, jwtSecret);

    // JWT carries userId only; organizationId, role, and plan context always come from the User document.
    const user = await User.findById(decoded.userId).select('-passwordHash');

    if (!user || user.status !== 'active') {
      throw new AppError(401, 'UNAUTHORIZED', 'User not found or inactive');
    }

    req.user = user;

    // --- GLOBAL PLAN LOCK ENFORCEMENT ---
    // Intercept requests if organization limits are exceeded
    // Skip for admins
    if (user.role !== 'admin' && user.organizationId) {
      // Exempt core routes needed for upgrading and viewing lock status
      const path = req.originalUrl || req.path;
      const isExemptPath =
        path.includes('/profile') ||
        path.includes('/plan-warnings') ||
        path.includes('/plans') ||
        path.includes('/payment') ||
        path.includes('/auth') ||
        path.includes('/webhooks') ||
        // Read-only analytics — must load even when over lifetime usage (display only)
        (path.includes('/analytics') && req.method === 'GET');

      if (!isExemptPath) {
        const orgKey = user.organizationId.toString();
        const now = Date.now();
        const cached = orgLockCache.get(orgKey);

        if (cached && now - cached.at < ORG_LOCK_CACHE_TTL_MS) {
          if (cached.locked) {
            throw new AppError(
              403,
              'PLAN_LIMIT_EXCEEDED',
              cached.reason ||
                'Your organization is locked because you have exceeded your plan limits. Please upgrade to continue using our services.'
            );
          }
        } else {
          const { usageTrackerService } = await import('../services/usage/usageTracker.service');
          const peeked = await usageTrackerService.peekUsageFromCache(orgKey);

          if (peeked) {
            const lockStatus = await usageTrackerService.isOrganizationLocked(orgKey, peeked);
            orgLockCache.set(orgKey, {
              at: now,
              locked: lockStatus.locked,
              reason: lockStatus.reason
            });
            if (lockStatus.locked) {
              throw new AppError(
                403,
                'PLAN_LIMIT_EXCEEDED',
                lockStatus.reason ||
                  'Your organization is locked because you have exceeded your plan limits. Please upgrade to continue using our services.'
              );
            }
          } else {
            if (!orgUsageLockWarmInFlight.has(orgKey)) {
              orgUsageLockWarmInFlight.add(orgKey);
              void usageTrackerService
                .getOrganizationUsage(orgKey, true, { profileOnly: true })
                .then((usage) => usageTrackerService.isOrganizationLocked(orgKey, usage))
                .then((lock) => {
                  orgLockCache.set(orgKey, {
                    at: Date.now(),
                    locked: lock.locked,
                    reason: lock.reason
                  });
                })
                .catch(() => {
                  /* non-fatal; next request will retry warm */
                })
                .finally(() => {
                  orgUsageLockWarmInFlight.delete(orgKey);
                });
            }
            // Do not block the request on cold usage cache — lock is enforced once async warm completes.
          }
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Check if user has specific permission
export const authorize = (...permissions: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Not authenticated'));
    }

    if (req.user.role === 'admin') {
      return next(); // Admins have all permissions
    }

    const hasPermission = permissions.some(permission => 
      req.user.permissions.includes(permission)
    );

    if (!hasPermission) {
      return next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
    }

    next();
  };
};
