const nodemailer = require('nodemailer');

/**
 * Email Service - Notifications for leads and customers
 */
class EmailService {
  constructor() {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
      console.warn('⚠️  SMTP not configured - emails disabled');
      this.transporter = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    this.fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;
    this.notifyEmail = process.env.NOTIFY_EMAIL || process.env.SMTP_USER;

    console.log('✅ Email service initialized');
  }

  /**
   * Check if email is configured
   */
  isConfigured() {
    return this.transporter !== null;
  }

  /**
   * Send email
   */
  async send(to, subject, html, text = null) {
    if (!this.transporter) {
      console.log(`📧 Email (disabled): ${subject} → ${to}`);
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.fromEmail,
        to: to,
        subject: subject,
        html: html,
        text: text || html.replace(/<[^>]*>/g, '')
      });

      console.log(`📧 Email sent: ${subject} → ${to}`);
      return true;
    } catch (error) {
      console.error('❌ Email error:', error.message);
      return false;
    }
  }

  /**
   * Notify about new lead/call
   */
  async notifyNewLead(lead, callData) {
    const subject = `🔔 New Lead: ${lead.phone}`;

    const html = `
      <h2>New AI Receptionist Lead</h2>

      <h3>Contact Info</h3>
      <table style="border-collapse: collapse; width: 100%; max-width: 500px;">
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;"><strong>Phone</strong></td>
          <td style="padding: 8px; border: 1px solid #ddd;">${lead.phone}</td>
        </tr>
        ${lead.name ? `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;"><strong>Name</strong></td>
          <td style="padding: 8px; border: 1px solid #ddd;">${lead.name}</td>
        </tr>
        ` : ''}
        ${lead.email ? `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;"><strong>Email</strong></td>
          <td style="padding: 8px; border: 1px solid #ddd;">${lead.email}</td>
        </tr>
        ` : ''}
        ${lead.company ? `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;"><strong>Company</strong></td>
          <td style="padding: 8px; border: 1px solid #ddd;">${lead.company}</td>
        </tr>
        ` : ''}
      </table>

      <h3>Call Details</h3>
      <ul>
        <li><strong>Duration:</strong> ${callData.duration || 0} seconds</li>
        <li><strong>Turns:</strong> ${callData.turns || 0}</li>
        <li><strong>Interest Level:</strong> ${lead.interest_level || 'Unknown'}</li>
      </ul>

      ${callData.transcript ? `
      <h3>Transcript</h3>
      <pre style="background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto;">
${callData.transcript}
      </pre>
      ` : ''}

      ${callData.summary ? `
      <h3>AI Summary</h3>
      <p style="background: #e8f4fd; padding: 15px; border-radius: 5px;">
        ${callData.summary}
      </p>
      ` : ''}

      <hr style="margin: 20px 0;">
      <p style="color: #666; font-size: 12px;">
        AI Receptionist Lead Notification<br>
        ${new Date().toLocaleString()}
      </p>
    `;

    return await this.send(this.notifyEmail, subject, html);
  }

  /**
   * Send setup link to prospect
   */
  async sendSetupLink(toEmail, name) {
    const subject = `AI Always Answer - Your Setup Link! 🚀`;

    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #2563eb;">Nice talking to you!</h2>
        <p>Hi ${name},</p>
        <p>As promised on the phone, here is the link to get your AI Always Answer receptionist set up.</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="https://buy.stripe.com/dRm4gzdiF6aqcykcfZ18c07" style="background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">Get Started for $99/mo</a>
        </div>

        <p><strong>What happens next?</strong></p>
        <ol>
          <li>Click the link above to subscribe.</li>
          <li>We'll build your custom AI persona (usually within 24 hours).</li>
          <li>Your phones start working for you instead of against you.</li>
        </ol>

        <p>If you have any questions, just reply to this email.</p>
        
        <p>Best,<br><strong>Lyndon</strong><br>AI Always Answer</p>
        
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #999; font-size: 12px; text-align: center;">
          We don't do voicemail. We do business.<br>
          <a href="https://aialwaysanswer.com" style="color: #999;">aialwaysanswer.com</a>
        </p>
      </div>
    `;

    return await this.send(toEmail, subject, html);
  }

  /**
   * Send welcome email to new customer
   */
  async sendWelcomeEmail(customer) {
    const subject = `Welcome to AI Receptionist - Let's Get Started! 🎉`;

    const html = `
      <h1>Welcome to AI Receptionist!</h1>

      <p>Hi ${customer.name || 'there'},</p>

      <p>Thank you for subscribing to the <strong>${customer.plan}</strong> plan. You've taken the first step toward never missing a business call again!</p>

      <h2>What's Next?</h2>

      <ol>
        <li><strong>Set up your phone number</strong> - We'll help you configure your Twilio number or port your existing one</li>
        <li><strong>Customize your AI</strong> - Tell us about your business so the AI can represent you perfectly</li>
        <li><strong>Go live!</strong> - Start receiving calls handled by your AI receptionist</li>
      </ol>

      <h2>Quick Links</h2>
      <ul>
        <li><a href="${process.env.BASE_URL}/dashboard">Your Dashboard</a></li>
        <li><a href="${process.env.BASE_URL}/settings">Configure Settings</a></li>
        <li><a href="${process.env.BASE_URL}/help">Help Center</a></li>
      </ul>

      <h2>Need Help?</h2>
      <p>Reply to this email or call us - our support team is here for you.</p>

      <p>Best regards,<br>The AI Receptionist Team</p>

      <hr style="margin: 20px 0;">
      <p style="color: #666; font-size: 12px;">
        You're receiving this because you signed up for AI Receptionist.<br>
        ${new Date().toLocaleString()}
      </p>
    `;

    return await this.send(customer.email, subject, html);
  }

  /**
   * Send weekly report
   */
  async sendWeeklyReport(customer, stats) {
    const subject = `📊 Your Weekly AI Receptionist Report`;

    const html = `
      <h1>Weekly Report</h1>

      <p>Hi ${customer.name || 'there'},</p>

      <p>Here's how your AI receptionist performed this week:</p>

      <table style="border-collapse: collapse; width: 100%; max-width: 400px;">
        <tr style="background: #f5f5f5;">
          <td style="padding: 12px; border: 1px solid #ddd;"><strong>Calls Answered</strong></td>
          <td style="padding: 12px; border: 1px solid #ddd; text-align: right;">${stats.totalCalls}</td>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd;"><strong>Leads Captured</strong></td>
          <td style="padding: 12px; border: 1px solid #ddd; text-align: right;">${stats.leadsCaptures}</td>
        </tr>
        <tr style="background: #f5f5f5;">
          <td style="padding: 12px; border: 1px solid #ddd;"><strong>Avg Call Duration</strong></td>
          <td style="padding: 12px; border: 1px solid #ddd; text-align: right;">${stats.avgDuration}s</td>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd;"><strong>Minutes Used</strong></td>
          <td style="padding: 12px; border: 1px solid #ddd; text-align: right;">${stats.minutesUsed} / ${stats.minutesIncluded}</td>
        </tr>
      </table>

      <p><a href="${process.env.BASE_URL}/dashboard">View Full Dashboard →</a></p>

      <hr style="margin: 20px 0;">
      <p style="color: #666; font-size: 12px;">
        AI Receptionist Weekly Report<br>
        ${new Date().toLocaleString()}
      </p>
    `;

    return await this.send(customer.email, subject, html);
  }
}

module.exports = new EmailService();
