import { Router } from 'express';
import { AutomationController } from '../controllers/automation.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireUsage } from '../middleware/usageEnforcement.middleware';
import { checkPlanStatus, enforceAutomationsLimit } from '../middleware/planEnforcement.middleware';

const router = Router();
const controller = new AutomationController();

router.use(authenticate);
router.use(checkPlanStatus);

router.get('/', controller.getAll);
router.get('/:automationId', controller.getById);
// Enforce automation limit before creation
router.post('/', requireUsage('automations'), enforceAutomationsLimit, controller.create);
router.patch('/:automationId', controller.update);
router.delete('/:automationId', controller.delete);
router.patch('/:automationId/toggle', controller.toggle);
router.get('/:automationId/logs', controller.getExecutionLogs);
router.post('/:automationId/test', controller.test);
router.post('/whatsapp/test-template', controller.testWhatsAppTemplate);
router.post('/:automationId/trigger', controller.trigger);
router.post('/trigger-event', controller.triggerByEvent);
router.post('/run-batch', controller.runBatch);
router.post('/extract-data', controller.extractData);
router.post('/suggest-extraction-schema', controller.suggestExtractionSchema);

export default router;

