const { Resend } = require('resend');

class EmailService {
  constructor() {
    this.resend = null;
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
      console.log('✅ Email service initialized with Resend API');
    } else {
      console.warn('⚠️ Resend API Key missing. Email functionality will be disabled.');
    }
  }

  async sendSetupLink(toEmail, setupLink) {
    if (!this.resend) {
      console.error('❌ Cannot send email: Resend API not initialized.');
      return false;
    }

    console.log(`📧 Sending setup link via Resend to: ${toEmail}`);
    try {
      const { data, error } = await this.resend.emails.send({
        from: 'AI Receptionist <onboarding@resend.dev>', // Default for unverified domains
        // Replace with your verified sender once domain is verified in Resend:
        // from: 'AI Receptionist <sales@aialwaysanswer.com>',
        to: [toEmail],
        subject: "Your AI Receptionist Setup Link",
        text: `Welcome to AI Always Answer!

Here is your link to set up your AI Receptionist: ${setupLink}

If you have any questions, just reply to this email.

Best,
The AI Always Answer Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Welcome to AI Always Answer!</h2>
            <p>We're excited to get you started with your new AI Receptionist.</p>
            <p>Click the button below to complete your setup:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${setupLink}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Set Up My AI Receptionist</a>
            </div>
            <p>Or copy and paste this link into your browser:</p>
            <p><a href="${setupLink}">${setupLink}</a></p>
            <p>If you have any questions, just reply to this email.</p>
            <br>
            <p>Best,</p>
            <p>The AI Always Answer Team</p>
          </div>
        `,
      });

      if (error) {
        console.error("❌ Resend error:", error);
        return false;
      }

      console.log("📧 Email sent successfully via Resend. ID:", data.id);
      return true;
    } catch (err) {
      console.error("❌ Unexpected error sending email via Resend:", err.message);
      return false;
    }
  }
}

module.exports = EmailService;
