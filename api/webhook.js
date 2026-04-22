export const config = {
  runtime: "nodejs"
};
const { google } = require('googleapis');
// api/webhook.js
// TikTok webhook handler with AI agent integration + Gemini fallback
const Redis = require('ioredis');
import { waitUntil } from '@vercel/functions';

// TikTok API credentials
const APP_ID = '7576146137725878288';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const redis = new Redis(process.env.REDIS_URL);

// AI Agent URLs (primary)
const AI_MODEL = "azure~openai.gpt-5-2-chat";
const CREATE_CHAT_URL = "https://carelytics.sdnim.com/api/flows/trigger/0dc3a82d-1e76-408e-b4f9-cced0f5d9fc2";
const SEND_MESSAGE_URL = "https://carelytics.sdnim.com/api/flows/trigger/e33fcc9c-555e-4b1b-af74-ef6f229f46e4";

// Gemini fallback config
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ⚠️ IMPORTANT: Paste your full aibot system prompt here so Gemini
// behaves consistently when it takes over as fallback.
const FALLBACK_SYSTEM_PROMPT = `You are Carey, a warm and supportive mental health chatbot 
for CareCorner Singapore. You help young people (aged 12–25) who may be experiencing 
emotional difficulties. Be empathetic, non-judgmental, and supportive. 
If someone is in danger, always refer them to call 995 or reach 1771.`;

// Helper to log to Google Sheets
async function logToSheet(chatId, userId, userMsg, aiMsg, riskLevel) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Raw_data!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    chatId.toString(),
                    userId.toString(),
                    userMsg,
                    aiMsg,
                    riskLevel || "N/A",
                    new Date().toLocaleString("en-SG", { timeZone: "Asia/Singapore" })
                ]],
            },
        });
        console.log("✅ Logged to Google Sheets");
    } catch (error) {
        console.error("❌ Google Sheets Error:", error);
    }
}


export default async function handler(req, res) {
    if (req.method === 'GET') {
        const action = req.query.action;
        if (action === 'clear') {
            const count = chatSessions.size;
            chatSessions.clear();
            return res.status(200).json({
                success: true,
                message: `Cleared ${count} chat sessions`,
                cleared: count
            });
        }
        return res.status(200).json({
            success: true,
            message: 'Webhook is running',
            activeSessions: chatSessions.size
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const webhookData = req.body;

        console.log('=== NEW WEBHOOK EVENT ===');
        console.log('Event Type:', webhookData.event);
        console.log('Timestamp:', new Date(webhookData.create_time * 1000).toISOString());

        let content = {};
        try {
            content = JSON.parse(webhookData.content);
        } catch (e) {
            console.log('Could not parse content:', e);
        }

        // Guard: ignore messages sent by the bot itself
        if (content.from_user?.role === 'business_account') {
            console.log('🤖 Message sent by bot — ignoring to prevent loop');
            return res.status(200).json({ ok: true, message: 'Ignored bot message' });
        }

        if (webhookData.event === 'im_receive_msg') {
            waitUntil(handleIncomingMessage(webhookData, content));
        }

        // Respond immediately to prevent TikTok retries
        res.status(200).json({
            success: true,
            message: 'Webhook received',
            event: webhookData.event
        });

    } catch (error) {
        console.error('Error processing webhook:', error);
        if (!res.headersSent) {
            return res.status(200).json({
                success: false,
                error: error.message
            });
        }
    }
}

// Check for static/quick-reply triggers
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
        if (text.includes(keyword)) {
            return response;
        }
    }

    return null;
}

// ============================================================
// NEW: Gemini fallback function
// Called when primary AI (aibot via Directus) fails or times out
// ============================================================
async function sendMessageToFallbackLLM(userMessage) {
    console.log('🔄 Attempting Gemini fallback LLM...');

    const response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: {
                parts: [{ text: FALLBACK_SYSTEM_PROMPT }]
            },
            contents: [
                {
                    parts: [{ text: userMessage }]
                }
            ],
            generationConfig: {
                maxOutputTokens: 500,
                temperature: 0.7
            }
        }),
        signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error('❌ Gemini API error response:', errText);
        throw new Error(`Gemini API failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
        console.warn('⚠️ Unexpected Gemini response format:', JSON.stringify(data));
        throw new Error('Gemini returned empty response');
    }

    console.log('✅ Gemini fallback responded, length:', text.length, 'chars');
    return text;
}

// Handle incoming messages and get AI response
async function handleIncomingMessage(webhookData, content) {
    const messageId = content.message_id;
    const TAGGING_CHAT_ID = "3051176c095d4631a96e394342a1685e";
    const conversationId = content.conversation_id;
    const openId = webhookData.user_openid;
    const userMessage = content.text.body;

    // Guard: skip messages already replied to (dedup via Redis)
    if (!messageId) {
        console.log('⚠️ No message_id found, skipping');
        return;
    }
    const isNewMessage = await redis.set(`lock:${messageId}`, 'processed', 'EX', 3600, 'NX');
    if (!isNewMessage) {
        console.log('⚠️ Duplicate message detected (Redis lock), skipping:', messageId);
        return;
    }

    console.log('📨 INCOMING MESSAGE');
    console.log('From:', content.from);
    console.log('From User Role:', content.from_user?.role);
    console.log('To User Role:', content.to_user?.role);
    console.log('Conversation ID:', content.conversation_id);
    console.log('Message Type:', content.type);

    // Only respond to messages from personal accounts (users)
    if (content.from_user?.role === 'business_account') {
        console.log('⚠️ Message is from business account (our bot) - IGNORING to prevent loop');
        return;
    }

    // Only process text messages
    if (content.type !== 'text') {
        console.log('Not a text message, skipping');
        return;
    }

    // Check for static/quick-reply triggers first
    const staticReply = getStaticResponse(userMessage);
    if (staticReply) {
        console.log("⚡ Static template found. Bypassing AI.");
        await logToSheet(conversationId, content.from, userMessage, staticReply);
        await sendTikTokMessage(openId, conversationId, staticReply);
        return;
    }

    console.log('User Message:', userMessage);

    try {
        // Get or create AI chat session for this TikTok conversation
        let aiChatId = await redis.get(`session:${conversationId}`);

        if (!aiChatId) {
            console.log('Creating new AI chat session...');
            aiChatId = await createAIChat();
            await redis.set(`session:${conversationId}`, aiChatId, 'EX', 86400);
            console.log('AI Chat ID Saved to Redis:', aiChatId);
        }

        // Show typing indicator
        await sendTypingIndicator(webhookData.user_openid, content.conversation_id);

        // ============================================================
        // UPDATED: Primary AI call with Gemini fallback
        // ============================================================
        let aiResponse, riskLevel;

        try {
            // Attempt primary AI (aibot via Directus) + risk tagger in parallel
            console.log('📡 Calling primary AI agents in parallel...');
            [aiResponse, riskLevel] = await Promise.all([
                sendMessageToAI(aiChatId, userMessage),
                sendMessageToAI(TAGGING_CHAT_ID, userMessage)
            ]);
            console.log('✅ Primary AI responded successfully');
            console.log(`🧠 Risk tagged as: ${riskLevel}`);

        } catch (primaryError) {
            // Primary AI is down or timed out — switch to Gemini
            console.warn('⚠️ Primary AI failed:', primaryError.message);
            console.warn('🔄 Switching to Gemini fallback...');

            try {
                aiResponse = await sendMessageToFallbackLLM(userMessage);
                // Risk tagging is not possible without the primary tagger
                riskLevel = "N/A (Gemini fallback)";
                console.log('✅ Gemini fallback responded successfully');

            } catch (fallbackError) {
                // Both primary and Gemini have failed — send a safe hardcoded reply
                console.error('❌ Both primary AI and Gemini fallback failed:', fallbackError.message);
                aiResponse = "I'm having some trouble right now and can't respond properly. Please try again in a moment. If this is urgent, you can reach someone at 1771 💛";
                riskLevel = "ERROR";
            }
        }
        // ============================================================

        console.log('AI Response:', aiResponse);

        await logToSheet(
            conversationId,
            content.from,
            userMessage,
            aiResponse,
            riskLevel
        );

        await sendTikTokMessage(
            webhookData.user_openid,
            content.conversation_id,
            aiResponse
        );

        console.log('✅ Response sent to user successfully');

    } catch (error) {
        console.error('❌ Error handling message:', error);

        // Last-resort fallback if something unexpected breaks
        try {
            await sendTikTokMessage(
                webhookData.user_openid,
                content.conversation_id,
                "I'm having trouble processing your message right now. Please try again in a moment."
            );
        } catch (fallbackError) {
            console.error('Failed to send fallback message:', fallbackError);
        }
    }
}

// Create a new AI chat session
async function createAIChat() {
    console.log('🤖 Creating AI chat with model:', AI_MODEL);
    console.log('🚪 About to call CREATE_CHAT_URL:', CREATE_CHAT_URL);

    try {
        const response = await fetch(CREATE_CHAT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: AI_MODEL }),
            signal: AbortSignal.timeout(10000)
        });

        console.log('📥 Fetch returned, status:', response.status);

        const data = await response.json();
        console.log('✅ AI chat created, ID:', data.id);

        return data.id;
    } catch (error) {
        console.error('💥 Fetch failed:', error.name, error.message);
        throw error;
    }
}

// Send message to primary AI agent and get response
async function sendMessageToAI(chatId, message) {
    console.log('💬 Sending to AI - Chat ID:', chatId, 'Message:', message);

    try {
        console.log('📡 Making fetch request to backend...');
        const response = await fetch(SEND_MESSAGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: message,
                chat_id: chatId
            }),
            signal: AbortSignal.timeout(50000) // 50 second timeout
        });

        console.log('📥 Got response from backend, status:', response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Backend error response:', errorText);
            throw new Error(`Failed to send message to AI: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log('✅ AI response received, length:', data.response?.content?.length || 0, 'chars');

        if (data.response?.content) {
            return data.response.content;
        } else if (data.response) {
            return data.response;
        } else {
            console.warn('Unexpected AI response format:', data);
            return "Sorry, I couldn't process that response.";
        }
    } catch (error) {
        console.error('💥 Error sending message to AI:', error.name, error.message);
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            console.error('⏱️ Backend request timed out after 50 seconds');
            throw new Error('AI service is taking too long to respond. Please try again.');
        }
        throw error;
    }
}

// Send a message via TikTok Business Messaging API
async function sendTikTokMessage(businessId, conversationId, messageText) {
    const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';

    const dynamicToken = await redis.get('tiktok_access_token');
    console.log("Using token from Redis:", dynamicToken);

    console.log('🚀 Sending TikTok message...');
    console.log('Business ID:', businessId);
    console.log('Conversation ID:', conversationId);
    console.log('Message length:', messageText.length, 'characters');

    const payload = {
        business_id: businessId,
        recipient_type: "CONVERSATION",
        recipient: conversationId,
        message_type: "TEXT",
        text: {
            body: messageText
        }
    };

    try {
        console.log('📡 Making fetch request to TikTok API...');
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Access-Token': dynamicToken
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000)
        });

        console.log('📥 Got response from TikTok, status:', response.status);
        const data = await response.json();
        console.log('📄 Response data:', JSON.stringify(data));

        if (data.code !== 0) {
            console.error('❌ TikTok API Error:', data);
            throw new Error(`TikTok API Error: ${data.message}`);
        }

        console.log('✅ TikTok message sent successfully');
        return data;
    } catch (error) {
        console.error('💥 Error in sendTikTokMessage:', error.name, error.message);
        if (error.name === 'TimeoutError') {
            console.error('⏱️ Request timed out after 10 seconds');
        }
        throw error;
    }
}

// Send "typing..." indicator to TikTok
async function sendTypingIndicator(businessId, conversationId) {
    const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';

    console.log('⌨️ Sending typing indicator...');

    try {
        const dynamicToken = await redis.get('tiktok_access_token');

        const payload = {
            business_id: businessId,
            recipient_type: "CONVERSATION",
            recipient: conversationId,
            message_type: "SENDER_ACTION",
            sender_action: "TYPING"
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Access-Token': dynamicToken
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000)
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