/**
 * AI Always Answer — Cold Email Blaster
 * Sends personalized cold emails to local service businesses
 * From: sales@aialwaysanswer.com via Namecheap Private Email
 */

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 587,
  secure: false,
  auth: {
    user: 'sales@aialwaysanswer.com',
    pass: '_(H5kHC;j}e,tw}'
  }
});

// ─── TARGET LIST ──────────────────────────────────────────────────────────────
// Format: { name, business, email, industry }
// Add your scraped leads here. Examples below to test with.
const targets = [
  // PASTE YOUR LEADS HERE
  // { name: 'John', business: 'ABC Plumbing', email: 'john@abcplumbing.com', industry: 'plumbing' },
];

// ─── EMAIL TEMPLATES BY INDUSTRY ─────────────────────────────────────────────
function getEmailContent(target) {
  const industryLines = {
    plumbing: "When someone's pipe bursts at midnight, the first plumber who answers gets the job.",
    hvac:     "When someone's AC dies in July, the first HVAC company who answers gets the call.",
    roofing:  "When a storm rolls through, the first roofer who answers gets the job.",
    electrical: "When someone has an electrical emergency, the first electrician who answers gets the work.",
    default:  "When a customer needs help fast, the first business who answers gets the job.",
  };

  const hook = industryLines[target.industry] || industryLines.default;

  const subject = `${target.business} — your phones after hours`;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; font-size: 15px; line-height: 1.6;">

<p>Hi ${target.name},</p>

<p>${hook}</p>

<p>Is that you — or your voicemail?</p>

<p>We built an AI receptionist that answers every call instantly, 24/7, books appointments, and texts you the lead details. It costs <strong>$99/month</strong> and sounds like a real person.</p>

<p>Don't take my word for it — <strong>call this number right now and hear it yourself:</strong></p>

<p style="text-align:center; margin: 24px 0;">
  <a href="tel:8175338424" style="background:#2563eb; color:white; font-size:22px; font-weight:bold; padding:14px 32px; border-radius:8px; text-decoration:none; display:inline-block;">
    📞 (817) 533-8424
  </a>
</p>

<p>That AI just answered your call. It can do the same for <em>${target.business}</em> starting tonight.</p>

<p>14-day money-back guarantee. No contracts. Setup in under an hour.</p>

<p>
  <a href="https://aialwaysanswer.com?ref=email" style="color:#2563eb;">See how it works →</a>
</p>

<p style="margin-top:32px; color:#666; font-size:13px;">
  — Lyndon<br>
  AI Always Answer<br>
  <a href="mailto:sales@aialwaysanswer.com" style="color:#666;">sales@aialwaysanswer.com</a><br><br>
  <a href="mailto:sales@aialwaysanswer.com?subject=Unsubscribe" style="color:#999; font-size:12px;">Unsubscribe</a>
</p>

</body>
</html>
  `.trim();

  const text = `
Hi ${target.name},

${hook}

Is that you — or your voicemail?

We built an AI receptionist that answers every call instantly, 24/7, books appointments, and texts you the lead details. It costs $99/month and sounds like a real person.

Call this number right now and hear it yourself: (817) 533-8424

That AI just answered your call. It can do the same for ${target.business} starting tonight.

14-day money-back guarantee. No contracts. Setup in under an hour.

https://aialwaysanswer.com

— Lyndon
AI Always Answer
sales@aialwaysanswer.com

To unsubscribe, reply with "unsubscribe"
  `.trim();

  return { subject, html, text };
}

// ─── SEND ─────────────────────────────────────────────────────────────────────
async function sendEmails() {
  if (targets.length === 0) {
    console.log('No targets loaded. Add leads to the targets[] array and run again.');
    process.exit(0);
  }

  console.log(`Sending to ${targets.length} targets...\n`);

  let sent = 0;
  let failed = 0;

  for (const target of targets) {
    const { subject, html, text } = getEmailContent(target);

    try {
      await transporter.sendMail({
        from: '"AI Always Answer" <sales@aialwaysanswer.com>',
        to: target.email,
        subject,
        html,
        text,
      });

      console.log(`✅ Sent → ${target.email} (${target.business})`);
      sent++;

      // Throttle: 1 email every 3 seconds to avoid spam flags
      await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      console.log(`❌ Failed → ${target.email}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${sent} sent, ${failed} failed.`);
}

sendEmails();
