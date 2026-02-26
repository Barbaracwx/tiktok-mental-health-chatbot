export const config = {
  runtime: "nodejs"
};
// api/webhook.js
// TikTok webhook handler with AI agent integration

// TikTok API credentials
const APP_ID = '7576146137725878288';
const ACCESS_TOKEN = 'act.qain9m0CvC7aAm8wbaRuQ6F8DTzXPAaUQrzEFNwJ0T1LpZPQ5e93OttVOyzH!6194.s1';

// AI Agent URLs
//const CREATE_CHAT_URL = "https://aibot-backend-vercel.vercel.app/api/create-chat";
//const SEND_MESSAGE_URL = "https://aibot-backend-vercel.vercel.app/api/send-message";
const AI_MODEL = "azure~openai.gpt-4o-mini";

const CREATE_CHAT_URL = "https://carelytics.sdnim.com/api/flows/trigger/0dc3a82d-1e76-408e-b4f9-cced0f5d9fc2";
const SEND_MESSAGE_URL = "https://carelytics.sdnim.com/api/flows/trigger/e33fcc9c-555e-4b1b-af74-ef6f229f46e4";

// Store chat sessions (conversation_id -> chat_id mapping)
// In production, you'd want to use a database instead of memory
const chatSessions = new Map();

// ==============================
// 🚨 Crisis Detection & Risk Classification
// ==============================
function classifyRisk(message) {
    if (!message) return "LOW";

    const text = message.toLowerCase();

    const HIGH_RISK = [
        "kill myself",
        "suicide",
        "end my life",
        "want to die",
        "don't want to live",
        "hurt myself",
        "self harm",
        "cut myself",
        "overdose",
        "jump off"
    ];

    const MEDIUM_RISK = [
        "hopeless",
        "empty",
        "worthless",
        "no point",
        "giving up",
        "can't go on",
        "overwhelmed",
        "so tired of everything",
        "alone"
    ];

    if (HIGH_RISK.some(k => text.includes(k))) {
        return "HIGH";
    }

    if (MEDIUM_RISK.some(k => text.includes(k))) {
        return "MEDIUM";
    }

    return "LOW";
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
    console.log('User Message:', userMessage);
    //Assess mental health risk
    const riskLevel = classifyRisk(userMessage);
    console.log('🧠 Risk Level:', riskLevel);

    
    try {
        // Get or create AI chat session for this TikTok conversation
        let aiChatId = chatSessions.get(content.conversation_id);
        let isNewConversation = false;
        
        if (!aiChatId) {
            console.log('Creating new AI chat session...');
            aiChatId = await createAIChat();
            chatSessions.set(content.conversation_id, aiChatId);
            console.log('AI Chat ID:', aiChatId);
            isNewConversation = true;
            
            // 🎭 SETUP: Prime the AI with its role as a supportive friend/therapist
            console.log('🎭 Setting up AI personality...');
            //     await sendMessageToAI(aiChatId, 
            //         "You are now a supportive friend and mental health companion for young people in Singapore (ages 13-30). " +
            //         "Your role is to: " +
            //         "1. Listen with empathy and without judgment " +
            //         "3. Be warm, friendly, and approachable - like talking to a caring friend " +
            //         "Keep replies concise and easy to read, like a natural text conversation. Avoid long paragraphs or too many sentences. Keep to maximum four sentences." +
            //         "Respond as a supportive companion using Dialectical Behaviour Therapy (DBT) principles. Validate the user’s feelings first using non-judgmental language. Balance acceptance and change by showing understanding while gently encouraging helpful coping strategies." +
            //         "Use principles from Dialectical Behaviour Therapy (DBT) where applicable: Validation: acknowledge and normalize feelings."+
            //         "Mindfulness: help the user notice emotions without judgment."+
            //         "Distress tolerance: suggest small coping steps for difficult moments."+
            //         "Emotional regulation: give gentle guidance to manage intense feelings."+
            //         "Interpersonal effectiveness: support healthy communication and self-assertion if relevant."+
            //         "Keep responses concise, conversational, and friendly, like texting a trusted friend. Use simple language, short sentences, and a warm, supportive tone."

            //     );
                await sendMessageToAI(aiChatId, 
                    "You are a compassionate, empathetic assistant. When a user shares struggles or negative thoughts, first validate their feelings sincerely, showing understanding without judgment. Then, help them reframe unhelpful thoughts using principles from Cognitive Behavioral Therapy (CBT):"+
                    "1. Identify unhelpful thinking patterns or distortions."+
                    "2. Offer balanced or alternative perspectives."+
                    "3. Suggest small, manageable coping strategies or skills to regulate emotions."+
                    "Keep responses under 200 characters."
                );
            console.log('✅ AI personality configured');
        } else {
            console.log('Using existing AI Chat ID:', aiChatId);
        }
        
        // Prepare message for AI
        let messageToAI = userMessage;

        if (riskLevel === "MEDIUM") {
            messageToAI =
                "The user is emotionally overwhelmed. Respond with empathy, validation, and gentle encouragement to seek support.\n\n" +
                "After a while, can direct users to seek professional help to: https://carecorner-ist.my.site.com/insight/."
                "User said: " + userMessage;
        }

        if (riskLevel === "HIGH") {
            messageToAI =
                "The user has expressed thoughts of self-harm or suicide. " +
                "If suicide/self-harm intent or means are detected (e.g., pills), stop all coaching. Provide 1771 (National Mindline) and 995 (SCDF) immediately. Use only minimal grounding (e.g., press your thumb into your finger) to keep them present while they call." +
                "User said: " + userMessage;
        }
        
        // If this is the first real message from the user, add welcome context
        if (isNewConversation) {
            console.log('👋 First message - adding welcome context...');
            messageToAI = 
                `This is my first message to you. Please respond by: ` +
                `1) Giving me a warm, brief welcome (1-2 sentences) introducing yourself as a supportive space for emotions and mental health ` +
                `2) Then naturally acknowledging and responding to what I just said: "${userMessage}" ` +
                `Keep it conversational and flow naturally - don't make it sound like two separate sections.`;
        }
        
        // Send to AI and get response
        console.log('Sending message to AI agent...');

        // ⌨️ SHOW TYPING INDICATOR
        await sendTypingIndicator(
            webhookData.user_openid,
            content.conversation_id
        );

        const aiResponse = await sendMessageToAI(aiChatId, messageToAI);
        console.log('AI Response:', aiResponse);

        // Immediate crisis response for HIGH risk
        // if (riskLevel === "HIGH") {
        //     const crisisMessage =
        //         "I’m really glad you told me this. You’re not alone, and help is available.\n\n" +
        //         "If things feel overwhelming right now, please reach out to Care Corner. " +
        //         "They provide free and confidential mental health support for young people in Singapore.\n\n" +
        //         "👉 https://carey.carecorner.org.sg/\n\n" +
        //         "If you’re in immediate danger, please call 999 or go to the nearest A&E.";
            
        //         // Send AI's response back to user on TikTok
        //     await sendTikTokMessage(
        //         webhookData.user_openid,
        //         content.conversation_id,
        //         crisisMessage
        //     );
        // }

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
            signal: AbortSignal.timeout(30000) // 30 second timeout
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
                'Access-Token': ACCESS_TOKEN
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
async function sendTypingIndicator(businessId, conversationId) {
    const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';
    
    console.log('⌨️ Sending typing indicator...');
    
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
                'Access-Token': ACCESS_TOKEN
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000) // 5 second timeout
        });
        
        const data = await response.json();
        
        if (data.code === 0) {
            console.log('✅ Typing indicator sent');
        } else {
            console.log('⚠️ Typing indicator failed (non-critical):', data.message);
        }
    } catch (error) {
        // Don't throw - typing indicator is not critical
        console.log('⚠️ Typing indicator error (non-critical):', error.message);
    }
}