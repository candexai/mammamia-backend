import { Request, Response, NextFunction } from 'express';
import { planService } from '../services/plan.service';
import { logger } from '../utils/logger.util';

export class PlanController {
  /**
   * Create a new plan (Admin only)
   */
  async createPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const plan = await planService.createPlan(req.body);
      
      res.status(201).json({
        success: true,
        message: 'Plan created successfully',
        data: plan
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get all plans
   */
  async getAllPlans(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      const includeInactive = isAdmin && req.query.includeInactive === 'true';
      const plans = await planService.findAllPlans(includeInactive);
      
      res.status(200).json({
        success: true,
        data: plans
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get plan by ID
   */
  async getPlanById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const plan = await planService.findPlanById(req.params.id);
      
      res.status(200).json({
        success: true,
        data: plan
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update plan (Admin only)
   */
  async updatePlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const plan = await planService.updatePlan(req.params.id, req.body);
      
      res.status(200).json({
        success: true,
        message: 'Plan updated successfully',
        data: plan
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete plan (Admin only)
   */
  async deletePlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await planService.deletePlan(req.params.id);
      
      res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Assign plan to organization (Admin only)
   */
  async assignPlanToOrganization(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { organizationId, planId } = req.body;
      
      logger.info('Assign plan request received', { 
        organizationId, 
        planId, 
        body: req.body,
        bodyKeys: Object.keys(req.body || {}),
        organizationIdType: typeof organizationId,
        planIdType: typeof planId
      });
      
      if (!organizationId || organizationId === '' || organizationId === 'undefined') {
        logger.warn('Missing or invalid organization ID in request', { organizationId, type: typeof organizationId });
        res.status(400).json({
          success: false,
          message: 'Organization ID is required',
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: [{ field: 'organizationId', message: 'Organization ID is required and must be valid' }]
          }
        });
        return;
      }

      if (!planId || planId === '' || planId === 'undefined') {
        logger.warn('Missing or invalid plan ID in request', { planId, type: typeof planId });
        res.status(400).json({
          success: false,
          message: 'Plan ID is required',
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: [{ field: 'planId', message: 'Plan ID is required and must be valid' }]
          }
        });
        return;
      }

      const result = await planService.assignPlanToOrganization(organizationId, planId);
      
      logger.info('Plan assigned successfully', { organizationId, planId });
      
      res.status(200).json({
        success: true,
        message: 'Plan assigned successfully',
        data: result
      });
    } catch (error: any) {
      logger.error('Failed to assign plan', { 
        error: error.message, 
        stack: error.stack,
        organizationId: req.body.organizationId,
        planId: req.body.planId
      });
      next(error);
    }
  }
}

export const planController = new PlanController();
