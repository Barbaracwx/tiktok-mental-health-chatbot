// api/webhook.js
// TikTok webhook handler with AI agent integration

// TikTok API credentials
const APP_ID = '7576146137725878288';
const ACCESS_TOKEN = 'act.UevSun6gz95HQEH7YCBumkDvLmVDz8PdHrEnaPoZw70J509JkqzSuOxZIYeu!6197.s1';

// AI Agent URLs
const CREATE_CHAT_URL = "https://aibot-backend-xl3x.onrender.com/create-chat";
const SEND_MESSAGE_URL = "https://aibot-backend-xl3x.onrender.com/send-message";
const AI_MODEL = "azure~anthropic.claude-4-sonnet";

// Store chat sessions (conversation_id -> chat_id mapping)
// In production, you'd want to use a database instead of memory
const chatSessions = new Map();

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
        
        // Only handle incoming messages from USERS (not messages we send)
        if (webhookData.event === 'im_receive_msg') {
            await handleIncomingMessage(webhookData, content);
        } else if (webhookData.event === 'im_send_msg') {
            console.log('Message sent by bot - ignoring to avoid loop');
        } else {
            console.log('Other event type:', webhookData.event);
        }
        
        // Always respond with 200 OK
        return res.status(200).json({ 
            success: true, 
            message: 'Webhook received',
            event: webhookData.event 
        });
        
    } catch (error) {
        console.error('Error processing webhook:', error);
        return res.status(200).json({ 
            success: false, 
            error: error.message 
        });
    }
}

// Handle incoming messages and get AI response
async function handleIncomingMessage(webhookData, content) {
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
    
    try {
        // Get or create AI chat session for this TikTok conversation
        let aiChatId = chatSessions.get(content.conversation_id);
        
        if (!aiChatId) {
            console.log('Creating new AI chat session...');
            aiChatId = await createAIChat();
            chatSessions.set(content.conversation_id, aiChatId);
            console.log('AI Chat ID:', aiChatId);
        } else {
            console.log('Using existing AI Chat ID:', aiChatId);
        }
        
        // Send message to AI agent and get response
        console.log('Sending message to AI agent...');
        const aiResponse = await sendMessageToAI(aiChatId, userMessage);
        console.log('AI Response:', aiResponse);
        
        // Send AI's response back to user on TikTok
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
    console.log('Creating AI chat with model:', AI_MODEL);
    
    const response = await fetch(CREATE_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: AI_MODEL
        })
    });
    
    if (!response.ok) {
        throw new Error(`Failed to create AI chat: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('AI chat created:', data);
    
    return data.id;
}

// Send message to AI agent and get response
async function sendMessageToAI(chatId, message) {
    console.log('Sending to AI - Chat ID:', chatId, 'Message:', message);
    
    const response = await fetch(SEND_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: message,
            chat_id: chatId
        })
    });
    
    if (!response.ok) {
        throw new Error(`Failed to send message to AI: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('AI response data:', data);
    
    // Extract the text response from AI
    // Your AI returns: { response: { content: "text here" } }
    if (data.response?.content) {
        return data.response.content;
    } else if (data.response) {
        return data.response;
    } else {
        // Fallback if format is unexpected
        console.warn('Unexpected AI response format:', data);
        return "Sorry, I couldn't process that response.";
    }
}

// Send a message via TikTok Business Messaging API
async function sendTikTokMessage(businessId, conversationId, messageText) {
    const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';
    
    console.log('Sending TikTok message...');
    console.log('Business ID:', businessId);
    console.log('Conversation ID:', conversationId);
    console.log('Message:', messageText);
    
    const payload = {
        business_id: businessId,
        recipient_type: "CONVERSATION",
        recipient: conversationId,
        message_type: "TEXT",
        text: {
            body: messageText
        }
    };
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Access-Token': ACCESS_TOKEN
        },
        body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    
    if (data.code !== 0) {
        console.error('TikTok API Error:', data);
        throw new Error(`TikTok API Error: ${data.message}`);
    }
    
    console.log('TikTok message sent successfully');
    return data;
}