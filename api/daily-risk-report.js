const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const nodemailer = require('nodemailer');

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Step 1: Connect to Google Sheets
    const auth = new GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Raw_data!A:F',
    });

    const rows = response.data.values || [];

    // Step 2: Filter for today's high risk messages (SGT)
    const todaySGT = new Date().toLocaleDateString('en-GB', {
      timeZone: 'Asia/Singapore',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }); // e.g. "29/04/2026"

    const highRiskRows = rows.slice(1).filter(row => {
      const tag = (row[5] || '').toLowerCase().trim();
      const timestamp = row[4] || '';
      const rowDate = timestamp.split(',')[0].trim(); // extract date part
      return tag === 'high risk' && rowDate === todaySGT;
    });

    // Step 3: If no high risk messages, skip email
    if (highRiskRows.length === 0) {
      console.log('✅ No high risk messages today, skipping email');
      return res.status(200).json({ message: 'No high risk messages today' });
    }

    // Step 4: Build email body
    const emailBody = `
Daily High Risk Message Report — ${todaySGT} (SGT)

The following high risk messages were detected today:

${highRiskRows.map((row, i) => `
---
Message ${i + 1}
User ID: ${row[1] || 'N/A'}
Message: ${row[2] || 'N/A'}
AI Response: ${row[3] || 'N/A'}
Timestamp: ${row[4] || 'N/A'}
`).join('\n')}

---
This is an automated report from the Carey TikTok Bot.
    `.trim();

    // Step 5: Send email via Outlook
    const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_EMAIL,
        pass: process.env.GMAIL_PASSWORD,
    },
    });

    await transporter.sendMail({
      from: process.env.GMAIL_EMAIL,
      to: process.env.ALERT_EMAIL,
      subject: `⚠️ Carey Bot — ${highRiskRows.length} High Risk Message(s) Today (${todaySGT})`,
      text: emailBody,
    });

    console.log(`✅ High risk email sent with ${highRiskRows.length} messages`);
    return res.status(200).json({ message: `Email sent with ${highRiskRows.length} high risk messages` });

  } catch (error) {
    console.error('❌ Daily risk report failed:', error.message);
    return res.status(500).json({ error: error.message });
  }
}