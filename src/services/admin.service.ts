import Organization from '../models/Organization';
import User from '../models/User';
import Automation from '../models/Automation';
import AutomationExecution from '../models/AutomationExecution';
import GoogleIntegration from '../models/GoogleIntegration';
import SocialIntegration from '../models/SocialIntegration';
import Settings from '../models/Settings';
import Profile, { IProfile } from '../models/Profile';
import Conversation from '../models/Conversation';
import { logger } from '../utils/logger.util';
import { analyticsService } from './analytics/analytics.service';
import { usageTrackerService } from './usage/usageTracker.service';
import mongoose from 'mongoose';
import Plan from '../models/Plan';

const ADMIN_DASHBOARD_CACHE_TTL_SEC = 300;
const ADMIN_DASHBOARD_CACHE_KEY = 'admin:dashboard:counts:v1';
const ADMIN_USAGE_CACHE_KEY = 'admin:dashboard:usage:v1';

const localAdminCache = new Map<string, { value: any; expiresAt: number }>();

function getLocalCache(key: string): any | null {
  const entry = localAdminCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  if (entry) localAdminCache.delete(key);
  return null;
}

function setLocalCache(key: string, value: any, ttlSec = ADMIN_DASHBOARD_CACHE_TTL_SEC): void {
  localAdminCache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

async function redisGet(key: string): Promise<any | null> {
  try {
    const { default: redisClient, isRedisAvailable } = await import('../config/redis');
    if (isRedisAvailable()) {
      const raw = await redisClient.get(key);
      if (raw) return JSON.parse(raw);
    }
  } catch (_) { /* fall through */ }
  return null;
}

async function redisSet(key: string, value: any, ttlSec = ADMIN_DASHBOARD_CACHE_TTL_SEC): Promise<void> {
  try {
    const { default: redisClient, isRedisAvailable } = await import('../config/redis');
    if (isRedisAvailable()) {
      await redisClient.setEx(key, ttlSec, JSON.stringify(value));
    }
  } catch (_) { /* non-fatal */ }
}

export class AdminService {
  /**
   * Fast dashboard counts — countDocuments only, no usage aggregations.
   */
  async getDashboardCounts() {
    try {
      const cached = (await redisGet(ADMIN_DASHBOARD_CACHE_KEY)) ?? getLocalCache(ADMIN_DASHBOARD_CACHE_KEY);
      if (cached) return cached;

      const [
        totalOrganizations,
        activeOrganizations,
        totalUsers,
        totalAutomations,
        activeAutomations,
        totalExecutions,
        failedExecutions,
        googleIntegrations,
        whatsappIntegrations,
        instagramIntegrations,
        facebookIntegrations,
        ecommerceIntegrations
      ] = await Promise.all([
        Organization.countDocuments({ status: { $ne: 'deleted' } }).lean(),
        Organization.countDocuments({ status: 'active' }).lean(),
        User.countDocuments({ status: 'active' }).lean(),
        Automation.countDocuments().lean(),
        Automation.countDocuments({ isActive: true }).lean(),
        AutomationExecution.countDocuments().lean(),
        AutomationExecution.countDocuments({ status: 'failed' }).lean(),
        GoogleIntegration.countDocuments({ status: 'active' }).lean(),
        SocialIntegration.countDocuments({ platform: 'whatsapp', status: 'connected' }).lean(),
        SocialIntegration.countDocuments({ platform: 'instagram', status: 'connected' }).lean(),
        SocialIntegration.countDocuments({ platform: 'facebook', status: 'connected' }).lean(),
        Settings.countDocuments({ 'ecommerceIntegration.platform': { $exists: true, $ne: null } }).lean()
      ]);

      const result = {
        totalOrganizations,
        activeOrganizations,
        totalUsers,
        totalAutomations,
        activeAutomations,
        totalExecutions,
        failedExecutions,
        googleIntegrations,
        whatsappIntegrations,
        instagramIntegrations,
        facebookIntegrations,
        ecommerceIntegrations
      };

      await redisSet(ADMIN_DASHBOARD_CACHE_KEY, result);
      setLocalCache(ADMIN_DASHBOARD_CACHE_KEY, result);
      return result;
    } catch (error: any) {
      logger.error('Failed to get dashboard counts', { error: error.message });
      throw error;
    }
  }

  /**
   * Slow usage totals for admin dashboard cards (call minutes + chat conversations).
   */
  async getDashboardUsage() {
    try {
      const cached = (await redisGet(ADMIN_USAGE_CACHE_KEY)) ?? getLocalCache(ADMIN_USAGE_CACHE_KEY);
      if (cached) return cached;

      const [callMinutes, chatConversations] = await Promise.all([
        usageTrackerService.calculatePlatformCallMinutes(),
        usageTrackerService.calculatePlatformChatConversations()
      ]);

      const result = { callMinutes, chatConversations };
      await redisSet(ADMIN_USAGE_CACHE_KEY, result);
      setLocalCache(ADMIN_USAGE_CACHE_KEY, result);
      return result;
    } catch (error: any) {
      logger.error('Failed to get dashboard usage', { error: error.message });
      throw error;
    }
  }

  /**
   * Pre-warm usage cache on server start so first admin visit is fast.
   */
  async warmDashboardUsageCache(): Promise<void> {
    try {
      const existing = await redisGet(ADMIN_USAGE_CACHE_KEY);
      if (existing) {
        logger.info('[Admin] Dashboard usage cache already warm');
        return;
      }
      await this.getDashboardUsage();
      logger.info('[Admin] Dashboard usage cache warmed');
    } catch (error: any) {
      logger.warn('[Admin] Failed to warm dashboard usage cache', { error: error.message });
    }
  }

  /**
   * Platform usage totals for analytics (date-range aware). Not used by dashboard counts.
   */
  async getPlatformUsageTotals(dateRange?: { from?: Date; to?: Date }) {
    const fromKey = dateRange?.from?.toISOString() ?? 'all';
    const toKey = dateRange?.to?.toISOString() ?? 'all';
    const cacheKey = `admin:platform:usage:${fromKey}:${toKey}`;

    const cached = (await redisGet(cacheKey)) ?? getLocalCache(cacheKey);
    if (cached) return cached;

    const dr = dateRange?.from || dateRange?.to
      ? { dateFrom: dateRange.from, dateTo: dateRange.to }
      : undefined;
    const metrics = await analyticsService.getSimpleMetrics(undefined, undefined, dr);
    const result = {
      callMinutes: metrics.callMinutes,
      chatConversations: metrics.totalConversations
    };

    await redisSet(cacheKey, result);
    setLocalCache(cacheKey, result);
    return result;
  }

  /**
   * @deprecated Use getDashboardCounts + getDashboardUsage. Kept for backward compatibility.
   */
  async getDashboardMetrics() {
    try {
      const [counts, usage] = await Promise.all([
        this.getDashboardCounts(),
        this.getDashboardUsage()
      ]);

      return {
        ...counts,
        totalCallMinutes: usage.callMinutes,
        totalChatConversations: usage.chatConversations
      };
    } catch (error: any) {
      logger.error('Failed to get dashboard metrics', { error: error.message });
      throw error;
    }
  }

  /**
   * Get all automations across all organizations
   */
  async getAllAutomations(page = 1, limit = 20, filters: any = {}) {
    try {
      const query: any = {};

      if (filters.organizationId) {
        query.organizationId = filters.organizationId;
      }

      if (filters.status) {
        if (filters.status === 'active') {
          query.isActive = true;
        } else if (filters.status === 'inactive') {
          query.isActive = false;
        }
      }

      if (filters.search) {
        query.name = { $regex: filters.search, $options: 'i' };
      }

      const skip = (page - 1) * limit;
      const [automations, total] = await Promise.all([
        Automation.find(query)
          .populate('organizationId', 'name slug')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Automation.countDocuments(query)
      ]);

      const automationsWithDetails = automations.map((automation: any) => {
        const organization = automation.organizationId as any;
        const nodes = automation.nodes || [];
        const triggerNode = nodes.find((n: any) => n.type === 'trigger');

        return {
          _id: automation._id,
          name: automation.name,
          description: automation.description || '',
          organizationId: organization ? {
            _id: organization._id,
            name: organization.name,
            slug: organization.slug
          } : null,
          isActive: automation.isActive,
          nodeCount: nodes.length,
          triggerType: triggerNode?.serviceId || 'unknown',
          lastExecutedAt: automation.lastExecutedAt || null,
          executionCount: automation.executionCount || 0,
          createdAt: automation.createdAt,
          updatedAt: automation.updatedAt,
          nodes: nodes,
          edges: automation.edges || []
        };
      });

      return {
        items: automationsWithDetails,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      };
    } catch (error: any) {
      logger.error('Failed to get all automations', { error: error.message });
      throw error;
    }
  }

  /**
   * Get automation by ID
   */
  async getAutomationById(automationId: string) {
    try {
      const automation = await Automation.findById(automationId)
        .populate('organizationId', 'name slug')
        .lean();

      if (!automation) throw new Error('Automation not found');
      return automation;
    } catch (error: any) {
      logger.error('Failed to get automation by ID', { error: error.message });
      throw error;
    }
  }

  /**
   * Toggle automation status
   */
  async toggleAutomation(automationId: string, isActive: boolean) {
    try {
      const automation = await Automation.findByIdAndUpdate(
        automationId,
        { isActive },
        { new: true }
      );
      if (!automation) throw new Error('Automation not found');
      return automation;
    } catch (error: any) {
      logger.error('Failed to toggle automation', { error: error.message });
      throw error;
    }
  }

  /**
   * Get execution logs with filters
   */
  async getExecutionLogs(page = 1, limit = 20, filters: any = {}) {
    try {
      const query: any = {};
      if (filters.organizationId) query.organizationId = filters.organizationId;
      if (filters.automationId) query.automationId = filters.automationId;
      if (filters.status) query.status = filters.status;
      if (filters.dateFrom || filters.dateTo) {
        query.createdAt = {};
        if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
      }

      const skip = (page - 1) * limit;
      const [executions, total] = await Promise.all([
        AutomationExecution.find(query)
          .populate({
            path: 'automationId',
            select: 'name organizationId',
            populate: {
              path: 'organizationId',
              select: 'name slug',
              model: 'Organization'
            }
          })
          .sort({ executedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        AutomationExecution.countDocuments(query)
      ]);

      const items = executions.map((execution: any) => {
        const automation = execution.automationId as any;
        const organization = automation?.organizationId as any;
        return {
          _id: execution._id?.toString() || execution._id,
          automation: automation ? { _id: automation._id, name: automation.name } : null,
          organization: organization ? { _id: organization._id, name: organization.name } : null,
          status: execution.status,
          error: execution.errorMessage || (execution as any).error,
          executedAt: execution.executedAt || (execution as any).createdAt,
          triggerData: execution.triggerData
        };
      });

      return {
        items,
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit)
        }
      };
    } catch (error: any) {
      logger.error('Failed to get execution logs', { error: error.message });
      throw error;
    }
  }

  /**
   * Get execution by ID
   */
  async getExecutionById(executionId: string) {
    try {
      const execution = await AutomationExecution.findById(executionId)
        .populate({
          path: 'automationId',
          select: 'name organizationId',
          populate: {
            path: 'organizationId',
            select: 'name slug',
            model: 'Organization'
          }
        })
        .lean();
      if (!execution) throw new Error('Execution not found');
      return execution;
    } catch (error: any) {
      logger.error('Failed to get execution by ID', { error: error.message });
      throw error;
    }
  }

  /**
   * Rerun execution
   */
  async rerunExecution(executionId: string) {
    try {
      const execution = await AutomationExecution.findById(executionId).populate('automationId');
      if (!execution) throw new Error('Execution not found');

      const automation = execution.automationId as any;
      if (!automation || !automation.isActive) throw new Error('Automation not found or inactive');

      const { AutomationEngine } = await import('./automationEngine.service');
      const engine = new AutomationEngine();

      const organizationId = automation.organizationId ? automation.organizationId.toString() : '';

      await engine.executeAutomation(
        automation._id.toString(),
        execution.triggerData || {},
        organizationId
      );

      return { message: 'Execution queued for retry', executionId };
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Get integrations status
   */
  async getIntegrationsStatus() {
    try {
      const organizations = await Organization.find({ status: { $ne: 'deleted' } }).lean();
      const Settings = (await import('../models/Settings')).default;
      
      const statusByOrg = await Promise.all(
        organizations.map(async (org: any) => {
          const googleIntegration = await GoogleIntegration.findOne({ 
            organizationId: org._id, 
            status: 'active' 
          }).lean();
          
          const whatsappIntegration = await SocialIntegration.findOne({ 
            organizationId: org._id, 
            platform: 'whatsapp', 
            status: 'connected' 
          }).lean();
          
          const instagramIntegration = await SocialIntegration.findOne({ 
            organizationId: org._id, 
            platform: 'instagram', 
            status: 'connected' 
          }).lean();
          
          const facebookIntegration = await SocialIntegration.findOne({ 
            organizationId: org._id, 
            platform: 'facebook', 
            status: 'connected' 
          }).lean();
          
          const settings = await Settings.findOne({ organizationId: org._id }).lean();
          const ecommerceIntegration = settings?.ecommerceIntegration;

          return {
            organization: { 
              id: org._id.toString(), 
              name: org.name,
              slug: org.slug
            },
            google: {
              connected: !!googleIntegration,
              tokenExpiry: googleIntegration?.tokenExpiry,
              services: googleIntegration ? {
                gmail: googleIntegration.services?.gmail || false,
                sheets: googleIntegration.services?.sheets || false,
                calendar: googleIntegration.services?.calendar || false,
                drive: googleIntegration.services?.drive || false,
              } : undefined,
              lastSyncedAt: googleIntegration?.updatedAt
            },
            whatsapp: {
              connected: !!whatsappIntegration,
              webhookVerified: whatsappIntegration?.webhookVerified || false,
              lastSyncedAt: whatsappIntegration?.updatedAt
            },
            instagram: {
              connected: !!instagramIntegration,
              webhookVerified: instagramIntegration?.webhookVerified || false,
              lastSyncedAt: instagramIntegration?.updatedAt
            },
            facebook: {
              connected: !!facebookIntegration,
              webhookVerified: facebookIntegration?.webhookVerified || false,
              lastSyncedAt: facebookIntegration?.updatedAt
            },
            ecommerce: {
              connected: !!(ecommerceIntegration?.platform),
              platform: ecommerceIntegration?.platform || null,
              lastSyncedAt: settings?.updatedAt,
              enabledTriggers: 0 // Default to 0 as enabledTriggers is not in the Settings model
            }
          };
        })
      );
      return statusByOrg;
    } catch (error: any) {
      logger.error('Failed to get integrations status', { error: error.message });
      throw error;
    }
  }

  /**
   * Get all organizations with usage
   */
  async getOrganizations(filters: any = {}) {
    try {
      const query: any = {};
      if (filters.plan) query.plan = filters.plan;
      if (filters.status) query.status = filters.status;

      // Filter out deleted by default unless asked
      if (!query.status) query.status = { $ne: 'deleted' };

      const organizations = await Organization.find(query)
        .populate('ownerId', 'email firstName lastName')
        .populate('planId')
        .sort({ createdAt: -1 })
        .lean();

      return await Promise.all(organizations.map(async (org: any) => {
        let usage = { callMinutes: 0, chatMessages: 0, automations: 0 };
        try {
          usage = await usageTrackerService.getOrganizationUsage(org._id.toString());
        } catch (e) { }

        return {
          ...org,
          usage,
          planDetails: org.planId || { name: org.plan || 'free' }
        };
      }));
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Get organization usage
   */
  async getOrganizationUsage(organizationId?: string, dateRange?: { from?: Date; to?: Date }) {
    // Simplification for restore
    if (!organizationId) return [];
    return usageTrackerService.getOrganizationUsage(organizationId);
  }

  /**
   * Get user details
   */
  async getUserDetails(userId: string) {
    const user = await User.findById(userId).populate('organizationId').lean();
    if (!user) throw new Error('User not found');

    const profile = await Profile.findOne({ userId }).lean(); // Legacy profile lookup
    // OR fallback to organization profile
    let orgProfile = null;
    if (user.organizationId) {
      orgProfile = await Profile.findOne({ organizationId: (user.organizationId as any)._id }).lean();
    }

    return {
      user,
      profile: orgProfile || profile
    };
  }

  /**
   * Upgrade User Plan (Refactored)
   */
  async upgradeUserPlan(userId: string, profileType: string) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const plan = await Plan.findOne({ slug: profileType }).lean();
    if (!plan) throw new Error(`Invalid plan type: ${profileType}`);

    if (!user.organizationId) throw new Error('User has no organization');

    const org = await Organization.findById(user.organizationId);
    if (!org) throw new Error('Organization not found');

    // Update Org Plan
    org.plan = profileType;
    org.planId = plan._id as mongoose.Types.ObjectId;
    await org.save();

    // Update User Profile (selectedProfile)
    user.selectedProfile = profileType;
    await user.save();

    // Ensure profile exists for tracking
    let profile = await Profile.findOne({ organizationId: org._id });
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);

    if (!profile) {
      profile = await Profile.create({
        organizationId: org._id,
        billingCycleStart: now,
        billingCycleEnd: end,
        isActive: true,
        // Start fresh
        voiceMinutesUsed: 0,
        chatConversationsUsed: 0,
        automationsUsed: 0
      });
    } else {
      // RESET usage on Plan Upgrade (Fresh Start Policy)
      // This ensures they get the full benefit of the new plan immediately
      profile.voiceMinutesUsed = 0;
      profile.chatConversationsUsed = 0;
      profile.automationsUsed = 0;
      profile.billingCycleStart = now;
      profile.billingCycleEnd = end;
      await profile.save();
    }

    logger.info(`✅ Upgraded organization ${org._id} (User ${userId}) to plan ${profileType} and RESET usage.`);

    return {
      success: true,
      plan: plan.name,
      planId: plan._id,
      organizationId: org._id
    };
  }

  /**
   * Get all users
   */
  async getAllUsers(filters: any = {}) {
    const query: any = {};
    if (filters.role) query.role = filters.role;
    if (filters.status) query.status = filters.status;
    if (filters.search) {
      query.$or = [
        { email: { $regex: filters.search, $options: 'i' } },
        { firstName: { $regex: filters.search, $options: 'i' } },
      ];
    }
    return User.find(query).populate('organizationId').sort({ createdAt: -1 }).lean();
  }

  /**
   * Get Usage Reports
   */
  async getUsageReports(dateFrom?: string, dateTo?: string) {
    try {
      // Use metrics service
      const range = (dateFrom || dateTo) ? {
        dateFrom: dateFrom ? new Date(dateFrom) : undefined,
        dateTo: dateTo ? new Date(dateTo) : undefined
      } : undefined;

      // Get platform-wide metrics
      const adminMetrics = await analyticsService.getAdminMetrics(range);

      // Get all organizations for usage breakdown
      const organizations = await Organization.find({ status: { $ne: 'deleted' } }).lean();
      
      // Get usage by organization
      const usageByOrganization = await Promise.all(
        organizations.map(async (org: any) => {
          try {
            const orgMetrics = await analyticsService.getOrganizationMetrics(org._id.toString(), range);
            const userCount = await User.countDocuments({ organizationId: org._id, status: 'active' });
            
            return {
              _id: org._id.toString(),
              name: org.name,
              totalCallMinutes: orgMetrics.callMinutes || 0,
              totalChatConversations: orgMetrics.totalConversations || 0,
              userCount
            };
          } catch (error) {
            logger.error(`Failed to get metrics for org ${org._id}:`, error);
            return {
              _id: org._id.toString(),
              name: org.name,
              totalCallMinutes: 0,
              totalChatConversations: 0,
              userCount: 0
            };
          }
        })
      );

      // Get conversations by channel
      const conversationsByChannel: any = {};
      const conversations = await Conversation.find(range ? {
        createdAt: {
          ...(range.dateFrom && { $gte: range.dateFrom }),
          ...(range.dateTo && { $lte: range.dateTo })
        }
      } : {}).lean();

      conversations.forEach((conv: any) => {
        const channel = conv.channel || 'unknown';
        conversationsByChannel[channel] = (conversationsByChannel[channel] || 0) + 1;
      });

      return {
        totalCallMinutes: adminMetrics.platformWide.callMetrics.totalCallMinutes || 0,
        totalChatConversations: adminMetrics.platformWide.chatMetrics.totalConversations || 0,
        usageByOrganization,
        conversationsByChannel
      };
    } catch (error: any) {
      logger.error('Failed to get usage reports', { error: error.message });
      throw error;
    }
  }

  /**
   * Get Billing Overview
   */
  async getBillingOverview() {
    try {
      // 1. Get all plans
      const plans = await Plan.find().lean();
      const planMap = plans.reduce((acc, plan) => {
        acc[plan.slug] = plan;
        return acc;
      }, {} as Record<string, any>);

      // 2. Get STRICTLY ACTIVE organizations linked to a Plan
      const activeOrgs = await Organization.find({
        status: 'active'
      }).populate('planId').lean();

      // 3. Calculate Recurring Revenue
      const billingData = activeOrgs.map((org: any) => {
        // Source of truth is org.planId (from migration) -> fallback to org.plan -> fallback to free
        let plan = org.planId as any;
        if (!plan && planMap[org.plan]) plan = planMap[org.plan];

        const price = plan ? plan.price : 0;
        const planName = plan ? plan.slug : 'free';

        return {
          orgId: org._id,
          planName,
          price
        };
      });

      const revenueByPlan = billingData.reduce((acc, item) => {
        acc[item.planName] = (acc[item.planName] || 0) + item.price;
        return acc;
      }, {} as Record<string, number>);

      const countByPlan = billingData.reduce((acc, item) => {
        acc[item.planName] = (acc[item.planName] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const totalMRR = Object.values(revenueByPlan).reduce((sum, val) => sum + val, 0);

      return {
        planBreakdown: countByPlan,
        revenueBreakdown: revenueByPlan,
        totalMRR,
        totalActiveOrganizations: activeOrgs.length,
        organizationsWithBilling: activeOrgs
      };
    } catch (error: any) {
      logger.error('Failed to get billing overview', { error: error.message });
      throw error;
    }
  }

  async getSystemSettings() {
    return {
      platformName: 'Aistein',
      version: '1.0.0',
      features: {
        automations: true,
        voiceAgent: true,
        whatsapp: true,
        instagram: true,
        facebook: true,
        googleWorkspace: true,
        ecommerce: true
      }
    };
  }

  async updateSystemSettings(settings: any) {
    logger.info('System settings updated', { settings });
    return { success: true };
  }

  async getAuditLogs(filters: any = {}) {
    return { logs: [], total: 0, page: 1, limit: 50 };
  }

  async getSystemAlerts() {
    // Simple alerts
    const alerts: any[] = [];
    const failed = await AutomationExecution.countDocuments({
      status: 'failed',
      createdAt: { $gte: new Date(Date.now() - 86400000) }
    });
    if (failed > 10) alerts.push({ type: 'warning', title: 'High Failure Rate', message: `${failed} failures in 24h` });
    return { alerts, total: alerts.length };
  }
}

export const adminService = new AdminService();
