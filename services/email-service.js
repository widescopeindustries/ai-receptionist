const { Resend } = require('resend');

/**
 * Email Service - Notifications for leads and customers using Resend
 * Supports multi-tenant with per-business notification routing
 */
class EmailService {
  constructor() {
    this.resend = null;
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
      console.log('✅ Email service initialized with Resend API');
    } else {
      console.warn('⚠️ Resend API Key missing. Email functionality will be disabled.');
    }
    this.notifyEmail = process.env.NOTIFY_EMAIL || 'info@widescopeindustries.com';
  }

  isConfigured() {
    return this.resend !== null;
  }

  /**
   * Notify about new lead/call
   * @param {Object} lead - Lead record
   * @param {Object} callData - Call details (duration, turns, transcript, businessName)
   * @param {string} [recipientOverride] - Business-specific email to notify
   */
  async notifyNewLead(lead, callData, recipientOverride = null) {
    if (!this.resend) return false;

    const businessName = callData.businessName || 'AI Receptionist';
    const subject = `🔔 [${businessName}] New Lead: ${lead.phone}`;
    const html = `
      <h2>New ${businessName} Lead</h2>
      <h3>Contact Info</h3>
      <p><strong>Phone:</strong> ${lead.phone}</p>
      <p><strong>Name:</strong> ${lead.name || 'Not provided'}</p>
      <p><strong>Email:</strong> ${lead.email || 'Not provided'}</p>
      <p><strong>Company:</strong> ${lead.company || 'Not provided'}</p>
      ${lead.address ? `<p><strong>Address:</strong> ${lead.address}</p>` : ''}
      ${lead.notes ? `<p><strong>Notes:</strong> ${lead.notes}</p>` : ''}
      <h3>Call Details</h3>
      <ul>
        <li><strong>Duration:</strong> ${callData.duration || 0} seconds</li>
        <li><strong>Turns:</strong> ${callData.turns || 0}</li>
        <li><strong>Interest Level:</strong> ${lead.interest_level || 'Unknown'}</li>
      </ul>
      ${callData.transcript ? `<h3>Transcript</h3><pre style="background: #f5f5f5; padding: 15px; border-radius: 5px; white-space: pre-wrap;">${callData.transcript}</pre>` : ''}
    `;

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <leads@aialwaysanswer.com>',
        to: [recipientOverride || this.notifyEmail],
        subject: subject,
        html: html
      });
      return true;
    } catch (error) {
      console.error('❌ Email error:', error.message);
      return false;
    }
  }

  /**
   * Send lead alert to owner when AI captures a lead on a call
   * @param {Object} leadData - { name, email, website, phone, callTime }
   */
  async sendLeadAlert(leadData) {
    if (!this.resend) {
      console.log('📋 Lead captured (email disabled):', leadData);
      return false;
    }

    const { name, email, website, phone, callTime } = leadData;
    const to = process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || 'molyndon@gmail.com';

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <leads@aialwaysanswer.com>',
        to: [to],
        subject: `New lead from call: ${name || phone || 'Unknown'}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #2563eb;">New lead — follow up within 10 minutes</h2>
            <table style="width:100%; border-collapse: collapse;">
              <tr><td style="padding:8px; font-weight:bold;">Name</td><td style="padding:8px;">${name || 'Not provided'}</td></tr>
              <tr style="background:#f9f9f9;"><td style="padding:8px; font-weight:bold;">Email</td><td style="padding:8px;">${email || 'Not provided'}</td></tr>
              <tr><td style="padding:8px; font-weight:bold;">Website</td><td style="padding:8px;">${website || 'Not provided'}</td></tr>
              <tr style="background:#f9f9f9;"><td style="padding:8px; font-weight:bold;">Phone</td><td style="padding:8px;">${phone || 'Unknown'}</td></tr>
              <tr><td style="padding:8px; font-weight:bold;">Called at</td><td style="padding:8px;">${callTime || new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}</td></tr>
            </table>
            <p style="margin-top:20px; color:#666;">They were told someone would reach out within 10 minutes.</p>
          </div>
        `
      });
      console.log(`✅ Lead alert sent to ${to}`);
      return true;
    } catch (err) {
      console.error('❌ Lead alert email error:', err.message);
      return false;
    }
  }

  /**
   * Send setup link to prospect (for AI Always Answer business)
   */
  async sendSetupLink(toEmail, name) {
    if (!this.resend) return false;

    const setupLink = "https://buy.stripe.com/dRm4gzdiF6aqcykcfZ18c07";
    console.log(`📧 Sending setup link to: ${toEmail}`);

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <sales@aialwaysanswer.com>',
        to: [toEmail],
        subject: "Your AI Receptionist Setup Link",
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #2563eb;">Nice talking to you!</h2>
            <p>Hi ${name},</p>
            <p>As promised on the phone, here is the link to get your AI Always Answer receptionist set up.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${setupLink}" style="background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">Get Started for $99/mo</a>
            </div>
            <p><strong>What happens next?</strong></p>
            <ol>
              <li>Click the link above to subscribe.</li>
              <li>We'll build your custom AI persona (usually within 24 hours).</li>
              <li>Your phones start working for you instead of against you.</li>
            </ol>
            <p>If you have any questions, just reply to this email.</p>
            <p>Best,<br><strong>Lyndon</strong><br>AI Always Answer</p>
          </div>
        `
      });
      return true;
    } catch (err) {
      console.error("❌ Resend error:", err.message);
      return false;
    }
  }
  /**
   * Send personalized demo link to prospect
   */
  async sendDemoLink(toEmail, prospectName, businessName, demoUrl) {
    if (!this.resend) {
      console.log(`📧 Demo link (email disabled): ${demoUrl} → ${toEmail}`);
      return false;
    }

    const name = prospectName || 'there';

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <sales@aialwaysanswer.com>',
        to: [toEmail],
        subject: `Your ${businessName} AI Receptionist Demo is Live`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: #f8fafc;">
            <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h2 style="color: #1f2937; margin-top: 0; font-size: 24px;">Hi ${name},</h2>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                We built a custom AI receptionist demo for <strong>${businessName}</strong>.
              </p>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                It's already trained on your services, your location, and your business.
              </p>
              <div style="text-align: center; margin: 35px 0;">
                <a href="${demoUrl}" style="background-color: #2563eb; color: white; padding: 16px 40px; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 18px; display: inline-block;">
                  See Your Demo
                </a>
              </div>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                You can talk to it right now — no setup, no signup.
              </p>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                If you like what you hear, you can launch it for <strong>$99/month</strong>.
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
              <p style="color: #6b7280; font-size: 14px;">
                — Lyndon<br/>
                <strong>AI Always Answer</strong>
              </p>
            </div>
          </div>
        `
      });
      console.log(`✅ Demo link sent to ${toEmail}`);
      return true;
    } catch (err) {
      console.error('❌ Demo link email error:', err.message);
      return false;
    }
  }
  /**
   * Send magic login link to customer
   */
  async sendMagicLink(toEmail, loginUrl) {
    if (!this.resend) return false;

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <noreply@aialwaysanswer.com>',
        to: [toEmail],
        subject: 'Your AI Always Answer Login Link',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: #f8fafc;">
            <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h2 style="color: #1f2937; margin-top: 0;">Sign in to your dashboard</h2>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">Click the button below to access your AI Always Answer dashboard. This link is unique to your account.</p>
              <div style="text-align: center; margin: 35px 0;">
                <a href="${loginUrl}" style="background-color: #2563eb; color: white; padding: 16px 40px; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 18px; display: inline-block;">Open Dashboard</a>
              </div>
              <p style="color: #9ca3af; font-size: 13px;">If you didn't request this link, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
              <p style="color: #6b7280; font-size: 14px;">AI Always Answer</p>
            </div>
          </div>
        `
      });
      console.log(`📧 Magic link sent to ${toEmail}`);
      return true;
    } catch (err) {
      console.error('❌ Magic link email error:', err.message);
      return false;
    }
  }

  /**
   * Send welcome email with dashboard link after Stripe checkout
   */
  async sendCustomerWelcome(toEmail, name, plan, dashboardUrl) {
    if (!this.resend) return false;

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <welcome@aialwaysanswer.com>',
        to: [toEmail],
        subject: 'Welcome to AI Always Answer!',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: #f8fafc;">
            <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h2 style="color: #1f2937; margin-top: 0;">Welcome aboard, ${name}!</h2>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                Your <strong>${plan}</strong> plan is now active. Let's get your AI receptionist set up so she can start answering calls.
              </p>
              <div style="text-align: center; margin: 35px 0;">
                <a href="${dashboardUrl}" style="background-color: #2563eb; color: white; padding: 16px 40px; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 18px; display: inline-block;">Set Up Your Receptionist</a>
              </div>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;"><strong>What happens next:</strong></p>
              <ol style="color: #4b5563; font-size: 16px; line-height: 1.8;">
                <li>Click the link above to access your dashboard</li>
                <li>Tell us about your business (takes 2 minutes)</li>
                <li>We'll provision your dedicated phone number</li>
                <li>Forward your calls and you're live!</li>
              </ol>
              <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                Questions? Just reply to this email.
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
              <p style="color: #6b7280; font-size: 14px;">
                — Lyndon<br/><strong>AI Always Answer</strong>
              </p>
            </div>
          </div>
        `
      });
      return true;
    } catch (err) {
      console.error('❌ Welcome email error:', err.message);
      return false;
    }
  }
}

module.exports = new EmailService();
