export const config = {
  runtime: "nodejs"
};
const { google } = require('googleapis');
// api/webhook.js
// TikTok webhook handler with AI agent integration
const Redis = require('ioredis');

// TikTok API credentials
const APP_ID = '7576146137725878288';
//const ACCESS_TOKEN = 'act.LLDF3xkKMTdpZ40stCfNK7rNxJZc4jViq7173cMRz7zW1sKOjX6UOaxqcpLy!6222.s1';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const redis = new Redis(process.env.REDIS_URL);

// AI Agent URLs
//const CREATE_CHAT_URL = "https://aibot-backend-vercel.vercel.app/api/create-chat";
//const SEND_MESSAGE_URL = "https://aibot-backend-vercel.vercel.app/api/send-message";
const AI_MODEL = "azure~anthropic.claude-4-sonnet";

const CREATE_CHAT_URL = "https://carelytics.sdnim.com/api/flows/trigger/0dc3a82d-1e76-408e-b4f9-cced0f5d9fc2";
const SEND_MESSAGE_URL = "https://carelytics.sdnim.com/api/flows/trigger/e33fcc9c-555e-4b1b-af74-ef6f229f46e4";

// Store chat sessions (conversation_id -> chat_id mapping)
// In production, you'd want to use a database instead of memory
const chatSessions = new Map();

// Helper to log to Google Sheets
async function logToSheet(chatId, userId, userMsg, aiMsg) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                // The replace here is CRUCIAL for Vercel to read the key correctly
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Raw_data!A:E', // Make sure your tab is named Sheet1
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    chatId.toString(), 
                    userId.toString(), 
                    userMsg, 
                    aiMsg, 
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
    // Only accept POST requests (and GET for manual session clear)
    if (req.method === 'GET') {
        // GET request to clear sessions
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
        
        // Parse the content field
        let content = {};
        try {
            content = JSON.parse(webhookData.content);
        } catch (e) {
            console.log('Could not parse content:', e);
        }

        // ==============================
        // 🔒 GUARD CLAUSE TO PREVENT LOOP
        // Ignore messages sent by the bot itself
        if (content.from_user?.role === 'business_account') {
            console.log('🤖 Message sent by bot — ignoring to prevent loop');
            // respond to webhook immediately so TikTok won't retry
            return res.status(200).json({ ok: true, message: 'Ignored bot message' });
        }

        if (webhookData.event === 'im_receive_msg') {
            await handleIncomingMessage(webhookData, content);
        }
        
        // ⚡ CRITICAL: Respond immediately to prevent TikTok retries
        res.status(200).json({ 
            success: true, 
            message: 'Webhook received',
            event: webhookData.event 
        });
        
    } catch (error) {
        console.error('Error processing webhook:', error);
        // Still return 200 to prevent retries
        if (!res.headersSent) {
            return res.status(200).json({ 
                success: false, 
                error: error.message 
            });
        }
    }
}

// Function to check for "Quick-Reply" or "Hard-coded" triggers
function getStaticResponse(message) {
    if (!message) return null;
    
    const text = message.toLowerCase().trim();

    // Define your triggers
    const triggers = {
        "book an appointment": "You can book a session with our team here. If you're unsure whether to book, I can help you figure that out too 😊\n\nhttps://carey.carecorner.org.sg",
        "i am a caregiver / parent": "Thanks for supporting a young person — that matters a lot 💛 You can explore support options and resources here. If you’d like, I can also share tips on how to support them better.\n\nhttps://carecorner-ist.my.site.com/insight/",
        "i am in urgent danger": "I’m really sorry you’re going through this. You don’t have to face it alone. If you are in immediate danger, please call 995. You can also talk to someone at 1771. I can stay with you while you reach out 💛",
        "faqs": "Here are some common questions about our services. If you don’t see what you need, just ask me — I’ll try my best to help.\n\nhttps://carey.carecorner.org.sg/faqs/"
    };

    // Loop through the triggers to see if the user's message CONTAINS the keyword
    for (const [keyword, response] of Object.entries(triggers)) {
        if (text.includes(keyword)) {
            return response;
        }
    }

    return null;
}

// Keep track of message IDs we already responded to
const repliedMessages = new Set();

// Handle incoming messages and get AI response
async function handleIncomingMessage(webhookData, content) {
    const messageId = content.message_id;

    // 🔒 GUARD CLAUSE: ignore messages we've already replied to
    if (!messageId) {
        console.log('⚠️ No message_id found, skipping');
        return;
    }
    if (repliedMessages.has(messageId)) {
        console.log('⚠️ Already replied to this message, skipping:', messageId);
        return;
    }

    // Mark this message as replied
    repliedMessages.add(messageId);

    console.log('📨 INCOMING MESSAGE');
    console.log('From:', content.from);
    console.log('From User Role:', content.from_user?.role);
    console.log('To User Role:', content.to_user?.role);
    console.log('Conversation ID:', content.conversation_id);
    console.log('Message Type:', content.type);
    
    // CRITICAL: Only respond to messages FROM personal accounts (users)
    // Ignore messages FROM business accounts (our own messages)
    if (content.from_user?.role === 'business_account') {
        console.log('⚠️ Message is from business account (our bot) - IGNORING to prevent loop');
        return;
    }
    
    // Only process text messages
    if (content.type !== 'text') {
        console.log('Not a text message, skipping');
        return;
    }
    
    const userMessage = content.text.body;
    const conversationId = content.conversation_id;
    const openId = webhookData.user_openid;

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
        let aiChatId = chatSessions.get(content.conversation_id);
        
        if (!aiChatId) {
            console.log('Creating new AI chat session...');
            aiChatId = await createAIChat();
            chatSessions.set(content.conversation_id, aiChatId);
            console.log('AI Chat ID:', aiChatId);
        }
        // Prepare message for AI
        let messageToAI = userMessage;
        
        // Send to AI and get response
        console.log('Sending message to AI agent...');

        // ⌨️ SHOW TYPING INDICATOR
        await sendTypingIndicator(
            webhookData.user_openid,
            content.conversation_id
        );

        const aiResponse = await sendMessageToAI(aiChatId, messageToAI);
        console.log('AI Response:', aiResponse);

        await logToSheet(
            content.conversation_id, // chatId
            content.from,            // userId (TikTok open_id)
            userMessage,             // userMsg
            aiResponse               // aiMsg
        );

        await sendTikTokMessage(
            webhookData.user_openid,
            content.conversation_id,
            aiResponse
        );
        
        console.log('✅ AI response sent to user successfully');
        
    } catch (error) {
        console.error('❌ Error handling message:', error);
        
        // Send fallback message if AI fails
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

// Send message to AI agent and get response
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
        
        // Extract the text response from AI
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
            console.error('⏱️ Backend request timed out after 30 seconds');
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
            signal: AbortSignal.timeout(10000) // 10 second timeout
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
// Send "typing..." indicator to TikTok
async function sendTypingIndicator(businessId, conversationId) {
    const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';
    
    console.log('⌨️ Sending typing indicator...');

    try {
        // 1. ADD THIS LINE: You must fetch the token here too!
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
                'Access-Token': dynamicToken // Now this variable exists
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