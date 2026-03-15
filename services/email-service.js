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
}

module.exports = new EmailService();
