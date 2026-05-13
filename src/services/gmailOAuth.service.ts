import axios from 'axios';
import { AppError } from '../middleware/error.middleware';
import { successResponse } from '../utils/response.util';

export class GmailOAuthService {
  private pythonApiUrl: string;

  constructor() {
    // Gmail OAuth endpoints (/email/authorize) are on keplerov1-python-2 server, not elvenlabs-voiceagent
    // Priority: EMAIL_API_URL > keplerov1-python-2 (default) > COMM_API_URL > PYTHON_API_URL
    this.pythonApiUrl = process.env.EMAIL_API_URL || 'https://keplerov1-python-2.onrender.com';
    console.log('[Gmail OAuth Service] Python API URL:', this.pythonApiUrl);
    console.log('[Gmail OAuth Service] EMAIL_API_URL:', process.env.EMAIL_API_URL || 'not set, using default');
    console.log('[Gmail OAuth Service] Using email API server for Gmail OAuth endpoints');
  }

  /**
   * Initiate Gmail OAuth flow
   * Redirects user to Google OAuth page via Python API
   * 
   * IMPORTANT: The Python API must be configured to redirect to our callback URL
   * after processing the OAuth code. The redirect_uri parameter tells the Python API
   * where to redirect after successful authorization.
   */
  async authorize(req: any, res: any): Promise<void> {
    try {
      // Get userId and organizationId from request (needed to save integration later)
      const userId = req.user?._id?.toString() || req.user?.id?.toString();
      const organizationId = req.user?.organizationId?.toString() || req.user?._id?.toString();
      
      if (!userId || !organizationId) {
        throw new Error('User ID and Organization ID are required for Gmail OAuth');
      }
      
      // Public origin of this Node API (same as recording links in Sheets). Never hardcode deploy URLs.
      const publicBackendBase = (process.env.BACKEND_URL || process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
      if (!publicBackendBase) {
        throw new AppError(
          500,
          'CONFIG_ERROR',
          'Set BACKEND_URL or PUBLIC_API_URL to your public API origin (e.g. https://api.candexai.co.in) so Gmail OAuth can redirect to this backend.'
        );
      }
      const callbackUrl = `${publicBackendBase}/api/v1/social-integrations/gmail/oauth/callback?organizationId=${organizationId}&userId=${userId}`;
      
      // Python API flow:
      // 1. User → Python API /email/authorize?redirect_url=OUR_CALLBACK
      // 2. Python API → Google OAuth (with Python API's own redirect_uri)
      // 3. Google → Python API /email/oauth2callback?code=...
      // 4. Python API processes code and redirects to OUR_CALLBACK (redirect_url from step 1)
      // 5. Our callback handler receives the request and redirects to frontend
      const pythonUrl = `${this.pythonApiUrl}/email/authorize?redirect_url=${encodeURIComponent(callbackUrl)}`;
      console.log('[Gmail OAuth] Initiating OAuth flow');
      console.log('[Gmail OAuth] Python API URL:', pythonUrl);
      console.log('[Gmail OAuth] Our callback URL (Python API should redirect here):', callbackUrl);
      console.log('[Gmail OAuth] Organization ID:', organizationId);
      console.log('[Gmail OAuth] User ID:', userId);
      console.log('[Gmail OAuth] Using redirect_url parameter (not redirect_uri)');
      
      // Check if this is an AJAX/fetch request (frontend expects JSON response)
      const isAjaxRequest = req.headers['x-requested-with'] === 'XMLHttpRequest' || 
                           req.headers['content-type']?.includes('application/json') ||
                           req.headers['accept']?.includes('application/json');
      
      if (isAjaxRequest) {
        // Return JSON with redirect URL for frontend to handle
        // Match Meta OAuth response format: { success: true, data: { authUrl: "..." } }
        console.log('[Gmail OAuth] AJAX request detected, returning redirect URL');
        const response = successResponse({ authUrl: pythonUrl }, 'Gmail OAuth URL generated');
        console.log('[Gmail OAuth] Response shape:', JSON.stringify({ success: response.success, hasAuthUrl: !!response.data?.authUrl }));
        return res.json(response);
      }
      
      // For direct browser requests, redirect immediately
      // Forward the request to Python API
      // The Python API will handle the OAuth redirect to Google
      res.redirect(pythonUrl);
    } catch (error: any) {
      console.error('[Gmail OAuth] Error initiating authorization:', error.message);
      
      // Check if this is an AJAX request
      const isAjaxRequest = req.headers['x-requested-with'] === 'XMLHttpRequest' || 
                           req.headers['content-type']?.includes('application/json');
      
      if (isAjaxRequest) {
        return res.status(500).json({
          success: false,
          error: 'GMAIL_OAUTH_ERROR',
          message: error.message || 'Failed to initiate Gmail OAuth'
        });
      }
      
      throw new AppError(
        500,
        'GMAIL_OAUTH_ERROR',
        error.message || 'Failed to initiate Gmail OAuth'
      );
    }
  }

  /**
   * Handle OAuth callback from Google
   * This endpoint can be called in two ways:
   * 1. Directly by Google (with code parameter) - if Python API redirects properly
   * 2. By Python API redirect (might include user_email in query or body)
   */
  async handleCallback(req: any, res: any): Promise<void> {
    try {
      const { code, state, user_email, email, success, message, organizationId, userId } = req.query;
      const body = req.body || {};
      
      console.log('[Gmail OAuth Callback] Received callback:', {
        hasCode: !!code,
        hasState: !!state,
        hasUserEmail: !!(user_email || email || body.user_email || body.email),
        hasOrganizationId: !!organizationId,
        hasUserId: !!userId,
        query: req.query,
        body: Object.keys(body).length > 0 ? body : 'empty'
      });
      
      let userEmail = user_email || email || body.user_email || body.email || '';
      
      // Get organizationId and userId from query (passed via callback URL)
      const orgId = organizationId || body.organizationId;
      const usrId = userId || body.userId;
      
      if (!orgId) {
        console.error('[Gmail OAuth Callback] Missing organizationId');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        return res.redirect(
          `${frontendUrl}/settings/socials?error=${encodeURIComponent('Missing organization ID')}&platform=gmail`
        );
      }
      
      // Save Gmail integration if we have userEmail
      if (userEmail) {
        try {
          const socialIntegrationService = (await import('./socialIntegration.service')).default;
          
          console.log('[Gmail OAuth Callback] Saving Gmail integration:', {
            organizationId: orgId,
            userEmail,
            userId: usrId
          });
          
          // Save integration - Gmail uses userEmail as the identifier
          // For Gmail, we don't have an API key, so we'll use the userEmail as a placeholder
          // The actual authentication is handled by the Python API using X-User-Email header
          if (!usrId) {
            throw new Error('User ID not found. Cannot create Gmail integration without userId.');
          }
          
          await socialIntegrationService.upsertIntegration({
            userId: usrId, // REQUIRED: User who owns this integration
            organizationId: orgId,
            platform: 'gmail',
            apiKey: userEmail, // Use email as identifier (will be encrypted)
            credentials: {
              userEmail: userEmail,
              connectedAt: new Date()
            },
            metadata: {
              userId: usrId,
              connectedAt: new Date(),
              email: userEmail
            },
            skipVerification: true, // Gmail OAuth is already verified by Python API
            webhookVerified: false // Gmail doesn't use webhooks
          });
          
          console.log('[Gmail OAuth Callback] ✅ Gmail integration saved successfully');
        } catch (saveError: any) {
          console.error('[Gmail OAuth Callback] Error saving integration:', saveError.message);
          // Don't throw - still redirect to frontend, but log the error
        }
      }
      
      // If we have a code, forward it to Python API via POST
      if (code) {
        console.log('[Gmail OAuth Callback] Code received, forwarding to Python API');
        const pythonUrl = `${this.pythonApiUrl}/email/oauth2callback`;
        console.log('[Gmail OAuth Callback] Forwarding to Python API (POST):', pythonUrl);
        
        try {
          // Use POST request with code and state only (no redirect_uri)
          const response = await axios.post(pythonUrl, {
            code,
            state: state || null
          }, {
            headers: {
              'Content-Type': 'application/json'
            }
          });

          console.log('[Gmail OAuth Callback] Python API response:', {
            success: response.data?.success,
            hasUserEmail: !!response.data?.user_email,
            message: response.data?.message
          });

          // Extract user email from response if available
          if (response.data?.user_email && !userEmail) {
            userEmail = response.data.user_email;
          }
        } catch (apiError: any) {
          console.error('[Gmail OAuth Callback] Python API error:', apiError.response?.data || apiError.message);
          // If Python API returns error but we have user_email from query/body, continue
          if (!userEmail) {
            throw apiError;
          }
        }
      } else if (!userEmail) {
        // No code and no user_email - this is an error
        console.error('[Gmail OAuth Callback] Missing both authorization code and user email');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        return res.redirect(
          `${frontendUrl}/settings/socials?error=${encodeURIComponent('Authorization failed: missing code or email')}&platform=gmail`
        );
      }

      // ALWAYS redirect to frontend (never return JSON)
      // This ensures users are successfully redirected back to the platform after OAuth
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const redirectUrl = userEmail 
        ? `${frontendUrl}/settings/socials?success=true&platform=gmail&email=${encodeURIComponent(userEmail)}`
        : `${frontendUrl}/settings/socials?success=true&platform=gmail`;
      
      console.log('[Gmail OAuth Callback] ✅ OAuth successful, redirecting to frontend');
      console.log('[Gmail OAuth Callback] Redirect URL:', redirectUrl);
      console.log('[Gmail OAuth Callback] User email:', userEmail || 'not provided');
      console.log('[Gmail OAuth Callback] Source:', code ? 'Python API processed code' : 'Direct redirect from Python API');
      
      // Ensure we always redirect (never send JSON)
      // This is the final step - user gets redirected back to platform
      return res.redirect(redirectUrl);
    } catch (error: any) {
      console.error('[Gmail OAuth Callback] ❌ Error handling callback:', error.response?.data || error.message);
      console.error('[Gmail OAuth Callback] Error stack:', error.stack);
      
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const errorMessage = error.response?.data?.message || error.message || 'Gmail OAuth callback failed';
      const redirectUrl = `${frontendUrl}/settings/socials?error=${encodeURIComponent(errorMessage)}&platform=gmail`;
      
      console.log('[Gmail OAuth Callback] Redirecting to error page:', redirectUrl);
      return res.redirect(redirectUrl);
    }
  }

  /**
   * Send email via Gmail API
   */
  async sendEmail(userEmail: string, emailData: {
    to: string;
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
  }): Promise<any> {
    try {
      const pythonUrl = `${this.pythonApiUrl}/email/send`;
      
      const response = await axios.post(pythonUrl, {
        to: emailData.to,
        subject: emailData.subject,
        body: emailData.body,
        cc: emailData.cc,
        bcc: emailData.bcc
      }, {
        headers: {
          'X-User-Email': userEmail
        }
      });

      return response.data;
    } catch (error: any) {
      console.error('[Gmail Service] Error sending email:', error.response?.data || error.message);
      throw new AppError(
        500,
        'GMAIL_SEND_ERROR',
        error.response?.data?.message || error.message || 'Failed to send email'
      );
    }
  }

  /**
   * Logout and delete user credentials
   */
  async logout(userEmail: string): Promise<void> {
    try {
      const pythonUrl = `${this.pythonApiUrl}/email/logout`;
      
      await axios.delete(pythonUrl, {
        headers: {
          'X-User-Email': userEmail
        }
      });

      console.log('[Gmail OAuth] Logout successful for:', userEmail);
    } catch (error: any) {
      console.error('[Gmail OAuth] Error logging out:', error.response?.data || error.message);
      throw new AppError(
        500,
        'GMAIL_LOGOUT_ERROR',
        error.response?.data?.message || error.message || 'Failed to logout'
      );
    }
  }

  /**
   * List all connected Gmail accounts (Admin endpoint)
   */
  async getConnectedUsers(): Promise<string[]> {
    try {
      const pythonUrl = `${this.pythonApiUrl}/email/connected-users`;
      
      const response = await axios.get(pythonUrl);
      return response.data || [];
    } catch (error: any) {
      console.error('[Gmail OAuth] Error getting connected users:', error.response?.data || error.message);
      throw new AppError(
        500,
        'GMAIL_LIST_ERROR',
        error.response?.data?.message || error.message || 'Failed to list connected users'
      );
    }
  }
}

export default new GmailOAuthService();

