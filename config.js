/**
 * Global Configuration for WhatsApp MD Bot
 */

module.exports = {
    // Bot Owner Configuration
    ownerNumber: ['233243729528'], // Replace with your actual WhatsApp number without + or spaces (e.g., 233241234567)
    ownerName: ['pocket'], // Updated to your name/handle
    
    // Bot Configuration
    botName: 'pocketBot',
    prefix: '.',
    sessionName: 'session',
    sessionID: process.env.SESSION_ID || '', // Paste your session here 
    newsletterJid: '120363161513685998@newsletter', // Newsletter JID for menu forwarding
    updateZipUrl: 'https://github.com/apf/KnightBot-Mini/archive/refs/heads/main.zip', // Updated with your GitHub username
    
    // Sticker Configuration
    packname: 'Knight Bot',

    // Bot Behavior
    selfMode: false, // Private mode - only owner can use commands
    autoRead: false,
    autoTyping: false,
    autoBio: false,
    autoSticker: false,
    autoReact: false,
    autoReactMode: 'bot',
    autoDownload: false,
    
    // Group Settings Defaults
    defaultGroupSettings: {
      antilink: false,
      antilinkAction: 'delete', // 'delete', 'kick', 'warn'
      antitag: false,
      antitagAction: 'delete',
      antiall: false, // Owner only - blocks all messages from non-admins
      antiviewonce: false,
      antibot: false,
      antibotAction: 'warn', // 'warn' | 'kick'
      anticall: false, // Anti-call feature
      antigroupmention: false, // Anti-group mention feature
      antigroupmentionAction: 'delete', // 'delete', 'kick'
      antigroupstatus: false, // Block group status posts
      antigroupstatusAction: 'delete', // 'delete', 'kick'
      antisticker: false, // Stickers not allowed in group
      antistickerAction: 'delete', // 'delete', 'kick'
      antibadword: false, // Block bad words in group
      antibadwordAction: 'delete', // 'delete', 'kick', 'warn'
      welcome: false,
      welcomeMessage: '╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @user 👋\n┃Member count: #memberCount\n┃𝚃𝙸𝙼𝙴: time⏰\n╰━━━━━━━━━━━━━━━╯\n\n*@user* Welcome to *@group*! 🎉\n*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\ngroupDesc\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ botName*',
      goodbye: false,
      goodbyeMessage: 'Goodbye @user 👋 We will never miss you!',
      antiSpam: false,
      antiSpamAction: 'warn', // 'warn' | 'kick'
      antidelete: false,
      detect: false,
      chatbot: false,
      suppress: false, // Members get no command reply; owner and admins still can
      autosticker: false // Auto-convert images/videos to stickers
    },

    // API Keys (add your own)
    apiKeys: {
      openai: '',
      deepai: '',
      remove_bg: '',
      telegram: '8834454929:AAFObZTD28Aa4w7fh3FbpPcZyPlPIkyi5ew' // @BotFather token — required for .tg / .tgsticker
    },
    
    // KnightBot Mini media API (song/video/tiktok/facebook/instagram downloaders)
    mediaApiUrl: (process.env.YT_API_URL || 'https://api-xgp2.onrender.com').replace(/\/$/, ''),
    mediaApiKey: process.env.YT_API_KEY || 'knight',
    // KnightBot public API (reactions GIFs, etc.)
    knightApiUrl: (process.env.KNIGHT_API_URL || 'https://knightbotapi.stream').replace(/\/$/, ''),
    knightApiKey: process.env.KNIGHT_API_KEY || 'knight',
    princeApiUrl: (process.env.PRINCE_API_URL || 'https://api.princetechn.com').replace(/\/$/, ''),
    princeApiKey: process.env.PRINCE_API_KEY || 'prince',

    // Message Configuration
    messages: {
      wait: '⏳ Please wait...',
      success: '✅ Success!',
      error: '❌ Error occurred!',
      ownerOnly: '👑 This command is only for bot owner!',
      adminOnly: '🛡️ This command is only for group admins!',
      groupOnly: '👥 This command can only be used in groups!',
      privateOnly: '💬 This command can only be used in private chat!',
      botAdminNeeded: '🤖 Bot needs to be admin to execute this command!',
      invalidCommand: '❓ Invalid command! Type .menu for help'
    },
    
    // Timezone
    timezone: 'Africa/Accra', // Updated to match your local timezone
    
    // Limits
    maxWarnings: 3,
    
    // Social Links (optional)
    social: {
      github: 'https://github.com/Francis2Marfo', // Change this to your actual GitHub profile link if different
      instagram: 'https://instagram.com/kngightbotmd',
      youtube: 'http://youtube.com/@mr_unique_hacker'
    }
};
