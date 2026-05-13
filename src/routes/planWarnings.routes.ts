import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { planWarningsService } from '../services/usage/planWarnings.service';
import { logger } from '../utils/logger.util';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/v1/plan-warnings
 * Get plan usage warnings for current user's organization
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = (req.user as any)?.organizationId;

    if (!organizationId) {
      // Plan and usage are org-scoped; JWT carries userId only — org comes from the User document (see authenticate middleware).
      res.status(200).json({
        success: true,
        data: { warnings: [], lockStatus: { locked: false, reason: null } }
      });
      return;
    }

    const { warnings, lockStatus } = await planWarningsService.getWarningsAndLockStatus(organizationId.toString());

    res.status(200).json({
      success: true,
      data: { warnings, lockStatus }
    });
  } catch (error: any) {
    logger.error('[Plan Warnings API] Error:', error.message);
    next(error);
  }
});

/**
 * POST /api/v1/plan-warnings/check
 * Check if user can perform an action
 */
router.post('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = (req.user as any)?.organizationId;
    const { action } = req.body;

    if (!organizationId) {
      res.status(200).json({
        success: true,
        data: { allowed: true }
      });
      return;
    }

    if (!action || !['call', 'chat', 'automation'].includes(action)) {
      res.status(400).json({
        success: false,
        message: 'Invalid action type'
      });
      return;
    }

    const result = await planWarningsService.canPerformAction(organizationId.toString(), action);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    logger.error('[Plan Warnings API] Error checking action:', error.message);
    next(error);
  }
});

export default router;
