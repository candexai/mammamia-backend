import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller';
import { authenticate } from '../middleware/auth.middleware';
import { avatarUpload } from '../config/multer';

const router = Router();

// Public widget settings endpoint (no auth required)
router.get('/widget/:widgetId', settingsController.getWidgetSettings);

// All other routes require authentication
router.use(authenticate);

// Settings routes
router.get('/', settingsController.getSettings);
router.patch('/', settingsController.updateSettings);
router.post('/chatbot-avatar', avatarUpload.single('file'), settingsController.uploadChatbotAvatar);

// E-commerce credentials
router.post('/ecommerce-credentials', settingsController.saveEcommerceCredentials);
router.delete('/ecommerce-credentials', settingsController.deleteEcommerceCredentials);

// Operator management routes
router.get('/operators', settingsController.getOperators);
router.post('/operators', settingsController.createOperator);
router.patch('/operators/:id', settingsController.updateOperator);
router.delete('/operators/:id', settingsController.deleteOperator);

export default router;

