import Settings from '../models/Settings';
import User from '../models/User';
import { AppError } from '../middleware/error.middleware';
import { inboundAgentConfigService } from './inboundAgentConfig.service';
import { gcsService } from './gcs.service';

export class SettingsService {
  private isGcsChatbotAvatarUrl(url?: string | null): boolean {
    if (!url) return false;
    return /https:\/\/storage\.googleapis\.com\/.+\/chatbot-avatars\//.test(url);
  }

  /**
   * Get widget settings by widgetId (public access)
   * CRITICAL: widgetId IS userId (validated as ObjectId in controller)
   * NO FALLBACKS - must find settings for the exact userId
   * FAILS LOUDLY if settings not found
   */
  async getWidgetSettings(widgetId: string) {
    // CRITICAL: widgetId must be a valid ObjectId (validated in controller)
    // widgetId === userId (no mapping table exists)
    const mongoose = (await import('mongoose')).default;
    
    if (!mongoose.Types.ObjectId.isValid(widgetId)) {
      throw new AppError(400, 'INVALID_WIDGET_ID', `Invalid widget ID format: ${widgetId}`);
    }
    
    const userId = new mongoose.Types.ObjectId(widgetId);
    const settings = await Settings.findOne({ userId });
    
    if (!settings) {
      // CRITICAL: Fail loudly - do NOT return default settings
      throw new AppError(404, 'WIDGET_SETTINGS_NOT_FOUND', `Widget settings not found for widget ID: ${widgetId}. Please configure settings for this widget.`);
    }
    
    return settings;
  }

  /**
   * Get settings for a user (create default if doesn't exist)
   */
  async getSettings(userId: string) {
    let settings = await Settings.findOne({ userId });
    
    if (!settings) {
      // Create default settings
      settings = await Settings.create({
        userId,
        chatbotName: 'AI Assistant',
        primaryColor: '#6366f1',
        widgetPosition: 'right',
        language: 'en',
        emailNotifications: true,
        soundNotifications: true
      });
    }
    
    return settings;
  }

  /**
   * Update settings
   */
  async updateSettings(userId: string, data: any) {
    let settings = await Settings.findOne({ userId });
    
    if (!settings) {
      // Create if doesn't exist
      settings = await Settings.create({
        userId,
        ...data
      });
    } else {
      // Update existing - use MongoDB $set for arrays to ensure proper replacement
      const { ecommerceIntegration, defaultKnowledgeBaseNames, defaultKnowledgeBaseIds, ...safeData } = data;
      
      // Use $set operator for array fields to ensure proper replacement (not merge)
      const updateData: any = { ...safeData };
      
      // Explicitly handle array fields with $set
      if (defaultKnowledgeBaseNames !== undefined) {
        updateData.defaultKnowledgeBaseNames = defaultKnowledgeBaseNames;
      }
      
      if (defaultKnowledgeBaseIds !== undefined) {
        updateData.defaultKnowledgeBaseIds = defaultKnowledgeBaseIds;
      }
      
      // Use updateOne with $set for proper array handling
      await Settings.updateOne(
        { userId },
        { $set: updateData }
      );
      
      // Reload settings to return updated document
      settings = await Settings.findOne({ userId });
      
      // Ensure settings is not null (should always exist after update)
      if (!settings) {
        throw new AppError(500, 'SETTINGS_ERROR', 'Failed to update settings');
      }
    }
    
    // Sync inbound agent config if knowledge base settings were updated
    if (data.defaultKnowledgeBaseNames !== undefined || data.language !== undefined) {
      try {
        console.log('[Settings Service] Syncing inbound agent config...');
        await inboundAgentConfigService.syncConfig(userId);
        console.log('[Settings Service] Inbound agent config synced successfully');
      } catch (error) {
        console.error('[Settings Service] Failed to sync inbound agent config:', error);
        // Don't throw error, just log it
      }
    }
    
    return settings;
  }

  /**
   * Upload chatbot avatar to GCS and persist URL in settings
   */
  async uploadChatbotAvatar(
    userId: string,
    file: Express.Multer.File
  ): Promise<{ avatarUrl: string; settings: any }> {
    if (!file) {
      throw new AppError(400, 'VALIDATION_ERROR', 'No file uploaded');
    }

    let settings = await Settings.findOne({ userId });

    const avatarUrl = await gcsService.uploadFile(
      file.buffer,
      file.originalname,
      file.mimetype,
      'chatbot-avatars'
    );

    // Best-effort cleanup of previous chatbot avatar if it was stored in our GCS folder
    if (settings?.chatbotAvatar && this.isGcsChatbotAvatarUrl(settings.chatbotAvatar)) {
      try {
        await gcsService.deleteFile(settings.chatbotAvatar);
      } catch (error) {
        console.warn('[Settings Service] Failed to delete previous chatbot avatar:', error);
      }
    }

    if (!settings) {
      settings = await Settings.create({
        userId,
        chatbotAvatar: avatarUrl
      });
    } else {
      settings.chatbotAvatar = avatarUrl;
      await settings.save();
    }

    return { avatarUrl, settings };
  }

  /**
   * Save e-commerce integration credentials
   * Also syncs to InboundAgentConfig
   */
  async saveEcommerceCredentials(
    userId: string,
    credentials: {
      platform: 'shopify' | 'woocommerce' | 'magento2' | 'prestashop' | 'qapla';
      base_url?: string;
      api_key?: string;
      api_secret?: string;
      access_token?: string;
    }
  ) {
    console.log('[Settings Service] Saving e-commerce credentials:', {
      userId,
      platform: credentials.platform,
      base_url: credentials.base_url,
      has_api_key: !!credentials.api_key,
      has_api_secret: !!credentials.api_secret
    });

    let settings = await Settings.findOne({ userId });
    
    if (!settings) {
      // Create if doesn't exist
      settings = await Settings.create({
        userId,
        ecommerceIntegration: credentials
      });
    } else {
      // Update e-commerce integration
      console.log('[Settings Service] Updating existing settings with e-commerce credentials');
      console.log('[Settings Service] Current ecommerceIntegration:', JSON.stringify(settings.ecommerceIntegration, null, 2));
      console.log('[Settings Service] New credentials:', JSON.stringify(credentials, null, 2));
      
      settings.ecommerceIntegration = credentials;
      await settings.save();
      
      // Verify the save worked
      const verifySettings = await Settings.findOne({ userId });
      console.log('[Settings Service] ✅ Settings saved. Verification:', {
        has_ecommerceIntegration: !!verifySettings?.ecommerceIntegration,
        platform: verifySettings?.ecommerceIntegration?.platform,
        has_base_url: !!verifySettings?.ecommerceIntegration?.base_url,
        has_api_key: !!verifySettings?.ecommerceIntegration?.api_key,
        has_api_secret: !!verifySettings?.ecommerceIntegration?.api_secret
      });
    }
    
    // Sync to InboundAgentConfig for all phone numbers
    try {
      console.log('[Settings Service] Syncing e-commerce credentials to InboundAgentConfig...');
      const syncedConfigs = await inboundAgentConfigService.syncConfig(userId);
      console.log('[Settings Service] ✅ E-commerce credentials synced to InboundAgentConfig successfully');
      console.log('[Settings Service] Synced configs count:', syncedConfigs.length);
      
      if (syncedConfigs.length > 0) {
        console.log('[Settings Service] Phone numbers with e-commerce credentials:', syncedConfigs.map(c => c.calledNumber));
      } else {
        // No phone numbers configured - create a default InboundAgentConfig for chatbot use
        console.log('[Settings Service] ⚠️  No phone numbers configured. Creating default InboundAgentConfig for chatbot use...');
        await inboundAgentConfigService.createDefaultConfigForChatbot(userId, credentials);
        console.log('[Settings Service] ✅ Default InboundAgentConfig created for chatbot use');
      }
    } catch (error) {
      console.error('[Settings Service] ❌ Failed to sync e-commerce credentials to InboundAgentConfig:', error);
      // Don't throw error, just log it - credentials are saved in Settings
      // Still try to create default config for chatbot
      try {
        console.log('[Settings Service] Attempting to create default InboundAgentConfig for chatbot...');
        await inboundAgentConfigService.createDefaultConfigForChatbot(userId, credentials);
        console.log('[Settings Service] ✅ Default InboundAgentConfig created for chatbot use');
      } catch (defaultConfigError) {
        console.error('[Settings Service] ❌ Failed to create default InboundAgentConfig:', defaultConfigError);
      }
    }
    
    console.log('[Settings Service] ✅ WooCommerce integration setup complete for user:', userId);
    return settings;
  }

  /**
   * Delete e-commerce integration credentials
   * Removes from Settings and InboundAgentConfig
   */
  async deleteEcommerceCredentials(userId: string) {
    console.log('[Settings Service] Deleting e-commerce credentials for userId:', userId);

    const settings = await Settings.findOne({ userId });
    
    if (!settings) {
      console.log('[Settings Service] ⚠️  No settings found for userId:', userId);
      throw new AppError(404, 'NOT_FOUND', 'Settings not found');
    }

    if (!settings.ecommerceIntegration || !settings.ecommerceIntegration.platform) {
      console.log('[Settings Service] ⚠️  No e-commerce integration found to delete');
      throw new AppError(404, 'NOT_FOUND', 'E-commerce integration not found');
    }

    const platform = settings.ecommerceIntegration.platform;
    console.log('[Settings Service] Removing e-commerce integration:', platform);

    // Remove e-commerce integration from Settings
    settings.ecommerceIntegration = undefined as any;
    await settings.save();
    
    // Use $unset to ensure the field is completely removed from MongoDB
    await Settings.updateOne(
      { userId },
      { $unset: { ecommerceIntegration: "" } }
    );

    console.log('[Settings Service] ✅ E-commerce credentials removed from Settings');

    // Remove from InboundAgentConfig for all phone numbers
    try {
      console.log('[Settings Service] Removing e-commerce credentials from InboundAgentConfig...');
      const configs = await inboundAgentConfigService.get(userId);
      
      const InboundAgentConfig = (await import('../models/InboundAgentConfig')).default;
      
      for (const config of configs) {
        if (config.ecommerce_credentials) {
          // Use $unset to completely remove the field
          await InboundAgentConfig.updateOne(
            { _id: config._id },
            { $unset: { ecommerce_credentials: "" } }
          );
          console.log(`[Settings Service] ✅ Removed e-commerce credentials from InboundAgentConfig for ${config.calledNumber}`);
        }
      }

      // Also remove from default chatbot config (calledNumber = '')
      try {
        const defaultConfig = await inboundAgentConfigService.getByPhoneNumber(userId, '');
        if (defaultConfig && defaultConfig.ecommerce_credentials) {
          await InboundAgentConfig.updateOne(
            { _id: defaultConfig._id },
            { $unset: { ecommerce_credentials: "" } }
          );
          console.log('[Settings Service] ✅ Removed e-commerce credentials from default chatbot config');
        }
      } catch (error) {
        console.log('[Settings Service] No default chatbot config found or error removing:', error);
      }

      console.log('[Settings Service] ✅ E-commerce credentials removed from all InboundAgentConfig documents');
    } catch (error) {
      console.error('[Settings Service] ❌ Failed to remove e-commerce credentials from InboundAgentConfig:', error);
      // Don't throw error - credentials are removed from Settings, which is the main source
    }

    console.log('[Settings Service] ✅ E-commerce integration deletion complete for user:', userId);
    return { message: 'E-commerce integration deleted successfully', platform };
  }

  /**
   * Get all operators (users)
   */
  async getOperators() {
    const users = await User.find({})
      .select('+password') // Include password field as requested
      .lean();
    return users;
  }

  /**
   * Create operator
   */
  async createOperator(data: any) {
    const existingUser = await User.findOne({ email: data.email });
    if (existingUser) {
      throw new AppError(409, 'DUPLICATE', 'User with this email already exists');
    }

    // CRITICAL: Only allow admin role if email is in ADMIN_EMAILS env var
    const adminEmails = process.env.ADMIN_EMAILS?.split(',').map((e: string) => e.trim().toLowerCase()) || [];
    const requestedRole = data.role || 'operator';
    const isAdminEmail = adminEmails.includes(data.email.toLowerCase());
    
    // Enforce: Only admin emails can be created as admin
    const finalRole = (requestedRole === 'admin' && !isAdminEmail) ? 'operator' : requestedRole;
    
    if (requestedRole === 'admin' && !isAdminEmail) {
      console.warn(`[Settings Service] ⚠️ Attempted to create admin user with non-admin email: ${data.email}. Setting role to 'operator'.`);
    }

    const user = await User.create({
      email: data.email,
      password: data.password, // Store plain password as requested
      firstName: data.firstName || data.name?.split(' ')[0] || '',
      lastName: data.lastName || data.name?.split(' ')[1] || '',
      role: finalRole,
      permissions: finalRole === 'admin' ? ['all'] : (data.permissions || [])
    });

    // Return user with password visible
    return user.toObject();
  }

  /**
   * Update operator
   */
  async updateOperator(id: string, data: any) {
    const user = await User.findById(id);
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    // Update fields
    if (data.email) user.email = data.email;
    if (data.firstName) user.firstName = data.firstName;
    if (data.lastName) user.lastName = data.lastName;
    
    // CRITICAL: Only allow admin role if email is in ADMIN_EMAILS env var
    if (data.role) {
      const adminEmails = process.env.ADMIN_EMAILS?.split(',').map((e: string) => e.trim().toLowerCase()) || [];
      const isAdminEmail = adminEmails.includes((data.email || user.email).toLowerCase());
      
      // Enforce: Only admin emails can be updated to admin
      if (data.role === 'admin' && !isAdminEmail) {
        console.warn(`[Settings Service] ⚠️ Attempted to update user to admin with non-admin email: ${data.email || user.email}. Keeping current role.`);
        // Don't update role if trying to set to admin without admin email
      } else {
        user.role = data.role;
        // Update permissions based on role
        if (data.role === 'admin') {
          user.permissions = ['all'];
        } else if (data.permissions) {
          user.permissions = data.permissions;
        }
      }
    }
    
    if (data.permissions && user.role !== 'admin') {
      user.permissions = data.permissions;
    }
    
    if (data.password) user.password = data.password; // Update plain password
    
    // Handle legacy name field
    if (data.name && !data.firstName && !data.lastName) {
      user.firstName = data.name.split(' ')[0] || '';
      user.lastName = data.name.split(' ')[1] || '';
    }

    await user.save();

    return user.toObject();
  }

  /**
   * Delete operator
   */
  async deleteOperator(id: string) {
    const user = await User.findByIdAndDelete(id);
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    return { message: 'User deleted successfully' };
  }
}

export const settingsService = new SettingsService();

