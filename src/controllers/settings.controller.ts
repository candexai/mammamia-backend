import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { AppError } from '../middleware/error.middleware';
import { settingsService } from '../services/settings.service';
import { successResponse } from '../utils/response.util';

export class SettingsController {
  // Public endpoint for widget settings (no auth required)
  // CRITICAL: widgetId === userId (validated in service)
  // NO FALLBACKS - fails loudly if settings not found
  getWidgetSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { widgetId } = req.params;

      // Service validates widgetId and throws if settings not found
      const settings = await settingsService.getWidgetSettings(widgetId);

      // Return only public-safe settings (no sensitive data)
      const greeting = settings.autoReplyMessage || 'Hello! How can I help you today?';
      res.json(successResponse({
        chatbotName: settings.chatbotName || 'Support Assistant',
        chatbotAvatar: settings.chatbotAvatar || null,
        primaryColor: settings.primaryColor || '#6366f1',
        autoReplyMessage: greeting,
        welcomeMessage: greeting, // Alias for widget compatibility
        language: settings.language || 'en'
      }));
    } catch (error) {
      next(error);
    }
  };

  getSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const settings = await settingsService.getSettings(req.user!._id);
      res.json(successResponse({ settings }));
    } catch (error) {
      next(error);
    }
  };

  updateSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      console.log('[Settings Update] userId:', req.user!._id);
      console.log('[Settings Update] Received data:', JSON.stringify(req.body, null, 2));

      const settings = await settingsService.updateSettings(req.user!._id, req.body);

      console.log('[Settings Update] Saved successfully');
      console.log('[Settings Update] defaultKnowledgeBaseName:', settings.defaultKnowledgeBaseName);

      res.json(successResponse({ settings }));
    } catch (error) {
      next(error);
    }
  };

  uploadChatbotAvatar = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError(400, 'VALIDATION_ERROR', 'No file uploaded');
      }

      const result = await settingsService.uploadChatbotAvatar(req.user!._id, req.file);
      res.json(successResponse(result, 'Chatbot avatar uploaded successfully'));
    } catch (error) {
      next(error);
    }
  };

  getOperators = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const operators = await settingsService.getOperators();
      res.json(successResponse({ operators }));
    } catch (error) {
      next(error);
    }
  };

  createOperator = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const operator = await settingsService.createOperator(req.body);
      res.json(successResponse({ operator }, 'Operator created successfully'));
    } catch (error) {
      next(error);
    }
  };

  updateOperator = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const operator = await settingsService.updateOperator(req.params.id, req.body);
      res.json(successResponse({ operator }, 'Operator updated successfully'));
    } catch (error) {
      next(error);
    }
  };

  deleteOperator = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await settingsService.deleteOperator(req.params.id);
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Save e-commerce integration credentials
   * POST /api/v1/settings/ecommerce-credentials
   */
  saveEcommerceCredentials = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id.toString();
      const { platform, base_url, api_key, api_secret, access_token } = req.body;

      console.log('[Settings Controller] Saving e-commerce credentials:', {
        userId,
        platform,
        base_url,
        has_api_key: !!api_key,
        has_api_secret: !!api_secret
      });

      if (!platform) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Platform is required'
          }
        });
      }

      const settings = await settingsService.saveEcommerceCredentials(userId, {
        platform,
        base_url,
        api_key,
        api_secret,
        access_token
      });

      console.log('[Settings Controller] ✅ E-commerce credentials saved successfully:', {
        platform,
        base_url,
        has_api_key: !!api_key,
        has_api_secret: !!api_secret
      });

      res.json(successResponse({ settings }, 'E-commerce credentials saved successfully'));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Delete e-commerce integration credentials
   * DELETE /api/v1/settings/ecommerce-credentials
   */
  deleteEcommerceCredentials = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id.toString();

      console.log('[Settings Controller] Deleting e-commerce credentials for userId:', userId);

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID not found'
          }
        });
      }

      const result = await settingsService.deleteEcommerceCredentials(userId);

      console.log('[Settings Controller] ✅ E-commerce credentials deleted successfully:', result);

      res.json(successResponse(result, 'E-commerce integration deleted successfully'));
    } catch (error) {
      next(error);
    }
  };
}

export const settingsController = new SettingsController();

