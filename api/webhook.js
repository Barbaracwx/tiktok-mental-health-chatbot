export const config = {
  runtime: "nodejs"
};

const Redis = require('ioredis');
import { waitUntil } from '@vercel/functions';

const redis = new Redis(process.env.REDIS_URL);

const CREATE_CHAT_URL = "https://carelytics.sdnim.com/api/flows/trigger/0dc3a82d-1e76-408e-b4f9-cced0f5d9fc2";
const SEND_MESSAGE_URL = "https://carelytics.sdnim.com/api/flows/trigger/e33fcc9c-555e-4b1b-af74-ef6f229f46e4";

const DIFY_API_URL = process.env.DIFY_API_URL;
const DIFY_API_KEY = process.env.DIFY_API_KEY;

const MAX_HISTORY = 20; // 10 exchanges
const MAX_REPLAY = 10;  // max messages to replay into AIBot on recovery

// ─── HISTORY HELPERS ──────────────────────────────────────────────────────────

async function saveToHistory(conversationId, userMessage, assistantReply, handledBy) {
  try {
    const key = `history:${conversationId}`;
    const existing = await redis.get(key);
    const history = existing ? JSON.parse(existing) : [];

    history.push({ role: 'user', content: userMessage, handledBy });
    history.push({ role: 'assistant', content: assistantReply, handledBy });

    // Keep only last MAX_HISTORY messages
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    await redis.set(key, JSON.stringify(history), 'EX', 21600); // 6 hours
    console.log(`💾 Saved to history (${handledBy}), total messages: ${history.length}`);
  } catch (error) {
    console.error('⚠️ Failed to save history:', error.message);
  }
}

async function getHistory(conversationId) {
  try {
    const key = `history:${conversationId}`;
    const existing = await redis.get(key);
    return existing ? JSON.parse(existing) : [];
  } catch (error) {
    console.error('⚠️ Failed to get history:', error.message);
    return [];
  }
}

// ─── DIFY FALLBACK ────────────────────────────────────────────────────────────

async function sendMessageToDify(conversationId, userMessage) {
  console.log('🔄 Falling back to Dify...');

  const difyConversationId = await redis.get(`dify_session:${conversationId}`) || '';
  const isFirstDifyMessage = !difyConversationId;

  let queryToSend = userMessage;

  // On first Dify message, prepend AIBot history as context
  if (isFirstDifyMessage) {
    const history = await getHistory(conversationId);
    const aibotHistory = history.filter(m => m.handledBy === 'aibot');

    if (aibotHistory.length > 0) {
      const transcript = aibotHistory
        .map(m => `${m.role === 'user' ? 'User' : 'Carey'}: ${m.content}`)
        .join('\n');

      queryToSend = `[Previous conversation before handover]\n${transcript}\n\n[Current message]\nUser: ${userMessage}`;
      console.log('📋 Prepended AIBot history to first Dify message');
    }
  }

  const response = await fetch(`${DIFY_API_URL}/chat-messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DIFY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: {},
      query: queryToSend,
      response_mode: 'blocking',
      conversation_id: difyConversationId,
      user: conversationId,
    }),
    signal: AbortSignal.timeout(50000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dify API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  if (data.conversation_id) {
    await redis.set(`dify_session:${conversationId}`, data.conversation_id, 'EX', 86400);
  }

  return data.answer;
}

// ─── AIBOT ────────────────────────────────────────────────────────────────────

async function createAIChat() {
  console.log('🤖 Creating AIBot chat session...');

  const response = await fetch(CREATE_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: "azure~openai.gpt-5-2-chat"}),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`createAIChat failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.id) {
    throw new Error('createAIChat returned no ID');
  }

  console.log('✅ AIBot chat created, ID:', data.id);
  return data.id;
}

async function sendMessageToAI(chatId, message) {
  console.log('💬 Sending to AIBot - Chat ID:', chatId);

  const response = await fetch(SEND_MESSAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message, chat_id: chatId }),
    signal: AbortSignal.timeout(50000),
  });

  if (!response.ok) {
    throw new Error(`sendMessageToAI failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.response?.content) return data.response.content;
  if (data.response) return data.response;

  throw new Error('Unexpected AIBot response format');
}

// ─── MAIN AI CALL WITH DIFY FALLBACK ─────────────────────────────────────────

async function getAIResponse(conversationId, userMessage) {
  try {
    // Step 1: Get or create AIBot session
    let aiChatId = await redis.get(`session:${conversationId}`);

    if (!aiChatId) {
      console.log('No AIBot session found, creating one...');
      aiChatId = await createAIChat();
      await redis.set(`session:${conversationId}`, aiChatId, 'EX', 86400);
    }

    // Step 2: Check if AIBot missed any Dify messages and replay them
    const history = await getHistory(conversationId);
    const lastAibotIndex = history.map(m => m.handledBy).lastIndexOf('aibot');
    const missedByAibot = history
      .slice(lastAibotIndex + 1)
      .filter(m => m.handledBy === 'dify')
      .slice(-MAX_REPLAY); // cap at last 10

    if (missedByAibot.length > 0) {
      console.log(`🔁 Replaying ${missedByAibot.length} missed Dify messages into AIBot...`);

      for (const msg of missedByAibot) {
        if (msg.role === 'user') {
          try {
            await sendMessageToAI(aiChatId, msg.content);
            console.log('✅ Replayed message into AIBot:', msg.content.slice(0, 50));
          } catch (replayError) {
            console.error('⚠️ Failed to replay message into AIBot:', replayError.message);
            // If replay itself fails, AIBot is still down — throw to trigger Dify fallback
            throw replayError;
          }
        }
      }
      console.log('✅ AIBot caught up on missed Dify messages');
    }

    // Step 3: Send actual user message to AIBot
    const aiResponse = await sendMessageToAI(aiChatId, userMessage);
    console.log('✅ AIBot responded successfully');

    // Step 4: Save to history
    await saveToHistory(conversationId, userMessage, aiResponse, 'aibot');

    return aiResponse;

  } catch (error) {
    console.error('❌ AIBot failed:', error.message);
    console.log('🔄 Routing to Dify fallback...');

    try {
      const difyResponse = await sendMessageToDify(conversationId, userMessage);
      console.log('✅ Dify fallback responded successfully');

      // Save to history as dify
      await saveToHistory(conversationId, userMessage, difyResponse, 'dify');

      return difyResponse;
    } catch (difyError) {
      console.error('❌ Dify fallback also failed:', difyError.message);
      throw new Error('Both AIBot and Dify failed');
    }
  }
}

// ─── STATIC RESPONSES ─────────────────────────────────────────────────────────

function getStaticResponse(message) {
  if (!message) return null;

  const text = message.toLowerCase().trim();

  const triggers = {
    "book an appointment": "You can book a session with our team here. If you're unsure whether to book, I can help you figure that out too 😊\n\nhttps://carey.carecorner.org.sg",
    "i am a caregiver / parent": "Thanks for supporting a young person — that matters a lot 💛 You can explore support options and resources here. If you'd like, I can also share tips on how to support them better.\n\nhttps://carecorner-ist.my.site.com/insight/",
    "i am in urgent danger": "I'm really sorry you're going through this. You don't have to face it alone. If you are in immediate danger, please call 995. You can also talk to someone at 1771. I can stay with you while you reach out 💛",
    "faqs": "Here are some common questions about our services. If you don't see what you need, just ask me — I'll try my best to help.\n\nhttps://carey.carecorner.org.sg/faqs/"
  };

  for (const [keyword, response] of Object.entries(triggers)) {
    if (text.includes(keyword)) return response;
  }

  return null;
}

// ─── LOG TO GOOGLE SHEETS ──────────────────────────────────────────────────
async function logToGoogleSheets(conversationId, from, userMessage, aiResponse) {
  try {
    const { GoogleAuth } = require('google-auth-library');
    const { google } = require('googleapis');

    const auth = new GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const timestamp = new Date().toISOString();

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Raw_data!A:E',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[conversationId, from, userMessage, aiResponse, timestamp]],
      },
    });

    console.log('✅ Logged to Google Sheets');
  } catch (error) {
    console.error('⚠️ Failed to log to Google Sheets:', error.message);
  }
}

// ─── HANDLE INCOMING MESSAGE ──────────────────────────────────────────────────

async function handleIncomingMessage(webhookData, content) {
  const messageId = content.message_id;
  const conversationId = content.conversation_id;
  const userMessage = content.text.body;

  if (!messageId) {
    console.log('⚠️ No message_id found, skipping');
    return;
  }

  // Dedup guard
  const isNewMessage = await redis.set(`lock:${messageId}`, 'processed', 'EX', 3600, 'NX');
  if (!isNewMessage) {
    console.log('⚠️ Duplicate message, skipping:', messageId);
    return;
  }

  console.log('📨 Incoming message from:', content.from);
  console.log('Conversation ID:', conversationId);
  console.log('Message:', userMessage);

  if (content.from_user?.role === 'business_account') {
    console.log('⚠️ Message from business account, ignoring');
    return;
  }

  if (content.type !== 'text') {
    console.log('Not a text message, skipping');
    return;
  }

  // Check static triggers first
  const staticReply = getStaticResponse(userMessage);
  if (staticReply) {
    console.log('⚡ Static response matched');
    await sendTikTokMessage(webhookData.user_openid, conversationId, staticReply);
    return;
  }

  try {
    await sendTypingIndicator(webhookData.user_openid, conversationId);

    const reply = await getAIResponse(conversationId, userMessage);

    await logToGoogleSheets(conversationId, content.from, userMessage, reply);

    await sendTikTokMessage(webhookData.user_openid, conversationId, reply);
    console.log('✅ Reply sent to user');

  } catch (error) {
    console.error('❌ All AI options failed:', error.message);
    await sendTikTokMessage(
      webhookData.user_openid,
      conversationId,
      "I'm having trouble processing your message right now. Please try again in a moment."
    );
  }
}

// ─── TIKTOK HELPERS ───────────────────────────────────────────────────────────

async function sendTikTokMessage(businessId, conversationId, messageText) {
  const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';
  const dynamicToken = await redis.get('tiktok_access_token');

  console.log('🚀 Sending TikTok message, length:', messageText.length);

  const payload = {
    business_id: businessId,
    recipient_type: "CONVERSATION",
    recipient: conversationId,
    message_type: "TEXT",
    text: { body: messageText }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': dynamicToken
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`TikTok API Error: ${data.message}`);
  }

  console.log('✅ TikTok message sent');
  return data;
}

async function sendTypingIndicator(businessId, conversationId) {
  const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';
  const dynamicToken = await redis.get('tiktok_access_token');

  const payload = {
    business_id: businessId,
    recipient_type: "CONVERSATION",
    recipient: conversationId,
    message_type: "SENDER_ACTION",
    sender_action: "TYPING"
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': dynamicToken
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    const data = await response.json();
    if (data.code === 0) {
      console.log('✅ Typing indicator sent');
    } else {
      console.log('⚠️ Typing indicator failed (non-critical):', data.message);
    }
  } catch (error) {
    console.log('⚠️ Typing indicator error (non-critical):', error.message);
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ success: true, message: 'Webhook is running' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const webhookData = req.body;

    console.log('=== NEW WEBHOOK EVENT ===');
    console.log('Event:', webhookData.event);

    let content = {};
    try {
      content = JSON.parse(webhookData.content);
    } catch (e) {
      console.log('Could not parse content:', e);
    }

    if (content.from_user?.role === 'business_account') {
      console.log('🤖 Bot message — ignoring');
      return res.status(200).json({ ok: true, message: 'Ignored bot message' });
    }

    if (webhookData.event === 'im_receive_msg') {
      waitUntil(handleIncomingMessage(webhookData, content));
    }

    return res.status(200).json({ success: true, event: webhookData.event });

  } catch (error) {
    console.error('Error processing webhook:', error);
    if (!res.headersSent) {
      return res.status(200).json({ success: false, error: error.message });
    }
  }
}