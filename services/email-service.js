const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    console.log(`📧 Initializing Email Service with Host: ${process.env.SMTP_HOST}, Port: ${process.env.SMTP_PORT}, Secure: ${process.env.SMTP_SECURE}`);
    
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      connectionTimeout: 30000, // 30 seconds
      greetingTimeout: 30000,
      socketTimeout: 30000,
      debug: true,
      logger: true
    });

    this.verifyConnection();
  }

  async verifyConnection() {
    try {
      console.log('📧 Verifying SMTP connection...');
      await this.transporter.verify();
      console.log('✅ Email service initialized (SMTP connection verified)');
    } catch (error) {
      console.error('❌ Email service initialization failed:', error.message);
      console.error('❌ Full Error:', JSON.stringify(error));
    }
  }

  async sendSetupLink(toEmail, setupLink) {
    console.log(`📧 Attempting to send setup link to: ${toEmail}`);
    try {
      const info = await this.transporter.sendMail({
        from: `"AI Receptionist" <${process.env.SMTP_USER}>`,
        to: toEmail,
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

      console.log("📧 Email sent successfully: %s", info.messageId);
      return true;
    } catch (error) {
      console.error("❌ Error sending email:", error.message);
      return false;
    }
  }
}

module.exports = EmailService;
