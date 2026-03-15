const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 587,
  secure: false,
  auth: { user: 'sales@aialwaysanswer.com', pass: '_(H5kHC;j}e,tw}' }
});

const targets = [
  { name: 'Team',     business: 'Rivertop Roofing',                   email: 'info@RivertopRoofing.com',              industry: 'roofing' },
  { name: 'Team',     business: 'Caprock Roofing',                    email: 'info@caprockroof.com',                  industry: 'roofing' },
  { name: 'Team',     business: 'Bluejay Roofing',                    email: 'bluejaycontractors@gmail.com',          industry: 'roofing' },
  { name: 'Team',     business: 'Rockwall Roofing Specialists',       email: 'rrs75087@gmail.com',                    industry: 'roofing' },
  { name: 'Team',     business: 'Interstate Roofing LLC',             email: 'info@interstateroofer.com',             industry: 'roofing' },
  { name: 'Tye',      business: 'RCSA Roofing & Construction',        email: 'tye@rcsausa.com',                       industry: 'roofing' },
  { name: 'Team',     business: 'Peoples Construction LLC',           email: 'newroof@peoplesconstruction.org',       industry: 'roofing' },
  { name: 'Team',     business: 'Sarris and Mackir Roofing',          email: 'info@mackir.com',                       industry: 'roofing' },
  { name: 'Team',     business: 'Verde Roofing & Construction',       email: 'info@verderoofing.com',                 industry: 'roofing' },
  { name: 'Team',     business: 'DV Construction & Roofing',          email: 'dvconstructionroofing@gmail.com',       industry: 'roofing' },
  { name: 'Mo',       business: 'Brown Roofing Solutions',            email: 'mo@brownroofingsolutions.com',          industry: 'roofing' },
  { name: 'Team',     business: 'Cornerstone Roofing',                email: 'Contact@Cornerstoneroofing.biz',        industry: 'roofing' },
  { name: 'Team',     business: 'Reign Roofing and Construction',     email: 'company@reignroofing.net',              industry: 'roofing' },
  { name: 'George',   business: 'West Construction Group',            email: 'george@wcgtexas.com',                   industry: 'roofing' },
  { name: 'Joe',      business: 'Whatley Roofing',                    email: 'joe@whatleyroofing.com',                industry: 'roofing' },
  { name: 'Team',     business: 'Reilly Roofing and Gutters',         email: 'freequote@reillyroofing.com',           industry: 'roofing' },
  { name: 'Rosemary', business: 'Stamper Roofing & Construction',     email: 'rosemary@stamperroofing.com',           industry: 'roofing' },
  { name: 'Team',     business: 'Helsley Roofing Company',            email: 'info@helsleyroofing.com',               industry: 'roofing' },
  { name: 'Team',     business: 'SCI Roofing & Remodeling',           email: 'Contact@sciroofingandremodeling.com',   industry: 'roofing' },
  { name: 'Team',     business: 'Absolute Construction',              email: 'office@absoluteteam.net',               industry: 'roofing' },
];

const hook = "When a storm rolls through DFW, the first roofer who answers gets the job. Every. Single. Time.";

function buildEmail(t) {
  const subject = t.name !== 'Team'
    ? `${t.name} — is ${t.business} answering after hours?`
    : `Is ${t.business} answering after the storm calls start?`;

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.7">
<p>Hi ${t.name},</p>
<p>${hook}</p>
<p>Is that you — or your voicemail?</p>
<p>We built an AI receptionist that answers every call instantly, 24/7, qualifies the lead, books appointments, and texts you the details. <strong>$99/month.</strong> Sounds like a real person. Never misses a call.</p>
<p>Don't take my word for it — <strong>call this number right now and hear it live:</strong></p>
<p style="text-align:center;margin:28px 0">
  <a href="tel:8175338424" style="background:#2563eb;color:white;font-size:22px;font-weight:bold;padding:14px 36px;border-radius:8px;text-decoration:none;display:inline-block">
    📞 (817) 533-8424
  </a>
</p>
<p>That AI just answered your call. It can do the same for <em>${t.business}</em> starting tonight.</p>
<p>Storm season is coming. 14-day money-back guarantee. No contracts. Live in under an hour.</p>
<p><a href="https://aialwaysanswer.com?ref=email-roofing" style="color:#2563eb">See how it works →</a></p>
<p style="margin-top:32px;color:#888;font-size:13px">
  — Lyndon<br>
  AI Always Answer<br>
  <a href="mailto:sales@aialwaysanswer.com" style="color:#888">sales@aialwaysanswer.com</a><br><br>
  <a href="mailto:sales@aialwaysanswer.com?subject=Unsubscribe" style="color:#bbb;font-size:12px">Unsubscribe</a>
</p>
</body>
</html>`;

  const text = `Hi ${t.name},

${hook}

Is that you — or your voicemail?

We built an AI receptionist that answers every call instantly, 24/7, qualifies the lead, books appointments, and texts you the details. $99/month. Sounds like a real person. Never misses a call.

Call this number right now and hear it live: (817) 533-8424

That AI just answered your call. It can do the same for ${t.business} starting tonight.

Storm season is coming. 14-day money-back guarantee. No contracts. Live in under an hour.

https://aialwaysanswer.com

— Lyndon
AI Always Answer
sales@aialwaysanswer.com

To unsubscribe, reply with "unsubscribe"`;

  return { subject, html, text };
}

async function send() {
  console.log(`Sending to ${targets.length} roofers...\n`);
  let sent = 0, failed = 0;
  for (const t of targets) {
    const { subject, html, text } = buildEmail(t);
    try {
      await transporter.sendMail({
        from: '"AI Always Answer" <sales@aialwaysanswer.com>',
        to: t.email,
        subject,
        html,
        text,
      });
      console.log(`✅ SENT → ${t.email} (${t.business})`);
      sent++;
    } catch (e) {
      console.log(`❌ FAIL → ${t.email}: ${e.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`\nDone. ${sent} sent, ${failed} failed.`);
}

send();
