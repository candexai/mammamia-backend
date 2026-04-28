import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { AutomationService } from '../services/automation.service';
import { profileService } from '../services/profile.service';
import { agentService } from '../services/agent.service';
import { successResponse, paginatedResponse } from '../utils/response.util';
import { AppError } from '../middleware/error.middleware';

export class AutomationController {
  private automationService: AutomationService;

  constructor() {
    this.automationService = new AutomationService();
  }

  getAll = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Get organizationId from user
      const organizationId = req.user?.organizationId || req.user?._id;
      const automations = await this.automationService.findAll(organizationId?.toString());
      res.json(successResponse(automations));
    } catch (error) {
      next(error);
    }
  };

  getById = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new Error('Organization ID not found');
      }
      const automation = await this.automationService.findById(req.params.automationId, organizationId.toString());
      res.json(successResponse(automation));
    } catch (error) {
      next(error);
    }
  };

  create = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Get organizationId from user
      const organizationId = req.user?.organizationId || req.user?._id;
      const userId = req.user?._id?.toString();
      if (!organizationId) {
        throw new Error('Organization ID not found');
      }

      // Add organizationId and userId to automation data
      const automationData = {
        ...req.body,
        organizationId: organizationId.toString(),
        userId: req.user?._id
      };

      const automation = await this.automationService.create(automationData);
      
      // Track automation usage after successful creation
      // Only count active automations
      if (userId && automationData.isActive !== false) {
        try {
          const { usageService } = await import('../services/usage.service');
          await usageService.incrementAutomations(userId, 1);
        } catch (usageError: any) {
          console.warn('[Automation Controller] Failed to track automation usage:', usageError.message);
          // Don't fail automation creation if usage tracking fails
        }
      }
      
      res.status(201).json(successResponse(automation, 'Automation created'));
    } catch (error) {
      next(error);
    }
  };

  update = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new Error('Organization ID not found');
      }
      const automation = await this.automationService.update(req.params.automationId, req.body, organizationId.toString());
      res.json(successResponse(automation, 'Automation updated'));
    } catch (error) {
      next(error);
    }
  };

  delete = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new Error('Organization ID not found');
      }
      const result = await this.automationService.delete(req.params.automationId, organizationId.toString());
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  toggle = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { isActive } = req.body;
      if (!req.user?._id) throw new Error('Organization ID not found');
      const userIdStr = req.user._id.toString();
      const organizationIdStr = await profileService.ensureOrganizationForUser(userIdStr);
      const automation = await this.automationService.toggle(req.params.automationId, isActive, organizationIdStr, userIdStr);
      res.json(successResponse(automation, `Automation ${isActive ? 'activated' : 'deactivated'}`));
    } catch (error) {
      next(error);
    }
  };

  getExecutionLogs = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page = 1, limit = 20, ...filters } = req.query;
      const result = await this.automationService.getExecutionLogs(
        req.params.automationId,
        Number(page),
        Number(limit),
        filters
      );
      res.json(paginatedResponse(
        result.items,
        result.pagination.page,
        result.pagination.limit,
        result.pagination.total
      ));
    } catch (error) {
      next(error);
    }
  };

  test = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.automationService.testAutomation(
        req.params.automationId,
        req.body.testData
      );
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  testWhatsAppTemplate = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      const userId = req.user?._id?.toString();

      if (!organizationId || !userId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization or user context not found');
      }

      const { to, templateName, languageCode, phoneNumberId, components, templateParams } = req.body || {};

      if (!to || !templateName || !languageCode) {
        throw new AppError(
          400,
          'MISSING_PARAMETERS',
          'to, templateName, and languageCode are required'
        );
      }

      const result = await this.automationService.testWhatsAppTemplate({
        organizationId: organizationId.toString(),
        userId,
        to: String(to).trim(),
        templateName: String(templateName).trim(),
        languageCode: String(languageCode).trim(),
        phoneNumberId: phoneNumberId ? String(phoneNumberId).trim() : undefined,
        components: Array.isArray(components) ? components : undefined,
        templateParams: Array.isArray(templateParams) ? templateParams : undefined
      });

      res.json(successResponse(result, 'WhatsApp template test sent via automation engine'));
    } catch (error) {
      next(error);
    }
  };

  trigger = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      const result = await this.automationService.triggerAutomation(
        req.params.automationId,
        req.body.triggerData,
        {
          userId: req.user?._id,
          organizationId: organizationId?.toString()
        }
      );
      res.json(successResponse(result, 'Automation triggered successfully'));
    } catch (error) {
      next(error);
    }
  };

  triggerByEvent = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { event, eventData } = req.body;
      const organizationId = req.user?.organizationId || req.user?._id;
      const result = await this.automationService.triggerByEvent(
        event,
        eventData,
        {
          userId: req.user?._id,
          organizationId: organizationId?.toString()
        }
      );
      res.json(successResponse(result, `${result.length} automation(s) triggered`));
    } catch (error) {
      next(error);
    }
  };

  runBatch = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { listId } = req.body;
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!organizationId) {
        throw new Error('Organization ID not found');
      }

      // Fetch all contacts in the list
      const ContactListMember = (await import('../models/ContactListMember')).default;
      const members = await ContactListMember.find({ listId });

      if (!members.length) {
        return res.status(400).json({ message: 'No contacts in list' });
      }

      const contactIds = members.map(m => m.contactId.toString());
      const Customer = (await import('../models/Customer')).default;
      const contacts = await Customer.find({ _id: { $in: contactIds } });

      const { automationId } = req.body;
      let agentId = process.env.DEFAULT_AGENT_ID;
      let phoneNumberId = process.env.DEFAULT_PHONE_NUMBER_ID;
      let automationName = 'Manual Batch';
      let sender_email = process.env.DEFAULT_SMTP_SENDER_EMAIL;

      if (automationId) {
        const Automation = (await import('../models/Automation')).default;
        const automation = await Automation.findById(automationId).lean();
        if (automation) {
          automationName = automation.name;
          const triggerNode = automation.nodes.find(n => n.service === 'batch_call' || n.service === 'keplero_mass_sending');
          if (triggerNode?.config) {
            const config = triggerNode.config as any;
            if (config.agent_id) agentId = config.agent_id;
            if (config.phone_number_id) phoneNumberId = config.phone_number_id;
          }
        }
      }

      // Resolve Phone Number to ElevenLabs ID (CRITICAL FIX)
      const PhoneNumber = (await import('../models/PhoneNumber')).default;
      const phoneNumberDoc = await PhoneNumber.findOne({
        $or: [
          { phone_number_id: phoneNumberId },
          { elevenlabs_phone_number_id: phoneNumberId }
        ],
        organizationId: new (await import('mongoose')).default.Types.ObjectId(organizationId.toString())
      }).lean();

      let elevenlabsPhoneNumberId = phoneNumberId;
      if (phoneNumberDoc) {
        elevenlabsPhoneNumberId = phoneNumberDoc.elevenlabs_phone_number_id || phoneNumberId;
      }

      // Resolve Sender Email (copied from BatchCallingController for consistency)
      try {
        const GoogleIntegration = (await import('../models/GoogleIntegration')).default;
        const googleIntegration = await GoogleIntegration.findOne({
          organizationId: new (await import('mongoose')).default.Types.ObjectId(organizationId.toString()),
          'services.gmail': true,
          status: 'active'
        }).lean();

        if (googleIntegration?.googleProfile?.email) {
          sender_email = googleIntegration.googleProfile.email;
        } else {
          const SocialIntegration = (await import('../models/SocialIntegration')).default;
          const socialIntegration = await SocialIntegration.findOne({
            organizationId: new (await import('mongoose')).default.Types.ObjectId(organizationId.toString()),
            platform: 'gmail',
            status: 'connected'
          }).lean();

          if (socialIntegration) {
            sender_email = socialIntegration.credentials?.email || socialIntegration.metadata?.email || sender_email;
          }
        }
      } catch (emailError: any) {
        console.warn('[Automation Controller] Error resolving sender email:', emailError.message);
      }

      if (!agentId || !elevenlabsPhoneNumberId) {
        return res.status(400).json({ message: 'Agent ID and Phone Number ID are required. Please configure the trigger node correctly.' });
      }

      console.log(`[Automation Controller] Running batch for automation: ${automationName}`, {
        agentId,
        phoneNumberId,
        elevenlabsPhoneNumberId,
        sender_email
      });

      // 1. Submit to Batch Calling Service (ElevenLabs)
      const { batchCallingService } = await import('../services/batchCalling.service');
      const batchParams = {
        agent_id: agentId,
        call_name: `${automationName} - ${new Date().toLocaleDateString()}`,
        recipients: contacts
          .filter(c => !!c.phone)
          .map(c => ({
            phone_number: c.phone!,
            name: String(c.name || 'Customer'),
            email: c.email,
            dynamic_variables: {
              name: String(c.name || 'Customer'),
              email: c.email
            }
          })),
        phone_number_id: elevenlabsPhoneNumberId,
        sender_email: sender_email
      };

      let batchResult;
      try {
        batchResult = await batchCallingService.submitBatchCall(batchParams);
      } catch (submitError: any) {
        // If 404, try re-registering the phone number
        if (submitError.statusCode === 404 && phoneNumberDoc && phoneNumberDoc.provider === 'twilio' && phoneNumberDoc.sid && phoneNumberDoc.token) {
          console.log('[Automation Controller] Phone number not found in API (404), attempting re-registration...');
          const { sipTrunkService } = await import('../services/sipTrunk.service');
          const reg = await sipTrunkService.registerTwilioPhoneNumberWithElevenLabs({
            label: phoneNumberDoc.label,
            phone_number: phoneNumberDoc.phone_number,
            sid: phoneNumberDoc.sid,
            token: phoneNumberDoc.token,
            supports_inbound: phoneNumberDoc.supports_inbound || false,
            supports_outbound: phoneNumberDoc.supports_outbound || false
          });

          // Update DB with new ID
          const PhoneNumber = (await import('../models/PhoneNumber')).default;
          await PhoneNumber.updateOne(
            { _id: phoneNumberDoc._id },
            { $set: { elevenlabs_phone_number_id: reg.phone_number_id } }
          );

          // Retry with new ID
          batchParams.phone_number_id = reg.phone_number_id;
          elevenlabsPhoneNumberId = reg.phone_number_id; // Keep updated for trigger event
          batchResult = await batchCallingService.submitBatchCall(batchParams);
          console.log('[Automation Controller] ✅ Batch call succeeded after re-registration');
        } else {
          throw submitError;
        }
      }

      // 2. Save BatchCall record
      const BatchCall = (await import('../models/BatchCall')).default;
      await BatchCall.create({
        userId: req.user?._id,
        organizationId: new (await import('mongoose')).default.Types.ObjectId(organizationId.toString()),
        batch_call_id: batchResult.id,
        name: batchResult.name,
        agent_id: agentId,
        status: batchResult.status,
        phone_number_id: elevenlabsPhoneNumberId,
        phone_provider: batchResult.phone_provider || 'elevenlabs',
        created_at_unix: batchResult.created_at_unix,
        scheduled_time_unix: batchResult.scheduled_time_unix,
        total_calls_scheduled: contacts.length,
        last_updated_at_unix: Date.now() / 1000,
        agent_name: batchResult.agent_name || 'AI Assistant',
        call_name: batchResult.name,
        recipients_count: contacts.length,
        automation_id: automationId ? new (await import('mongoose')).default.Types.ObjectId(automationId.toString()) : undefined
      });

      // 3. Trigger automation system with batch_call event (for legacy compatibility)

      await this.automationService.triggerByEvent('batch_call', {
        event: 'batch_call',
        source: 'list',
        listId,
        contactIds,
        agent_id: agentId,
        phone_number_id: elevenlabsPhoneNumberId,
        batch_id: batchResult.id,
        userId: req.user?._id,
        organizationId: organizationId.toString()
      }, {
        userId: req.user?._id,
        organizationId: organizationId.toString()
      });

      res.json({ success: true, contactCount: contactIds.length, batchId: batchResult.id });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Extract structured data from conversation using LLM
   * POST /api/v1/automation/extract-data
   * Body: { conversation_id: string, extraction_type?: string, extraction_prompt?: string, json_example?: object }
   * When extraction_prompt + json_example are provided, returns extracted_data matching json_example; otherwise uses extraction_type (appointment/lead).
   */
  extractData = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { conversation_id, extraction_type = 'appointment', extraction_prompt, json_example } = req.body;
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!conversation_id) {
        return res.status(400).json({
          success: false,
          error: 'conversation_id is required'
        });
      }

      if (!organizationId) {
        throw new Error('Organization ID not found');
      }

      const options =
        extraction_prompt && json_example && typeof json_example === 'object'
          ? { extraction_prompt, json_example }
          : undefined;

      const result = await this.automationService.extractConversationData(
        conversation_id,
        extraction_type,
        organizationId.toString(),
        options
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Suggest extraction_prompt and json_example from an agent's system prompt.
   * POST /api/v1/automation/suggest-extraction-schema
   * Body: { agent_id?: string, system_prompt?: string } — agent_id is MongoDB _id; if provided, fetches agent and uses its system_prompt.
   */
  suggestExtractionSchema = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { agent_id, system_prompt: bodyPrompt } = req.body;
      const organizationId = req.user?.organizationId || req.user?._id;
      const userId = req.user?.id || req.user?._id;

      if (!organizationId) {
        throw new Error('Organization ID not found');
      }

      let systemPrompt: string;
      if (bodyPrompt && typeof bodyPrompt === 'string' && bodyPrompt.trim()) {
        systemPrompt = bodyPrompt.trim();
      } else if (agent_id && typeof agent_id === 'string') {
        const agent = await agentService.getAgentById(agent_id, userId?.toString() || '');
        if (!agent || !(agent as any).system_prompt) {
          return res.status(404).json({
            success: false,
            error: 'Agent not found or has no system prompt'
          });
        }
        systemPrompt = (agent as any).system_prompt;
      } else {
        return res.status(400).json({
          success: false,
          error: 'Provide agent_id or system_prompt in body'
        });
      }

      const result = await this.automationService.suggestExtractionSchema(systemPrompt, organizationId.toString());
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };
}

export const automationController = new AutomationController();
