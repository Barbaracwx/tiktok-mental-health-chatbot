const Redis = require('ioredis');

// Initialize the connection using the URL in your Environment Variables
// Vercel will look for REDIS_URL which you should add in your dashboard
const redis = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
  try {
    // 1. Pull the master key from your Redis Cloud "String" key
    const refreshToken = await redis.get('tiktok_refresh_token');

    if (!refreshToken) {
      return res.status(400).json({ error: "No refresh token found in Redis Cloud." });
    }

    // 2. Ask TikTok for a fresh Access Token
    const response = await fetch('https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.TIKTOK_CLIENT_ID,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });

    const result = await response.json();

    // 3. Check for TikTok's "Success" code (0)
    if (result.code === 0 && result.data && result.data.access_token) {
      
      // 4. Update Redis Cloud with the NEW tokens
      // Using 'await redis.set' works for the String type you created in the dashboard
      await redis.set('tiktok_access_token', result.data.access_token);
      await redis.set('tiktok_refresh_token', result.data.refresh_token);
      
      console.log("✅ Successfully rotated tokens in Redis Cloud.");
      return res.status(200).json({ message: "Tokens updated successfully" });
      
    } else {
      console.error("TikTok API Error:", result);
      return res.status(400).json({ 
        error: "TikTok rejected the refresh request", 
        details: result 
      });
    }
  } catch (error) {
    console.error("Server Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}