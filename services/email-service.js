const { Resend } = require('resend');

/**
 * Email Service - Notifications for leads and customers using Resend
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

  /**
   * Check if email is configured
   */
  isConfigured() {
    return this.resend !== null;
  }

  /**
   * Notify about new lead/call
   */
  async notifyNewLead(lead, callData) {
    if (!this.resend) return false;

    const subject = `🔔 New Lead: ${lead.phone}`;
    const html = `
      <h2>New AI Receptionist Lead</h2>
      <h3>Contact Info</h3>
      <p><strong>Phone:</strong> ${lead.phone}</p>
      <p><strong>Name:</strong> ${lead.name || 'Not provided'}</p>
      <p><strong>Email:</strong> ${lead.email || 'Not provided'}</p>
      <p><strong>Company:</strong> ${lead.company || 'Not provided'}</p>
      <h3>Call Details</h3>
      <ul>
        <li><strong>Duration:</strong> ${callData.duration || 0} seconds</li>
        <li><strong>Turns:</strong> ${callData.turns || 0}</li>
      </ul>
      ${callData.transcript ? `<h3>Transcript</h3><pre>${callData.transcript}</pre>` : ''}
    `;

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <leads@aialwaysanswer.com>',
        to: [this.notifyEmail],
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
   * Send setup link to prospect
   */
  async sendSetupLink(toEmail, name) {
    if (!this.resend) return false;

    const setupLink = "https://buy.stripe.com/dRm4gzdiF6aqcykcfZ18c07";
    console.log(`📧 Sending setup link to: ${toEmail}`);

    try {
      await this.resend.emails.send({
        from: 'AI Always Answer <sales@aialwaysanswer.com>',
        to: [toEmail],
        subject: "Your AI Receptionist Setup Link 🚀",
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